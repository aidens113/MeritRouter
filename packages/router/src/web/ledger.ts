import type { Db } from "../storage/db.js";
import { nextUtcMidnight } from "../providers/limits.js";

/**
 * The record of agents' web requests (`web_requests`): one row per attempt on a backend, grouped
 * by `call_id` (one web_search or web_fetch tool call; a call that fails over to the next backend
 * has several attempts). The first attempt of a call is reserved inside one write transaction that
 * checks the per-task and per-day budgets, which count tool calls, so they hold across processes
 * sharing the store. Per-backend caps count attempts. A refused call is never recorded (nothing
 * was sent).
 */

export type WebRequestKind = "search" | "fetch";
export type WebRequestStatus = "pending" | "ok" | "error";

export interface WebRequestRow {
  id: number;
  callId: string;
  taskId: string | null;
  projectId: string;
  sessionId: string | null;
  kind: WebRequestKind;
  /** The backend this attempt went to (`builtin` for MeritRouter's own fetch). */
  backend: string;
  /** The backend key used (`vault:3`, `env:TAVILY_API_KEY`, ...); null when keyless. */
  keyRef: string | null;
  /** The query or the URL. */
  target: string;
  status: WebRequestStatus;
  /** How a failed attempt failed (rate_limited, auth_invalid, out_of_credits, server, ...). */
  errorKind: string | null;
  results: number | null;
  bytes: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: number;
  call_id: string;
  task_id: string | null;
  project_id: string;
  session_id: string | null;
  kind: WebRequestKind;
  backend: string;
  key_ref: string | null;
  target: string;
  status: WebRequestStatus;
  error_kind: string | null;
  results: number | null;
  bytes: number | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const toRow = (r: Row): WebRequestRow => ({
  id: r.id,
  callId: r.call_id,
  taskId: r.task_id,
  projectId: r.project_id,
  sessionId: r.session_id,
  kind: r.kind,
  backend: r.backend,
  keyRef: r.key_ref,
  target: r.target,
  status: r.status,
  errorKind: r.error_kind,
  results: r.results,
  bytes: r.bytes,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface WebBudget {
  perTask: number;
  perDay: number;
}

export interface AttemptInput {
  callId: string;
  taskId: string | null;
  sessionId: string | null;
  kind: WebRequestKind;
  backend: string;
  keyRef: string | null;
  target: string;
}

export type ReserveOutcome = { ok: true; id: number } | { ok: false; reason: string };

/** Start of the current UTC day. */
export function utcDayStart(now: number): number {
  return nextUtcMidnight(now) - 86_400_000;
}

/** Start of the current UTC month, and of the next one. */
export function utcMonth(now: number): { start: number; next: number } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), next: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

export class WebLedger {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Web tool calls a task made (each counts once, however many backends it tried). */
  taskCount(taskId: string): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT call_id) AS n FROM web_requests WHERE task_id = ?").get(taskId) as { n: number }).n;
  }

  /** Web tool calls made install-wide since the start of the current UTC day. */
  dayCount(): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT call_id) AS n FROM web_requests WHERE started_at >= ?").get(utcDayStart(this.now())) as { n: number }).n;
  }

  /** Attempts sent to one backend since `since` (every kind and outcome). */
  backendCount(backend: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM web_requests WHERE backend = ? AND started_at >= ?").get(backend, since) as { n: number }).n;
  }

  private insert(a: AttemptInput): number {
    return Number(
      this.db
        .prepare("INSERT INTO web_requests (call_id, task_id, session_id, kind, backend, key_ref, target, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(a.callId, a.taskId, a.sessionId, a.kind, a.backend, a.keyRef, a.target.slice(0, 2000), this.now()).lastInsertRowid,
    );
  }

  /**
   * The first attempt of a tool call: check both budgets and record it as pending, in one write
   * transaction so two processes cannot both take the last slot.
   */
  reserve(a: AttemptInput, budget: WebBudget): ReserveOutcome {
    return this.db.transaction((): ReserveOutcome => {
      if (a.taskId !== null) {
        const used = this.taskCount(a.taskId);
        if (used >= budget.perTask) return { ok: false, reason: `this task's web request budget is used up (${used} of web.max_requests_per_task ${budget.perTask}); continue with what you have` };
      }
      const today = this.dayCount();
      if (today >= budget.perDay) return { ok: false, reason: `the install's daily web request budget is used up (${today} of web.max_requests_per_day ${budget.perDay}; resets at 00:00 UTC); continue with what you have` };
      return { ok: true, id: this.insert(a) };
    }).immediate();
  }

  /** A further attempt of a call already reserved (the next backend after a failure). */
  attempt(a: AttemptInput): number {
    return this.insert(a);
  }

  settle(id: number, outcome: { ok: true; results?: number; bytes?: number } | { ok: false; error: string; errorKind: string }): void {
    if (outcome.ok) this.db.prepare("UPDATE web_requests SET status = 'ok', results = ?, bytes = ?, finished_at = ? WHERE id = ?").run(outcome.results ?? null, outcome.bytes ?? null, this.now(), id);
    else this.db.prepare("UPDATE web_requests SET status = 'error', error = ?, error_kind = ?, finished_at = ? WHERE id = ?").run(outcome.error.slice(0, 500), outcome.errorKind, this.now(), id);
  }

  /** A task's attempts, oldest first. */
  forTask(taskId: string): WebRequestRow[] {
    return (this.db.prepare("SELECT * FROM web_requests WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(toRow);
  }

  /** The latest attempts install-wide (optionally one project's), newest first. */
  recent(limit = 50, project?: string): WebRequestRow[] {
    const rows = project === undefined ? this.db.prepare("SELECT * FROM web_requests ORDER BY id DESC LIMIT ?").all(limit) : this.db.prepare("SELECT * FROM web_requests WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(project, limit);
    return (rows as Row[]).map(toRow);
  }
}
