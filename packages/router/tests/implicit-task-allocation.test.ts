import { afterEach, describe, expect, it } from "vitest";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { defaultTaskGrant, jobPool } from "../src/admission/budget-requests.js";
import { effectiveBudget, heldRequests } from "../src/admission/admission.js";
import { grantOf } from "../src/admission/job-pool.js";
import { taskAllocationAlternatives, taskAllocationForecast } from "../src/verification/task-allocation-feedback.js";
import { git } from "../src/workspaces/git.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

async function fixture(options: { parentCap?: number; defaultRequests?: number; ceiling?: number; critical?: boolean } = {}) {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, team: { supervisor_reserve_requests: 4, ...(options.defaultRequests ? { default_task_requests: options.defaultRequests } : {}) },
    verification: { max_total_requests_per_task: options.ceiling ?? null },
    profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 128, classify: "never", min_tier: "T3" } } } });
  const client = new ScriptedClient(() => reply("no provider call expected"));
  sy = open(env, client, { worker: false });
  const parent = (await sy.submitTasks([WorkerTaskSchema.parse({ profile: "supervise", goal: "Deliver fixture", repositoryAliases: ["core"],
    constraints: { acceptanceCriteria: ["Works"] }, budget: { maxModelRequests: options.parentCap ?? 128 },
    ...(options.critical ? { importance: "critical", importanceReason: "Fixture verifies inherited review protection" } : {}) })]))[0]!.taskId;
  const ctx = { taskId: parent, spec: sy.tasks.get(parent)!.spec, tasks: sy.tasks, cfg: sy.cfg, gate: sy.gate,
    now: Date.now, budget: { maxModelRequests: options.parentCap ?? 128 }, signal: new AbortController().signal,
    services: { submitTasks: sy.submitTasks.bind(sy), getTask: (id: string) => { const task = sy!.tasks.get(id); return task ? { spec: task.spec, state: task.row.state, result: task.result } : null; } } } as unknown as RunContext;
  const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:fixture", role: "supervisor", task: parent },
    repos: new Map([["core", { alias: "core", worktree: env.repo, branch: "main", baseSha: (await git(env.repo, ["rev-parse", "HEAD"])).trim() }]]), briefChecks: new Set(), children: new Map() };
  const harness = { ctx, role: "supervisor", readers: new Map(), edits: new Set() } as unknown as HarnessEnv;
  const plan = (node: Record<string, unknown>, dispatch: boolean) => supervisorTools(state).find(tool => tool.def.function.name === "plan_work")!.run({ nodes: [node], dispatch }, harness);
  return { parent, client, state, plan };
}

const brief = (label = "repair") => ({ label, profile: "implement", goal: "Repair source fixture", repositories: ["core"],
  allowed_paths: ["src/**"], acceptance_criteria: ["Works"], difficulty: "T3" });

describe("implicit worker total allocation", () => {
  it("holds the canonical finite allocation, pins the same total and makes draft/actual forecasts agree", async () => {
    const f = await fixture();
    const draft = await f.plan(brief(), false);
    expect(draft).toContain("first-run execution 8, review 4, repair 8, total allocated 20");
    expect(heldRequests(sy!.db, f.parent)).toBe(0);
    const output = await f.plan(brief(), true);
    const child = sy!.tasks.childrenOf(f.parent)[0]!;
    expect(child.spec.budget?.maxModelRequests).toBe(20);
    expect(grantOf(sy!.db, child.row.id)).toMatchObject({ requests: 20, source: "default" });
    expect(heldRequests(sy!.db, f.parent)).toBe(20);
    expect(effectiveBudget(sy!.cfg, child.spec, "T3").maxModelRequests).toBe(8);
    expect(output).toContain("budget 20 requests");
    expect(draft).toContain(taskAllocationForecast(sy!.cfg, child.spec));
    expect(output).toContain(taskAllocationForecast(sy!.cfg, child.spec));
    expect(f.client.requests).toHaveLength(0);
  });

  it("refuses an implicit total that cannot fit the parent pool before any child or grant is recorded", async () => {
    const f = await fixture({ parentCap: 20 });
    const before = jobPool(sy!.db, sy!.cfg, f.parent);
    expect(before).toMatchObject({ cap: 20, reserve: 4, available: 16 });
    await expect(f.plan(brief(), true)).rejects.toThrow(/needs 20 model requests.*16 left/);
    expect(sy!.tasks.childrenOf(f.parent)).toHaveLength(0);
    expect(jobPool(sy!.db, sy!.cfg, f.parent)).toEqual(before);
    expect(f.client.requests).toHaveLength(0);
  });

  it.each([{ configured: 12, explicit: undefined, expected: 12 }, { configured: 12, explicit: 16, expected: 16 }])(
    "honors configured and explicit total grants ($configured / $explicit)", async ({ configured, explicit, expected }) => {
      const f = await fixture({ defaultRequests: configured });
      await f.plan({ ...brief(), ...(explicit ? { max_requests: explicit } : {}) }, true);
      const child = sy!.tasks.childrenOf(f.parent)[0]!;
      expect(child.spec.budget?.maxModelRequests).toBe(expected);
      expect(grantOf(sy!.db, child.row.id)?.requests).toBe(expected);
      expect(heldRequests(sy!.db, f.parent)).toBe(expected);
      expect(f.client.requests).toHaveLength(0);
    });

  it("uses the real parent's importance and writable evaluator scope in the canonical default", async () => {
    const f = await fixture({ critical: true });
    sy!.cfg.coding.protected_paths = ["tests/**"];
    await f.plan({ ...brief(), allowed_paths: ["tests/**"] }, true);
    const child = sy!.tasks.childrenOf(f.parent)[0]!;
    const parent = { taskId: f.parent, importance: "critical" as const };
    const candidates = taskAllocationAlternatives(sy!.cfg, { ...child.spec, budget: undefined }, parent);
    const max = Math.max(...candidates.flatMap(({ result }) => result.ok ? [result.contract.budget.total] : []));
    expect(candidates.every(({ result }) => result.ok && result.contract.importance.level === "critical")).toBe(true);
    expect(child.spec.budget?.maxModelRequests).toBe(max);
    expect(max).toBeGreaterThan(20);
    expect(grantOf(sy!.db, child.row.id)?.requests).toBe(max);
    expect(f.client.requests).toHaveLength(0);
  });

  it("keeps a finite ceiling and charges actual classification inside the pinned total", async () => {
    const f = await fixture({ ceiling: 10 });
    // The parent also obeys the configured ceiling, so this fixture explicitly removes its
    // team reserve to fit the one10-request child; no production reserve formula changes.
    sy!.cfg.team.supervisor_reserve_requests = 0;
    await f.plan(brief(), true);
    const child = sy!.tasks.childrenOf(f.parent)[0]!;
    expect(child.spec.budget?.maxModelRequests).toBe(10);
    const actual = taskAllocationAlternatives(sy!.cfg, child.spec, null, 1);
    expect(actual.every(({ result }) => result.ok && result.contract.budget.classification === 1
      && result.contract.budget.total <= 10 && result.contract.budget.review === 4)).toBe(true);
    expect(heldRequests(sy!.db, f.parent)).toBe(10);
  });

  it("takes the maximum reachable canonical tier allocation without using an unbounded ceiling as the grant", async () => {
    await fixture();
    const spec = WorkerTaskSchema.parse({ profile: "inspect", goal: "Inspect real fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Works"] } });
    const alternatives = taskAllocationAlternatives(sy!.cfg, spec);
    expect(alternatives.length).toBeGreaterThan(1);
    const wanted = Math.max(...alternatives.flatMap(({ result }) => result.ok ? [result.contract.budget.total] : []));
    expect(Number.isSafeInteger(wanted)).toBe(true);
    expect(defaultTaskGrant(sy!.cfg, spec)).toBe(wanted);
    expect(wanted).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
