import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { RepoReader } from "../src/context/repo-reader.js";
import { executeOperation, cancelOperation } from "../src/harness/operation-lifecycle.js";
import { operationRegistry } from "../src/harness/operation-registry.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { capturedLease } from "../src/storage/task-leases.js";
import * as gitCommands from "../src/workspaces/git.js";
import { z } from "zod";
import { operationExecutionTimeRemaining, pauseOperationExecutionTimeout } from "../src/harness/operation-lifecycle.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await sy?.close(); env?.cleanup(); sy = undefined; env = undefined; });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) { const value = read(); if (accepts(value)) return value; if (Date.now() >= deadline) throw new Error("Fixture condition timed out"); await sleep(10); }
}

async function fixture(command = `"${process.execPath}" --version`, taskTimeout = 15000) {
  env = makeEnv({ config: baseConfig({ security: { outside_repository: "human_only" }, coding: { runner: "native" } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const [submitted] = await sy.submitTasks([{ profile: "implement", goal: "Exercise separately bounded approval/execution phases", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["Check remains bounded"], allowedPaths: ["src/**"], checks: [command] } }]);
  const stored = sy.tasks.claim("operation-test", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: taskTimeout })[0]!;
  expect(stored.row.id).toBe(submitted!.taskId);
  const controller = new AbortController();
  const ctx = { cfg: env.cfg, tasks: sy.tasks, taskId: stored.row.id, taskLease: capturedLease(stored), spec: stored.spec, now: Date.now, signal: controller.signal, artifacts: sy.artifacts, session: null } as unknown as RunContext;
  const harness = { ctx, role: "implementer", toolInvocationId: "approval-timing", readers: new Map([["core", new RepoReader("core", env.repo, null)]]), workspace: { alias: "core", root: env.repo, allowedPaths: ["src/**"] }, checks: { commands: [command], cwd: env.repo, env: {}, timeoutMs: 5000, maxRuns: 10 }, universe: { refs: new Map() }, checkResults: [], edits: new Set(), allowArtifacts: true } as HarnessEnv;
  const actions = new WorkerActionRequests(sy.db);
  const requests = () => actions.list({ project: stored.row.project_id, taskId: stored.row.id });
  return {
    ctx, harness, controller, requests, actions,
    pending: () => until(() => requests().find(row => row.status === "pending"), Boolean),
    invoke: (name = "run_recipe", args: Record<string, unknown> = { id: "check:1", timeout_ms: 1500 }) => executeOperation(operationRegistry().find(def => def.name === name)!, args, harness),
    decide: (id: string, decision: "approve" | "deny") => actions.decide({ project: stored.row.project_id, id, decision, reason: "Explicit temporary fixture operator decision", actor: { kind: "operator" }, config: env!.cfg }),
  };
}

it.each([false, true])("keeps pending approval stable beyond execution timeout, including enclosing grouped batch (%s)", async nested => {
  const f = await fixture();
  let settled = false;
  const operation = (nested ? f.invoke("batch", { timeout_ms: 1600, items: [{ id: "checks", operation: "run_checks", args: { ids: ["check:1"], timeout_ms: 1500 } }] }) : f.invoke()).then(result => { settled = true; return result; });
  const request = await f.pending();
  await sleep(1800);
  expect(settled).toBe(false);
  expect(f.requests()).toHaveLength(1);
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("pending");
  const executed = await f.decide(request!.id, "approve");
  expect(executed).toMatchObject({ status: "completed", exitCode: 0 });
  expect((await operation).status).toBe("succeeded");
});

it("still kills approved execution at its requested timeout and waits for confirmed process stop", async () => {
  const f = await fixture(`"${process.execPath}" slow-check.cjs`);
  const marker = path.join(env!.repo, "late-marker"), started = path.join(env!.dir, "execution-started");
  writeFileSync(path.join(env!.repo, "slow-check.cjs"), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(Date.now()));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),1800);`);
  const operation = f.invoke("run_recipe", { id: "check:1", timeout_ms: 600 });
  const request = await f.pending();
  await sleep(800);
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("pending");
  const execution = f.decide(request!.id, "approve");
  await until(() => existsSync(started), Boolean);
  const result = await operation, executed = await execution;
  expect(["unknown_effect", "failed"]).toContain(result.status);
  expect(executed).toMatchObject({ status: "uncertain", exitCode: null, quiescedAt: expect.any(Number) });
  const startedAt = Number(readFileSync(started, "utf8"));
  expect(executed.quiescedAt!).toBeGreaterThanOrEqual(startedAt);
  await sleep(Math.max(0, startedAt + 2000 - Date.now()));
  expect(existsSync(marker)).toBe(false);
}, 10000);

it("denial resolves the wait without execution or a replacement approval", async () => {
  const f = await fixture();
  const operation = f.invoke();
  const request = await f.pending();
  await sleep(500);
  expect((await f.decide(request!.id, "deny")).status).toBe("denied");
  expect((await operation).status).toBe("waiting_approval");
  expect(f.requests()).toHaveLength(1);
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("denied");
});

it.each(["task", "operation"] as const)("preserves explicit %s cancellation and refuses late execution", async cancellation => {
  const f = await fixture();
  const operation = f.invoke();
  const request = await f.pending();
  await sleep(500);
  if (cancellation === "task") f.controller.abort("Explicit caller cancellation");
  else expect(cancelOperation(f.harness, "approval-timing").status).toBe("cancellation_requested");
  expect((await operation).status).toBe("unknown_effect");
  expect((await f.decide(request!.id, "approve")).status).toBe("cancelled");
  expect(f.actions.get(request!.project, request!.id)?.quiescedAt).toBeTypeOf("number");
});

it("keeps the task deadline active throughout human approval waiting", async () => {
  const f = await fixture(undefined, 2500);
  const operation = f.invoke("run_recipe", { id: "check:1", timeout_ms: 1000 });
  const request = await f.pending();
  await sleep(1300);
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("pending");
  const result = await operation;
  expect(["unknown_effect", "failed"]).toContain(result.status);
  expect(result.diagnostics.join(" ")).toMatch(/deadline|lease|cancel/i);
  expect((await f.decide(request!.id, "approve")).status).toBe("cancelled");
});

it("does not file a late approval when explicitly cancelled during active source capture", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const capturing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = gitCommands.git;
  vi.spyOn(gitCommands, "git").mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
  const operation = f.invoke();
  await capturing;
  f.controller.abort("Explicit cancellation during source capture");
  release();
  expect((await operation).status).toBe("unknown_effect");
  expect(f.requests()).toHaveLength(0);
});

it("does not revive an expired active budget when its timeout callback has not run yet", async () => {
  const f = await fixture();
  const result = await executeOperation({ name: "expired-clock-fixture", description: "fixture", args: z.object({ timeout_ms: z.number() }), sideEffect: "command", async run(_, child) {
    const delayedNow = Date.now() + 100;
    const clock = vi.spyOn(Date, "now").mockReturnValue(delayedNow);
    const resume = pauseOperationExecutionTimeout(child.ctx.signal);
    try { expect(child.ctx.signal.aborted).toBe(true); }
    finally { resume(); clock.mockRestore(); }
    return "No expired-budget work executed";
  } }, { timeout_ms: 50 }, f.harness);
  expect(result.status).toBe("unknown_effect");
  expect(f.requests()).toHaveLength(0);
});

it.each([false, true])("charges fast completion between polls before starting another grouped command (legacy timestamp %s)", async legacy => {
  const f = await fixture();
  const realTimer = setTimeout;
  const realSleep = (ms: number) => new Promise(resolve => realTimer(resolve, ms));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const operation = f.invoke("run_checks", { ids: ["check:1", "check:1"], timeout_ms: 50 });
  for (let i = 0; i < 500 && !f.requests().some(row => row.status === "pending"); i++) await realSleep(10);
  const request = f.requests().find(row => row.status === "pending")!;
  expect(request).toBeDefined();
  const executed = await f.decide(request.id, "approve");
  expect(executed.status).toBe("completed");
  expect(executed.executionStartedAt).toBeTypeOf("number");
  if (legacy) sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_remove(value_json,'$.executionStartedAt','$.executionTimeoutMs') WHERE id=?").run(request.id);
  // No waiter poll has run. Its first observation sees completed, never running.
  await vi.advanceTimersByTimeAsync(100);
  expect((await operation).status).toBe("unknown_effect");
  expect(f.requests()).toHaveLength(1);
  expect(f.requests()[0]!.status).toBe("completed");
});

it("persists ancestor execution cap independently of polling and keeps pending replay identity stable", async () => {
  const f = await fixture(`"${process.execPath}" capped-check.cjs`);
  const marker = path.join(env!.repo, "capped-late-write");
  writeFileSync(path.join(env!.repo, "capped-check.cjs"), `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1800);`);
  const input = { command: `"${process.execPath}" capped-check.cjs`, cwd: env!.repo, timeoutMs: 5000, reason: "Temporary parent budget fixture", invocationId: "stable-capped-request" };
  let firstId = "", firstCap = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const result = await executeOperation({ name: "parent-budget-fixture", description: "fixture", args: z.object({ timeout_ms: z.number() }), sideEffect: "command", async run(_, parent) {
    return executeOperation({ name: "child-budget-fixture", description: "fixture", args: z.object({ timeout_ms: z.number() }), sideEffect: "command", async run(_, child) {
      const first = await f.actions.file(child.ctx, input);
      firstId = first.id; firstCap = first.executionTimeoutMs!;
      vi.setSystemTime(Date.now() + 200);
      const replay = await f.actions.file(child.ctx, input);
      expect(replay.id).toBe(first.id);
      expect(replay.action.timeoutMs).toBe(5000);
      expect(replay.executionTimeoutMs).toBeLessThanOrEqual(firstCap);
      return { id: replay.id };
    } }, { timeout_ms: 5000 }, parent);
  } }, { timeout_ms: 1200 }, f.harness);
  expect(result.status).toBe("succeeded");
  const row = f.actions.get(f.ctx.taskLease!.project, firstId)!;
  expect(row.executionTimeoutMs).toBeGreaterThan(0);
  expect(row.executionTimeoutMs).toBeLessThanOrEqual(1200);
  expect(row.action.timeoutMs).toBe(5000);
  expect(row.executionTimeoutMs).toBeLessThan(firstCap);
  vi.useRealTimers();
  // Both operation clocks have settled; only the broker's persisted cap can stop this process.
  const executed = await f.decide(row.id, "approve");
  expect(executed).toMatchObject({ status: "uncertain", exitCode: null, quiescedAt: expect.any(Number) });
  await sleep(1900);
  expect(existsSync(marker)).toBe(false);
  expect(f.requests()).toHaveLength(1);
}, 10000);

it("charges overlapping ancestor pause execution spans only once", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const result = await executeOperation({ name: "overlapping-clock-fixture", description: "fixture", args: z.object({ timeout_ms: z.number() }), sideEffect: "command", async run(_, child) {
    const start = Date.now(), first = pauseOperationExecutionTimeout(child.ctx.signal), second = pauseOperationExecutionTimeout(child.ctx.signal);
    vi.setSystemTime(start + 300); first(start + 100);
    vi.setSystemTime(start + 400); second(start + 200);
    expect(operationExecutionTimeRemaining(child.ctx.signal)).toBe(700);
    return "Overlapping spans charged as a union";
  } }, { timeout_ms: 1000 }, f.harness);
  expect(result.status).toBe("succeeded");
});

it("does not carry approval across a changed source while execution time is paused", async () => {
  const f = await fixture();
  const operation = f.invoke();
  const request = await f.pending();
  await sleep(500);
  writeFileSync(path.join(env!.repo, "README.md"), "Changed after exact approval request\n");
  await expect(f.decide(request!.id, "approve")).rejects.toThrow(/source changed/);
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("pending");
  f.controller.abort("Explicit cleanup after source changed");
  expect((await operation).status).toBe("unknown_effect");
  expect(f.actions.get(request!.project, request!.id)?.status).toBe("cancelled");
  expect(f.requests()).toHaveLength(1);
});
