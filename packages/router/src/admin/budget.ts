import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import { BudgetRequests, jobPool, type BudgetRequest, type BudgetRequestStatus, type JobPool } from "../admission/budget-requests.js";
import { extraRequests, grantOf, grantsOf, taskHold } from "../admission/job-pool.js";

/**
 * Budget control for the panel, the CLI, and MCP (docs/working/budget-control.md): workers'
 * requests for more model requests, their decisions, and each job's request pool.
 */

export interface BudgetRequestView extends BudgetRequest {
  /** The requesting task's label (or id). */
  label: string;
  /** The job's pool now (null for a top-level task). */
  pool: JobPool | null;
}

function cfgOf(sy: Switchyard, taskId: string) {
  return sy.projectContext(sy.tasks.projectOf(taskId) ?? "");
}

function labelOf(sy: Switchyard, taskId: string): string {
  return sy.tasks.get(taskId)?.spec.label ?? taskId;
}

/** Requests for more budget, newest first; `project` limits them to one project's. */
export function budgetRequestsView(sy: Switchyard, opts: { status?: BudgetRequestStatus; jobId?: string; taskId?: string; project?: string; limit?: number } = {}): BudgetRequestView[] {
  const pools = new Map<string, JobPool | null>();
  return new BudgetRequests(sy.db).list(opts).map((r) => {
    let pool: JobPool | null = null;
    if (r.jobId) {
      if (!pools.has(r.jobId)) pools.set(r.jobId, jobPool(sy.db, cfgOf(sy, r.jobId), r.jobId));
      pool = pools.get(r.jobId) ?? null;
    }
    return { ...r, label: labelOf(sy, r.taskId), pool };
  });
}

/** Who decides from where: a person (CLI, panel) decides any request; an MCP client any but a person's. */
export type BudgetDecider = { kind: "human"; id: string } | { kind: "external"; id: string };

/**
 * Decide a pending request on behalf of a person or an external supervisor. With `project`,
 * another project's request is refused. Throws a SwitchyardError with the reason (pool too
 * small, already decided, task finished, a person's decision required).
 */
export function decideBudgetRequest(sy: Switchyard, id: number, input: { approve: boolean; grant?: number | null; reason: string; by: BudgetDecider }, project?: string): BudgetRequest {
  const store = new BudgetRequests(sy.db);
  const req = store.get(id);
  if (!req || (project !== undefined && req.project !== "" && req.project !== project)) throw new SwitchyardError("not_found", `unknown budget request ${id}${project ? ` in project ${project}` : ""}`);
  if (input.by.kind === "external" && req.approver === "human") throw new SwitchyardError("human_decision_required", `budget request ${id} is decided by a person (team.budget_approver: human): switchyard budget approve|deny ${id}, or the panel`);
  if (!input.reason.trim()) throw new SwitchyardError("reason_required", "say why");
  return store.decide(id, { approve: input.approve, grant: input.grant ?? null, by: `${input.by.kind}:${input.by.id}`, reason: input.reason, cfg: cfgOf(sy, req.taskId) });
}

export interface JobBudgetView {
  pool: JobPool;
  /** Each worker task's grant: what it was given, extra approvals, what it used, and what it holds now. */
  tasks: Array<{ taskId: string; label: string; state: string; granted: number; source: string; extra: number; used: number; held: number }>;
}

/** A job's pool and every task's grant (null when the task is not a supervisor job). */
export function jobBudget(sy: Switchyard, jobId: string): JobBudgetView | null {
  const pool = jobPool(sy.db, cfgOf(sy, jobId), jobId);
  if (!pool) return null;
  const tasks = grantsOf(sy.db, jobId).map((g) => {
    const t = sy.tasks.get(g.taskId);
    const state = t?.row.state ?? "unknown";
    return { taskId: g.taskId, label: t?.spec.label ?? g.taskId, state, granted: g.requests, source: g.source, extra: extraRequests(sy.db, g.taskId), used: sy.admission.taskTotals(g.taskId).requests, held: taskHold(sy.db, g, state) };
  });
  return { pool, tasks };
}

/** A task's grant and extras (null when it was not delegated by a supervisor). */
export function taskBudget(sy: Switchyard, taskId: string): { granted: number; source: string; extra: number; jobId: string } | null {
  const g = grantOf(sy.db, taskId);
  return g ? { granted: g.requests, source: g.source, extra: extraRequests(sy.db, taskId), jobId: g.jobId } : null;
}
