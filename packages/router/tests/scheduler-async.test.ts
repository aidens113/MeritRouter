import { afterEach, expect, it, vi } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { Scheduler } from "../src/core/scheduler.js";
import type { Executor } from "../src/core/executor.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: Switchyard | undefined, scheduler: Scheduler | undefined;
const releases: Array<() => void> = [];
afterEach(async () => { releases.splice(0).forEach(release => release()); await scheduler?.stop(); scheduler = undefined; await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; vi.restoreAllMocks(); });
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); releases.push(release); return { promise, release }; }
function setup(batch = false) {
  env = makeEnv({ config: baseConfig({ execution: { max_concurrent_tasks: 1, lease_seconds: 30 }, profiles: { ...baseConfig().profiles, summarize: { mode: "completion", batching: { enabled: batch, max_items: 3 } } } }) });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const executor = { checkWatchdog: vi.fn(), abortAll: vi.fn(), runSingle: vi.fn(async () => undefined), runBatch: vi.fn(async () => undefined) };
  scheduler = new Scheduler(sy.cfg, sy.tasks, executor as unknown as Executor, "queue-owner");
  return { executor, queue: scheduler.queue };
}
function submit(...ids: string[]) { sy!.tasks.submit(ids.map(id => WorkerTaskSchema.parse(summarizeTask({ id }))), { project: "demo" }); }

it("serializes concurrent ticks while awaiting a queue claim", async () => {
  const { executor, queue } = setup(); submit("one");
  const entered = barrier(), blocked = barrier();
  const claim = queue.claim.bind(queue);
  let active = 0, peak = 0;
  const spy = vi.spyOn(queue, "claim").mockImplementation(async input => {
    peak = Math.max(peak, ++active); entered.release(); await blocked.promise;
    try { return await claim(input); } finally { active--; }
  });
  const first = scheduler!.tick(); await entered.promise;
  const second = scheduler!.tick(); expect(second).toBe(first);
  expect(executor.runSingle).not.toHaveBeenCalled(); blocked.release();
  await Promise.all([first, second]);
  expect(peak).toBe(1); expect(spy).toHaveBeenCalledTimes(2);
  expect(executor.runSingle).toHaveBeenCalledTimes(1);
});

it.each(["claim", "claimCompanions"] as const)("stop drains committed pending %s and interrupts all new leases without dispatch", async operation => {
  const { executor, queue } = setup(operation === "claimCompanions"); submit("one", "two", "three");
  const entered = barrier(), blocked = barrier();
  const original = queue[operation].bind(queue);
  vi.spyOn(queue, operation).mockImplementation(async (input: any) => {
    const receipt = await original(input); entered.release(); await blocked.promise; return receipt;
  });
  const ticking = scheduler!.tick(); await entered.promise;
  let stopped = false;
  const stopping = scheduler!.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); expect(sy!.db.open).toBe(true);
  blocked.release(); await Promise.all([ticking, stopping]);
  expect(executor.runSingle).not.toHaveBeenCalled(); expect(executor.runBatch).not.toHaveBeenCalled();
  const rows = sy!.tasks.list();
  expect(rows.filter(task => task.row.lease_owner !== null)).toHaveLength(0);
  expect(rows.filter(task => task.row.state === "interrupted")).toHaveLength(operation === "claim" ? 1 : 3);
});

it.each(["owner", "expiry", "cancel", "deadline", "generation"])("never dispatches a persisted %s change during async claim", async change => {
  const { executor, queue } = setup(); submit("one");
  const entered = barrier(), blocked = barrier(); const claim = queue.claim.bind(queue);
  vi.spyOn(queue, "claim").mockImplementation(async input => { const rows = await claim(input); entered.release(); await blocked.promise; return rows; });
  const ticking = scheduler!.tick().catch(error => error); await entered.promise;
  const mutation = { owner: "lease_owner = 'foreign'", expiry: "lease_expires_at = 0", cancel: "cancel_requested = 1", deadline: "deadline_at = 0", generation: "run_count = run_count + 1, lease_owner = 'foreign'" }[change]!;
  sy!.db.prepare("UPDATE tasks SET " + mutation + " WHERE id = 'one'").run();
  blocked.release(); await ticking;
  expect(executor.runSingle).not.toHaveBeenCalled(); expect(executor.runBatch).not.toHaveBeenCalled();
  const row = sy!.tasks.get("one")!.row;
  if (change === "owner" || change === "generation") expect(row.lease_owner).toBe("foreign");
  else expect(row.lease_owner).toBeNull();
});

it.each(["claim", "claimCompanions"] as const)("rejection after %s commits recovers new leases and preserves an older dispatched attempt", async operation => {
  const { executor, queue } = setup(operation === "claimCompanions"); submit("older");
  await scheduler!.tick(); expect(executor.runSingle).toHaveBeenCalledTimes(1);
  sy!.cfg.execution.max_concurrent_tasks = 2;
  submit("new", "companion");
  const original = queue[operation].bind(queue);
  vi.spyOn(queue, operation).mockImplementation(async (input: any) => { await original(input); throw new Error("fixture receipt lost"); });
  await expect(scheduler!.tick()).rejects.toThrow("fixture receipt lost");
  expect(executor.runSingle).toHaveBeenCalledTimes(1); expect(executor.runBatch).not.toHaveBeenCalled();
  expect(sy!.tasks.get("older")!.row).toMatchObject({ state: "running", lease_owner: "queue-owner", run_count: 1 });
  expect(sy!.tasks.get("new")!.row).toMatchObject({ state: "interrupted", lease_owner: null });
  if (operation === "claimCompanions") expect(sy!.tasks.get("companion")!.row.state).toBe("interrupted");
  await scheduler!.tick(); expect(executor.runSingle).toHaveBeenCalledTimes(1);
});

it("timer-driven rejection fails closed without unhandled rejection or repeated claims", async () => {
  const { executor, queue } = setup(); submit("one");
  const failed = barrier(); const spy = vi.spyOn(queue, "claim").mockImplementation(async () => { failed.release(); throw new Error("fixture offline"); });
  scheduler!.start(1); await failed.promise; await scheduler!.stop();
  expect(spy).toHaveBeenCalledTimes(1); expect(executor.runSingle).not.toHaveBeenCalled();
  expect(sy!.tasks.get("one")!.row.state).toBe("queued");
});


it("draining a pending coding claim releases its file lease and fences cleanup by attempt", async () => {
  const { queue, executor } = setup();
  sy!.tasks.submit([WorkerTaskSchema.parse({ id: "writer", profile: "implement", goal: "fixture edit", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["fixture"], allowedPaths: ["src/**"] } })], { project: "demo" });
  const entered = barrier(), blocked = barrier(); const claim = queue.claim.bind(queue);
  vi.spyOn(queue, "claim").mockImplementation(async input => { const result = await claim(input); entered.release(); await blocked.promise; return result; });
  const ticking = scheduler!.tick(); await entered.promise;
  expect(sy!.db.prepare("SELECT released_at FROM file_leases WHERE task_id = 'writer'").get()).toEqual({ released_at: null });
  expect(sy!.tasks.interrupt("writer", "queue-owner", "wrong-attempt", 2)).toBe(false);
  const stopping = scheduler!.stop(); blocked.release(); await Promise.all([ticking, stopping]);
  expect(executor.runSingle).not.toHaveBeenCalled();
  expect(sy!.db.prepare("SELECT release_reason FROM file_leases WHERE task_id = 'writer'").get()).toEqual({ release_reason: "interrupted" });
  expect(sy!.tasks.get("writer")!.row).toMatchObject({ state: "interrupted", lease_owner: null, run_count: 1 });
});
