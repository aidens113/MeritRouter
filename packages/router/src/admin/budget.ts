import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { BudgetRequests, jobPool, type BudgetRequest, type BudgetRequestStatus, type JobPool } from "../admission/budget-requests.js";
import { extraRequests, grantOf, grantsOf, taskHold } from "../admission/job-pool.js";
import { fanOutProjects, locateProjectTask, openProjectStores, projectScope, scopesFor, withAvailability, type RowsWithAvailability } from "./project-reads.js";
import type { ProjectRuntimeStore } from "../projects/runtime-store.js";

/**
 * Budget control for the panel, the CLI, and MCP (docs/working/budget-control.md): workers'
 * requests for more model requests, their decisions, and each job's request pool. `budget_requests`,
 * `task_request_grants` and `job_budget_carves` are project-private (`src/storage/store-role.ts`),
 * so every read here goes through the owning project's own store (`sy.projectStores(slug)`),
 * never `sy.db` directly.
 */

export interface BudgetRequestView extends BudgetRequest {
  /** The requesting task's label (or id). */
  label: string;
  /** The job's pool now (null for a top-level task). */
  pool: JobPool | null;
}

function cfgOf(sy: MeritRouter, taskId: string) {
  return sy.projectContext(sy.tasks.projectOf(taskId) ?? "");
}

function labelOf(stores: ProjectRuntimeStore, taskId: string): string {
  return stores.tasks.get(taskId)?.spec.label ?? taskId;
}

/**
 * Requests for more budget, newest first; `project` limits them to one project's (every
 * configured project plus unassigned ('') rows when omitted). A request charged to no project
 * ('', an installation-level task: probes, scans) lives on `sy.db`, like `locateRequest`'s '' case;
 * every other project's own rows come from that project's own store.
 */
export function budgetRequestsView(sy: MeritRouter, opts: { status?: BudgetRequestStatus; jobId?: string; taskId?: string; project?: string; limit?: number } = {}): RowsWithAvailability<BudgetRequestView> {
  const { project, ...filter } = opts;
  const pools = new Map<string, JobPool | null>();
  const rowsOf = (db: MeritRouter["db"], p: string, labelOfTask: (taskId: string) => string): BudgetRequestView[] =>
    new BudgetRequests(db).list({ ...filter, project: p }).map((r) => {
      let pool: JobPool | null = null;
      if (r.jobId) {
        if (!pools.has(r.jobId)) pools.set(r.jobId, jobPool(db, cfgOf(sy, r.jobId), r.jobId));
        pool = pools.get(r.jobId) ?? null;
      }
      return { ...r, label: labelOfTask(r.taskId), pool };
    });
  let rows: BudgetRequestView[];
  let unavailable: ReturnType<typeof fanOutProjects>["unavailable"];
  if (project === "") {
    rows = rowsOf(sy.db, "", (id) => sy.tasks.get(id)?.spec.label ?? id);
    unavailable = [];
  } else {
    const scopes = projectScope(sy, project, { qualification: true });
    const fan = fanOutProjects(sy, scopes, (stores, p) => rowsOf(stores.db, p, (id) => labelOf(stores, id)));
    rows = project === undefined ? [...fan.rows, ...rowsOf(sy.db, "", (id) => sy.tasks.get(id)?.spec.label ?? id)] : fan.rows;
    unavailable = fan.unavailable;
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
  return withAvailability(rows.sort((a, b) => b.id - a.id).slice(0, limit), unavailable);
}

/** Who decides from where: a person (CLI, panel) decides any request; an MCP client any but a person's. */
export type BudgetDecider = { kind: "human"; id: string } | { kind: "external"; id: string };

/**
 * Decide a pending request on behalf of a person or an external supervisor. With `project`,
 * another project's request is refused. Throws a MeritRouterError with the reason (pool too
 * small, already decided, task finished, a person's decision required).
 */
export function decideBudgetRequest(sy: MeritRouter, id: number, input: { approve: boolean; grant?: number | null; reason: string; by: BudgetDecider }, project?: string): BudgetRequest {
  // A request's numeric id is unique only within its own store. A request charged to no project
  // ('', an installation-level task: probes, scans) lives on `sy.db`, like `locateRequest`'s ''
  // case; every other project's own rows live in that project's own store, so the given project
  // (or every scope, trying `sy.db` last) is searched for the first store that holds this id.
  let found: { db: MeritRouter["db"]; req: BudgetRequest } | null = null;
  if (project !== "") {
    for (const p of scopesFor(sy, project)) {
      const opened = openProjectStores(sy, p);
      if (!opened.ok) continue;
      const req = new BudgetRequests(opened.stores.db).get(id);
      if (req) {
        found = { db: opened.stores.db, req };
        break;
      }
    }
  }
  if (!found && (project === undefined || project === "")) {
    const req = new BudgetRequests(sy.db).get(id);
    if (req && req.project === "") found = { db: sy.db, req };
  }
  if (!found || (project !== undefined && found.req.project !== project)) throw new MeritRouterError("not_found", `unknown budget request ${id}${project ? ` in project ${project}` : ""}`);
  const { db, req } = found;
  if (input.by.kind === "external" && req.approver === "human") throw new MeritRouterError("human_decision_required", `budget request ${id} is decided by a person (team.budget_approver: human): meritrouter budget approve|deny ${id}, or the panel`);
  if (!input.reason.trim()) throw new MeritRouterError("reason_required", "say why");
  return new BudgetRequests(db).decide(id, { approve: input.approve, grant: input.grant ?? null, by: `${input.by.kind}:${input.by.id}`, reason: input.reason, cfg: cfgOf(sy, req.taskId) });
}

export interface JobBudgetView {
  pool: JobPool;
  /** Each worker task's grant: what it was given, extra approvals, what it used, and what it holds now. */
  tasks: Array<{ taskId: string; label: string; state: string; granted: number; source: string; extra: number; used: number; held: number }>;
}

/** A job's pool and every task's grant (null when the task is not a supervisor job). */
export function jobBudget(sy: MeritRouter, jobId: string): JobBudgetView | null {
  const located = locateProjectTask(sy, jobId);
  if (!located) return null;
  const { stores } = located;
  const pool = jobPool(stores.db, cfgOf(sy, jobId), jobId);
  if (!pool) return null;
  const tasks = grantsOf(stores.db, jobId).map((g) => {
    const t = stores.tasks.get(g.taskId);
    const state = t?.row.state ?? "unknown";
    return { taskId: g.taskId, label: t?.spec.label ?? g.taskId, state, granted: g.requests, source: g.source, extra: extraRequests(stores.db, g.taskId), used: sy.admission.taskTotals(g.taskId).requests, held: taskHold(stores.db, g, state) };
  });
  return { pool, tasks };
}

/** A task's grant and extras (null when it was not delegated by a supervisor). */
export function taskBudget(sy: MeritRouter, taskId: string): { granted: number; source: string; extra: number; jobId: string } | null {
  const located = locateProjectTask(sy, taskId);
  if (!located) return null;
  const g = grantOf(located.stores.db, taskId);
  return g ? { granted: g.requests, source: g.source, extra: extraRequests(located.stores.db, taskId), jobId: g.jobId } : null;
}
