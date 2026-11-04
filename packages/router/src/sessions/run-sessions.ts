import { statSync } from "node:fs";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import type { TierName } from "../config/schema.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import type { RunOutcome } from "../runners/types.js";
import { agentLabel, roleForProfile } from "../roles/index.js";
import type { SessionRecord, SessionStore } from "./store.js";
import type { SessionRecorder } from "./recorder.js";
import type { SessionEndStatus } from "./events.js";
import type { ResumePlan } from "./resume.js";
import { assertInfrastructureRecoveryReceipt, infrastructureRecoveryMemory } from "../storage/task-infrastructure-recovery.js";
import { assertMaintenanceContinuation } from "../storage/task-deadline-continuation.js";
import { assertBlockedJobContinuation, blockedJobContinuationNote } from "../storage/blocked-job-continuation.js";
import { assertSupervisorBudgetContinuation, assertSupervisorBudgetContinuationSource, supervisorBudgetContinuationNote, SUPERVISOR_BUDGET_CONTINUED } from "../storage/supervisor-budget-continuation.js";

/**
 * The session lifecycle of a task's runs, as the executor drives it: open a run's session
 * (linked to the previous run and to the delegating session), choose an interrupted session to
 * resume, and end a session without letting a recording failure change the task's outcome.
 */

/** Task event written when a session delegates the task (see `MeritRouter.submitTasks`). */
export const DELEGATED_BY_SESSION = "delegated_by_session";
const DelegatedBySchema = z.object({ sessionId: z.string().min(1) });

/**
 * Data of the task event `resumed` (see `TaskStore.resume`): how the next run should start.
 * `sessionId` resumes that session; `freshWorkspace` starts a coding task over in a new
 * worktree (the operator's `resume <task>`). Without either, an interrupted latest session is
 * resumed when its role allows it.
 */
export const ResumeDirectiveSchema = z.object({ sessionId: z.string().min(1).optional(), freshWorkspace: z.boolean().optional(), failedObservationRecovery: z.literal(true).optional(), failedInfrastructureRecovery: z.literal(true).optional(), infrastructureRecoveryOperationId: z.string().min(1).max(200).optional(), blockedJobContinuation: z.literal(true).optional(), blockedJobOperationId: z.string().min(1).max(200).optional(), maintenanceContinuation: z.literal(true).optional(), maintenanceOperationId: z.string().min(1).max(200).optional(), supervisorBudgetContinuation: z.literal(true).optional(), supervisorBudgetOperationId: z.string().min(1).max(200).optional() }).strict()
  .refine(value => value.failedInfrastructureRecovery === undefined ? value.infrastructureRecoveryOperationId === undefined : !!value.sessionId && !!value.infrastructureRecoveryOperationId && value.failedObservationRecovery === undefined && value.blockedJobContinuation === undefined, "Infrastructure recovery requires its exact session and operation")
  .refine(value => value.blockedJobContinuation === undefined ? value.blockedJobOperationId === undefined : !!value.sessionId && !!value.blockedJobOperationId && value.freshWorkspace === undefined && value.failedObservationRecovery === undefined && value.failedInfrastructureRecovery === undefined, "Blocked job continuation requires its exact exclusive session and operation")
  .refine(value => value.maintenanceContinuation === undefined ? value.maintenanceOperationId === undefined : !!value.sessionId && !!value.maintenanceOperationId && value.freshWorkspace === undefined && value.failedObservationRecovery === undefined && value.failedInfrastructureRecovery === undefined && value.blockedJobContinuation === undefined && value.infrastructureRecoveryOperationId === undefined && value.blockedJobOperationId === undefined, "Maintenance continuation requires its exact exclusive session and operation")
  .refine(value => value.supervisorBudgetContinuation === undefined ? value.supervisorBudgetOperationId === undefined : !!value.sessionId && !!value.supervisorBudgetOperationId && value.freshWorkspace === undefined && value.failedObservationRecovery === undefined && value.failedInfrastructureRecovery === undefined && value.blockedJobContinuation === undefined && value.maintenanceContinuation === undefined && value.infrastructureRecoveryOperationId === undefined && value.blockedJobOperationId === undefined && value.maintenanceOperationId === undefined, "Supervisor budget continuation requires its exact exclusive session and operation");
export type ResumeDirective = z.infer<typeof ResumeDirectiveSchema>;

/** Profile modes whose runs continue an interrupted session (agent loops); the others re-run fresh. */
const RESUMABLE_MODES = new Set(["read_only", "coding", "supervisor"]);

/** What the run lifecycle reads: the session store (null runs without recording), tasks, and config. */
export interface RunSessionDeps {
  cfg: ResolvedConfig;
  tasks: TaskStore;
  sessions: SessionStore | null;
}

/** A session reopened to continue, with the plan its run follows. */
export interface RunResume {
  session: SessionRecorder;
  plan: ResumePlan;
}

/** A run's outcome state as a session end status: a spent budget is a failure with that reason. */
export function sessionEnd(state: RunOutcome["state"], stopReason: string): { status: SessionEndStatus; stopReason: string } {
  if (state === "budget_exhausted") return { status: "failed", stopReason: "budget_exhausted" };
  return { status: state, stopReason: stopReason || state };
}

/**
 * The task's own runs, oldest first: not its classifier sessions, and not the reviewer sessions
 * that are children of its runs (a reviewer's parent is a session of the same task).
 */
export function authorSessions(store: SessionStore, taskId: string): SessionRecord[] {
  const all = store.forTask(taskId);
  const ids = new Set(all.map((s) => s.id));
  return all.filter((s) => s.role !== "classifier" && !(s.parentSessionId && ids.has(s.parentSessionId)));
}

/** The author session a session belongs to: itself, or for a reviewer the run it reviewed. */
function authorOf(store: SessionStore, s: SessionRecord): SessionRecord | null {
  if (!s.taskId || !s.parentSessionId) return s;
  const parent = store.get(s.parentSessionId);
  return parent && parent.taskId === s.taskId ? parent : s;
}

/** The job a task belongs to: a supervise task is its own job; a delegated task belongs to its parent's. */
export function jobIdFor(task: StoredTask): string | null {
  return task.spec.profile === "supervise" ? task.row.id : (task.spec.parentTaskId ?? null);
}

/**
 * Open the session for one run of a task: a recovery re-run or an escalation links to the
 * task's previous run, and a delegated task to the session that delegated it.
 */
export function openRunSession(d: Pick<RunSessionDeps, "tasks" | "sessions">, task: StoredTask, plan: { tier: TierName }, previousSessionId?: string | null): SessionRecorder | null {
  const store = d.sessions;
  if (!store) return null;
  const id = task.row.id;
  const role = roleForProfile(task.spec.profile);
  const previous = previousSessionId !== undefined ? previousSessionId : (authorSessions(store, id).at(-1)?.id ?? null);
  const delegatedBy = d.tasks
    .events(id, 500)
    .filter((e) => e.type === DELEGATED_BY_SESSION)
    .map((e) => DelegatedBySchema.safeParse(e.data))
    .find((r) => r.success)?.data?.sessionId;
  return store.create({
    taskId: id,
    jobId: jobIdFor(task),
    parentSessionId: delegatedBy ?? null,
    previousSessionId: previous,
    role,
    agentLabel: agentLabel(role, task.spec.label ?? id),
    profile: task.spec.profile,
    tier: plan.tier,
  });
}

/** The directive of the `resumed` task event that queued the current run, if any. */
function resumeDirective(tasks: TaskStore, taskId: string): ResumeDirective {
  const events = tasks.events(taskId, 500);
  let claim = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "claimed") {
      claim = i;
      break;
    }
  }
  for (let i = claim - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "claimed") break;
    if (e.type === "resumed") {
      const d = ResumeDirectiveSchema.safeParse(e.data ?? {});
      if (!d.success && e.data && typeof e.data === "object" && (Object.hasOwn(e.data, "failedObservationRecovery") || Object.hasOwn(e.data, "failedInfrastructureRecovery") || Object.hasOwn(e.data, "infrastructureRecoveryOperationId") || Object.hasOwn(e.data, "blockedJobContinuation") || Object.hasOwn(e.data, "blockedJobOperationId") || Object.hasOwn(e.data, "maintenanceContinuation") || Object.hasOwn(e.data, "maintenanceOperationId") || Object.hasOwn(e.data, "supervisorBudgetContinuation") || Object.hasOwn(e.data, "supervisorBudgetOperationId"))) throw new Error("Continuation directive is malformed");
      return d.success ? d.data : {};
    }
  }
  return {};
}

/** Current explicit recoveries must retain their session instead of taking ordinary fresh fallback. */
export function assertExplicitResumeDirective(d: RunSessionDeps, task: StoredTask): boolean {
  const directive = resumeDirective(d.tasks, task.row.id);
  const row = d.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type='blocked_job_continued' AND json_extract(data_json,'$.input.expectedRunCount')=? ORDER BY id DESC LIMIT 1")
    .get(task.row.id, task.row.run_count - 1) as { data_json: string } | undefined;
  if (row) {
    const expected = z.object({ input: z.object({ sessionId: z.string(), operationId: z.string() }) }).parse(JSON.parse(row.data_json));
    if (!directive.blockedJobContinuation || directive.sessionId !== expected.input.sessionId || directive.blockedJobOperationId !== expected.input.operationId)
      throw new Error("Blocked job continuation receipt has a missing or changed resume directive");
  }
  if (directive.blockedJobContinuation) {
    if (!d.sessions || !directive.sessionId || !directive.blockedJobOperationId) throw new Error("Blocked continuation lost its exact session authority");
    assertBlockedJobContinuation(d.tasks, d.sessions, d.cfg, task, directive.sessionId, directive.blockedJobOperationId);
  }
  return directive.blockedJobContinuation === true || directive.failedInfrastructureRecovery === true || directive.failedObservationRecovery === true;
}

/** Fail closed before routing/classification can send any request; does not create a session. */
export function assertMaintenanceResumeDirective(d: RunSessionDeps, task: StoredTask): boolean {
  const directive = resumeDirective(d.tasks, task.row.id);
  // A missing/replaced directive must never fall through to ordinary resume after a time grant.
  const maintenanceGrant = d.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type='execution_time_continued' AND json_extract(data_json,'$.input.expectedRunCount')=? AND json_extract(data_json,'$.input.maintenance.cause')='operator_framework_maintenance' ORDER BY id DESC LIMIT 1")
    .get(task.row.id, task.row.run_count - 1) as { data_json: string } | undefined;
  if (maintenanceGrant) {
    const expected = z.object({ input: z.object({ sessionId: z.string(), operationId: z.string() }) }).parse(JSON.parse(maintenanceGrant.data_json));
    if (!directive.maintenanceContinuation || directive.maintenanceOperationId !== expected.input.operationId || directive.sessionId !== expected.input.sessionId) throw new Error("Maintenance continuation directive is missing or changed");
  }
  if (!directive.maintenanceContinuation) return false;
  if (!d.sessions || !directive.sessionId || !directive.maintenanceOperationId) throw new Error("Maintenance continuation lost its exact session authority");
  assertMaintenanceContinuation(d.tasks, d.sessions, task, directive.sessionId, directive.maintenanceOperationId);
  return true;
}

/** A missing or downgraded directive cannot turn the queued budget recovery into a fresh run. */
function supervisorBudgetDirective(d: RunSessionDeps, task: StoredTask): ResumeDirective | null {
  const directive = resumeDirective(d.tasks, task.row.id);
  const row = d.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? AND json_extract(data_json,'$.input.expectedRunCount')=? ORDER BY id DESC LIMIT 1")
    .get(task.row.id, SUPERVISOR_BUDGET_CONTINUED, task.row.run_count - 1) as { data_json: string } | undefined;
  if (row) {
    const expected = z.object({ input: z.object({ sessionId: z.string(), operationId: z.string() }) }).parse(JSON.parse(row.data_json));
    if (!directive.supervisorBudgetContinuation || directive.sessionId !== expected.input.sessionId || directive.supervisorBudgetOperationId !== expected.input.operationId) throw new Error("Supervisor budget continuation directive is missing or changed");
  }
  if (!directive.supervisorBudgetContinuation) return null;
  if (!d.sessions || !directive.sessionId || !directive.supervisorBudgetOperationId) throw new Error("Supervisor budget continuation lost its exact session authority");
  return directive;
}

/** Fail before routing/classification, and revalidate linked memory before runner effects. */
export async function assertSupervisorBudgetResumeDirective(d: RunSessionDeps, task: StoredTask, linkedSessionId?: string): Promise<boolean> {
  const directive = supervisorBudgetDirective(d, task);
  if (!directive) return false;
  await assertSupervisorBudgetContinuationSource(d.tasks, d.sessions!, d.cfg, task, directive.sessionId!, directive.supervisorBudgetOperationId!, linkedSessionId);
  // Git proof awaits must not allow a concurrently replaced directive to pass admission.
  const current = supervisorBudgetDirective(d, task);
  if (JSON.stringify(current) !== JSON.stringify(directive)) throw new Error("Supervisor budget continuation directive changed during source proof");
  return true;
}

/** Own a linked recorder until every initialization write succeeds and the executor receives it. */
function initializeLinkedResume(d: RunSessionDeps, task: StoredTask, target: SessionRecord, plan: ResumePlan,
  failureReason: string, initialize: (session: SessionRecorder) => void): RunResume {
  if (!d.sessions) throw new Error("Linked recovery requires its session store");
  const session = d.sessions.create({ taskId: target.taskId, jobId: target.jobId, parentSessionId: target.parentSessionId, previousSessionId: target.id, role: target.role, agentLabel: target.agentLabel, profile: target.profile, tier: target.tier });
  try {
    initialize(session);
    return { session, plan };
  } catch (error) {
    endRunSession(d.tasks, task, session, "failed", failureReason);
    throw error;
  }
}

/**
 * The resume rule: a run continues the task's latest session (or the one a directive names)
 * when that session is `interrupted` and the task's mode is an agent loop, unless the
 * operator asked a coding task to start over. The session is reopened and its plan returned;
 * null means a fresh run (linked to the previous session).
 */
export function resumeFor(d: RunSessionDeps, task: StoredTask): RunResume | null {
  const store = d.sessions;
  const mode = d.cfg.profiles[task.spec.profile]?.mode;
  const directive = resumeDirective(d.tasks, task.row.id);
  assertMaintenanceResumeDirective(d, task);
  assertExplicitResumeDirective(d, task);
  const budgetDirective = supervisorBudgetDirective(d, task);
  if (budgetDirective) {
    const { receipt, memory } = assertSupervisorBudgetContinuation(d.tasks, store!, d.cfg, task, budgetDirective.sessionId!, budgetDirective.supervisorBudgetOperationId!);
    const target = memory.session;
    return initializeLinkedResume(d, task, target, memory.plan, "supervisor_budget_continuation_recording_failed", session => {
      session.syncMessages(memory.plan.messages);
      session.setWorkspace(memory.workspace);
      session.note("supervisor_budget_continuation", supervisorBudgetContinuationNote(receipt));
      d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, previousSessionId: target.id, supervisorBudgetOperationId: budgetDirective.supervisorBudgetOperationId, actions: [] });
    });
  }
  if (directive.maintenanceContinuation) {
    if (!store || !directive.sessionId || !directive.maintenanceOperationId || !mode || !RESUMABLE_MODES.has(mode)) throw new Error("Maintenance continuation lost its exact session authority");
    const { receipt, memory } = assertMaintenanceContinuation(d.tasks, store, task, directive.sessionId, directive.maintenanceOperationId);
    const target = memory.session;
    return initializeLinkedResume(d, task, target, memory.plan, "maintenance_continuation_recording_failed", session => {
      session.syncMessages(memory.plan.messages);
      if (target.workspace) session.setWorkspace(target.workspace);
      session.note("operator_framework_maintenance", { operationId: receipt.input.operationId, previousSessionId: target.id, authorization: receipt.input.maintenance, previousStopReason: "shutdown" });
      d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, previousSessionId: target.id, maintenanceOperationId: directive.maintenanceOperationId, actions: [] });
    });
  }
  if (directive.blockedJobContinuation) {
    if (!store || !directive.sessionId || !directive.blockedJobOperationId) throw new Error("Blocked continuation lost its exact session authority");
    const { receipt, memory } = assertBlockedJobContinuation(d.tasks, store, d.cfg, task, directive.sessionId, directive.blockedJobOperationId);
    const target = memory.session;
    return initializeLinkedResume(d, task, target, memory.plan, "blocked_job_continuation_recording_failed", session => {
      session.syncMessages(memory.plan.messages);
      session.setWorkspace(memory.workspace);
      session.note("blocked_job_continuation", blockedJobContinuationNote(receipt));
      d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, previousSessionId: target.id, blockedJobOperationId: directive.blockedJobOperationId, actions: [] });
    });
  }
  if (directive.failedInfrastructureRecovery) {
    if (!store || !directive.sessionId || !directive.infrastructureRecoveryOperationId) throw new Error("Infrastructure recovery lost its retained session authority");
    assertInfrastructureRecoveryReceipt(d.tasks, task, directive.sessionId, directive.infrastructureRecoveryOperationId);
    const recovery = infrastructureRecoveryMemory(d.tasks, store, d.cfg, task, directive.sessionId);
    const target = recovery.session, plan = recovery.plan;
    return initializeLinkedResume(d, task, target, plan, "infrastructure_recovery_recording_failed", session => {
      session.syncMessages(plan.messages);
      session.setWorkspace(target.workspace!);
      session.note("infrastructure_failure_recovery", { previousSessionId: target.id, previousStopReason: target.stopReason, operationId: directive.infrastructureRecoveryOperationId });
      d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, previousSessionId: target.id, actions: plan.actions.map(action => action.kind), warnings: plan.warnings });
    });
  }
  if (directive.failedObservationRecovery && (!store || mode !== "supervisor" || !directive.sessionId)) throw new Error("Supervisor observation recovery lost its session authority");
  if (!store || !mode || !RESUMABLE_MODES.has(mode)) return null;
  if (directive.freshWorkspace && mode === "coding" && !directive.sessionId) return null;
  const named = directive.sessionId ? store.get(directive.sessionId) : null;
  // A reviewer is never resumed: the run continues the author's session it reviewed (an
  // accepted submission then finishes without a request and verification runs again).
  const target = named ? authorOf(store, named) : (authorSessions(store, task.row.id).at(-1) ?? null);
  const failedRecovery = directive.failedObservationRecovery === true;
  if (failedRecovery && (!named || !target || target.id !== directive.sessionId || target.taskId !== task.row.id || target.status !== "failed" || target.role !== "supervisor" || mode !== "supervisor" || target.stopReason !== "repeated_tool_call:task_result" || !target.workspace?.repos.length))
    throw new Error("Supervisor observation recovery lost its retained failed session");
  if (!failedRecovery && (!target || target.taskId !== task.row.id || target.status !== "interrupted")) return null;
  if (!target) return null;
  if (failedRecovery && store.events(target.id, { limit: 1 })?.corrupt.length) throw new Error("Supervisor observation recovery transcript is corrupt");
  if (failedRecovery && target.workspace!.repos.some(repo => !task.spec.repositoryAliases.includes(repo.alias) || !d.cfg.repositoryPaths[repo.alias]?.writable || !repo.baseCommit || !statSync(repo.worktree, { throwIfNoEntry: false })?.isDirectory())) throw new Error("Supervisor observation recovery workspace is unavailable");
  const plan = store.planResume(target.id, { recoverEdits: d.cfg.sessions.recover_edits });
  if (failedRecovery && plan?.actions.length) throw new Error("Supervisor observation recovery has unresolved effects");
  if (!plan || plan.messages.length === 0) {
    if (failedRecovery) throw new Error("Supervisor observation recovery transcript is missing");
    return null; // nothing logged: start fresh
  }
  if (failedRecovery) {
    return initializeLinkedResume(d, task, target, plan, "supervisor_observation_recovery_recording_failed", session => {
      session.syncMessages(plan.messages);
      session.setWorkspace(target.workspace!);
      session.resumed("Explicit continuation of a settled supervisor observation failure; no additional budget granted.", [], { notAppliedTools: plan.notAppliedTools });
      session.note("supervisor_observation_recovery", { previousSessionId: target.id, previousStopReason: target.stopReason });
      d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, previousSessionId: target.id, actions: plan.actions.map(a => a.kind), warnings: plan.warnings });
    });
  }
  const session = store.reopen(target.id);
  d.tasks.event(task.row.id, "session_resumed", { sessionId: session.id, actions: plan.actions.map((a) => a.kind), warnings: plan.warnings });
  return { session, plan };
}

/**
 * The tier of the run this one continues after an interruption: the resumed session's, or
 * the latest author session's when it ended `interrupted` (crash, shutdown, lease loss,
 * watchdog, capacity deferral). Null when the previous run ended otherwise or there is none.
 */
export function interruptedTier(store: SessionStore | null, task: StoredTask, resume: { session: SessionRecorder } | null): TierName | null {
  if (!store) return null;
  const last = resume ? store.get(resume.session.id) : (authorSessions(store, task.row.id).at(-1) ?? null);
  if (!last || (!resume && last.status !== "interrupted")) return null;
  return last.tier;
}

/** End a run's session. The task outcome is already decided, so a recording failure is logged, not thrown. */
export function endRunSession(tasks: TaskStore, task: StoredTask, session: SessionRecorder | null, status: SessionEndStatus, stopReason: string): void {
  if (!session || session.ended) return;
  try {
    session.end(status, stopReason);
  } catch (err) {
    tasks.event(task.row.id, "session_record_failed", { sessionId: session.id, error: (err as Error).message });
  }
}
