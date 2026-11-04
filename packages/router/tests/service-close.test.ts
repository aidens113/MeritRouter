import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { ServiceOperations } from "../src/core/service-operations.js";
import * as validation from "../src/core/validate.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  const ownedService = sy, ownedEnvironment = env;
  sy = undefined; env = undefined;
  vi.useRealTimers();
  await ownedService?.close();
  ownedEnvironment?.cleanup();
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
function holdSettlement(s: MeritRouter) {
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
    expect(s.close()).toBe(closing);
    // Drain the close method's existing preparation/scheduler/report awaits deterministically.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(closeDb).not.toHaveBeenCalled();
    release.resolve();
    expect(await settle).toBe(1);
    await closing;
    expect(s.close()).toBe(closing);
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
      await expect(s.submitTasks([{ ...summarizeTask(), profile: "inspect", repositoryAliases: ["core"] }], { purpose: "promotion_review" })).rejects.toThrow(/completion-mode/);
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

  it("finishes an admitted retry whose validation crosses shutdown without reopening qualification", async () => {
    const s = service();
    const entered = deferred<void>(), release = deferred<void>();
    const original = validation.validateTask;
    vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => {
      const spec = await original(...args);
      entered.resolve(); await release.promise; return spec;
    });
    let retryState: string | undefined, requests: unknown, workers: number | undefined;
    vi.spyOn(s.brain.promotions, "settle").mockImplementation(async () => {
      const [retry] = await s.submitTasks([summarizeTask()], { purpose: "promotion_review" });
      retryState = s.tasks.get(retry!.taskId)!.row.state;
      workers = s.activeWorkers;
      requests = s.db.prepare("SELECT COUNT(*) n FROM model_requests").get();
      return 1;
    });
    const settling = s.settlePromotions();
    await entered.promise;
    const closeDb = vi.spyOn(s.db, "close");
    const closing = s.close();
    try {
      await expect(s.submitTasks([summarizeTask()], { purpose: "promotion_review" })).rejects.toThrow(/closing/);
      expect(closeDb).not.toHaveBeenCalled();
      release.resolve();
      expect(await settling).toBe(1);
      expect(retryState).toBe("queued");
      expect(workers).toBe(0);
      expect(requests).toEqual({ n: 0 });
      await closing;
    } finally { release.resolve(); await closing; }
  });

  it.each(["write", "promotion"] as const)("drains a direct Brain %s before closing its store and refuses later writes", async kind => {
    const s = service(), brain = s.brain;
    const entered = deferred<void>(), release = deferred<void>();
    const ensure = brain.ensure.bind(brain);
    vi.spyOn(brain, "ensure").mockImplementationOnce(async control => {
      entered.resolve(); await release.promise; await ensure(control);
    });
    const actor = { agent: "fixture", role: "tool" as const };
    const rel = `projects/${env!.cfg.brain.project}/notes/drain.md`;
    const operation = kind === "write"
      ? brain.write({ kind: "human" }, actor, rel, "# Admitted write\n")
      : brain.promotions.promote({ kind: "human", name: "fixture" }, actor, { title: "Bound retries", body: "Bound retry counts for remote calls.", sources: [] });
    await entered.promise;
    const closeDb = vi.spyOn(s.db, "close"), closing = s.close();
    try {
      await expect(brain.write({ kind: "human" }, actor, rel, "# Late write\n")).rejects.toThrow(/closing/);
      expect(closeDb).not.toHaveBeenCalled();
      expect(s.db.prepare("SELECT 1 n").get()).toEqual({ n: 1 });
      release.resolve();
      expect((await operation).commit).toBeTruthy();
      await closing;
      expect(closeDb).toHaveBeenCalledOnce();
      await expect(brain.ensure()).rejects.toThrow(/closing/);
    } finally { release.resolve(); await closing; }
  });

  it("keeps resource lifetime separate from promotion scope and refuses ended or foreign ownership", async () => {
    const operations = new ServiceOperations(), other = new ServiceOperations();
    const release = deferred<void>();
    let detached!: Promise<unknown>;
    await operations.run("alpha", async () => {
      detached = release.promise.then(() => operations.run("alpha", async () => "late"));
      other.seal();
      await expect(other.run("alpha", async () => "foreign")).rejects.toThrow(/closing/);
      operations.seal();
      await operations.run("beta", async () => {
        expect(operations.allowsPromotionRetry("beta")).toBe(false);
        await expect(operations.run("beta", async () => "foreign promotion", true)).rejects.toThrow(/promotion project/);
      });
      expect(operations.allowsPromotionRetry("alpha")).toBe(true);
    }, true);
    const rejected = expect(detached).rejects.toThrow(/ended/);
    release.resolve(); await rejected;
    await operations.drain();
    await expect(operations.runRoot("alpha", async () => "late root")).rejects.toThrow(/closing/);
  });

  it("drains a split project's direct Brain write before closing its project SQLite store", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-close-project-")));
    const release = deferred<void>();
    let closing: Promise<void> | undefined;
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory, stdio: "pipe" });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "init"], { cwd: directory, stdio: "pipe" });
      env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory, repositories: { app: { path: directory } } } } }) });
      const s = sy = open(env, new ScriptedClient(() => reply("unused")));
      await s.createSplitProject({ slug: "alpha", directory });
      const brain = s.brain, projectDb = s.projectStores("alpha").db;
      const entered = deferred<void>(), ensure = brain.ensure.bind(brain);
      vi.spyOn(brain, "ensure").mockImplementationOnce(async control => { entered.resolve(); await release.promise; await ensure(control); });
      const operation = brain.write({ kind: "human" }, { agent: "fixture", role: "tool" }, "projects/alpha/notes/drain.md", "# Admitted split write\n");
      await entered.promise;
      const closeDb = vi.spyOn(projectDb, "close");
      closing = s.close();
      await expect(brain.ensure()).rejects.toThrow(/closing/);
      expect(closeDb).not.toHaveBeenCalled();
      expect(projectDb.prepare("SELECT 1 n").get()).toEqual({ n: 1 });
      release.resolve();
      expect((await operation).commit).toBeTruthy();
      await closing;
      expect(closeDb).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await (closing ?? sy?.close());
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
