import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { recordGrant } from "../src/admission/job-pool.js";
import { budgetRequestsView, decideBudgetRequest, jobBudget, taskBudget } from "../src/admin/budget.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const human = { kind: "human", id: "panel" } as const;
function setup() {
  const cfg: Record<string, unknown> = baseConfig({ team: { supervisor_reserve_requests: 4 } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  cfg.repositories = {};
  cfg.projects = { alpha: { repositories: { core: { path: "repo" } } }, beta: { repositories: { core: { path: "repo" } } } };
  env = makeEnv({ config: cfg });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "job_a", profile: "supervise", goal: "test", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } }), WorkerTaskSchema.parse({ id: "task_a", parentTaskId: "job_a", label: "alpha-worker", profile: "inspect", goal: "inspect", repositoryAliases: ["core"], budget: { maxModelRequests: 2 }, constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
  recordGrant(sy.db, { taskId: "task_a", jobId: "job_a", requests: 2, source: "supervisor" }, Date.now());
  return new BudgetRequests(sy.db);
}
function request(store: BudgetRequests, count = 4) { return store.file({ taskId: "task_a", jobId: "job_a", role: "inspector", requests: count, reason: "Need to inspect more files", used: 1, cap: 2, approver: "human" }); }

describe("panel budget service", () => {
  it("requires exact project scope even for unassigned rows", () => {
    const store = setup();
    const r = request(store);
    expect(budgetRequestsView(sy!, { project: "beta" })).toEqual([]);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: true, reason: "ok", by: human }, "beta")).toThrow(/unknown budget request/);
    expect(store.get(r.id)?.status).toBe("pending");
    sy!.db.prepare("UPDATE budget_requests SET project_id = '' WHERE id = ?").run(r.id);
    expect(budgetRequestsView(sy!, { project: "alpha" })).toEqual([]);
    expect(budgetRequestsView(sy!, { project: "" })).toHaveLength(1);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: true, reason: "ok", by: human }, "alpha")).toThrow(/unknown budget request/);
    expect(decideBudgetRequest(sy!, r.id, { approve: false, reason: "No more work needed", by: human }, "")).toMatchObject({ status: "denied", granted: 0, decidedBy: "human:panel" });
  });

  it("supports partial grants, preserves paid limits, and refuses stale and oversized decisions atomically", () => {
    const store = setup();
    const r = request(store);
    const before = jobBudget(sy!, "job_a")!;
    const specBefore = sy!.tasks.get("task_a")!.spec;
    const available = before.pool.available;
    if (available === null) throw new Error("fixture expected a finite job pool");
    expect(available).toBeGreaterThan(2);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: true, grant: available + 1, reason: "over-ask", by: human }, "alpha")).toThrow(/does not fit/);
    expect(store.get(r.id)?.status).toBe("pending");
    expect(jobBudget(sy!, "job_a")!.pool).toEqual(before.pool);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: true, grant: 1.5, reason: "bad grant", by: human }, "alpha")).toThrow(/whole number/);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: false, reason: "  ", by: human }, "alpha")).toThrow(/say why/);
    expect(decideBudgetRequest(sy!, r.id, { approve: true, grant: 2, reason: "Two more files", by: human }, "alpha")).toMatchObject({ granted: 2, status: "approved", decisionReason: "Two more files" });
    expect(taskBudget(sy!, "task_a")).toMatchObject({ granted: 2, extra: 2, jobId: "job_a" });
    const after = jobBudget(sy!, "job_a")!;
    expect(after.pool.available).toBe(available - 2);
    expect(after.pool.held).toBe(before.pool.held + 2);
    expect(after.tasks[0]).toMatchObject({ granted: 2, extra: 2, held: 4, used: 0 });
    expect(sy!.tasks.get("task_a")!.spec.budget).toEqual(specBefore.budget);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: false, reason: "stale", by: human }, "alpha")).toThrow(/already approved/);
    expect(taskBudget(sy!, "task_a")!.extra).toBe(2);
    expect(sy!.tasks.events("task_a").some((e) => e.type === "budget_granted")).toBe(true);
  });

  it("expires a finished task request without granting and returns unused holds", () => {
    const store = setup();
    const r = request(store);
    sy!.cancelTasks(["task_a"]);
    expect(() => decideBudgetRequest(sy!, r.id, { approve: true, reason: "too late", by: human }, "alpha")).toThrow(/already cancelled/);
    expect(store.get(r.id)).toMatchObject({ status: "expired", granted: 0 });
    expect(jobBudget(sy!, "job_a")!.tasks[0]!.held).toBe(0);
    expect(taskBudget(sy!, "task_a")!.extra).toBe(0);
  });
});
