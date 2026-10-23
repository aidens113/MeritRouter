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
export const ResumeDirectiveSchema = z.object({ sessionId: z.string().min(1).optional(), freshWorkspace: z.boolean().optional() }).strict();
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
      return d.success ? d.data : {};
    }
  }
  return {};
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
  if (!store || !mode || !RESUMABLE_MODES.has(mode)) return null;
  const directive = resumeDirective(d.tasks, task.row.id);
  if (directive.freshWorkspace && mode === "coding" && !directive.sessionId) return null;
  const named = directive.sessionId ? store.get(directive.sessionId) : null;
  // A reviewer is never resumed: the run continues the author's session it reviewed (an
  // accepted submission then finishes without a request and verification runs again).
  const target = named ? authorOf(store, named) : (authorSessions(store, task.row.id).at(-1) ?? null);
  if (!target || target.taskId !== task.row.id || target.status !== "interrupted") return null;
  const plan = store.planResume(target.id, { recoverEdits: d.cfg.sessions.recover_edits });
  if (!plan || plan.messages.length === 0) return null; // nothing logged: start fresh
  const session = store.reopen(target.id);
  d.tasks.event(task.row.id, "session_resumed", { sessionId: target.id, actions: plan.actions.map((a) => a.kind), warnings: plan.warnings });
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
