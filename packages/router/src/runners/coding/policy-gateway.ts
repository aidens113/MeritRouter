import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { AdmissionDenied, GatewayError } from "../../core/errors.js";
import type { ChatMessage, ChatTool, ChatToolCall, ContentPart } from "../../gateway/types.js";
import { ask, type RunContext } from "../types.js";

export interface PolicyGateway {
  baseUrl: string;
  token: string;
  /** Model id the agent must name; any other value is ignored anyway. */
  model: string;
  stats: { admitted: number; denied: number; lastDenial: string | null; lastServed: { endpointId: string; requestId: string } | null };
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  return content === null || content === undefined ? "" : JSON.stringify(content);
}

/** Normalize an OpenAI-compatible request body from an agent into our message shapes. */
export function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("messages must be an array");
  return raw.map((m: Record<string, unknown>) => {
    const role = m.role;
    if (role === "system" || role === "developer") return { role: "system", content: textOf(m.content) };
    if (role === "user") {
      if (Array.isArray(m.content)) {
        const parts: ContentPart[] = [];
        for (const p of m.content as Array<Record<string, unknown>>) {
          if (p.type === "text") parts.push({ type: "text", text: String(p.text ?? "") });
          else if (p.type === "image_url" && p.image_url) parts.push({ type: "image_url", image_url: { url: String((p.image_url as { url: unknown }).url) } });
        }
        return { role: "user", content: parts };
      }
      return { role: "user", content: textOf(m.content) };
    }
    if (role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as ChatToolCall[]) : undefined;
      return { role: "assistant", content: m.content === null ? null : textOf(m.content), ...(calls?.length ? { tool_calls: calls } : {}) };
    }
    if (role === "tool") return { role: "tool", tool_call_id: String(m.tool_call_id ?? ""), content: textOf(m.content) };
    throw new Error(`unsupported message role ${String(role)}`);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Job-scoped OpenAI-compatible endpoint for coding agents. Every model call the agent makes
 * (including titles, summaries, compaction, and its own retries) is admitted through the
 * task's gate, so request budgets and routing cannot be bypassed from inside the agent.
 */
export async function startPolicyGateway(
  ctx: RunContext,
  executionId: string,
  opts: {
    maxDenied: number;
    onStop: (reason: string) => void;
    /** Runs before each request is forwarded (commit the previous response's edits). */
    beforeRequest?: (lastServed: { endpointId: string; requestId: string } | null) => Promise<void>;
  },
): Promise<PolicyGateway> {
  const token = `sy-job-${randomBytes(24).toString("hex")}`;
  const tokenBuf = Buffer.from(token);
  const stats = { admitted: 0, denied: 0, lastDenial: null as string | null, lastServed: null as { endpointId: string; requestId: string } | null };
  let serial = Promise.resolve();
  let consecutiveDenied = 0;
  const model = "worker";
  const maxOutput = Math.min(ctx.profile.max_output_tokens, ctx.spec.budget?.maxOutputTokens ?? Infinity);

  const authorized = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
    return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!authorized(req)) return sendJson(res, 401, { error: { message: "invalid job token", type: "authentication_error" } });
      const url = (req.url ?? "").replace(/\?.*$/, "").replace(/\/+$/, "");
      if (req.method === "GET" && url.endsWith("/models")) {
        return sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "switchyard" }] });
      }
      if (req.method !== "POST" || !url.endsWith("/chat/completions")) return sendJson(res, 404, { error: { message: "not found" } });

      let body: Record<string, unknown>;
      let messages: ChatMessage[];
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        messages = normalizeMessages(body.messages);
      } catch (err) {
        return sendJson(res, 400, { error: { message: (err as Error).message, type: "invalid_request_error" } });
      }
      const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? maxOutput);
      const tools = Array.isArray(body.tools) ? (body.tools as ChatTool[]) : undefined;
      try {
        // Snapshots must not interleave: serialize the commit step across concurrent requests.
        const snap = serial.then(() => opts.beforeRequest?.(stats.lastServed));
        serial = snap.catch(() => undefined);
        await snap;
        const { response, endpoint, requestId } = await ask(ctx, {
          executionId,
          purpose: "runner",
          chat: {
            messages,
            max_tokens: Math.max(1, Math.min(Number.isFinite(requested) && requested > 0 ? requested : maxOutput, maxOutput)),
            ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
            ...(tools?.length ? { tools } : {}),
            ...(body.tool_choice === "auto" || body.tool_choice === "none" || body.tool_choice === "required" ? { tool_choice: body.tool_choice } : {}),
          },
        });
        stats.admitted++;
        stats.lastServed = { endpointId: endpoint.id, requestId };
        consecutiveDenied = 0;
        const created = Math.floor(Date.now() / 1000);
        const id = `chatcmpl-${randomBytes(8).toString("hex")}`;
        const usage = { prompt_tokens: response.usage.inputTokens ?? 0, completion_tokens: response.usage.outputTokens ?? 0, total_tokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0) };
        const finish = response.message.tool_calls?.length ? "tool_calls" : (response.finishReason ?? "stop");
        if (body.stream === true) {
          // Emulated stream: the full answer in one delta, then the finish chunk and [DONE].
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const delta: Record<string, unknown> = { role: "assistant", content: response.message.content ?? "" };
          if (response.message.tool_calls?.length) delta.tool_calls = response.message.tool_calls.map((c, index) => ({ index, ...c }));
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        return sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: response.message.content, ...(response.message.tool_calls?.length ? { tool_calls: response.message.tool_calls } : {}) }, finish_reason: finish }],
          usage,
        });
      } catch (err) {
        stats.denied++;
        consecutiveDenied++;
        stats.lastDenial = (err as Error).message;
        if (err instanceof AdmissionDenied) {
          if (["task_request_budget_exhausted", "task_token_budget_exhausted", "cancel_requested", "lease_lost", "deadline_exceeded", "task_not_active"].includes(err.reason)) {
            opts.onStop(err.reason);
          } else if (consecutiveDenied >= opts.maxDenied) opts.onStop(`denied ${consecutiveDenied} consecutive requests: ${err.reason}`);
          return sendJson(res, 429, { error: { message: err.message, type: "switchyard_denied", code: err.reason } });
        }
        if (consecutiveDenied >= opts.maxDenied) opts.onStop(`${consecutiveDenied} consecutive failed requests`);
        const ge = err instanceof GatewayError ? err : null;
        const status = ge?.kind === "rate_limited" || ge?.kind === "pool_exhausted" ? 429 : ge?.kind === "policy_violation" ? 502 : 503;
        if (ge?.kind === "policy_violation") opts.onStop("policy_violation");
        return sendJson(res, status, { error: { message: (err as Error).message, type: ge?.kind ?? "error" } }, ge?.retryAfterMs ? { "retry-after": String(Math.ceil(ge.retryAfterMs / 1000)) } : {});
      }
    })().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: (err as Error).message } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    model,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
