import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { WorkerTaskSchema, type WorkerResult } from "../src/core/task.js";
import { syntheticResult, type ClaimLimits } from "../src/storage/tasks.js";
import { PlanStore, type PlanNodeInput } from "../src/storage/plans.js";
import { agentTimeline, jobMetrics, teamMetrics, WAITING_FOR_PROVIDER_SLOT } from "../src/admin/job-metrics.js";
import { comparisonRequestsToday, comparisons, planComparison, runComparison } from "../src/qualification/comparison.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

// The CLI runs from dist/ (build first: pnpm --filter switchyard-router build).
const cliJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|FREELLMAPI|SWITCHYARD/i.test(k)));
}
function cli(e: Env, ...args: string[]) {
  const r = spawnSync(process.execPath, [cliJs, ...args, "--config", e.cfg.configPath], { encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function teamConfig(extra: Record<string, unknown> = {}) {
  const cfg = baseConfig({ team: { max_agents: 8 }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

const T0 = 1_760_000_000_000;
const S = 1000;
let clock = T0;
const at = (seconds: number) => {
  clock = T0 + seconds * S;
};
const LIMITS: ClaimLimits = { maxConcurrent: 20, maxWritersPerRepo: 10, leaseMs: 600_000, defaultTimeoutMs: 600_000, supervisorProfiles: ["supervise"], maxSupervisors: 1 };
const done = (id: string): WorkerResult => ({ ...syntheticResult(id, "completed", "done"), acceptanceStatus: "met", summary: `summary of ${id}` });
const task = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
  WorkerTaskSchema.parse({ id, label: id.replace(/^t_/, ""), parentTaskId: parent, profile: "inspect", goal: `do ${id}`, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] }, ...extra });
const coding = (id: string, parent: string, allowedPaths: string[], dependsOn: string[]) =>
  task(id, parent, { profile: "implement", writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths }, dependsOn });
const node = (label: string, dependsOn: string[], difficulty: "T1" | "T2" | "T3", weight: number): PlanNodeInput => ({ label, profile: "inspect", goal: `do ${label}`, acceptanceCriteria: ["x"], dependsOn, requiresAcceptedInputs: false, weight, difficulty });

/** Insert a model request charged to `taskIds` (the request ledger, as the gate records it). */
function request(s: Switchyard, id: string, purpose: string, taskIds: string[], o: { status?: string; reported?: number; estimated?: number } = {}) {
  s.db.prepare("INSERT OR IGNORE INTO executions (id, kind, profile, status, created_at) VALUES ('x_metrics', 'task', 'inspect', 'finished', ?)").run(T0);
  s.db
    .prepare("INSERT INTO model_requests (id, execution_id, purpose, gateway_model, status, reserved_at, est_input_tokens, reserved_output_tokens, reported_cost_usd, estimated_cost_usd, served_endpoint_id) VALUES (?, 'x_metrics', ?, 'auto:x', ?, ?, 10, 10, ?, ?, 'ep-1')")
    .run(id, purpose, o.status ?? "succeeded", clock, o.reported ?? null, o.estimated ?? null);
  for (const t of taskIds) s.db.prepare("INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens) VALUES (?, ?, 10, 10)").run(id, t);
}

/**
 * A job with known intervals (seconds after T0): J runs 1-50. A runs 3-13; E (submitted 3.5)
 * waits for a provider slot 4-6 and runs 6-9; B and C depend on A; B runs 14-24 while C waits
 * for B's file lease 14-25, runs 25-27, is deferred for capacity 27-30, and runs 30-40; D
 * depends on B and C and runs 41-45.
 */
function seedJob(s: Switchyard, job = "t_job") {
  at(0);
  s.tasks.submit([WorkerTaskSchema.parse({ id: job, label: "metrics-job", profile: "supervise", goal: "A diamond with known intervals", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } })]);
  at(1);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual([job]);
  at(2);
  new PlanStore(s.db, () => clock).record(job, [node("a", [], "T1", 1), node("e", [], "T1", 1), node("b", ["a"], "T2", 2), node("c", ["a"], "T3", 4), node("d", ["b", "c"], "T1", 1)], { createdBy: "supervisor:test" });
  s.tasks.submit([task("t_a", job), coding("t_b", job, ["src/a.ts"], ["t_a"])]);
  at(2.5);
  s.tasks.submit([coding("t_c", job, ["src/**"], ["t_a"])]);
  s.tasks.submit([task("t_d", job, { dependsOn: ["t_b", "t_c"] })]);
  at(3);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_a"]);
  at(3.5);
  s.tasks.submit([task("t_e", job)]);
  at(4);
  // The capacity worker's scheduler records this when no provider in the plan has a free slot.
  s.tasks.event("t_e", WAITING_FOR_PROVIDER_SLOT, { providers: ["groq"] });
  at(6);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_e"]);
  at(9);
  s.tasks.finish("t_e", "w", done("t_e"), "completed");
  at(13);
  s.tasks.finish("t_a", "w", done("t_a"), "completed");
  at(14);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_b"]);
  at(24);
  s.tasks.finish("t_b", "w", done("t_b"), "completed");
  at(25);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_c"]);
  at(27);
  expect(s.tasks.deferForCapacity("t_c", "w", T0 + 30 * S, "pool cooling")).toBe(true);
  at(30);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_c"]);
  at(40);
  s.tasks.finish("t_c", "w", done("t_c"), "completed");
  at(41);
  expect(s.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_d"]);
  at(45);
  s.tasks.finish("t_d", "w", done("t_d"), "completed");
  at(50);
  s.tasks.finish(job, "w", done(job), "completed");
  // The request ledger: 12 distinct requests (one batch request charged to A and E counts once).
  for (const id of ["r1", "r2", "r3"]) request(s, id, "agent_loop", [job]);
  request(s, "r4", "tool_loop", ["t_a"]);
  request(s, "r5", "tool_loop", ["t_a"]);
  request(s, "r6", "verification", ["t_a"], { estimated: 0.01 });
  request(s, "r7", "tool_loop", ["t_b"]);
  request(s, "r8", "repair", ["t_b"], { reported: 0.005 });
  request(s, "r9", "tool_loop", ["t_c"], { status: "failed" });
  request(s, "r10", "tool_loop", ["t_c"], { estimated: 0.01 });
  request(s, "r11", "verification", ["t_d"]);
  request(s, "r12", "batch", ["t_a", "t_e"]);
}

const sec = (s: number) => T0 + s * S;

describe("job metrics", () => {
  it("derives wall-clock, parallelism, critical paths, requests, cost, and waiting time by reason from stored data", () => {
    env = makeEnv({ config: teamConfig() });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false, now: () => clock });
    seedJob(sy);
    const m = jobMetrics(sy, "t_job", { now: sec(100) })!;
    expect(m).toMatchObject({ kind: "team", label: "metrics-job", state: "completed", startedAt: sec(1), finishedAt: sec(50), wallClockMs: 49 * S, queuedMs: 1 * S });
    expect(m.tasks).toEqual({ agents: 5, completed: 5, failed: 0, open: 0, subJobs: 0 });

    // Parallelism: change points of running agents and waiting tasks.
    expect(m.parallelism.points.map((p) => [(p.at - T0) / S, p.running, p.waiting])).toEqual([
      [1, 0, 0],
      [2, 0, 2],
      [2.5, 0, 4],
      [3, 1, 3],
      [3.5, 1, 4],
      [6, 2, 3],
      [9, 1, 3],
      [13, 0, 3],
      [14, 1, 2],
      [24, 0, 2],
      [25, 1, 1],
      [27, 0, 2],
      [30, 1, 1],
      [40, 0, 1],
      [41, 1, 0],
      [45, 0, 0],
      [50, 0, 0],
    ]);
    expect(m.parallelism).toMatchObject({ peak: 2, mean: 0.8, busyMs: 36 * S, agentMs: 39 * S });
    expect([m.peakParallelism, m.meanParallelism]).toEqual([2, 0.8]);

    // Critical path: planned by estimated cost, actual by agent time (a 10s, c 12s, d 4s).
    expect(m.criticalPath.planned).toEqual({ labels: ["a", "c", "d"], cost: 6, agentMs: 26 * S });
    expect(m.criticalPath.actual).toEqual({ labels: ["a", "c", "d"], agentMs: 26 * S });

    // Requests and cost across the tree (the supervisor's own included), per completed task.
    expect(m.requests).toBe(12);
    expect(m.requestsByPurpose).toEqual({ classification: 0, execution: 9, verification: 2, repair: 1 });
    expect(m.failedRequests).toBe(1);
    expect(m.costUsd).toBeCloseTo(0.025, 9);
    expect(m.requestsPerCompletedTask).toBe(2.4);
    expect(m.costPerCompletedTaskUsd).toBeCloseTo(0.005, 9);
    expect(m.verificationShare).toBe(0.167);

    // Waiting by reason: B 12s + C 11.5s + D 38.5s on dependencies; A 1s + E 0.5s ready in the queue.
    expect(m.waiting.byReason).toEqual({ dependencies: 62 * S, acceptance: 0, file_lease: 11 * S, provider_slot: 2 * S, project_cap: 0, capacity: 3 * S, queue: 1.5 * S, interrupted: 0 });
    expect(m.waitingMs).toBe(79.5 * S);
    expect(m.waiting.tasksThatWaited).toBe(5);
    expect(m.agents.find((a) => a.taskId === "t_c")!.runs.map((r) => [(r.start - T0) / S, (r.end - T0) / S])).toEqual([[25, 27], [30, 40]]);

    // One agent's task: the same measures for a single run.
    const a = jobMetrics(sy, "t_a", { now: sec(100) })!;
    expect(a).toMatchObject({ kind: "single", parentJobId: "t_job", wallClockMs: 10 * S, peakParallelism: 1, meanParallelism: 1, requests: 4, completedTasks: 1, requestsPerCompletedTask: 4 });
    expect(a.criticalPath).toEqual({ planned: null, actual: { labels: ["a"], agentMs: 10 * S } });
    expect(jobMetrics(sy, "nope")).toBeNull();
    expect(teamMetrics(sy, { now: sec(100) }).map((s) => [s.jobId, s.requests])).toEqual([["t_job", 12]]);
  });

  it("counts a sub-job's tasks in its parent, summarises the sub-job, and stops a stalled job's clock", () => {
    env = makeEnv({ config: teamConfig() });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false, now: () => clock });
    at(0);
    sy.tasks.submit([WorkerTaskSchema.parse({ id: "t_parent", profile: "supervise", goal: "parent", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } })]);
    expect(sy.tasks.claim("w", LIMITS).map((t) => t.row.id)).toEqual(["t_parent"]);
    at(1);
    sy.tasks.submit([task("t_sub", "t_parent", { profile: "supervise" }), task("t_side", "t_parent")]);
    at(2);
    expect(sy.tasks.claim("w", LIMITS).map((t) => t.row.id).sort()).toEqual(["t_side", "t_sub"]);
    sy.tasks.submit([task("t_w1", "t_sub"), task("t_w2", "t_sub")]);
    at(3);
    expect(sy.tasks.claim("w", LIMITS).map((t) => t.row.id).sort()).toEqual(["t_w1", "t_w2"]);
    at(5);
    for (const id of ["t_w1", "t_w2", "t_side"]) sy.tasks.finish(id, "w", done(id), "completed");
    at(6);
    sy.tasks.finish("t_sub", "w", done("t_sub"), "completed");
    at(8);
    // The worker dies: the parent is left interrupted and its clock stops at the interruption.
    sy.tasks.interrupt("t_parent", "w", "worker shut down");
    const m = jobMetrics(sy, "t_parent", { now: sec(500) })!;
    expect(m.tasks).toEqual({ agents: 4, completed: 3, failed: 0, open: 0, subJobs: 1 });
    expect(m).toMatchObject({ wallClockMs: 8 * S, peakParallelism: 4 });
    expect(m.subJobs.map((s) => [s.jobId, s.kind, s.parentJobId, s.peakParallelism, s.wallClockMs])).toEqual([["t_sub", "team", "t_parent", 2, 4 * S]]);
    expect(m.criticalPath.actual).toEqual({ labels: ["sub"], agentMs: 4 * S });
  });

  it("attributes a ready task's wait to a provider slot from its state reason alone", () => {
    env = makeEnv({ config: teamConfig() });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false, now: () => clock });
    at(0);
    sy.tasks.submit([WorkerTaskSchema.parse({ id: "t_x", profile: "inspect", goal: "x", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } })]);
    at(4);
    sy.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = 't_x'").run(`${WAITING_FOR_PROVIDER_SLOT}:groq`, clock);
    const t = sy.tasks.get("t_x")!;
    const tl = agentTimeline(t, sy.tasks.events("t_x").map((e) => ({ ts: e.ts, type: e.type, data: e.data === null ? null : JSON.stringify(e.data) })), sec(10));
    expect(tl.waits.map((w) => [w.reason, (w.start - T0) / S, (w.end - T0) / S])).toEqual([["queue", 0, 4], ["provider_slot", 4, 10]]);
    expect(tl.runs).toEqual([]);
  });

  it("prints metrics in the CLI and as JSON (needs dist/cli.js)", () => {
    env = makeEnv({ config: teamConfig() });
    sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false, now: () => clock });
    seedJob(sy);
    const text = cli(env, "metrics", "t_job");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("job t_job (metrics-job) completed: A diamond with known intervals");
    expect(text.stdout).toContain("wall-clock 49.0s; queued 1.0s before it started");
    expect(text.stdout).toContain("parallelism: peak 2, mean 0.80 over the wall-clock; busy 36.0s; agent time 39.0s");
    expect(text.stdout).toContain("critical path (actual, by agent time): a -> c -> d 26.0s");
    expect(text.stdout).toContain("critical path (planned, by estimated cost 6): a -> c -> d; took 26.0s of agent time");
    expect(text.stdout).toContain("requests 12 (execution 9, verification 2, repair 1; 1 failed); 2.4 per completed task");
    expect(text.stdout).toContain("verification share 17% of requests");
    expect(text.stdout).toContain("waiting 1m19s across 5 tasks: dependencies 1m2s, file lease 11.0s, provider slot 2.0s, capacity 3.0s, queue 1.5s");
    expect(text.stdout).toMatch(/running agents over time \(peak 2\): \|.+\|/);
    const json = JSON.parse(cli(env, "metrics", "t_job", "--json").stdout) as { requests: number; waiting: { byReason: Record<string, number> } };
    expect(json.requests).toBe(12);
    expect(json.waiting.byReason.provider_slot).toBe(2 * S);
    const missing = cli(env, "metrics", "nope");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("unknown job or task nope");
    expect(cli(env, "metrics").stderr).toContain("usage: switchyard metrics <job-id|task-id>");
  }, 60_000);
});

// ---------- team vs single comparison (fake gateway; never a live provider) ----------

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");

const GOALS = [{ id: "where-add", goal: "Where is add() defined?", repository: "core", profile: "inspect", acceptanceCriteria: ["cites the line"], singleRequests: 4, teamRequests: 10 }];

describe("team vs single comparison", () => {
  it("states the planned budget, runs each goal as a team and as one agent, and records both metric sets", async () => {
    env = makeEnv({ config: teamConfig() });
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) {
        const script = [
          () => [call("delegate", { tasks: [{ label: "find-add", profile: "inspect", goal: "Find where add() is defined.", acceptance_criteria: ["cites the line"], file_refs: ["core:src/app.ts"] }] })],
          () => [call("await_tasks", { timeout_seconds: 30 })],
          () => [call("finish_job", { status: "completed", summary: "add() is in src/app.ts.", verified: [{ claim: "add is defined in src/app.ts", evidence: "worker citation" }], not_verified: [] })],
        ];
        return reply(null, { ...s, toolCalls: script[Math.min(turns(req), 2)]!() });
      }
      // Workers read the file they cite, then submit.
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
    });
    sy = open(env, client, { worker: true });
    const plan = planComparison(sy, { goals: GOALS });
    expect(plan).toMatchObject({ plannedRequests: 14, dailyAllocation: 200, usedToday: 0, remaining: 200, fits: true });
    expect(plan.goals[0]).toMatchObject({ id: "where-add", source: "supplied", repository: "core", singleRequests: 4, teamRequests: 10 });
    expect(() => planComparison(sy!, { goals: [{ ...GOALS[0], repository: "nope" }] })).toThrow(/unknown repository nope/);
    expect(() => planComparison(sy!, { goals: [{ ...GOALS[0], profile: "implement" }] })).toThrow(/implement goals need allowedPaths/);

    const progress: string[] = [];
    const c = await runComparison(sy, plan, { timeoutSeconds: 60, onProgress: (l) => progress.push(l) });
    expect(c).toMatchObject({ status: "finished", plannedRequests: 14 });
    expect(c.results).toHaveLength(1);
    const r = c.results[0]!;
    expect(r.team.metrics).toMatchObject({ state: "completed", agents: 1, completedTasks: 1, peakParallelism: 1 });
    expect(r.team.metrics.requests).toBeGreaterThanOrEqual(5);
    expect(r.team).toMatchObject({ stoppedAtCap: false, timedOut: false, requestCap: 10 });
    expect(r.single.metrics).toMatchObject({ state: "completed", agents: 1, completedTasks: 1, requests: 2 });
    expect(r.single.endpoints.length).toBeGreaterThan(0);
    expect(sy.tasks.get(r.team.taskId)!.spec.profile).toBe("supervise");
    expect(sy.tasks.get(r.single.taskId)!.spec.profile).toBe("inspect");
    expect(progress.length).toBe(4);
    expect(comparisons(sy).map((x) => x.id)).toEqual([c.id]);
    // The runs count against today's qualification allocation.
    expect(comparisonRequestsToday(sy)).toBe(r.team.metrics.requests + r.single.metrics.requests);
    expect(planComparison(sy, { goals: GOALS }).usedToday).toBe(r.team.metrics.requests + r.single.metrics.requests);
  }, 120_000);

  it("stops a team run at its request cap and refuses a plan that does not fit today's allocation", async () => {
    env = makeEnv({ config: teamConfig({ qualification: { max_requests_per_day: 20 } }) });
    // The supervisor delegates three workers that keep reading files (each request takes 150 ms)
    // until the runner cancels the team at its cap; the single agent answers at once.
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) {
        if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("delegate", { tasks: ["one", "two", "three"].map((label) => ({ label, profile: "inspect", goal: `Read every file (${label}).`, acceptance_criteria: ["reads them"] })) })] });
        return reply(null, { ...s, toolCalls: [call("await_tasks", { timeout_seconds: 30 }, `await${turns(req)}`)] });
      }
      if (/Read every file/.test(JSON.stringify(req.messages))) {
        await new Promise((r) => setTimeout(r, 150));
        return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts", start_line: turns(req) + 1 }, `read${turns(req)}`)] });
      }
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
    });
    sy = open(env, client, { worker: true });
    const tooBig = planComparison(sy, { goals: [{ ...GOALS[0], teamRequests: 30 }] });
    expect(tooBig).toMatchObject({ plannedRequests: 34, remaining: 20, fits: false });
    await expect(runComparison(sy, tooBig)).rejects.toThrow(/could use up to 34 requests but only 20/);
    expect(comparisons(sy)).toEqual([]);

    const plan = planComparison(sy, { goals: [{ ...GOALS[0], teamRequests: 5 }] });
    const c = await runComparison(sy, plan, { timeoutSeconds: 60, pollMs: 100 });
    const r = c.results[0]!;
    expect(r.team.stoppedAtCap).toBe(true);
    expect(r.team.metrics.state).toBe("cancelled");
    // At or a little over the cap (requests in flight when it was reached), never the 13 the team could make.
    expect(r.team.metrics.requests).toBeGreaterThanOrEqual(5);
    expect(r.team.metrics.requests).toBeLessThanOrEqual(8);
    expect(r.single.metrics.state).toBe("completed");
  }, 120_000);

  it("states the plan in the CLI and runs nothing without --yes (needs dist/cli.js)", () => {
    env = makeEnv({ config: teamConfig() });
    const goals = path.join(env.dir, "goals.json");
    writeFileSync(goals, JSON.stringify(GOALS));
    const dry = cli(env, "compare", "--goals", goals, "--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("comparison plan: 1 goal, each run as a team job and as a single agent");
    expect(dry.stdout).toContain("planned request budget: up to 14 requests");
    expect(dry.stdout).toContain("qualification allocation today: 0 of 200 used, 200 left -> fits");
    expect(dry.stdout).toContain("dry run: nothing ran");
    const noYes = cli(env, "compare", "--goals", goals);
    expect(noYes.stdout).toContain("nothing ran: add --yes to run it (up to 14 requests)");
    const evals = cli(env, "compare", "--eval", "fix-range", "--dry-run", "--json");
    expect(JSON.parse(evals.stdout)).toMatchObject({ plannedRequests: 8 + 24, goals: [{ id: "fix-range", source: "eval", teamRequests: 24 }] });
    expect(cli(env, "compare", "--eval", "nope", "--dry-run").stderr).toContain("unknown or review-only evals: nope");
    expect(cli(env, "compare", "list").stdout.trim()).toBe("(none)");
    expect(cli(env, "compare", "show", "cmp_x").stderr).toContain("unknown comparison cmp_x");
  }, 60_000);
});
