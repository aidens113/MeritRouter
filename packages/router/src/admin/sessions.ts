import { scopedSessionTimeline, SESSION_SCOPE_UNAVAILABLE } from "./session-project-scope.js";
import type { MeritRouter } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import type { SessionEventsPage, SessionListFilter, SessionRecord } from "../sessions/store.js";
import type { CorruptLine, SessionEvent, SessionStatus } from "../sessions/events.js";

// Agent sessions for the panel, CLI, and MCP: list rows, and one session with its timeline.

export interface SessionView extends SessionRecord {
  /** The task's label, when the session belongs to a labelled task. */
  taskLabel: string | null;
  /** Wall-clock duration so far (to `endedAt`, else the last event). */
  durationMs: number;
  /**
   * `MeritRouter.resumeSession` would continue this session: it is `interrupted`, its task is
   * `interrupted`, and it is the task's latest agent session (not a classifier call).
   */
  resumable: boolean;
}

export interface SessionDetail extends Omit<SessionEventsPage, "sessionId"> {
  session: SessionView;
  timelineUnavailable: string | null;
  /** Sessions this session spawned (delegated work), oldest first. */
  children: SessionView[];
  /** Every session of the same task (retries and escalations), oldest first. */
  taskSessions: SessionView[];
}

function sessionViews(sy: MeritRouter, records: SessionRecord[]): SessionView[] {
  const tasks = new Map<string, { label: string | null; state: TaskState | null }>();
  const task = (taskId: string) => {
    if (!tasks.has(taskId)) {
      const t = sy.tasks.get(taskId);
      tasks.set(taskId, { label: t?.spec.label ?? null, state: t?.row.state ?? null });
    }
    return tasks.get(taskId)!;
  };
  const latest = new Map<string, string | null>();
  const latestAgentSession = (taskId: string) => {
    if (!latest.has(taskId)) latest.set(taskId, sy.sessions.forTask(taskId).filter((s) => s.role !== "classifier").at(-1)?.id ?? null);
    return latest.get(taskId)!;
  };
  return records.map((r) => ({
    ...r,
    taskLabel: r.taskId ? task(r.taskId).label : null,
    durationMs: Math.max(0, (r.endedAt ?? r.updatedAt) - r.createdAt),
    resumable: r.status === "interrupted" && r.taskId !== null && task(r.taskId).state === "interrupted" && latestAgentSession(r.taskId) === r.id,
  }));
}

/** A session list filter, optionally limited to one project's sessions. */
export interface SessionViewFilter extends SessionListFilter {
  project?: string;
}

/** Sessions matching the filter, newest first; `project` limits them to one project's (all projects when omitted). */
export function sessionsView(sy: MeritRouter, filter: SessionViewFilter = {}): SessionView[] {
  const { project, ...rest } = filter;
  if (!project) return sessionViews(sy, sy.sessions.list(rest));
  // The store has no project filter: read the newest sessions of the filter and keep this project's.
  const limit = Math.min(rest.limit ?? 100, 1000);
  const mine = new Set((sy.db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5000").all(project) as Array<{ id: string }>).map((r) => r.id));
  return sessionViews(sy, sy.sessions.list({ ...rest, limit: 1000 }).filter((r) => mine.has(r.id)).slice(0, limit));
}

/** One session with a page of its timeline (events after `afterSeq`), its children, and its task's other sessions. */
export function sessionDetail(sy: MeritRouter, id: string, opts: { afterSeq?: number; limit?: number; project?: string } = {}): SessionDetail | null {
  const owner = sy.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(id) as {project_id:string}|undefined;
  if (!owner || (opts.project !== undefined && owner.project_id !== opts.project)) return null;
  const project = owner.project_id;
  const rec = sy.sessions.get(id);
  if (!rec) return null;
  const events = scopedSessionTimeline(sy,id,project);
  const sameProject = (r: SessionRecord) => (sy.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(r.id) as {project_id:string}|undefined)?.project_id === project && (!r.taskId || (sy.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(r.taskId) as {project_id:string}|undefined)?.project_id === project);
  const taskInProject = (id: string | null) => id !== null && (sy.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(id) as {project_id:string}|undefined)?.project_id === project;
  const sessionInProject = (id: string | null) => id !== null && (sy.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(id) as {project_id:string}|undefined)?.project_id === project;
  const safeRecord = (r: SessionRecord, payload = false): SessionRecord => ({...r,
    taskId:taskInProject(r.taskId) ? r.taskId : null,
    parentSessionId:sessionInProject(r.parentSessionId) ? r.parentSessionId : null,
    previousSessionId:sessionInProject(r.previousSessionId) ? r.previousSessionId : null,
    jobId:taskInProject(r.jobId) ? r.jobId : null, logPath:"", workspace:payload ? r.workspace : null,
    stopReason:payload ? r.stopReason : null, agentLabel:payload ? r.agentLabel : r.role});
  const selected = events ? events.filter(e=>e.seq > (opts.afterSeq ?? 0)).slice(0,Math.max(1,Math.min(10_000,opts.limit ?? 1000))) : [];
  return {
    events:selected, corrupt:[], hasMore:events ? selected.length < events.filter(e=>e.seq > (opts.afterSeq ?? 0)).length : false, lastSeq:rec.lastSeq,
    timelineUnavailable:events ? null : SESSION_SCOPE_UNAVAILABLE,
    session:sessionViews(sy,[safeRecord(rec,events !== null)])[0]!,
    children:sessionViews(sy,sy.sessions.list({parentSessionId:id,limit:1000}).reverse().filter(sameProject).map(r=>safeRecord(r))),
    taskSessions:rec.taskId ? sessionViews(sy,sy.sessions.forTask(rec.taskId).filter(sameProject).map(r=>safeRecord(r))) : [],
  };
}

export type { SessionRecord, SessionListFilter, SessionEventsPage, SessionEvent, SessionStatus, CorruptLine };
