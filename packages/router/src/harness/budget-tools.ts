import type { ToolSideEffect } from "../sessions/events.js";
import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import type { ProfileName } from "../config/schema.js";
import { approverFor, BudgetRequests, defaultTaskGrant, jobOfTask, jobPool, MAX_BUDGET_REQUEST, poolLine, type BudgetRequest, type JobPool } from "../admission/budget-requests.js";
import type { HarnessEnv, HarnessTool } from "./tools.js";

/**
 * Budget control tools (docs/working/budget-control.md, D3 and D4). A worker that runs low asks
 * for more with `request_more_budget` and waits, without model requests, for a decision; its
 * job's supervisor decides with `decide_budget_request` (`await_tasks` returns early when one is
 * pending). The limits are enforced in code: the request count per task, the job's pool, and the
 * run cap that an approval raises.
 */

function tool(name: string, sideEffect: ToolSideEffect, description: string, properties: Record<string, unknown>, required: string[], run: HarnessTool["run"], available?: HarnessTool["available"]): HarnessTool {
  return { def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, sideEffect, run, ...(available ? { available } : {}) };
}

const POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The outcome of a request, as the worker is told it. */
function outcomeText(req: BudgetRequest, env: HarnessEnv): string {
  const used = env.ctx.gate.admission.taskTotals(env.ctx.taskId).requests;
  const left = Math.max(0, env.ctx.budget.maxModelRequests - used);
  if (req.status === "approved") return `approved by ${req.decidedBy}: ${req.granted} more model request(s)${req.decisionReason ? ` (${req.decisionReason})` : ""}. Your limit is now ${env.ctx.budget.maxModelRequests}; you have used ${used}. Continue the work.`;
  if (req.status === "denied") return `denied by ${req.decidedBy}${req.decisionReason ? `: ${req.decisionReason}` : ""}. Finish with what you have: you have ${left} request(s) left; submit your result before they run out, marking anything unverified as unknown.`;
  return `no decision arrived (${req.decisionReason ?? "expired"}). Continue with your ${left} remaining request(s) and submit your result before they run out.`;
}

/** Worker tool: ask the job's supervisor (or the configured approver) for more model requests. */
export function requestBudgetTool(): HarnessTool {
  return tool(
    "request_more_budget",
    "external",
    "Ask for more model requests when the ones you have left will not finish the brief. Say how many you need and why (what is done, what remains). You wait, without spending requests, for the decision; approved requests raise your limit at once. Ask early (a few requests before you run out), not for padding; the number of asks per task is limited.",
    { requests: { type: "integer", minimum: 1, maximum: MAX_BUDGET_REQUEST, description: "how many more model requests you need" }, reason: { type: "string", description: "what is done, what remains, and why it needs this many" } },
    ["requests", "reason"],
    async (a, env) => {
      const ctx = env.ctx;
      const cfg = ctx.cfg;
      const db = ctx.tasks.db;
      const store = new BudgetRequests(db, ctx.now);
      const max = cfg.team.max_budget_requests_per_task;
      const asked = store.countFor(ctx.taskId);
      if (asked >= max) throw new Error(`you already asked ${asked} time(s), the most a task may (team.max_budget_requests_per_task ${max}); finish with what you have and submit`);
      const requests = Number(a.requests);
      if (!Number.isInteger(requests) || requests < 1 || requests > MAX_BUDGET_REQUEST) throw new Error(`requests must be a whole number from 1 to ${MAX_BUDGET_REQUEST}`);
      const reason = typeof a.reason === "string" ? a.reason.trim() : "";
      if (!reason) throw new Error("reason is required: what is done, what remains, and why it needs this many");
      const jobId = jobOfTask(db, cfg, ctx.taskId);
      const approver = approverFor(cfg, jobId);
      const used = ctx.gate.admission.taskTotals(ctx.taskId).requests;
      let req = store.file({ taskId: ctx.taskId, jobId, role: env.role, requests, reason, used, cap: ctx.budget.maxModelRequests, approver });
      ctx.session?.note(`budget request ${req.id}: ${requests} more model request(s), decided by ${approver}`, { budgetRequest: req.id, requests, approver });
      if (approver === "auto") req = store.autoDecide(req.id, cfg);
      else {
        const until = Date.now() + cfg.team.budget_request_wait_seconds * 1000;
        for (;;) {
          req = store.get(req.id)!;
          if (req.status !== "pending") break;
          // Interrupted while waiting: the request stays pending; a decision applies to the resumed run.
          if (ctx.signal.aborted) throw new Error("interrupted while waiting for a decision on the budget request");
          if (Date.now() >= until) {
            req = store.expire(req.id, `no decision within ${cfg.team.budget_request_wait_seconds}s`);
            break;
          }
          await sleep(POLL_MS);
        }
      }
      // Approved: the run cap grows now (admission reads it on every request); later runs of the task get it from the store.
      if (req.status === "approved" && req.granted > 0) ctx.budget = { ...ctx.budget, maxModelRequests: ctx.budget.maxModelRequests + req.granted };
      return `budget request ${req.id} ${outcomeText(req, env)}`;
    },
    (env) => env.role !== "supervisor" && env.ctx.purpose !== "verification" && env.ctx.cfg.team.max_budget_requests_per_task > 0,
  );
}

/** The job's pool, or null when no task store is behind it (a stubbed supervisor in tests). */
function poolOrNull(db: Db, cfg: ResolvedConfig, jobId: string): JobPool | null {
  try {
    return jobPool(db, cfg, jobId);
  } catch {
    return null;
  }
}

/** The request budget granted to one new worker brief (budget control D1). */
export interface BriefGrant {
  requests: number;
  /** supervisor: the brief's max_requests; default: the configured default. */
  source: "supervisor" | "default";
  /** Whether it becomes the task's budget.maxModelRequests (explicit, or team.default_task_requests set). */
  setBudget: boolean;
}

/**
 * The grants of new worker briefs: each brief's `max_requests`, else the default
 * (`defaultTaskGrant`). Together they must fit in what the job's pool has available; otherwise
 * nothing is granted and the error names the number left.
 */
export function grantBriefs(db: Db, cfg: ResolvedConfig, jobId: string, briefs: Array<{ it: Record<string, unknown>; label: string }>): { grants: Map<string, BriefGrant>; total: number } {
  const grants = new Map<string, BriefGrant>();
  let total = 0;
  if (!briefs.length) return { grants, total };
  const pool = poolOrNull(db, cfg, jobId);
  for (const { it, label } of briefs) {
    const explicit = it.max_requests !== undefined && it.max_requests !== null;
    const requests = explicit ? Number(it.max_requests) : defaultTaskGrant(cfg, String(it.profile) as ProfileName, typeof it.difficulty === "string" ? it.difficulty : null);
    if (!Number.isInteger(requests) || requests < 1) throw new Error(`${label}: max_requests must be a whole number of at least 1`);
    if (pool?.available !== null && pool && total + requests > pool.available) {
      throw new Error(
        `${label}: needs ${requests} model requests but your job has ${Math.max(0, pool.available - total)} left for new tasks (budget ${pool.cap}: you used ${pool.used}, open tasks hold ${pool.held}, ${pool.reserve} kept for your own requests${total ? `, ${total} granted earlier in this call` : ""}); nothing was dispatched. Lower max_requests, dispatch fewer tasks now, or await running tasks first.`,
      );
    }
    total += requests;
    grants.set(label, { requests, source: explicit ? "supervisor" : "default", setBudget: explicit || cfg.team.default_task_requests !== undefined });
  }
  return { grants, total };
}

/** A worker of the job waits for its supervisor's decision on a budget request. */
export function supervisorAsked(db: Db, jobId: string): boolean {
  try {
    return new BudgetRequests(db).list({ status: "pending", jobId }).some((r) => r.approver === "supervisor");
  } catch {
    return false; // no store behind a stubbed supervisor
  }
}

/** Pending requests of a job as lines for its supervisor (empty when there are none). */
export function pendingBudgetLines(db: Db, cfg: ResolvedConfig, jobId: string): string[] {
  let pending: BudgetRequest[];
  try {
    pending = new BudgetRequests(db).list({ status: "pending", jobId });
  } catch {
    return []; // no store behind a stubbed supervisor
  }
  if (!pending.length) return [];
  const labels = (id: string) => (db.prepare("SELECT json_extract(spec_json, '$.label') AS label FROM tasks WHERE id = ?").get(id) as { label: string | null } | undefined)?.label ?? id;
  const pool = poolOrNull(db, cfg, jobId);
  return [
    ...pending
      .slice()
      .reverse()
      .map(
        (r) =>
          `budget request ${r.id} from ${labels(r.taskId)} (${r.taskId}): wants ${r.requests} more model request(s) (used ${r.used} of ${r.cap}). Reason (the worker's claim): ${r.reason.slice(0, 600)}${r.approver === "supervisor" ? "" : ` [decided by ${r.approver}]`}`,
      ),
    ...(pool ? [`${poolLine(pool)}. Decide each with decide_budget_request: approve when the remaining work justifies it, else deny (the worker then submits what it has; re-delegate a narrower brief if needed).`] : []),
  ];
}

/** Supervisor tools: the job's pool and pending requests, and the decision. */
export function supervisorBudgetTools(jobId: string): HarnessTool[] {
  return [
    tool("budget_requests", "read", "Your job's request pool (budget, used, held by open tasks, available) and your workers' pending requests for more model requests.", {}, [], async (_a, env) => {
      const db = env.ctx.tasks.db;
      const lines = pendingBudgetLines(db, env.ctx.cfg, jobId);
      if (lines.length) return lines.join("\n");
      const pool = jobPool(db, env.ctx.cfg, jobId);
      return `no pending budget requests${pool ? `; ${poolLine(pool)}` : ""}`;
    }),
    tool(
      "decide_budget_request",
      "delegate",
      "Approve or deny a worker's request for more model requests, with a reason. An approval grants `grant` requests (default: what it asked) from your job's pool, which must have them available; the worker continues at once with the higher limit. Deny when the remaining work does not justify it; the worker then submits what it has.",
      { id: { type: "integer" }, approve: { type: "boolean" }, grant: { type: "integer", minimum: 1, description: "requests to grant (default: what was asked)" }, reason: { type: "string" } },
      ["id", "approve", "reason"],
      async (a, env) => {
        const db = env.ctx.tasks.db;
        const store = new BudgetRequests(db, env.ctx.now);
        const req = store.get(Number(a.id));
        if (!req || req.jobId !== jobId) throw new Error(`budget request ${String(a.id)} is not one of this job's`);
        if (req.approver !== "supervisor") throw new Error(`budget request ${req.id} is decided by ${req.approver}, not by you`);
        const reason = typeof a.reason === "string" ? a.reason.trim() : "";
        if (!reason) throw new Error("reason is required");
        const r = store.decide(req.id, { approve: a.approve === true, grant: a.grant === undefined || a.grant === null ? null : Number(a.grant), by: env.brain?.actor.agent ?? `supervisor (job ${jobId})`, reason, cfg: env.ctx.cfg });
        const pool = jobPool(db, env.ctx.cfg, jobId);
        return `budget request ${r.id}: ${r.status}${r.status === "approved" ? ` (+${r.granted})` : ""}${pool ? `; ${poolLine(pool)}` : ""}`;
      },
    ),
  ];
}
