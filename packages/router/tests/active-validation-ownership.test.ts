import { afterEach, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { WorkerActionRequests, type WorkerActionRequest } from "../src/harness/worker-actions.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { SupervisorRunner } from "../src/runners/supervisor.js";
import type { RunContext, SupervisorServices } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env, type ScriptedRequest } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const controllers: AbortController[] = [], running: Promise<WorkerActionRequest>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort("fixture cleanup");
  await Promise.allSettled(running.splice(0));
  vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined;
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const call = (name: string, args: unknown) => ({ id: `call-${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

async function fixture(options: { policy?: "human_only" | "supervisor"; long?: boolean; script?: (request: ScriptedRequest) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>> } = {}) {
  const config = baseConfig({ security: { outside_repository: options.policy ?? "human_only" } });
  Object.assign(config.profiles, { supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, classify: "never", min_tier: "T3" } });
  env = makeEnv({ config });
  const client = new ScriptedClient(options.script ?? (() => reply("unused")));
  sy = open(env, client, { worker: false });
  const command = options.long
    ? `"${process.execPath}" -e "const fs=require('node:fs');fs.writeFileSync('.check-ready','ready');const t=setInterval(()=>{if(fs.existsSync('.release-check')){clearInterval(t);console.log('check-finished')}},25)"`
    : `"${process.execPath}" --version`;
  const [job, worker, sibling] = await sy.submitTasks([
    { id: "job", label: "job", profile: "supervise", goal: "Own active validation", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Checked result"] } },
    { id: "worker", label: "worker", parentTaskId: "job", profile: "inspect", goal: "Validate exact source", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Exact check passes"], checks: [command] } },
    { id: "sibling", label: "sibling", parentTaskId: "job", profile: "inspect", goal: "Independent cancellable work", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Inspect"] } },
  ]);
  expect([job, worker, sibling].map(task => task!.taskId)).toEqual(["job", "worker", "sibling"]);
  const owner = "fixture-owner";
  sy.tasks.claim(owner, { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000, supervisorProfiles: ["supervise"], maxSupervisors: 2 });
  const controller = new AbortController(); controllers.push(controller);
  const context = (id: string): RunContext => {
    const task = sy!.tasks.get(id)!;
    return { cfg: env!.cfg, profile: env!.cfg.profiles[task.spec.profile]!, tasks: sy!.tasks, taskId: id, spec: task.spec, taskLease: capturedLease(task), leaseOwner: owner, claimedRunCount: task.row.run_count, taskProject: "demo", now: Date.now, signal: controller.signal, budget: { maxModelRequests: 30, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, gate: sy!.gate, artifacts: sy!.artifacts, tier: "T3", plan: sy!.router.plan(task.spec.profile, "T3", ["text"]), brain: null, access: null, effort: "active-validation", jobId: "job", services: null, attempts: [], session: null, resume: null };
  };
  const cancelled = vi.fn((ids: string[]) => sy!.cancelTasks(ids, "demo"));
  const services = {
    submitTasks: (raw: unknown[]) => sy!.submitTasks(raw, { project: "demo" }),
    getTask: (id: string) => { const task = sy!.tasks.get(id); return task ? { spec: task.spec, state: task.row.state, result: task.result } : null; },
    cancelTasks: cancelled,
    awaitResults: async (ids: string[]) => { await sleep(25); const tasks = ids.map(id => sy!.tasks.get(id)!); return { completed: tasks.flatMap(task => task.result ? [task.result] : []), pending: tasks.filter(task => !task.result).map(task => ({ taskId: task.row.id, state: task.row.state })), timedOut: true, waitedSeconds: 0.025 }; },
    acceptTask: (id: string, input: Parameters<MeritRouter["acceptTask"]>[1]) => sy!.acceptTask(id, input),
    rejectTask: (id: string, input: Parameters<MeritRouter["rejectTask"]>[1]) => sy!.rejectTask(id, input),
  } satisfies SupervisorServices;
  const ctx = { ...context("job"), services };
  const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:job", role: "supervisor", task: "job", job: "job" }, repos: new Map(), briefChecks: new Set(), children: new Map([["worker", "worker"], ["sibling", "sibling"]]) };
  const tools = supervisorTools(state), harness: HarnessEnv = { ctx, role: "supervisor", readers: new Map(), universe: { refs: new Map() }, allowArtifacts: false, edits: new Set() };
  const store = new WorkerActionRequests(sy.db);
  const request = await store.file(context("worker"), { command, cwd: env.repo, timeoutMs: 10_000, reason: "Exact temporary fixture validation" });
  const cancel = (ids = ["worker"]) => tools.find(tool => tool.def.function.name === "cancel_tasks")!.run({ task_ids: ids }, harness);
  const approve = () => {
    const promise = store.decide({ project: "demo", id: request.id, decision: "approve", reason: "Trusted fixture operator approves exact command", actor: { kind: "operator" }, config: env!.cfg, signal: controller.signal });
    running.push(promise); return promise;
  };
  const ready = async () => {
    for (let i = 0; i < 200 && !existsSync(path.join(env!.repo, ".check-ready")); i++) await sleep(25);
    expect(existsSync(path.join(env!.repo, ".check-ready"))).toBe(true);
    expect(store.get("demo", request.id)?.status).toBe("running");
  };
  return { ctx, state, store, request, cancelled, context, cancel, approve, ready,
    release: () => writeFileSync(path.join(env!.repo, ".release-check"), "continue"),
    wait: () => tools.find(tool => tool.def.function.name === "await_tasks")!.run({ task_ids: ["worker"], timeout_seconds: 1 }, harness) };
}
function row() { return sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE task_id='worker'").pluck().get() as string; }

it("refuses internal cancellation while exact human approval is pending", async () => {
  const f = await fixture(), before = row(), task = sy!.tasks.get("worker");
  await expect(f.cancel()).rejects.toThrow(/awaiting human approval/);
  expect(f.cancelled).not.toHaveBeenCalled(); expect(row()).toBe(before); expect(sy!.tasks.get("worker")).toEqual(task);
});
it("refuses operator-approved running execution and reports actual running state", async () => {
  const f = await fixture({ long: true }), executing = f.approve();
  await f.ready();
  const before = row();
  await expect(f.cancel()).rejects.toThrow(/operator-approved and running/);
  expect(f.cancelled).not.toHaveBeenCalled(); expect(row()).toBe(before); expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(0);
  const observation = await f.wait();
  expect(observation).toContain("running; approved by operator; execution in progress");
  expect(observation).not.toContain("awaiting human operator approval");
  f.release(); expect((await executing).exitCode).toBe(0);
});
it("distinguishes current running actions from inactive persisted running generations without altering them", async () => {
  const f = await fixture();
  sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.status','running','$.decidedBy','operator') WHERE id=?").run(f.request.id);
  const current = row();
  expect(await f.wait()).toContain("running; approved by operator; execution in progress");
  const lease = f.request.action.lease;
  const stale = [
    { ...lease, owner: "previous-owner" },
    { ...lease, runCount: lease.runCount + 1 },
    { ...lease, incarnation: "f".repeat(32) },
    { ...lease, project: "foreign" },
    { ...lease, taskId: "sibling" },
  ];
  for (const obsolete of stale) {
    sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(?,'$.action.lease',json(?)) WHERE id=?").run(current, JSON.stringify(obsolete), f.request.id);
    const before = row(), observation = await f.wait();
    expect(observation).toContain("persisted running from inactive generation; unresolved, requires operator reconciliation");
    expect(observation).not.toContain("execution in progress");
    expect(row()).toBe(before);
  }
  sy!.db.prepare("UPDATE worker_action_requests SET value_json=? WHERE id=?").run(current, f.request.id);
  sy!.db.prepare("UPDATE tasks SET deadline_at=? WHERE id='worker'").run(Date.now() - 1);
  expect(await f.wait()).toContain("persisted running from inactive generation; unresolved, requires operator reconciliation");
  expect(row()).toBe(current);
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(0);
}, 15_000);

it("refuses an entire mixed cancellation batch before changing an unprotected sibling", async () => {
  const f = await fixture(), sibling = sy!.tasks.get("sibling"), before = row();
  await expect(f.cancel(["sibling", "worker"])).rejects.toThrow(/awaiting human approval/);
  expect(f.cancelled).not.toHaveBeenCalled(); expect(sy!.tasks.get("sibling")).toEqual(sibling); expect(row()).toBe(before);
});
it("allows ordinary unprotected cancellation and pending supervisor-policy cleanup", async () => {
  const f = await fixture({ policy: "supervisor" });
  expect(await f.cancel(["sibling", "worker"])).toBe("cancellation requested");
  expect(f.cancelled).toHaveBeenCalledOnce(); expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(1);
});
it.each(["run", "incarnation", "foreign-action", "terminal"])("does not protect stale or nonauthoritative action state: %s", async mutation => {
  const f = await fixture();
  if (mutation === "run") sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.action.lease.runCount',999) WHERE id=?").run(f.request.id);
  if (mutation === "incarnation") sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.action.lease.incarnation',?) WHERE id=?").run("f".repeat(32), f.request.id);
  if (mutation === "foreign-action") sy!.db.prepare("UPDATE worker_action_requests SET project_id='foreign' WHERE id=?").run(f.request.id);
  if (mutation === "terminal") await f.store.decide({ project: "demo", id: f.request.id, decision: "deny", reason: "Explicit fixture denial", actor: { kind: "operator" }, config: env!.cfg });
  expect(await f.cancel()).toBe("cancellation requested");
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(1);
});
it("allows cancellation after approved execution has quiesced normally", async () => {
  const f = await fixture(); expect((await f.approve()).status).toBe("completed");
  expect(await f.cancel()).toBe("cancellation requested");
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(1);
});
it("preserves external operator cancellation of an approved running command", async () => {
  const f = await fixture({ long: true }), executing = f.approve(); await f.ready();
  sy!.cancelTasks(["worker"], "demo");
  const result = await executing;
  expect(result.status).toBe("uncertain"); expect(result.quiescedAt).toBeTypeOf("number");
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(1);
});
it("refuses stale supervisor authority and foreign/non-owned target IDs", async () => {
  const f = await fixture();
  await expect(f.cancel(["job"])).rejects.toThrow(/not a task of this job/);
  sy!.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id='job'").run();
  await expect(f.cancel(["sibling"])).rejects.toThrow(/active owning supervisor/);
  expect(f.cancelled).not.toHaveBeenCalled();
});

it("protects active approved work belonging to an owned sub-supervisor descendant", async () => {
  const f = await fixture();
  await sy!.submitTasks([
    { id: "subjob", label: "subjob", parentTaskId: "job", profile: "supervise", goal: "Nested bounded verification", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Nested check"] } },
    { id: "grandchild", label: "grandchild", parentTaskId: "subjob", profile: "inspect", goal: "Exact descendant check", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["check"] } },
  ]);
  sy!.tasks.claim("fixture-owner", { maxConcurrent: 6, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000, supervisorProfiles: ["supervise"], maxSupervisors: 3 });
  f.state.children.set("subjob", "subjob");
  const nested = await f.store.file(f.context("grandchild"), { command: `"${process.execPath}" --version`, cwd: env!.repo, timeoutMs: 5000, reason: "Exact nested fixture check" });
  await expect(f.cancel(["subjob"])).rejects.toThrow(nested.id);
  expect(f.cancelled).not.toHaveBeenCalled();
  expect(sy!.tasks.get("subjob")!.row.cancel_requested).toBe(0);
  expect(sy!.tasks.get("grandchild")!.row.cancel_requested).toBe(0);
});
it("serializes an operator approval racing internal cancellation without revoking approval", async () => {
  const f = await fixture({ long: true });
  const executing = f.approve();
  await expect(f.cancel()).rejects.toThrow(/human approval|operator-approved and running/);
  await f.ready();
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(0);
  f.release(); expect((await executing).exitCode).toBe(0);
});
it("allows expired-action cleanup without treating the old action as current authority", async () => {
  const f = await fixture();
  sy!.db.prepare("UPDATE tasks SET deadline_at=? WHERE id='worker'").run(Date.now() - 1);
  expect(await f.cancel()).toBe("cancellation requested");
  expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(1);
});
it("retains legitimate supervisor-policy cancellation of its own approved action", async () => {
  const f = await fixture({ policy: "supervisor", long: true });
  const executing = f.store.decide({ project: "demo", id: f.request.id, decision: "approve", reason: "Internal fixture approval", actor: { kind: "supervisor", taskId: "job", lease: f.ctx.taskLease! }, config: env!.cfg, signal: f.ctx.signal });
  running.push(executing); await f.ready();
  expect(f.store.get("demo", f.request.id)?.decidedBy).toBe("job");
  expect(await f.cancel()).toBe("cancellation requested");
  expect((await executing).quiescedAt).toBeTypeOf("number");
});

it("actual supervisor cannot cancel approved validation then finish blocked; it continues after the check settles", async () => {
  let f: Awaited<ReturnType<typeof fixture>>, executing: Promise<WorkerActionRequest>, step = 0;
  f = await fixture({ long: true, script: async request => {
    const served = { model: request.model, provider: request.provider };
    if (step++ === 0) return reply(null, { ...served, toolCalls: [call("finish_job", { status: "blocked", summary: "Stale pending-approval claim", verified: [], not_verified: ["work unfinished"] })] });
    expect(JSON.stringify(request.messages)).toContain("continue await_tasks until they settle");
    expect(sy!.tasks.get("worker")!.row.cancel_requested).toBe(0);
    const checked = await executing; expect(checked.exitCode).toBe(0);
    sy!.tasks.finish("worker", f.context("worker").leaseOwner, syntheticResult("worker", "completed", "observed exact command exit0"), "completed");
    sy!.tasks.finish("sibling", f.context("sibling").leaseOwner, syntheticResult("sibling", "completed", "fixture independent work done"), "completed");
    return reply(null, { ...served, toolCalls: [call("finish_job", { status: "completed", summary: "Exact validation finished", verified: [{ claim: "command passed", evidence: "operator executed command exit0" }], not_verified: [] })] });
  } });
  executing = f.approve(); await f.ready();
  // The exact action is still operator-approved and running in the source checkout: internal
  // cancellation of it is refused, same as "refuses operator-approved running execution" above.
  await expect(f.cancel()).rejects.toThrow(/operator-approved and running/);
  expect(f.cancelled).not.toHaveBeenCalled();
  // SupervisorRunner.run's own startup takes a mutation scope over that same source checkout
  // (integrationRepos) to create its integration worktree. Since b87f326 that scope is refused
  // while this exact approved command is active there; startup now waits for it to settle
  // instead of failing outright (Cause 3). Nothing inside the agent loop can release it --
  // startup blocks before any model turn runs -- so settle it from outside the loop, the way the
  // real operator's own command completion would, rather than waiting out the command's native
  // ~10s timeout kill (which would leave a non-zero/"uncertain" outcome instead of exitCode 0).
  setTimeout(() => f.release(), 20);
  const outcome = await new SupervisorRunner().run(f.ctx);
  expect(outcome.result.stopReason).toBe("supervisor_completed"); expect(step).toBe(2);
  expect(f.cancelled).not.toHaveBeenCalled(); expect(f.store.get("demo", f.request.id)?.exitCode).toBe(0);
}, 30_000);

it("does not wait on an uncertain admission refusal; only a known active_command waits", async () => {
  const f = await fixture();
  const mutation = await import("../src/workspaces/repository-mutation.js");
  const spy = vi.spyOn(mutation, "withRepositoryMutation").mockImplementationOnce(() =>
    Promise.reject(new mutation.RepositoryMutationError("command_uncertain", "Command completion or receipt retirement is unverified; guard retained")));
  const started = Date.now();
  await expect(new SupervisorRunner().run(f.ctx)).rejects.toThrow(/unverified; guard retained/);
  // A refusal of any kind other than active_command (and an active_command with no verified,
  // known, live, host-owned receipt) is refused immediately; it never enters the settle-wait loop.
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(spy).toHaveBeenCalledTimes(1);
});
