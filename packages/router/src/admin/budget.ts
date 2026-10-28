import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { BudgetRequests, jobPool, type BudgetRequest, type BudgetRequestStatus, type JobPool } from "../admission/budget-requests.js";
import { extraRequests, grantOf, grantsOf, taskHold } from "../admission/job-pool.js";
import { admissionOf, fanOutProjects, legacyStores, locateProjectTask, openProjectStores, projectScope, scopesFor, withAvailability, type RowsWithAvailability } from "./project-reads.js";
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

/** The context of the project owning `taskId` in `project`'s store ('' is the installation store's own unattributed rows). */
function cfgOf(sy: MeritRouter, taskId: string, project: string) {
  if (!project) return sy.projectContext(legacyStores(sy)?.tasks.projectOf(taskId) ?? "");
  return sy.projectContext(locateProjectTask(sy, taskId, project)?.project ?? project);
}

/** A label for an unattributed ('') row: only a legacy installation's own store holds any. */
const legacyLabel = (sy: MeritRouter) => (id: string) => legacyStores(sy)?.tasks.get(id)?.spec.label ?? id;

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
        if (!pools.has(r.jobId)) pools.set(r.jobId, jobPool(db, cfgOf(sy, r.jobId, p), r.jobId));
        pool = pools.get(r.jobId) ?? null;
      }
      return { ...r, label: labelOfTask(r.taskId), pool };
    });
  let rows: BudgetRequestView[];
  let unavailable: ReturnType<typeof fanOutProjects>["unavailable"];
  if (project === "") {
    rows = rowsOf(sy.db, "", legacyLabel(sy));
    unavailable = [];
  } else {
    const scopes = projectScope(sy, project, { qualification: true });
    const fan = fanOutProjects(sy, scopes, (stores, p) => rowsOf(stores.db, p, (id) => labelOf(stores, id)));
    rows = project === undefined ? [...fan.rows, ...rowsOf(sy.db, "", legacyLabel(sy))] : fan.rows;
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
  // Each store is matched on its own project's rows, so a shared legacy database cannot return
  // another project's request; without `project`, an id held by two project stores is refused.
  const matches: Array<{ db: MeritRouter["db"]; req: BudgetRequest; project: string }> = [];
  if (project !== "") {
    for (const p of scopesFor(sy, project)) {
      const opened = openProjectStores(sy, p);
      if (!opened.ok) continue;
      const req = new BudgetRequests(opened.stores.db).get(id);
      if (req && req.project === p) matches.push({ db: opened.stores.db, req, project: p });
    }
  }
  if (!matches.length && (project === undefined || project === "")) {
    const req = new BudgetRequests(sy.db).get(id);
    if (req && req.project === "") matches.push({ db: sy.db, req, project: "" });
  }
  if (matches.length > 1) throw new MeritRouterError("ambiguous_id", `budget request ${id} exists in several projects (${matches.map((m) => m.project).join(", ")}); name the project`);
  const found = matches[0];
  if (!found || (project !== undefined && found.req.project !== project)) throw new MeritRouterError("not_found", `unknown budget request ${id}${project ? ` in project ${project}` : ""}`);
  const { db, req } = found;
  if (input.by.kind === "external" && req.approver === "human") throw new MeritRouterError("human_decision_required", `budget request ${id} is decided by a person (team.budget_approver: human): meritrouter budget approve|deny ${id}, or the panel`);
  if (!input.reason.trim()) throw new MeritRouterError("reason_required", "say why");
  return new BudgetRequests(db).decide(id, { approve: input.approve, grant: input.grant ?? null, by: `${input.by.kind}:${input.by.id}`, reason: input.reason, cfg: cfgOf(sy, req.taskId, found.project) });
}

export interface JobBudgetView {
  pool: JobPool;
  /** Each worker task's grant: what it was given, extra approvals, what it used, and what it holds now. */
  tasks: Array<{ taskId: string; label: string; state: string; granted: number; source: string; extra: number; used: number; held: number }>;
}

/** A job's pool and every task's grant (null when the task is not a supervisor job); `project` reads only that project's store. */
export function jobBudget(sy: MeritRouter, jobId: string, project?: string): JobBudgetView | null {
  const located = locateProjectTask(sy, jobId, project);
  if (!located) return null;
  const { stores } = located;
  const pool = jobPool(stores.db, sy.projectContext(located.project), jobId);
  if (!pool) return null;
  const admission = admissionOf(sy, stores);
  const tasks = grantsOf(stores.db, jobId).map((g) => {
    const t = stores.tasks.get(g.taskId);
    const state = t?.row.state ?? "unknown";
    return { taskId: g.taskId, label: t?.spec.label ?? g.taskId, state, granted: g.requests, source: g.source, extra: extraRequests(stores.db, g.taskId), used: admission.taskTotals(g.taskId).requests, held: taskHold(stores.db, g, state) };
  });
  return { pool, tasks };
}

/** A task's grant and extras (null when it was not delegated by a supervisor); `project` reads only that project's store. */
export function taskBudget(sy: MeritRouter, taskId: string, project?: string): { granted: number; source: string; extra: number; jobId: string } | null {
  const located = locateProjectTask(sy, taskId, project);
  if (!located) return null;
  const g = grantOf(located.stores.db, taskId);
  return g ? { granted: g.requests, source: g.source, extra: extraRequests(located.stores.db, taskId), jobId: g.jobId } : null;
}
