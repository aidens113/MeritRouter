import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { TaskValidationError } from "../core/errors.js";
import type { SessionStore } from "../sessions/store.js";
import { immediate } from "./db.js";
import { canonicalJson, type StoredTask, type TaskStore } from "./tasks.js";
import { projectRuntimeActivationRoots } from "../workspaces/worktree.js";

export const LEGACY_MUTATION_LOCK_FAILURE = "internal_error: Repository mutation lock is busy; foreign or stale locks are preserved";
export const InfrastructureRecoverySchema = z.object({
  operationId: z.string().min(1).max(200), project: z.string().min(1).max(128),
  taskId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
  expectedDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedRunCount: z.number().int().positive(), expectedIncarnation: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  additionalSeconds: z.number().int().positive().max(604800).optional(),
}).strict();
export type InfrastructureRecoveryInput = z.input<typeof InfrastructureRecoverySchema>;
const EVENT = "infrastructure_failure_recovered";
const RecoveryReceiptSchema = z.object({ input: InfrastructureRecoverySchema, recoveredAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().positive(), claimEventId: z.number().int().positive(), claimAt: z.number().int().nonnegative(),
  reopenedSeq: z.number().int().positive(), previousStopReason: z.literal(LEGACY_MUTATION_LOCK_FAILURE) }).strict();

/** Verify retained memory without reopening a terminal log or applying its edits. */
export function infrastructureRecoveryMemory(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, task: StoredTask, sessionId: string) {
  const all = sessions.forTask(task.row.id), ids = new Set(all.map(session => session.id));
  const latest = all.filter(session => session.role !== "classifier" && !(session.parentSessionId && ids.has(session.parentSessionId))).at(-1);
  if (!latest || latest.id !== sessionId || latest.taskId !== task.row.id || latest.status !== "failed" || latest.stopReason !== LEGACY_MUTATION_LOCK_FAILURE || latest.profile !== task.spec.profile)
    throw new TaskValidationError("recovery requires the latest exact retained infrastructure-failed author session");
  const page = sessions.events(sessionId, { limit: 10000 });
  if (!page || page.hasMore || page.corrupt.length) throw new TaskValidationError("recovery log is missing, corrupt or exceeds the bounded proof window");
  const reopened = page.events.filter(event => event.type === "note" && event.data.text === "reopened").at(-1);
  const prior = reopened?.type === "note" ? z.object({ previousStatus: z.literal("interrupted"), previousStopReason: z.literal("user_paused") }).safeParse(reopened.data.data) : null;
  if (!reopened || !prior?.success) throw new TaskValidationError("recovery lacks a recorded user-paused session continuation");
  const suffix = page.events.filter(event => event.seq > reopened.seq);
  if (suffix.some(event => ["model_request", "model_response", "model_error", "tool_intent", "tool_outcome"].includes(event.type)))
    throw new TaskValidationError("recovery cannot reopen a run with model or tool dispatch evidence");
  const mode = cfg.profiles[task.spec.profile]?.mode;
  if (!mode || !["coding", "supervisor", "read_only"].includes(mode)) throw new TaskValidationError("recovery profile cannot resume");
  if (!latest.workspace?.repos.length || latest.workspace.repos.some(repo => !task.spec.repositoryAliases.includes(repo.alias) || !cfg.repositoryPaths[repo.alias]?.writable || !repo.baseCommit || !repo.head || !statSync(repo.worktree, { throwIfNoEntry: false })?.isDirectory()))
    throw new TaskValidationError("recovery workspace is missing or outside the retained assignment");
  const managedRoot = realpathSync(projectRuntimeActivationRoots(cfg).worktrees);
  for (const repo of latest.workspace.repos) {
    const relative = path.relative(managedRoot, realpathSync(repo.worktree));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new TaskValidationError("recovery workspace escapes the owning project's physical worktree root");
  }
  const plan = sessions.planResume(sessionId, { recoverEdits: cfg.sessions.recover_edits });
  if (!plan?.messages.length || plan.droppedRequestSeqs.length || plan.warnings.length || plan.actions.some(action => action.kind !== "reconcile_edits" || action.policy !== "commit"))
    throw new TaskValidationError("recovery memory has unresolved effects or unsupported reconciliation");
  const pending = sessions.pendingIntents(sessionId);
  if (!pending || pending.some(intent => !["edit", "read", "none"].includes(intent.sideEffect))) throw new TaskValidationError("recovery retains an unresolved external effect");
  return { session: latest, plan, reopenedSeq: reopened.seq, reopenedAt: reopened.at };
}

/** Trusted FINAL recovery for historical lock refusals misclassified as terminal failures. */
export function recoverInfrastructureFailure(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, raw: InfrastructureRecoveryInput) {
  const input = InfrastructureRecoverySchema.parse(raw);
  return immediate(tasks.db, () => {
    const task = tasks.get(input.taskId);
    if (!task || task.row.project_id !== input.project) throw new TaskValidationError("recovery task is missing or belongs to another project");
    const saved = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1")
      .get(input.taskId, EVENT, input.operationId) as { data_json: string } | undefined;
    if (saved) {
      const receipt = RecoveryReceiptSchema.parse(JSON.parse(saved.data_json));
      if (canonicalJson(receipt.input) !== canonicalJson(input)) throw new TaskValidationError("recovery replay changed its input");
      return { ...receipt, disposition: "replayed" as const };
    }
    const row = task.row;
    if (row.state !== "failed" || row.state_reason !== LEGACY_MUTATION_LOCK_FAILURE || row.cancel_requested || row.lease_owner !== null || row.lease_expires_at !== null)
      throw new TaskValidationError("recovery requires an ownerless historical repository-lock infrastructure failure");
    if (row.deadline_at !== input.expectedDeadlineAt || row.run_count !== input.expectedRunCount || row.lease_incarnation !== input.expectedIncarnation)
      throw new TaskValidationError("recovery deadline or attempt changed");
    const memory = infrastructureRecoveryMemory(tasks, sessions, cfg, task, input.sessionId);
    const claim = z.object({ id: z.number().int().positive(), ts: z.number().int().nonnegative(), data_json: z.string() }).parse(tasks.db.prepare("SELECT id,ts,data_json FROM events WHERE task_id=? AND type='claimed' ORDER BY id DESC LIMIT 1").get(input.taskId));
    if (z.object({ run: z.number().int().positive(), owner: z.string().min(1) }).parse(JSON.parse(claim.data_json)).run !== input.expectedRunCount)
      throw new TaskValidationError("recovery lacks its exact failed claim");
    if (memory.reopenedAt < claim.ts) throw new TaskValidationError("retained session was not reopened by this failed claim");
    const dispatched = tasks.db.prepare("SELECT 1 FROM request_charges c JOIN model_requests r ON r.id=c.request_id WHERE c.task_id=? AND ((c.run_count=? AND c.lease_incarnation=?) OR r.reserved_at>=?) UNION ALL SELECT 1 FROM model_requests r JOIN execution_members m ON m.execution_id=r.execution_id WHERE m.task_id=? AND r.reserved_at>=? LIMIT 1")
      .get(input.taskId, input.expectedRunCount, input.expectedIncarnation, claim.ts, input.taskId, claim.ts);
    if (dispatched) throw new TaskValidationError("recovery refused: current attempt has request accounting evidence");
    const now = tasks.serverNow();
    const limit = task.spec.budget?.timeoutSeconds ?? (cfg.profiles[task.spec.profile]?.mode === "supervisor" ? cfg.supervisor.job_timeout_seconds : cfg.execution.job_timeout_seconds);
    if (input.additionalSeconds !== undefined && input.additionalSeconds > limit) throw new TaskValidationError("recovery time grant exceeds the configured allowance");
    const deadlineAt = input.additionalSeconds === undefined ? input.expectedDeadlineAt : Math.max(now, input.expectedDeadlineAt) + input.additionalSeconds * 1000;
    if (deadlineAt <= now) throw new TaskValidationError("recovery deadline expired; an explicit bounded time grant is required");
    const receipt = RecoveryReceiptSchema.parse({ input, deadlineAt, recoveredAt: now, claimEventId: claim.id, claimAt: claim.ts, reopenedSeq: memory.reopenedSeq, previousStopReason: LEGACY_MUTATION_LOCK_FAILURE });
    const changed = tasks.db.prepare("UPDATE tasks SET state='queued',state_reason='resumed',result_json=NULL,finished_at=NULL,deadline_at=?,updated_at=? WHERE id=? AND project_id=? AND state='failed' AND deadline_at=? AND run_count=? AND lease_incarnation=? AND cancel_requested=0 AND lease_owner IS NULL AND lease_expires_at IS NULL")
      .run(deadlineAt, now, input.taskId, input.project, input.expectedDeadlineAt, input.expectedRunCount, input.expectedIncarnation);
    if (changed.changes !== 1) throw new TaskValidationError("recovery authority changed");
    tasks.event(input.taskId, EVENT, receipt);
    tasks.event(input.taskId, "resumed", { sessionId: input.sessionId, failedInfrastructureRecovery: true, infrastructureRecoveryOperationId: input.operationId });
    return { ...receipt, disposition: "fresh" as const };
  });
}

/** Rechecked after claim before a failed session may be cloned into its linked continuation. */
export function assertInfrastructureRecoveryReceipt(tasks: TaskStore, task: StoredTask, sessionId: string, operationId: string) {
  const raw = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1").get(task.row.id, EVENT, operationId) as { data_json: string } | undefined;
  if (!raw) throw new TaskValidationError("infrastructure recovery receipt is missing");
  const receipt = RecoveryReceiptSchema.parse(JSON.parse(raw.data_json));
  if (receipt.input.project !== task.row.project_id || receipt.input.taskId !== task.row.id || receipt.input.sessionId !== sessionId || receipt.input.expectedRunCount + 1 !== task.row.run_count || receipt.input.expectedIncarnation !== task.row.lease_incarnation || receipt.deadlineAt !== task.row.deadline_at)
    throw new TaskValidationError("infrastructure recovery receipt does not authorize this attempt");
}
