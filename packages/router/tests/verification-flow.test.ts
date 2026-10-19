import { afterEach, describe, expect, it } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import type { CodingRunner } from "../src/core/executor.js";
import { baseResult, type RunContext, type RunOutcome, type SupervisorServices } from "../src/runners/types.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { SwitchyardError } from "../src/core/errors.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const CHECK = "node -e \"process.exit(0)\"";

/** A coding runner double: no worktree, no model requests; the handler shapes the outcome. */
function stubCoding(handler: (ctx: RunContext, call: number) => RunOutcome): CodingRunner & { calls: RunContext[] } {
  const calls: RunContext[] = [];
  return {
    calls,
    run: async (ctx) => {
      calls.push(ctx);
      return handler(ctx, calls.length);
    },
  };
}

/** A completed coding outcome with its checks bound to `checkRevision`, submitted at `revision`. */
function codingOutcome(ctx: RunContext, o: { exitCode?: number; revision?: string; checkRevision?: string; changedPaths?: string[]; scopeViolation?: string[]; protectedPathsChanged?: string[]; log?: string } = {}): RunOutcome {
  const revision = o.revision ?? "tree-1";
  const checks = (ctx.spec.constraints.checks ?? []).map((command) => ({
    command,
    exitCode: o.exitCode ?? 0,
    logRef: ctx.artifacts.write({ taskId: ctx.taskId, kind: "check_log", label: command, content: o.log ?? `$ ${command}\nexit ${o.exitCode ?? 0}\n`, extension: ".log" }),
    revision: o.checkRevision ?? revision,
  }));
  return {
    state: "completed",
    result: baseResult({
      stopReason: "worker_submitted",
      summary: "stub",
      checks,
      changedPaths: o.changedPaths ?? ["src/app.ts"],
      scopeViolation: o.scopeViolation ?? [],
      protectedPathsChanged: o.protectedPathsChanged ?? [],
      baseCommits: { core: "0".repeat(40) },
    }),
    evidence: { revision },
  };
}

const implement = (o: Record<string, unknown> = {}) => ({
  profile: "implement",
  goal: "Add a subtract function to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty: "T1" },
  constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [CHECK] },
  ...o,
});

const noModel = () => new ScriptedClient(() => {
  throw new Error("no model request expected");
});

function profilesWith(overrides: Record<string, Record<string, unknown>>) {
  const p = { ...(baseConfig().profiles as Record<string, Record<string, unknown>>) };
  for (const [k, v] of Object.entries(overrides)) p[k] = { ...p[k], ...v };
  return p;
}

async function result(id: string, seconds = 20) {
  const out = await sy!.awaitResults([id], { timeoutSeconds: seconds });
  expect(out.timedOut).toBe(false);
  return out.completed[0]!;
}

describe("contract and verification in the executor", () => {
  it("compiles and stores the contract before the run; the default policy reproduces today's outcome", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = await result(sub!.taskId);
    // Today: a self-assessed completion is never better than not_verified.
    expect(r.acceptanceStatus).toBe("not_verified");
    expect(r.verificationStatus).toBe("passed");
    expect(r.unresolvedCriteria).toEqual([]);
    expect(r.unresolvedCriterionIds).toEqual([]);
    const stored = sy.contract(sub!.taskId)!;
    expect(stored.contract).toMatchObject({ tier: "T1", importance: { level: "normal", source: "default" }, verification: { level: "standard" } });
    expect(stored.contract.criteria).toEqual([{ id: "c1", text: "mentions the error", verify: "evidence", checks: [] }]);
    expect(r.verification).toMatchObject({ level: "standard", raisedFrom: null, contractSha256: stored.sha256 });
    expect(r.verification!.criteria).toEqual([expect.objectContaining({ id: "c1", outcome: "claimed" })]);
    const events = sy.tasks.events(sub!.taskId, 50).map((e) => e.type);
    expect(events.indexOf("contract_compiled")).toBeGreaterThan(-1);
    expect(events.indexOf("contract_compiled")).toBeLessThan(events.indexOf("completed"));
  });

  it("rejects at submit when the budget cannot hold the required verification", async () => {
    env = makeEnv();
    sy = open(env, noModel());
    // T1 critical -> strict: a review reserve of 6 plus one execution request exceeds summarize's 4.
    await expect(sy.submitTasks([summarizeTask({ importance: "critical", importanceReason: "billing data" })])).rejects.toThrow(/verification_budget_insufficient/);
    expect(sy.listTasks()).toEqual([]);
  });

  it("strict ends needs_supervisor until accepted, and the decision records who and why", async () => {
    env = makeEnv({ config: baseConfig({ profiles: profilesWith({ summarize: { max_model_requests: 8 } }) }) });
    const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));
    sy = open(env, client, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ importance: "critical", importanceReason: "billing data" })]);
    const r = await result(sub!.taskId);
    expect(r.acceptanceStatus).toBe("needs_supervisor");
    expect(r.verificationStatus).toBe("pending");
    expect(r.verification).toMatchObject({ level: "strict", importance: "critical", importanceSource: "task" });
    // The review reserve is excluded from the run: total 8, review 6, so execution gets 2.
    expect(sy.contract(sub!.taskId)!.contract.budget).toMatchObject({ total: 8, review: 6, execution: 2 });
    expect(client.requests).toHaveLength(1);

    const by = { kind: "supervisor" as const, id: "supervisor:job" };
    expect(() => sy!.acceptTask(sub!.taskId, { by })).toThrow(/needs a reason/);
    const out = sy.acceptTask(sub!.taskId, { by, reason: "compared the summary with the log" });
    expect(out.acceptanceStatus).toBe("met");
    const after = sy.tasks.get(sub!.taskId)!.result!;
    expect(after.acceptanceStatus).toBe("met");
    expect(after.verificationStatus).toBe("pending");
    expect(after.verification!.decisions).toEqual([expect.objectContaining({ decision: "accepted", by, reason: "compared the summary with the log" })]);
    expect(sy.tasks.events(sub!.taskId).map((e) => e.type)).toContain("result_accepted");
  });

  it("strict_acceptor human refuses the supervisor and accepts a human", async () => {
    env = makeEnv({ config: baseConfig({ profiles: profilesWith({ summarize: { max_model_requests: 8 } }), verification: { strict_acceptor: "human" } }) });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ importance: "critical", importanceReason: "billing data" })]);
    expect((await result(sub!.taskId)).acceptanceStatus).toBe("needs_supervisor");
    let err: unknown;
    try {
      sy.acceptTask(sub!.taskId, { by: { kind: "supervisor", id: "supervisor:job" }, reason: "looks right" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwitchyardError);
    expect((err as SwitchyardError).code).toBe("human_acceptance_required");
    expect(sy.tasks.get(sub!.taskId)!.result!.acceptanceStatus).toBe("needs_supervisor");
    expect(sy.acceptTask(sub!.taskId, { by: { kind: "human", id: "aiden" }, reason: "reviewed in the panel" }).acceptanceStatus).toBe("met");
  });

  it("a rejection needs a reason and makes the result unmet", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    await result(sub!.taskId);
    const by = { kind: "supervisor" as const, id: "supervisor:job" };
    expect(() => sy!.rejectTask(sub!.taskId, { by })).toThrow(/needs a reason/);
    expect(sy.rejectTask(sub!.taskId, { by, reason: "the summary misses the error" }).acceptanceStatus).toBe("unmet");
    expect(() => sy!.acceptTask(sub!.taskId, { by, reason: "changed my mind" })).toThrow(/cannot be accepted/);
  });

  it("a dependent of an unverified result runs, with a recorded warning", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const [a, b] = await sy.submitTasks([summarizeTask({ id: "up" }), summarizeTask({ id: "down", dependsOn: ["up"] })]);
    expect((await result(b!.taskId)).executionStatus).toBe("completed");
    expect(sy.tasks.events("down").find((e) => e.type === "dependency_unverified")?.data).toEqual({ dependency: a!.taskId, acceptanceStatus: "not_verified" });
  });
});

describe("coding verification", () => {
  it("passing checks on the submitted revision are met; the run cap is the tier's", async () => {
    env = makeEnv();
    const coding = stubCoding((ctx) => codingOutcome(ctx));
    sy = open(env, noModel(), { worker: true, coding });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed", unresolvedCriteria: [], unresolvedCriterionIds: [] });
    // A coding task measures at T2 here (the T1 hint only raises): standard, and T2's cap of 8.
    expect(coding.calls[0]!.budget.maxModelRequests).toBe(8);
    expect(coding.calls[0]!.contract).toMatchObject({ tier: "T2", verification: { level: "standard" } });
  });

  it("checks bound to an older revision are stale and go to the supervisor", async () => {
    env = makeEnv();
    sy = open(env, noModel(), { worker: true, coding: stubCoding((ctx) => codingOutcome(ctx, { revision: "tree-new", checkRevision: "tree-old" })) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r.acceptanceStatus).toBe("needs_supervisor");
    expect(r.verificationStatus).toBe("inconclusive");
    expect(r.verification!.checks.find((c) => c.name === "declared_checks")).toMatchObject({ outcome: "stale", required: true });
    expect(r.unresolvedCriterionIds).toEqual(["c1"]);
  });

  it("a change touching a critical path raises the level after the fact", async () => {
    env = makeEnv({ config: baseConfig({ verification: { rules: [{ id: "auth-critical", when: { changed_paths: ["src/auth/**"] }, importance: "critical" }] } }) });
    sy = open(env, noModel(), { worker: true, coding: stubCoding((ctx) => codingOutcome(ctx, { changedPaths: ["src/auth/login.ts"] })) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(sy.contract(sub!.taskId)!.contract.verification.level).toBe("standard");
    expect(r.verification).toMatchObject({ level: "strict", raisedFrom: "standard", importance: "critical", importanceSource: "rule:auth-critical" });
    expect(r.acceptanceStatus).toBe("needs_supervisor");
    const raised = sy.tasks.events(sub!.taskId).find((e) => e.type === "verification_raised");
    expect(raised?.data).toMatchObject({ from: "standard", to: "strict", newRules: ["auth-critical"] });
  });

  it("deep reserves its review out of the run cap and waits for review (none exists in V1)", async () => {
    env = makeEnv();
    const coding = stubCoding((ctx) => codingOutcome(ctx));
    sy = open(env, noModel(), { worker: true, coding });
    const [sub] = await sy.submitTasks([implement({ hints: { difficulty: "T3" } })]);
    const r = await result(sub!.taskId);
    expect(sy.contract(sub!.taskId)!.contract.budget).toMatchObject({ total: 8, review: 4, execution: 4 });
    expect(coding.calls[0]!.budget.maxModelRequests).toBe(4);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "pending" });
  });

  it("the escalation retry gets the failing check log, the unresolved criteria, and the repair budget", async () => {
    env = makeEnv({ config: baseConfig({ profiles: profilesWith({ implement: { max_model_requests: 16 } }) }) });
    const coding = stubCoding((ctx, n) => (n === 1 ? codingOutcome(ctx, { exitCode: 1, log: "AssertionError: subtract is not defined" }) : codingOutcome(ctx, { revision: "tree-2" })));
    sy = open(env, noModel(), { worker: true, coding });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(coding.calls).toHaveLength(2);
    const [first, second] = coding.calls;
    expect(first!.retry ?? null).toBeNull();
    expect(second!.retry).toMatchObject({ fromTier: "T2", reason: "acceptance_unmet", unresolvedCriteria: ["subtract exists"] });
    expect(second!.retry!.failingChecks).toEqual([expect.objectContaining({ command: CHECK, exitCode: 1, logTail: expect.stringContaining("subtract is not defined") })]);
    expect(second!.retry!.verificationReasons.join("\n")).toMatch(/declared_checks failed/);
    // Total 16 at T2: execution 8, repair 8 (one retry at T3's cap of 12, from what is left).
    expect(sy.contract(sub!.taskId)!.contract.budget).toMatchObject({ total: 16, execution: 8, review: 0, repair: 8 });
    // First run: T2's cap; the repair run: execution plus the repair reserve, within T3's cap.
    expect(first!.budget.maxModelRequests).toBe(8);
    expect(second!.budget.maxModelRequests).toBe(12);
    expect(r).toMatchObject({ acceptanceStatus: "met", routing: { tier: "T3", escalatedFrom: "T2" } });
  });
});

describe("supervisor acceptance tools", () => {
  function state(children: Record<string, string>): SupervisorState {
    const s = sy!;
    const services: SupervisorServices = {
      submitTasks: (raw, o) => s.submitTasks(raw, o),
      awaitResults: (ids, o) => s.awaitResults(ids, o),
      getTask: (id) => {
        const t = s.tasks.get(id);
        return t ? { spec: t.spec, state: t.row.state, result: t.result } : null;
      },
      cancelTasks: (ids) => s.cancelTasks(ids),
      acceptTask: (id, i) => s.acceptTask(id, i),
      rejectTask: (id, i) => s.rejectTask(id, i),
    };
    return {
      ctx: { services, taskId: "job-1", cfg: env!.cfg, signal: new AbortController().signal } as unknown as RunContext,
      db: s.db,
      actor: { agent: "supervisor:job", role: "supervisor", model: null, job: "job-1", task: "job-1", tier: "T3" },
      repos: new Map(),
      briefChecks: new Set(),
      children: new Map(Object.entries(children)),
    };
  }
  const run = (st: SupervisorState, name: string, args: Record<string, unknown>) => supervisorTools(st).find((t) => t.def.function.name === name)!.run(args, {} as HarnessEnv);

  it("describe the judgement and take importance on delegate", () => {
    env = makeEnv();
    sy = open(env, noModel());
    const tools = supervisorTools(state({}));
    const desc = (n: string) => tools.find((t) => t.def.function.name === n)!.def.function.description ?? "";
    expect(desc("accept_task")).toMatch(/job's goal and the specifications you were given/);
    expect(desc("accept_task")).toMatch(/recorded on the task with who accepted/);
    expect(desc("reject_task")).toMatch(/job's goal/);
    const props = (tools.find((t) => t.def.function.name === "delegate")!.def.function.parameters as { properties: { tasks: { items: { properties: Record<string, unknown> } } } }).properties.tasks.items.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["importance", "importance_reason"]));
  });

  it("integrate_task refuses unmet and out-of-scope results and needs accept with a reason otherwise", async () => {
    env = makeEnv();
    const coding = stubCoding((ctx) => {
      if (ctx.spec.label === "broken") return codingOutcome(ctx, { exitCode: 1 });
      if (ctx.spec.label === "scope") return codingOutcome(ctx, { scopeViolation: ["README.md"] });
      return codingOutcome(ctx);
    });
    sy = open(env, noModel(), { worker: true, coding });
    // T3: no escalation, and passing work is deep -> needs_supervisor in V1.
    const subs = await sy.submitTasks([implement({ label: "broken", hints: { difficulty: "T3" } }), implement({ label: "scope", hints: { difficulty: "T3" } }), implement({ label: "fine", hints: { difficulty: "T3" } })]);
    const ids = Object.fromEntries(subs.map((x, i) => [["broken", "scope", "fine"][i]!, x.taskId]));
    for (const id of Object.values(ids)) await result(id);
    const st = state(ids);
    await expect(run(st, "integrate_task", { task_id: "broken" })).rejects.toThrow(/unmet/);
    await expect(run(st, "integrate_task", { task_id: "scope" })).rejects.toThrow(/out-of-scope changes.*README\.md/);
    await expect(run(st, "integrate_task", { task_id: "fine" })).rejects.toThrow(/needs_supervisor.*accept: true/);
    expect(sy.tasks.get(ids.fine!)!.result!.acceptanceStatus).toBe("needs_supervisor");
    await expect(run(st, "integrate_task", { task_id: "fine", accept: true })).rejects.toThrow(/accept: true and a reason/);
    // The stub has no worktree: nothing is integrated and no acceptance is recorded.
    await expect(run(st, "integrate_task", { task_id: "fine", accept: true, reason: "read the patch" })).rejects.toThrow(/no worktree/);
    expect(sy.tasks.get(ids.fine!)!.result!.verification!.decisions).toEqual([]);
    expect(await run(st, "accept_task", { task_id: "fine", reason: "read the patch" })).toMatch(/accepted/);
    expect(sy.tasks.get(ids.fine!)!.result!.verification!.decisions).toEqual([expect.objectContaining({ decision: "accepted", by: { kind: "supervisor", id: "supervisor:job (job job-1)" }, reason: "read the patch" })]);
    expect(sy.tasks.get(ids.fine!)!.result!.acceptanceStatus).toBe("met");
    expect(await run(st, "reject_task", { task_id: "scope", reason: "edited README" })).toMatch(/rejected/);
    await expect(run(st, "accept_task", { task_id: "broken", reason: "fine anyway" })).rejects.toThrow(/cannot be accepted/);
  });
});
