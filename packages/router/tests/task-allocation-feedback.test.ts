import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config/load.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { compileContract } from "../src/verification/contract.js";
import { budgetInputFor, heldRequests } from "../src/admission/admission.js";
import { taskAllocationForecast, executionAllocationNotice } from "../src/verification/task-allocation-feedback.js";
import { poolLine, jobPool } from "../src/admission/budget-requests.js";
import { grantBriefs } from "../src/harness/budget-tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { RunContext } from "../src/runners/types.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

function config() {
  const cfg = parseConfig(baseConfig(), path.join(tmpdir(), "meritrouter-allocation-feedback.config.yaml"));
  cfg.profiles.implement!.max_model_requests = 64;
  cfg.tiers.T3.max_model_requests = 64;
  cfg.execution.max_model_requests_per_task = 128;
  cfg.verification.max_total_requests_per_task = 128;
  cfg.verification.budget.review_requests.deep = 12;
  return cfg;
}
const task = (total: number) => WorkerTaskSchema.parse({ profile: "implement", goal: "Repair the fixture",
  repositoryAliases: ["core"], writableRepository: "core", constraints: { allowedPaths: ["src/**"], acceptanceCriteria: ["Works"] },
  hints: { difficulty: "T3" }, verification: { atLeast: "deep" }, budget: { maxModelRequests: total } });

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

describe("task allocation feedback", () => {
  it.each([[16, 4], [20, 8], [28, 16]])("separates total grant %i from usable execution %i without changing policy", (total, execution) => {
    const cfg = config(), spec = task(total), before = JSON.stringify([cfg, spec]);
    const forecast = taskAllocationForecast(cfg, spec);
    expect(forecast).toContain(`T3/deep: first-run execution ${execution}, review 12, repair 0, total allocated ${total}`);
    expect(forecast).toContain("Provisional");
    expect(forecast).toContain("zero classification requests assumed");
    expect(forecast).toContain("final request is submission-only");
    expect(JSON.stringify([cfg, spec])).toBe(before);
  });

  it("reports a canonical shortfall without lowering mandatory review", () => {
    const cfg = config();
    expect(taskAllocationForecast(cfg, task(12))).toContain("needs 13 model requests");
    expect(cfg.verification.budget.review_requests.deep).toBe(12);
  });

  it("honors routing tier and shows alternatives when classification is unresolved", () => {
    const cfg = config(), spec = task(28);
    delete spec.hints;
    spec.routing = { tier: "T3" };
    expect(taskAllocationForecast(cfg, spec)).toContain("T3/deep");
    expect(taskAllocationForecast(cfg, spec)).not.toContain("T1/");
    delete spec.routing;
    cfg.profiles.implement!.min_tier = "T1";
    const uncertain = taskAllocationForecast(cfg, spec);
    for (const tier of ["T1", "T2", "T3"]) expect(uncertain).toContain(`${tier}/`);
    expect(uncertain).toContain("actual classification, policy and tier may change it");
  });

  it("uses canonical parent importance and evaluator-scope rules", () => {
    const cfg = config(), spec = task(40), parent = { taskId: "parent", importance: "critical" as const };
    cfg.coding.protected_paths = ["tests/**"];
    spec.constraints.allowedPaths = ["tests/**"];
    const actual = compileContract({ taskId: "expected", spec, tier: "T3", tags: spec.hints?.tags ?? null,
      rulebookFingerprint: null, policy: cfg.verification, evaluatorChangeExpected: true,
      budget: budgetInputFor(cfg, spec, "T3", 0), parent, now: 0 });
    expect(actual.ok).toBe(true);
    if (!actual.ok) throw new Error(actual.message);
    expect(actual.contract.importance.level).toBe("critical");
    const c = actual.contract;
    expect(taskAllocationForecast(cfg, spec, parent)).toContain(`T3/${c.verification.level}: first-run execution ${c.budget.execution}, review ${c.budget.review}, repair ${c.budget.repair}, total allocated ${c.budget.total}`);
  });

  it("states the effective remaining execution allowance across resume and approved extension", () => {
    const cfg = config(), spec = task(28);
    const result = compileContract({ taskId: "actual", spec, tier: "T3", tags: null, rulebookFingerprint: null,
      policy: cfg.verification, budget: budgetInputFor(cfg, spec, "T3", 0), parent: null, now: 0 });
    if (!result.ok) throw new Error(result.message);
    const notice = executionAllocationNotice(result.contract, 21, 9);
    expect(notice).toContain("12 model requests remain (9 already charged; cumulative execution cap 21)");
    expect(notice).toContain("Contract total allocation 28");
    expect(notice).toContain("reserved review 12");
    expect(notice).toContain("final execution request offers only submit_result");
    expect(executionAllocationNotice(result.contract, 16, 20)).toContain("0 model requests remain");
  });

  it("exposes forecast through the actual draft tool without provider calls, grants or task dispatch", async () => {
    const raw = baseConfig();
    env = makeEnv({ config: { ...raw, profiles: { ...raw.profiles,
      implement: { ...raw.profiles.implement, max_model_requests: 64 },
      supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 128, classify: "never", min_tier: "T3" } },
      execution: { ...raw.execution, max_model_requests_per_task: 128 },
      tiers: config().tiers,
      verification: { budget: { review_requests: { deep: 12, strict: 12 } } } } });
    const client = new ScriptedClient(() => reply("must not be called"));
    sy = open(env, client, { worker: false });
    const parent = sy.tasks.submit([WorkerTaskSchema.parse({ profile: "supervise", goal: "Deliver fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Works"] } })])[0]!.taskId;
    const ctx = { taskId: parent, spec: sy.tasks.get(parent)!.spec, tasks: sy.tasks, cfg: sy.cfg, gate: sy.gate,
      now: Date.now, budget: { maxModelRequests: 128 }, signal: new AbortController().signal, services: { getTask: () => null } } as unknown as RunContext;
    const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:fixture", role: "supervisor", task: parent },
      repos: new Map([["core", { alias: "core", worktree: env.repo, branch: "main", baseSha: "a".repeat(40) }]]), briefChecks: new Set(), children: new Map() };
    const harness = { ctx, role: "supervisor", readers: new Map(), edits: new Set() } as unknown as HarnessEnv;
    const output = await supervisorTools(state).find(t => t.def.function.name === "plan_work")!.run({ dispatch: false,
      nodes: [{ label: "repair", profile: "implement", goal: "Fix fixture", repositories: ["core"], allowed_paths: ["src/**"],
        acceptance_criteria: ["Works"], difficulty: "T3", max_requests: 20 }] }, harness);
    expect(output).toContain("draft; dispatch:false");
    expect(output).toContain("first-run execution 8, review 12");
    expect(sy.tasks.childrenOf(parent)).toHaveLength(0);
    expect(heldRequests(sy.db, parent)).toBe(0);
    expect(client.requests).toHaveLength(0);
  });

  it("explains spent terminal descendant usage without changing pool arithmetic", () => {
    const raw = baseConfig();
    env = makeEnv({ config: { ...raw, profiles: { ...raw.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 128, classify: "never", min_tier: "T3" } } } });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
    const pool = { jobId: "root", cap: 252, used: 70, held: 96, reserve: 76, available: 10 };
    expect(poolLine(pool)).toContain("10 available of 252");
    expect(poolLine(pool)).toContain("descendant usage/open grants 96");
    expect(poolLine(pool)).toContain("76 protected supervision/validation reserves");
    expect(poolLine(pool)).toContain("completed-task usage is spent");
    // Pure grant check only needs a real supervisor pool; no actual grant is recorded here.
    const parent = sy.tasks.submit([WorkerTaskSchema.parse({ profile: "supervise", goal: "Deliver", constraints: { acceptanceCriteria: ["Works"] }, budget: { maxModelRequests: 10 } })])[0]!.taskId;
    const before = jobPool(sy.db, sy.cfg, parent);
    expect(() => grantBriefs(sy!.db, sy!.cfg, parent, [{ label: "too-large", it: { profile: "implement", max_requests: 100 } }])).toThrow(/Completed-task usage is spent and waiting cannot release it/);
    expect(jobPool(sy.db, sy.cfg, parent)).toEqual(before);
    expect(sy.tasks.childrenOf(parent)).toHaveLength(0);
  });
});
