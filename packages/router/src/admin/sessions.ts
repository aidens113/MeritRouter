import { scopedSessionTimeline, SESSION_SCOPE_UNAVAILABLE } from "./session-project-scope.js";
import type { MeritRouter } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import type { SessionEventsPage, SessionListFilter, SessionRecord, SessionStore } from "../sessions/store.js";
import { SessionStatusSchema, type CorruptLine, type SessionEvent, type SessionStatus } from "../sessions/events.js";
import type { TaskStore } from "../storage/tasks.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";
import { fanOutProjects, locateSession, newestFirst, projectIdFilter, projectScope, withAvailability, type RowsWithAvailability } from "./project-reads.js";

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

/** The task/session reads `sessionViews` needs, scoped to one project's own store (never the installation store directly, so split layout's per-project isolation is respected). */
interface SessionViewContext {
  tasks: Pick<TaskStore, "get">;
  sessions: Pick<SessionStore, "get" | "list" | "forTask">;
}

/** `ctx` for a located project's own store, falling back to the installation service when there is none (an unowned '' row). */
function contextFor(sy: MeritRouter, stores: ProjectRuntimeStore | null): SessionViewContext {
  return stores ? { tasks: stores.tasks, sessions: stores.sessions ?? sy.sessions } : { tasks: sy.tasks, sessions: sy.sessions };
}

function sessionViews(ctx: SessionViewContext, records: SessionRecord[]): SessionView[] {
  const tasks = new Map<string, { label: string | null; state: TaskState | null }>();
  const task = (taskId: string) => {
    if (!tasks.has(taskId)) {
      const t = ctx.tasks.get(taskId);
      tasks.set(taskId, { label: t?.spec.label ?? null, state: t?.row.state ?? null });
    }
    return tasks.get(taskId)!;
  };
  const latest = new Map<string, string | null>();
  const latestAgentSession = (taskId: string) => {
    if (!latest.has(taskId)) latest.set(taskId, ctx.sessions.forTask(taskId).filter((s) => s.role !== "classifier").at(-1)?.id ?? null);
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

/** `filter`'s non-project fields, as a SQL fragment over a project's own `sessions` table (the `project_id` clause is added separately per project). Null when the filter can match nothing (an empty `status` array). */
function sessionFilterSql(filter: SessionListFilter): { sql: string; args: unknown[] } | null {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status !== undefined) {
    const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map((s) => SessionStatusSchema.parse(s));
    if (statuses.length === 0) return null;
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (filter.taskId !== undefined) (where.push("task_id = ?"), args.push(filter.taskId));
  if (filter.jobId !== undefined) (where.push("job_id = ?"), args.push(filter.jobId));
  if (filter.parentSessionId !== undefined) (where.push("parent_session_id = ?"), args.push(filter.parentSessionId));
  return { sql: where.join(" AND "), args };
}

/**
 * Sessions matching the filter, newest first; `project` limits them to one project's (all
 * projects when omitted, merged from each project's own store). Every project is read through
 * its own `sy.projectStores(slug)` handle, never the installation store directly (which is
 * refused for any read in split layout), so this works the same whether every project shares one
 * database (legacy) or each has its own (split). `unavailable` names projects whose store could
 * not be read.
 */
export function sessionsView(sy: MeritRouter, filter: SessionViewFilter = {}): RowsWithAvailability<SessionView> {
  const { project, ...rest } = filter;
  const limit = Math.max(1, Math.min(Math.floor(rest.limit ?? 100), 1000));
  const extra = sessionFilterSql(rest);
  if (!extra) return withAvailability([], []);
  const { rows, unavailable } = fanOutProjects(sy, projectScope(sy, project, { qualification: true }), (stores, slug) => {
    const f = projectIdFilter(sy, slug);
    const where = extra.sql ? `${f.sql} AND ${extra.sql}` : f.sql;
    const found = stores.db
      .prepare(`SELECT id, created_at FROM sessions WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...f.args, ...extra.args, limit) as Array<{ id: string; created_at: number }>;
    return found.map((r) => ({ ...r, stores }));
  });
  const merged = newestFirst(rows, (r) => r.created_at, limit);
  const located = merged.flatMap((r) => {
    const rec = (r.stores.sessions ?? sy.sessions).get(r.id);
    return rec ? [{ rec, stores: r.stores }] : [];
  });
  // Build each session's view with its own project's task/session lookups (split layout isolates
  // them from every other project's store), then put the views back in the merged, newest-first order.
  const groups = new Map<ProjectRuntimeStore, SessionRecord[]>();
  for (const { rec, stores } of located) groups.set(stores, [...(groups.get(stores) ?? []), rec]);
  const viewsById = new Map<string, SessionView>();
  for (const [stores, recs] of groups) for (const v of sessionViews(contextFor(sy, stores), recs)) viewsById.set(v.id, v);
  const views = located.map(({ rec }) => viewsById.get(rec.id)!);
  return withAvailability(views, unavailable);
}

/** One session with a page of its timeline (events after `afterSeq`), its children, and its task's other sessions. */
export function sessionDetail(sy: MeritRouter, id: string, opts: { afterSeq?: number; limit?: number; project?: string } = {}): SessionDetail | null {
  const located = locateSession(sy, id, opts.project);
  if (!located) return null;
  const { project, db, stores } = located;
  const ctx = contextFor(sy, stores);
  const rec = ctx.sessions.get(id);
  if (!rec) return null;
  const events = scopedSessionTimeline(sy,id,project);
  const sameProject = (r: SessionRecord) => (db.prepare("SELECT project_id FROM sessions WHERE id=?").get(r.id) as {project_id:string}|undefined)?.project_id === project && (!r.taskId || (db.prepare("SELECT project_id FROM tasks WHERE id=?").get(r.taskId) as {project_id:string}|undefined)?.project_id === project);
  const taskInProject = (id: string | null) => id !== null && (db.prepare("SELECT project_id FROM tasks WHERE id=?").get(id) as {project_id:string}|undefined)?.project_id === project;
  const sessionInProject = (id: string | null) => id !== null && (db.prepare("SELECT project_id FROM sessions WHERE id=?").get(id) as {project_id:string}|undefined)?.project_id === project;
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
    session:sessionViews(ctx,[safeRecord(rec,events !== null)])[0]!,
    children:sessionViews(ctx,ctx.sessions.list({parentSessionId:id,limit:1000}).reverse().filter(sameProject).map(r=>safeRecord(r))),
    taskSessions:rec.taskId ? sessionViews(ctx,ctx.sessions.forTask(rec.taskId).filter(sameProject).map(r=>safeRecord(r))) : [],
  };
}

export type { SessionRecord, SessionListFilter, SessionEventsPage, SessionEvent, SessionStatus, CorruptLine };
