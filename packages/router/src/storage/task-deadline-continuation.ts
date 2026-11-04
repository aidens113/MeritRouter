import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { LeaseReceiptSchema } from "./task-leases.js";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { TaskValidationError } from "../core/errors.js";
import { authorSessions } from "../sessions/run-sessions.js";
import { PROCESS_DIED, type SessionStore } from "../sessions/store.js";
import { immediate } from "./db.js";
import { canonicalJson, type TaskStore, type StoredTask } from "./tasks.js";

const MaintenanceAuthorizationSchema = z.object({
  cause: z.literal("operator_framework_maintenance"),
  timeoutProvenance: z.literal("configured_default"),
  authorizationReference: z.string().trim().min(1).max(2000),
  noUserHardDeadline: z.literal(true),
}).strict();
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const MaintenanceProofSchema = z.object({
  taskSpecDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  interruptionReceipt: LeaseReceiptSchema,
}).strict();
/** Trusted FINAL control operation; deliberately absent from runtime model tools. */
export const DeadlineContinuationSchema = z.object({
  operationId: z.string().min(1).max(200),
  project: z.string().min(1).max(128),
  taskId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  expectedDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedRunCount: z.number().int().positive(),
  expectedIncarnation: z.string().min(1).max(200),
  additionalSeconds: z.number().int().positive().max(604800),
  reason: z.string().trim().min(1).max(2000),
  maintenance: MaintenanceAuthorizationSchema.optional(),
}).strict();
export type DeadlineContinuationInput = z.input<typeof DeadlineContinuationSchema>;
const ReceiptSchema = z.object({
  input: DeadlineContinuationSchema,
  previousDeadlineAt: z.number().int().positive(),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  grantedAt: z.number().int().nonnegative(),
  maintenanceProof: MaintenanceProofSchema.optional(),
}).strict().refine(receipt => !!receipt.input.maintenance === !!receipt.maintenanceProof && receipt.previousDeadlineAt === receipt.input.expectedDeadlineAt && receipt.deadlineAt === Math.max(receipt.grantedAt, receipt.previousDeadlineAt) + receipt.input.additionalSeconds * 1000, "continuation receipt proof or deadline differs from its grant");
const EVENT = "execution_time_continued";

export function continueTaskDeadline(tasks: TaskStore, sessions: SessionStore, cfg: ResolvedConfig, raw: DeadlineContinuationInput) {
  const input = DeadlineContinuationSchema.parse(raw);
  return immediate(tasks.db, () => {
    const task = tasks.get(input.taskId);
    if (!task || task.row.project_id !== input.project) throw new TaskValidationError("continuation task is missing or belongs to another project");
    const stored = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1")
      .get(input.taskId, EVENT, input.operationId) as { data_json: string } | undefined;
    if (stored) {
      const receipt = ReceiptSchema.parse(JSON.parse(stored.data_json));
      if (canonicalJson(receipt.input) !== canonicalJson(input)) throw new TaskValidationError("continuation operation replay changed its input");
      return { ...receipt, disposition: "replayed" as const };
    }
    const previous = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.sessionId')=? AND json_extract(data_json,'$.input.expectedRunCount')=? AND json_extract(data_json,'$.input.expectedIncarnation')=? LIMIT 1")
      .get(input.taskId, EVENT, input.sessionId, input.expectedRunCount, input.expectedIncarnation) as { data_json: string } | undefined;
    if (previous) {
      ReceiptSchema.parse(JSON.parse(previous.data_json));
      throw new TaskValidationError("this interrupted session attempt already received execution time");
    }
    const row = task.row;
    if (row.cancel_requested || row.lease_owner !== null || row.lease_expires_at !== null ||
        !(row.state === "interrupted" || (row.state === "queued" && row.state_reason === "resumed")))
      throw new TaskValidationError("continuation requires recovered interrupted or resumed work without an owner");
    if (row.deadline_at !== input.expectedDeadlineAt || row.run_count !== input.expectedRunCount || row.lease_incarnation !== input.expectedIncarnation)
      throw new TaskValidationError("continuation deadline or attempt changed");
    const session = authorSessions(sessions, input.taskId).at(-1);
    if (!session || session.id !== input.sessionId || session.taskId !== input.taskId || session.status !== "interrupted" ||
        !(input.maintenance ? session.stopReason === "shutdown" : ["user_paused", PROCESS_DIED].includes(session.stopReason ?? "")) || session.profile !== task.spec.profile)
      throw new TaskValidationError("continuation requires the latest exact paused or recovered process-death author session");
    let maintenanceProof: z.infer<typeof MaintenanceProofSchema> | undefined;
    if (input.maintenance) {
      if (row.state !== "interrupted" || row.state_reason !== "worker shut down" || task.spec.budget?.timeoutSeconds !== undefined)
        throw new TaskValidationError("maintenance continuation requires genuine shutdown with a configured default timeout");
      maintenanceQuiescent(tasks, task);
      const memory = maintenanceMemory(tasks, sessions, task, input.sessionId);
      // Durable exact lease acknowledgement binds shutdown to this generation, not just an editable status label.
      const receipts = tasks.db.prepare("SELECT response_json FROM task_lease_operations WHERE kind='interrupt' AND json_extract(response_json,'$.lease.taskId')=? ORDER BY created_at DESC LIMIT 100")
        .all(input.taskId) as Array<{ response_json: string }>;
      const interruptionReceipt = receipts.map(raw => LeaseReceiptSchema.parse(JSON.parse(raw.response_json))).find(receipt => receipt.original === "applied" && receipt.state === "interrupted" && receipt.lease?.project === input.project && receipt.lease.runCount === input.expectedRunCount && receipt.lease.incarnation === input.expectedIncarnation);
      if (!interruptionReceipt) throw new TaskValidationError("maintenance shutdown lacks its exact durable interruption receipt");
      maintenanceProof = MaintenanceProofSchema.parse({ taskSpecDigest: digest(task.spec), sessionDigest: memory.sessionDigest, interruptionReceipt });
    }
    const mode = cfg.profiles[task.spec.profile]?.mode;
    if (!mode || !["coding", "supervisor", "read_only"].includes(mode)) throw new TaskValidationError("continuation profile cannot resume a session");
    const limit = task.spec.budget?.timeoutSeconds ?? (mode === "supervisor" ? cfg.supervisor.job_timeout_seconds : cfg.execution.job_timeout_seconds);
    if (input.additionalSeconds > limit) throw new TaskValidationError("continuation exceeds the configured task execution allowance");
    const now = tasks.serverNow(), deadlineAt = Math.max(now, input.expectedDeadlineAt) + input.additionalSeconds * 1000;
    const receipt = ReceiptSchema.parse({ input, previousDeadlineAt: input.expectedDeadlineAt, deadlineAt, grantedAt: now, ...(maintenanceProof ? { maintenanceProof } : {}) });
    const changed = tasks.db.prepare("UPDATE tasks SET deadline_at=?,state='queued',state_reason='resumed',result_json=NULL,updated_at=? WHERE id=? AND project_id=? AND deadline_at=? AND run_count=? AND lease_incarnation=? AND lease_owner IS NULL AND lease_expires_at IS NULL AND cancel_requested=0")
      .run(deadlineAt, now, input.taskId, input.project, input.expectedDeadlineAt, input.expectedRunCount, input.expectedIncarnation);
    if (changed.changes !== 1) throw new TaskValidationError("continuation authority changed");
    tasks.event(input.taskId, EVENT, receipt);
    tasks.event(input.taskId, "resumed", { sessionId: input.sessionId, ...(input.maintenance ? { maintenanceContinuation: true, maintenanceOperationId: input.operationId } : {}) });
    return { ...receipt, disposition: "fresh" as const };
  });
}

/** Reject concurrent effects over the retained same-project subtree without reconciling history. */
function maintenanceQuiescent(tasks: TaskStore, task: StoredTask, claimed = false): void {
  const rows = tasks.db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE id=? AND project_id=? UNION
    SELECT t.id FROM tasks t JOIN tree p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?)
    SELECT id FROM tree LIMIT 5001`).all(task.row.id, task.row.project_id, task.row.project_id) as Array<{ id: string }>;
  if (rows.length > 5000) throw new TaskValidationError("maintenance subtree exceeds bounded proof");
  for (const raw of rows) {
    const id = z.object({ id: z.string().min(1) }).parse(raw).id, child = tasks.get(id)!;
    if (!(claimed && id === task.row.id) && (child.row.lease_owner !== null || child.row.lease_expires_at !== null)) throw new TaskValidationError("maintenance task subtree still has an owner");
    if (tasks.db.prepare("SELECT 1 FROM sessions WHERE task_id=? AND status='running' LIMIT 1").get(id)) throw new TaskValidationError("maintenance task subtree has active sessions");
    if (tasks.db.prepare("SELECT 1 FROM model_requests r JOIN request_charges c ON c.request_id=r.id WHERE c.task_id=? AND r.status='reserved' LIMIT 1").get(id)) throw new TaskValidationError("maintenance task subtree has an active model request");
    // Split broker persists local preparation/participant holds BEFORE any physical global reservation.
    // Bound requests can therefore be blocked here even before model_requests projections exist.
    if (tasks.db.prepare("SELECT 1 FROM project_request_holds h JOIN project_request_protocol p ON p.request_id=h.request_id WHERE h.task_id=? AND (h.active=1 OR p.phase NOT IN ('settled','retired')) LIMIT 1").get(id)) throw new TaskValidationError("maintenance task subtree has unresolved split request authority");
    if (tasks.db.prepare("SELECT 1 FROM merge_queue WHERE (job_id=? OR task_id=?) AND state IN ('queued','integrating','picked') LIMIT 1").get(id, id)) throw new TaskValidationError("maintenance task subtree has active integration");
    const actions = tasks.db.prepare("SELECT id,project_id,task_id,value_json FROM worker_action_requests WHERE task_id=? LIMIT 5001").all(id);
    if (actions.length > 5000) throw new TaskValidationError("maintenance command history exceeds bounded proof");
    for (const rawAction of actions) {
      const row = z.object({ id: z.string(), project_id: z.string(), task_id: z.string(), value_json: z.string().max(100000) }).parse(rawAction);
      const action = z.object({ id: z.string(), project: z.string(), taskId: z.string(), status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]), quiescedAt: z.number().int().positive().optional() }).passthrough().parse(JSON.parse(row.value_json));
      if (row.project_id !== task.row.project_id || action.project !== row.project_id || action.taskId !== id || action.id !== row.id) throw new TaskValidationError("maintenance action scope changed");
      if (["completed", "denied", "cancelled"].includes(action.status)) continue;
      if (action.status === "uncertain" && action.quiescedAt !== undefined) continue;
      throw new TaskValidationError("maintenance task subtree has active or unresolved command actions");
    }
  }
}

function maintenanceMemory(tasks: TaskStore, sessions: SessionStore, task: StoredTask, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.taskId !== task.row.id || session.status !== "interrupted" || session.stopReason !== "shutdown" || session.profile !== task.spec.profile || authorSessions(sessions, task.row.id).at(-1)?.id !== sessionId)
    throw new TaskValidationError("maintenance retained shutdown session changed");
  const scope = z.object({ project_id: z.string() }).parse(tasks.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(sessionId));
  if (scope.project_id !== task.row.project_id || statSync(session.logPath).size > 32 * 1024 * 1024) throw new TaskValidationError("maintenance session scope or log bound changed");
  const page = sessions.events(sessionId, { limit: 10000 }), ended = page?.events.at(-1);
  if (!page || page.corrupt.length || page.hasMore || ended?.type !== "ended" || ended.data.status !== "interrupted" || ended.data.stopReason !== "shutdown") throw new TaskValidationError("maintenance shutdown log is incomplete or changed");
  const plan = sessions.planResume(sessionId);
  if (!plan?.messages.length || plan.actions.length || plan.warnings.length || plan.droppedRequestSeqs.length || sessions.pendingIntents(sessionId)?.length) throw new TaskValidationError("maintenance retained session has unresolved effects or missing memory");
  if (canonicalJson(session.workspace) !== canonicalJson(plan.workspace)) throw new TaskValidationError("maintenance workspace row differs from its retained log");
  return { session, plan, sessionDigest: digest({ session, events: page.events }) };
}

/** Exact grant gate before any resumed author session or provider request is opened. */
export function assertMaintenanceContinuation(tasks: TaskStore, sessions: SessionStore, task: StoredTask, sessionId: string, operationId: string) {
  const current = tasks.get(task.row.id);
  if (!current || current.row.lease_owner !== task.row.lease_owner || current.row.run_count !== task.row.run_count || current.row.lease_incarnation !== task.row.lease_incarnation || current.row.deadline_at !== task.row.deadline_at || current.row.cancel_requested || current.row.state !== "running") throw new TaskValidationError("maintenance claimed authority changed");
  const raw = tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.operationId')=? ORDER BY id LIMIT 1").get(task.row.id, EVENT, operationId) as { data_json: string } | undefined;
  if (!raw) throw new TaskValidationError("maintenance continuation receipt is missing");
  const receipt = ReceiptSchema.parse(JSON.parse(raw.data_json)), proof = receipt.maintenanceProof;
  if (!receipt.input.maintenance || !proof || receipt.input.project !== task.row.project_id || receipt.input.taskId !== task.row.id || receipt.input.sessionId !== sessionId || receipt.input.expectedRunCount + 1 !== task.row.run_count || receipt.input.expectedIncarnation !== task.row.lease_incarnation || receipt.deadlineAt !== task.row.deadline_at || proof.taskSpecDigest !== digest(current.spec) || current.spec.budget?.timeoutSeconds !== undefined || task.row.state !== "running" || task.row.cancel_requested || !task.row.lease_owner || (task.row.lease_expires_at ?? 0) <= tasks.serverNow() || receipt.deadlineAt <= tasks.serverNow())
    throw new TaskValidationError("maintenance receipt does not authorize this claimed attempt");
  const lease = proof.interruptionReceipt.lease;
  if (proof.interruptionReceipt.kind !== "interrupt" || proof.interruptionReceipt.original !== "applied" || proof.interruptionReceipt.state !== "interrupted" || lease?.taskId !== task.row.id || lease.project !== task.row.project_id || lease.runCount !== receipt.input.expectedRunCount || lease.incarnation !== receipt.input.expectedIncarnation) throw new TaskValidationError("maintenance interruption proof changed");
  maintenanceQuiescent(tasks, current, true);
  const memory = maintenanceMemory(tasks, sessions, current, sessionId);
  if (memory.sessionDigest !== proof.sessionDigest) throw new TaskValidationError("maintenance retained memory changed after grant");
  return { receipt, memory };
}
