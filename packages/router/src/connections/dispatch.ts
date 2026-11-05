import type { ResolvedConfig } from "../config/load.js";
import { AdmissionDenied } from "../core/errors.js";
import type { Gate } from "../gateway/gate.js";
import type { ChatResponse } from "../gateway/types.js";
import type { TaskRouter } from "../routing/router.js";
import { ClientConnectionError, ClientConnectionRequestSchema, clientResponse, type ClientConnectionRequest } from "./protocol.js";
import { clientResponseValidator, routePreservesClientConstraints } from "./constraints.js";
import { clientConnectionTokenMatches } from "./access.js";
import { createInstallationExecution, retireInstallationExecution } from "./installation-execution.js";
import type { ClientConnectionRequestLedger } from "./request-ledger.js";

/** Installation-owned Gate/ledger; direct calls have no task, project or worker profile. */
export interface ClientConnectionContext {
  cfg: ResolvedConfig;
  gate: Gate;
  router: TaskRouter;
  ledger: ClientConnectionRequestLedger;
  assertCurrent(): void;
}

export async function dispatchClientConnection(context: ClientConnectionContext, raw: ClientConnectionRequest, signal: AbortSignal, accessToken?: string): Promise<ChatResponse> {
  const request = ClientConnectionRequestSchema.parse(raw), { cfg, gate, router, ledger } = context, settings = cfg.client_connections;
  if (!settings.enabled || !settings.enabled_modes.includes("direct")) throw new ClientConnectionError(503, "connections_disabled", "Connections direct mode is disabled.");
  if (!clientConnectionTokenMatches(settings, accessToken)) throw new ClientConnectionError(401, "connection_token_required", "Send a valid Connections access token in the Authorization: Bearer header.");
  context.assertCurrent();
  if (signal.aborted) throw signal.reason;
  if (gate.projectIdentity || gate.ledger !== ledger || gate.projectDb !== gate.admission.db) throw new Error("Direct connections require the exact installation Gate and ledger");
  if (request.chat.max_tokens > settings.max_output_tokens) throw new ClientConnectionError(400, "output_limit_exceeded", "Requested output exceeds the Connections output token limit.");
  const chat = request.chat;
  const inputModalities: Array<"text" | "image"> = chat.messages.some(message => message.role === "user" && typeof message.content !== "string" && message.content.some(part => part.type === "image_url")) ? ["text", "image"] : ["text"];
  const plan = router.plan("direct", "T1", inputModalities, undefined, false, undefined, [], false, cfg);
  const needsTools = Boolean(chat.tools?.length || chat.messages.some(message => message.role === "tool" || (message.role === "assistant" && message.tool_calls?.length)));
  plan.candidates = plan.candidates.filter(endpoint => (!needsTools || endpoint.supportsTools === true) && (!chat.response_format || endpoint.supportsStructuredOutput === true));
  if (!plan.candidates.length) throw new AdmissionDenied("no_eligible_endpoint", "No configured route supports this request's required capabilities");
  plan.candidates = plan.candidates.filter(endpoint => routePreservesClientConstraints(gate.direct.providers.provider(endpoint.route.provider), endpoint, chat));
  if (!plan.candidates.length) throw new ClientConnectionError(400, "unsupported_request_constraints", "No configured route can preserve this tool choice or response format. Choose supported options or configure another route.");
  const validateResponse = clientResponseValidator(chat);
  const abort = new AbortController(), forward = () => abort.abort(signal.reason);
  signal.addEventListener("abort", forward, { once: true });
  if (signal.aborted) forward();
  const proof = createInstallationExecution(gate.admission, gate.admission.serverNow() + settings.request_timeout_seconds * 1000);
  const deadline = setTimeout(() => abort.abort(new ClientConnectionError(504, "request_timeout", "The client request exceeded its configured timeout.")), settings.request_timeout_seconds * 1000); deadline.unref();
  let completed = false, failed = false;
  try {
    ledger.register(proof, abort.signal, accessToken);
    const result = await gate.request({ plan, executionId: proof.executionId, installationExecution: proof, purpose: "client_connection", participants: [], chat, signal: abort.signal });
    if (abort.signal.aborted) throw abort.signal.reason;
    validateResponse(clientResponse(result.response));
    completed = true;
    return result.response;
  } catch (error) { failed = true; throw abort.signal.aborted ? abort.signal.reason ?? error : error; }
  finally {
    clearTimeout(deadline); signal.removeEventListener("abort", forward);
    ledger.unregister(proof); retireInstallationExecution(proof);
    try { gate.admission.finishExecution(proof.executionId, completed ? "completed" : abort.signal.aborted ? "cancelled" : "failed"); }
    catch (error) { if (!failed) throw error; }
    // Immutable receipts retain all attempts and uncertain exposure. No task, lease or
    // synthetic project exists for a background worker to replay.
  }
}
