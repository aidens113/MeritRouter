import type { Switchyard } from "../core/service.js";
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
   * `Switchyard.resumeSession` would continue this session: it is `interrupted`, its task is
   * `interrupted`, and it is the task's latest agent session (not a classifier call).
   */
  resumable: boolean;
}

export interface SessionDetail extends Omit<SessionEventsPage, "sessionId"> {
  session: SessionView;
  /** Sessions this session spawned (delegated work), oldest first. */
  children: SessionView[];
  /** Every session of the same task (retries and escalations), oldest first. */
  taskSessions: SessionView[];
}

function sessionViews(sy: Switchyard, records: SessionRecord[]): SessionView[] {
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

/** Sessions matching the filter, newest first. */
export function sessionsView(sy: Switchyard, filter: SessionListFilter = {}): SessionView[] {
  return sessionViews(sy, sy.sessions.list(filter));
}

/** One session with a page of its timeline (events after `afterSeq`), its children, and its task's other sessions. */
export function sessionDetail(sy: Switchyard, id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionDetail | null {
  const page = sy.sessions.events(id, opts);
  const rec = sy.sessions.get(id);
  if (!page || !rec) return null;
  const { sessionId: _sessionId, ...rest } = page;
  const children = sy.sessions.list({ parentSessionId: id, limit: 1000 }).reverse();
  return {
    ...rest,
    session: sessionViews(sy, [rec])[0]!,
    children: sessionViews(sy, children),
    taskSessions: rec.taskId ? sessionViews(sy, sy.sessions.forTask(rec.taskId)) : [],
  };
}

export type { SessionRecord, SessionListFilter, SessionEventsPage, SessionEvent, SessionStatus, CorruptLine };
