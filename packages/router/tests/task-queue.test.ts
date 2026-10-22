import { afterEach, expect, it, vi } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { PlanStore } from "../src/storage/plans.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { SqliteTaskQueue } from "../src/storage/sqlite-task-queue.js";
import { QueueClaimSchema, QueueCompanionsSchema, QueueTasksSchema } from "../src/storage/task-queue.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; vi.restoreAllMocks(); });
function setup() {
  env = makeEnv({ config: baseConfig({ execution: { max_concurrent_tasks: 1, lease_seconds: 30 } }) });
  sy = open(env, new ScriptedClient(req => reply(JSON.stringify(goodOutput()), { model: req.model, provider: req.provider })), { worker: false });
  return new SqliteTaskQueue(sy.cfg, sy.tasks);
}
function leaderRef(id: string, runCount?: number) {
  const row = sy!.tasks.get(id)!.row;
  return { taskId: id, runCount: runCount ?? row.run_count, incarnation: row.lease_incarnation, project: row.project_id };
}
function submit(id: string, project = "demo", extra: Record<string, unknown> = {}) {
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id, ...extra }))], { project });
}

it("accepts only data-only policy-free claim requests and validates nullable/numeric SQLite receipts", async () => {
  const queue = setup(); submit("one");
  expect(QueueClaimSchema.safeParse({ owner: "owner", maxConcurrent: 999 }).success).toBe(false);
  expect(QueueClaimSchema.safeParse({ owner: "owner", predicate: () => true }).success).toBe(false);
  expect(QueueCompanionsSchema.safeParse({ owner: "owner", leader: { taskId: "one", runCount: 1 }, excludeTaskIds: [], max: 999 }).success).toBe(false);
  const tasks = await queue.claim({ owner: "owner" });
  expect(JSON.parse(JSON.stringify(tasks))).toEqual(tasks);
  expect(tasks[0]!.row).toMatchObject({ lease_owner: "owner", run_count: 1, cancel_requested: 0, result_json: null });
  expect(QueueTasksSchema.safeParse([{ ...tasks[0], row: { ...tasks[0]!.row, lease_expires_at: "later" } }]).success).toBe(false);
  expect(QueueTasksSchema.safeParse([{ ...tasks[0], spec: { ...tasks[0]!.spec, constraints: { ...tasks[0]!.spec.constraints, outputSchema: { callback: () => true } } } }]).success).toBe(false);
});

it("rolls back the shared claim transaction, fairness and provider admission on invalid stored receipt", async () => {
  setup(); submit("one");
  const spec = sy!.tasks.get("one")!.spec;
  sy!.db.prepare("UPDATE tasks SET spec_json = ? WHERE id = 'one'").run(JSON.stringify({ ...spec, goal: 42 }));
  const queue = new SqliteTaskQueue(sy!.cfg, sy!.tasks, {
    check: () => { expect(sy!.db.inTransaction).toBe(true); return null; },
    claimed: () => { sy!.db.prepare("INSERT INTO meta(key,value) VALUES ('fixture_claim','held')").run(); },
  });
  await expect(queue.claim({ owner: "owner" })).rejects.toThrow();
  expect(sy!.tasks.get("one")!.row).toMatchObject({ state: "queued", lease_owner: null, run_count: 0 });
  expect(sy!.db.prepare("SELECT key FROM meta WHERE key LIKE 'claim_pass%' OR key = 'fixture_claim'").all()).toEqual([]);
});

it("derives companion bounds and compatibility privately, preserves project and per-item token isolation", async () => {
  const queue = setup();
  submit("leader"); submit("foreign", "other"); submit("capped", "demo", { budget: { maxInputTokens: 100 } });
  for (const id of ["excluded", "a", "b", "c", "d"]) submit(id);
  const [leader] = await queue.claim({ owner: "owner" });
  expect(leader!.row.id).toBe("leader");
  const companions = await queue.claimCompanions({ owner: "owner", leader: leaderRef("leader", leader!.row.run_count), excludeTaskIds: ["excluded"] });
  expect(companions.map(task => task.row.id)).toEqual(["a", "b", "c"]);
  for (const id of ["foreign", "capped", "excluded", "d"]) expect(sy!.tasks.get(id)!.row.state).toBe("queued");
  expect(await queue.claimCompanions({ owner: "wrong", leader: leaderRef("leader", 1), excludeTaskIds: [] })).toEqual([]);
  expect(await queue.claimCompanions({ owner: "owner", leader: leaderRef("leader", 2), excludeTaskIds: [] })).toEqual([]);
});

it("uses current adapter config and the same provider policy inside atomic claim", async () => {
  setup(); submit("one"); submit("two");
  const calls: string[] = [];
  const queue = new SqliteTaskQueue(sy!.cfg, sy!.tasks, { check: row => { expect(sy!.db.inTransaction).toBe(true); return row.id === "one" ? { wait: "fixture-cap", data: {} } : null; }, claimed: row => { calls.push(row.id); } });
  sy!.cfg.execution.max_concurrent_tasks = 2;
  expect((await queue.claim({ owner: "owner" })).map(task => task.row.id)).toEqual(["two"]);
  expect(calls).toEqual(["two"]);
  expect(sy!.tasks.get("one")!.row.state_reason).toBe("waiting_for_provider_slot:fixture-cap");
});

it("the actual default service scheduler awaits the SQLite queue and completes unchanged accounting", async () => {
  setup();
  const scheduler = (sy as unknown as { scheduler: import("../src/core/scheduler.js").Scheduler }).scheduler;
  const spy = vi.spyOn(scheduler.queue, "claim");
  const [task] = await sy!.submitTasks([summarizeTask({ id: "runtime" })]);
  await scheduler.tick();
  const result = await sy!.awaitResults([task!.taskId], { timeoutSeconds: 10 });
  expect(result.completed[0]!.executionStatus).toBe("completed"); expect(spy).toHaveBeenCalledTimes(1);
  expect(sy!.db.prepare("SELECT status FROM model_requests").all()).toEqual([{ status: "succeeded" }]);
  expect(sy!.db.prepare("SELECT task_id FROM request_charges").all()).toEqual([{ task_id: "runtime" }]);
});


it("default service close waits for a pending queue claim before closing SQLite", async () => {
  setup(); submit("closing");
  const scheduler = (sy as unknown as { scheduler: import("../src/core/scheduler.js").Scheduler }).scheduler;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const claim = scheduler.queue.claim.bind(scheduler.queue);
  vi.spyOn(scheduler.queue, "claim").mockImplementation(async input => { const result = await claim(input); entered(); await blocked; return result; });
  const ticking = scheduler.tick();
  try {
    await started;
    let closed = false;
    const service = sy!;
    const closing = service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(false); expect(service.db.open).toBe(true);
    release(); await Promise.all([ticking, closing]);
    expect(closed).toBe(true); expect(service.db.open).toBe(false); sy = undefined;
  } finally { release(); }
});


it("never admits a redundant plan node as a companion or a companion to its leader", async () => {
  const queue = setup(); submit("job");
  await queue.claim({ owner: "owner" });
  sy!.tasks.finish("job", "owner", syntheticResult("job", "completed", "fixture"), "completed");
  new PlanStore(sy!.db).record("job", [{ label: "redundant", profile: "summarize", goal: "fixture", acceptanceCriteria: ["fixture"], requiresAcceptedInputs: false, weight: 1, difficulty: "T1", redundancy: 2 }]);
  submit("leader"); submit("redundant", "demo", { parentTaskId: "job", label: "redundant" }); submit("ordinary");
  await queue.claim({ owner: "owner" });
  const companions = await queue.claimCompanions({ owner: "owner", leader: leaderRef("leader", 1), excludeTaskIds: [] });
  expect(companions.map(task => task.row.id)).toEqual(["ordinary"]);
  for (const id of ["leader", "ordinary"]) sy!.tasks.interrupt(id, "owner", "fixture", 1);
  expect((await queue.claim({ owner: "owner" })).map(task => task.row.id)).toEqual(["redundant"]);
  submit("remaining");
  expect(await queue.claimCompanions({ owner: "owner", leader: leaderRef("redundant", 1), excludeTaskIds: [] })).toEqual([]);
  expect(sy!.tasks.get("remaining")!.row.state).toBe("queued");
});

it("requires full async leader identity and rejects same-owner task-ID reuse before companion allocation", async () => {
  const queue = setup(); submit("leader");
  const [leader] = await queue.claim({ owner: "owner" });
  const old = leaderRef(leader!.row.id);
  expect(QueueCompanionsSchema.safeParse({ owner: "owner", leader: { ...old, project: undefined }, excludeTaskIds: [] }).success).toBe(false);
  expect(QueueCompanionsSchema.safeParse({ owner: "owner", leader: { ...old, incarnation: undefined }, excludeTaskIds: [] }).success).toBe(false);
  expect(QueueCompanionsSchema.safeParse({ owner: "owner", leader: { taskId: "leader", runCount: 1 }, excludeTaskIds: [] }).success).toBe(false);
  sy!.tasks.interrupt("leader", "owner", "fixture");
  sy!.db.prepare("DELETE FROM events WHERE task_id='leader'").run();
  sy!.db.prepare("DELETE FROM tasks WHERE id='leader'").run();
  submit("leader"); await queue.claim({ owner: "owner" }); submit("companion");
  expect(leaderRef("leader").runCount).toBe(old.runCount);
  expect(leaderRef("leader").incarnation).not.toBe(old.incarnation);
  expect(await queue.claimCompanions({ owner: "owner", leader: old, excludeTaskIds: [] })).toEqual([]);
  expect(sy!.tasks.get("companion")!.row.state).toBe("queued");
  expect((await queue.claimCompanions({ owner: "owner", leader: leaderRef("leader"), excludeTaskIds: [] })).map(task => task.row.id)).toEqual(["companion"]);
});
