import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import type { Switchyard } from "../src/core/service.js";
import { goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function service(worker = false) {
  env = makeEnv();
  sy = open(env, new ScriptedClient(req => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker });
  return sy;
}

/** Simulate a brain transaction still committing after its readable result has appeared. */
function holdSettlement(s: Switchyard) {
  const started = deferred<void>();
  const release = deferred<void>();
  vi.spyOn(s.brain.promotions, "settle").mockImplementation(async () => {
    started.resolve();
    await release.promise;
    // A late settlement still owns the service database, just as a brain write owns its Git child.
    s.db.prepare("SELECT 1").get();
    return 1;
  });
  return { started, release };
}

describe("service shutdown promotion ownership", () => {
  it("waits for an explicit in-flight settlement before closing the database", async () => {
    const s = service();
    const { started, release } = holdSettlement(s);
    const settle = s.settlePromotions();
    await started.promise;
    const closeDb = vi.spyOn(s.db, "close");
    const closing = s.close();
    // Drain the close method's existing preparation/scheduler/report awaits deterministically.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(closeDb).not.toHaveBeenCalled();
    release.resolve();
    expect(await settle).toBe(1);
    await closing;
    expect(closeDb).toHaveBeenCalledOnce();
    sy = undefined;
  });

  it("waits for settlement launched by a real review task's deferred completion", async () => {
    const s = service(true);
    const { started, release } = holdSettlement(s);
    await s.submitTasks([summarizeTask()], { purpose: "promotion_review" });
    await started.promise;
    const closeDb = vi.spyOn(s.db, "close");
    const closing = s.close();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(closeDb).not.toHaveBeenCalled();
    release.resolve();
    await closing;
    expect(closeDb).toHaveBeenCalledOnce();
    sy = undefined;
  });

  it("cancels a queued review-settlement callback and refuses new settles during shutdown", async () => {
    const s = service();
    const [task] = await s.submitTasks([summarizeTask()], { purpose: "promotion_review" });
    const settle = vi.spyOn(s.brain.promotions, "settle");
    vi.useFakeTimers();
    // Exercise the executor's settled-event boundary without starting an unrelated model run.
    (s as unknown as { events: EventEmitter }).events.emit("settled", task!.taskId);
    await s.close();
    await vi.runAllTimersAsync();
    expect(await s.settlePromotions()).toBe(0);
    expect(settle).not.toHaveBeenCalled();
    sy = undefined;
  });

  it("leaves a retry review submitted by a draining settle queued after the scheduler stops", async () => {
    const s = service(true);
    const started = deferred<void>();
    const release = deferred<void>();
    const stopped = deferred<void>();
    const scheduler = (s as unknown as { scheduler: { stop(): Promise<void> } }).scheduler;
    const stop = scheduler.stop.bind(scheduler);
    vi.spyOn(scheduler, "stop").mockImplementation(async () => { await stop(); stopped.resolve(); });
    let retryState: string | undefined;
    vi.spyOn(s.brain.promotions, "settle").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      const [retry] = await s.submitTasks([summarizeTask()], { purpose: "promotion_review" });
      retryState = s.tasks.get(retry!.taskId)?.row.state;
      expect(s.activeWorkers).toBe(0);
      return 1;
    });
    const settling = s.settlePromotions();
    await started.promise;
    const closing = s.close();
    await stopped.promise;
    release.resolve();
    expect(await settling).toBe(1);
    await closing;
    expect(retryState).toBe("queued");
    sy = undefined;
  });
});
