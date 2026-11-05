import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { effectiveBudget } from "../admission/admission.js";
import type { ResolvedConfig } from "../config/load.js";
import { maxAgentsPerJob } from "../config/schema.js";
import { AdmissionDenied } from "../core/errors.js";
import { WorkerTaskSchema, type WorkerTask } from "../core/task.js";
import type { Gate } from "../gateway/gate.js";
import { estimateTokens, type ChatResponse } from "../gateway/types.js";
import { ProviderSlotAdmission } from "../routing/claim-capacity.js";
import type { TaskRouter } from "../routing/router.js";
import { immediate } from "../storage/db.js";
import { ProjectFairnessDeferred, type ProjectFairCandidate } from "../storage/fair-claim.js";
import { ExecutionGrantCapacityError } from "../storage/project-execution-grants.js";
import { SqliteTaskLeases } from "../storage/sqlite-task-leases.js";
import type { SqliteProjectTaskQueue } from "../storage/sqlite-task-queue.js";
import { capturedLease, leaseOperationId, receiptApplied, reconcileLeaseOperation, type TaskLeases } from "../storage/task-leases.js";
import { syntheticResult, type StoredTask, type TaskStore } from "../storage/tasks.js";
import { projectLimits } from "../projects/schema.js";
import { ClientConnectionError, ClientConnectionRequestSchema, clientResponse, type ClientConnectionRequest } from "./protocol.js";
import { clientResponseValidator, routePreservesClientConstraints } from "./constraints.js";

/** Host capability only. A split runtime must supply its exact existing queue and lease port. */
export interface ClientConnectionContext {
  cfg: ResolvedConfig;
  tasks: TaskStore;
  gate: Gate;
  router: TaskRouter;
  taskLeases?: TaskLeases;
  queue?: SqliteProjectTaskQueue;
  readyProjects?: () => readonly ProjectFairCandidate[];
  assertCurrent(): void;
}

function claimLegacy(context: ClientConnectionContext, spec: WorkerTask, project: string, owner: string): StoredTask {
  const { cfg, tasks, gate, router } = context;
  return immediate(tasks.db, () => {
    context.assertCurrent();
    tasks.submit([spec], { project });
    tasks.db.prepare("UPDATE tasks SET purpose='client_connection' WHERE id=?").run(spec.id);
    const claimed = tasks.claim(owner, {
      maxConcurrent: cfg.execution.max_concurrent_tasks, maxWritersPerRepo: cfg.execution.max_concurrent_writers_per_repository,
      leaseMs: cfg.execution.lease_seconds * 1000, defaultTimeoutMs: cfg.execution.job_timeout_seconds * 1000,
      limit: 1, targetTaskId: spec.id,
      supervisorProfiles: Object.entries(cfg.profiles).filter(([, value]) => value?.mode === "supervisor").map(([key]) => key),
      maxSupervisors: cfg.supervisor.max_concurrent_jobs, maxAgentsPerJob: maxAgentsPerJob(cfg),
      providerSlots: new ProviderSlotAdmission(cfg, router, gate.health.capacity, () => tasks.serverNow()),
      projectLimits: slug => ({ priority: projectLimits(cfg, slug).priority, maxConcurrent: projectLimits(cfg, slug).max_concurrent_tasks }),
    });
    if (claimed.length !== 1 || claimed[0]!.row.id !== spec.id)
      throw new ClientConnectionError(429, "execution_capacity_unavailable", "Configured task or provider capacity is unavailable. Retry later.");
    return claimed[0]!;
  });
}

/** A real one-shot task/lease/execution, using the selected project's existing admission path. */
export async function dispatchClientConnection(context: ClientConnectionContext, raw: ClientConnectionRequest, signal: AbortSignal): Promise<ChatResponse> {
  const request = ClientConnectionRequestSchema.parse(raw), { cfg, tasks, gate, router } = context;
  const settings = cfg.client_connections;
  if (!settings.enabled || settings.project !== request.project || settings.profile !== request.profile)
    throw new ClientConnectionError(503, "connections_disabled", "Client connections are disabled or their selected project/profile changed.");
  context.assertCurrent();
  if (signal.aborted) throw signal.reason;
  if (gate.projectDb !== tasks.db || gate.admission.tasks !== tasks || (gate.projectIdentity && (!context.queue || context.queue.local.db !== tasks.db || context.taskLeases !== context.queue.taskLeases)))
    throw new Error("Client connection dispatch requires its exact project Gate, store and queue authority");
  if (context.queue && (context.queue.local.identity.slug !== request.project || gate.projectIdentity?.slug !== request.project))
    throw new Error("Client connection queue belongs to another project");
  const profile = cfg.profiles[request.profile];
  if (!profile || profile.mode !== "completion") throw new ClientConnectionError(400, "invalid_profile", "Select a configured completion profile for client connections.");
  const tokens = estimateTokens(request.chat.messages, request.chat.tools);
  if (profile.max_input_tokens !== undefined && tokens > profile.max_input_tokens)
    throw new ClientConnectionError(400, "context_limit_exceeded", "Messages exceed the selected profile's input token limit.");
  if (request.chat.max_tokens > settings.max_output_tokens)
    throw new ClientConnectionError(400, "output_limit_exceeded", "Requested output exceeds the Connections output token limit.");
  const chat = { ...request.chat, max_tokens: Math.min(request.chat.max_tokens, settings.max_output_tokens, profile.max_output_tokens) };
  const tier = profile.min_tier;
  const plan = router.plan(request.profile, tier, ["text"], undefined, false, undefined, [], false, cfg);
  const needsTools = Boolean(chat.tools?.length || chat.messages.some(message => message.role === "tool" || (message.role === "assistant" && message.tool_calls?.length)));
  plan.candidates = plan.candidates.filter(endpoint => (!needsTools || endpoint.supportsTools === true) && (!chat.response_format || endpoint.supportsStructuredOutput === true));
  if (!plan.candidates.length) throw new AdmissionDenied("no_eligible_endpoint", "No configured route supports this request's required capabilities");
  plan.candidates = plan.candidates.filter(endpoint => routePreservesClientConstraints(gate.direct.providers.provider(endpoint.route.provider), endpoint, chat));
  if (!plan.candidates.length) throw new ClientConnectionError(400, "unsupported_request_constraints", "No configured route can preserve this tool choice or response format. Choose supported options or configure another route.");
  const validateResponse = clientResponseValidator(chat);
  const spec = WorkerTaskSchema.parse({
    id: "tclient_" + randomUUID().replace(/-/g, ""), profile: request.profile,
    goal: "External client chat request", constraints: { acceptanceCriteria: ["Return the requested model response to the connected client."] },
    hints: { web: false }, routing: { tier },
    budget: { maxOutputTokens: chat.max_tokens, timeoutSeconds: Math.min(settings.request_timeout_seconds, cfg.execution.job_timeout_seconds) },
  });
  const owner = hostname() + ":" + process.pid + ":" + randomUUID().replace(/-/g, "").slice(0, 12);
  let task: StoredTask;
  try {
    task = context.queue ? context.queue.claimExternal(spec, owner, context.readyProjects?.() ?? []) : claimLegacy(context, spec, request.project, owner);
  } catch (error) {
    if (error instanceof ProjectFairnessDeferred || error instanceof ExecutionGrantCapacityError)
      throw new ClientConnectionError(429, "execution_capacity_unavailable", "Configured task capacity or another project's fair turn is active. Retry later.");
    throw error;
  }
  const lease = capturedLease(task), leases = context.taskLeases ?? new SqliteTaskLeases(cfg, tasks);
  const abort = new AbortController(), forward = () => abort.abort(signal.reason);
  signal.addEventListener("abort", forward, { once: true });
  if (signal.aborted) forward();
  const deadline = setTimeout(() => abort.abort(new ClientConnectionError(504, "request_timeout", "The client request exceeded its configured timeout.")),
    Math.min(settings.request_timeout_seconds, cfg.execution.job_timeout_seconds) * 1000);
  deadline.unref();
  let executionId: string | null = null, response: ChatResponse | null = null, servedEndpoint: string | null = null;
  let completed = false, requestFailed = false, requestError: unknown, renewal: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (abort.signal.aborted || completed) return;
      context.assertCurrent();
      const receipt = await leases.renew({ lease, operationId: leaseOperationId(tasks.serverNow()) });
      if (!receiptApplied(receipt)) throw new Error("Client connection task lease is no longer active");
    }).catch(error => { abort.abort(error); });
  }, Math.max(1000, Math.floor(cfg.execution.lease_seconds * 1000 / 3)));
  timer.unref();
  try {
    if (abort.signal.aborted) throw abort.signal.reason;
    context.assertCurrent();
    if (context.queue?.authorizeStart([task]) === "already_started") throw new Error("External client execution was already started");
    executionId = gate.admission.createExecution("task", request.profile, [{ taskId: lease.taskId, itemId: lease.taskId }]);
    const result = await gate.request({ plan, executionId, purpose: "client_connection",
      participants: [{ taskId: lease.taskId, leaseOwner: owner, lease, budget: effectiveBudget(cfg, spec, tier) }], chat, signal: abort.signal });
    response = result.response; servedEndpoint = result.endpoint.id;
    if (abort.signal.aborted) throw abort.signal.reason;
    validateResponse(clientResponse(response));
    completed = true;
    return response;
  } catch (error) {
    requestFailed = true; requestError = abort.signal.aborted ? abort.signal.reason ?? error : error; throw requestError;
  } finally {
    clearTimeout(deadline);
    clearInterval(timer);
    await renewal;
    signal.removeEventListener("abort", forward);
    const state = completed ? "completed" : abort.signal.aborted ? "cancelled" : "failed";
    const cleanupErrors: Array<{ stage: string; error: unknown }> = [];
    const cleanup = async (stage: string, work: () => unknown | Promise<unknown>) => {
      try { await work(); } catch (error) { cleanupErrors.push({ stage, error }); }
    };
    if (executionId) {
      await cleanup("execution_member", () => gate.admission.setMemberOutcome(executionId!, lease.taskId, state));
      await cleanup("execution_terminal", () => gate.admission.finishExecution(executionId!, state));
    }
    const result = syntheticResult(lease.taskId, state, "client_connection_" + state);
    await cleanup("task_usage", () => { result.usage.modelRequests = gate.admission.taskTotals(lease.taskId).requests; });
    result.usage = { ...result.usage, inputTokens: response?.usage.inputTokens ?? null, outputTokens: response?.usage.outputTokens ?? null,
      tokenUsageBasis: response?.usage.basis ?? "unknown", providerAttempts: response?.telemetry.providerAttempts ?? 0,
      providerAttemptsExact: response?.telemetry.providerAttemptsExact ?? false, reportedCostUsd: response?.usage.reportedCostUsd ?? null };
    if (servedEndpoint) result.servedEndpoints = [servedEndpoint];
    await cleanup("task_terminal", async () => {
      const input: Parameters<TaskLeases["finish"]>[0] = { lease, operationId: leaseOperationId(tasks.serverNow()), state, result };
      const receipt = await reconcileLeaseOperation(() => leases.finish(input));
      if (!receiptApplied(receipt)) throw new Error("Client connection terminal lease could not be recorded");
    });
    await cleanup("lease_drain", () => leases.drain());
    if (cleanupErrors.length) {
      try { tasks.event(lease.taskId, "client_connection_cleanup_failed", { stages: cleanupErrors.map(item => item.stage) }); } catch { /* Other cleanup attempts already ran. */ }
      if (!requestFailed) throw new AggregateError(cleanupErrors.map(item => item.error), "Client connection cleanup requires recovery");
      if (requestError instanceof Error) {
        try { Object.defineProperty(requestError, "cleanupErrors", { value: cleanupErrors, configurable: true }); } catch { /* Preserve the original request failure. */ }
      }
    }
  }
}
