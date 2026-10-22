import type { Db } from "../storage/db.js";

/**
 * A job's request pool (budget control D1 and D2): every worker task a supervisor delegates is
 * granted a request budget (`task_request_grants`), held from the job's budget while the task is
 * open; approved requests for more (`budget_requests`) add to the grant. What a finished task did
 * not use returns to the pool. Sub-supervisors' carves (`job_budget_carves`) are held the same
 * way (see `carvedRequests` in admission.ts); `heldRequests` there adds both.
 */

/** The budget a delegated worker task was granted. */
export interface TaskGrant {
  taskId: string;
  jobId: string;
  requests: number;
  /** supervisor: the brief's max_requests; default: team.default_task_requests or the tier's execution cap. */
  source: "supervisor" | "default";
  createdAt: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);

/** Record a grant; idempotent per task (a resumed supervisor records missing grants again). */
export function recordGrant(db: Db, g: Omit<TaskGrant, "createdAt">, now: number): void {
  db.prepare("INSERT OR IGNORE INTO task_request_grants (task_id, job_id, requests, source, created_at) VALUES (?, ?, ?, ?, ?)").run(g.taskId, g.jobId, g.requests, g.source, now);
}

export function grantOf(db: Db, taskId: string): TaskGrant | null {
  const r = db.prepare("SELECT * FROM task_request_grants WHERE task_id = ?").get(taskId) as { task_id: string; job_id: string; requests: number; source: TaskGrant["source"]; created_at: number } | undefined;
  return r ? { taskId: r.task_id, jobId: r.job_id, requests: r.requests, source: r.source, createdAt: r.created_at } : null;
}

export function grantsOf(db: Db, jobId: string): TaskGrant[] {
  const rows = db.prepare("SELECT * FROM task_request_grants WHERE job_id = ? ORDER BY created_at, task_id").all(jobId) as Array<{ task_id: string; job_id: string; requests: number; source: TaskGrant["source"]; created_at: number }>;
  return rows.map((r) => ({ taskId: r.task_id, jobId: r.job_id, requests: r.requests, source: r.source, createdAt: r.created_at }));
}

/** Requests granted to a task on top of its budget by approved requests for more. */
export function extraRequests(db: Db, taskId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(granted), 0) AS n FROM budget_requests WHERE task_id = ? AND status = 'approved'").get(taskId) as { n: number }).n;
}

function charged(db: Db, taskId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM request_charges WHERE task_id = ?").get(taskId) as { n: number }).n;
}

/**
 * What one granted task holds from its job's pool: while open, its grant plus approved extras
 * (or what it already used, when review and repair took it past that); once finished, what it
 * used, so the rest returns to the pool.
 */
export function taskHold(db: Db, g: Pick<TaskGrant, "taskId" | "requests">, state: string): number {
  const used = charged(db, g.taskId);
  return TERMINAL.has(state) ? used : Math.max(g.requests + extraRequests(db, g.taskId), used);
}

/** Requests a job's worker tasks hold from its pool (sub-supervisor carves not included). */
export function workerHeld(db: Db, jobId: string): number {
  const rows = db.prepare("SELECT g.task_id AS taskId, g.requests AS requests, t.state AS state FROM task_request_grants g JOIN tasks t ON t.id = g.task_id WHERE g.job_id = ?").all(jobId) as Array<{ taskId: string; requests: number; state: string }>;
  let total = 0;
  for (const r of rows) total += taskHold(db, r, r.state);
  return total;
}
