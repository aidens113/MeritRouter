import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import * as repositorySetup from "../src/projects/repository-setup.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { panelStopFile, turnPanelOff } from "../src/operations/panel.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

const state = vi.hoisted(() => ({ router: null as unknown, exit: vi.fn() }));
vi.mock("meritrouter", async () => {
  const actual = await import("../src/operations/panel.js");
  return {
    turnPanelOff: (cfg: Parameters<typeof actual.turnPanelOff>[0]) => actual.turnPanelOff(cfg, { exit: state.exit }),
    turnPanelOffAfterDrain: (router: Parameters<typeof actual.turnPanelOffAfterDrain>[0]) => actual.turnPanelOffAfterDrain(router, { exit: state.exit }),
  };
});
vi.mock("@/lib/api", () => ({
  HttpError: class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } },
  handle: async (fn: (router: unknown) => unknown) => {
    try { return { ok: true, ...await fn(state.router) as object }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  },
}));

let directory: string | undefined, env: Env | undefined, sy: MeritRouter | undefined;
const releases: Array<() => void> = [];
const posts: Promise<unknown>[] = [];
let routePost: (req: Request) => Promise<unknown>;
beforeAll(async () => {
  // Variable import exercises the actual route without adding the panel tree to router tsc's rootDir.
  const route = "../../../apps/panel/app/api/panel/stop/route.ts";
  routePost = (await import(route)).POST;
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(posts.splice(0));
  vi.clearAllTimers();
  vi.useRealTimers();
  await sy?.close(); sy = undefined;
  env?.cleanup(); env = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined;
  state.router = null; state.exit.mockReset(); vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
function post(origin = "http://127.0.0.1:4477") {
  const result = routePost(new Request("http://127.0.0.1:4477/api/panel/stop", { method: "POST", headers: { origin, host: "127.0.0.1:4477" } }));
  posts.push(result);
  return result;
}
function fake(close: () => Promise<void>) {
  directory = mkdtempSync(path.join(tmpdir(), "meritrouter-panel-drain-"));
  const router = { cfg: { storageDir: directory }, close: vi.fn(close) };
  state.router = router;
  return router;
}

it("retains the synchronous low-level stop API for callers that already drained", async () => {
  vi.useFakeTimers();
  const router = fake(async () => undefined);
  const receipt = turnPanelOff(router.cfg, { delayMs: 25, exit: state.exit });
  expect(receipt).toEqual({ stoppedAt: expect.any(String), marker: panelStopFile(router.cfg) });
  expect(existsSync(receipt.marker)).toBe(true);
  expect(router.close).not.toHaveBeenCalled();
  expect(state.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(25);
  expect(state.exit).toHaveBeenCalledOnce();
});

it("the actual stop route marks stop, drains Router work, then schedules process exit", async () => {
  vi.useFakeTimers();
  const draining = deferred();
  const router = fake(async () => {
    expect(existsSync(panelStopFile(router.cfg))).toBe(true);
    await draining.promise;
  });
  let settled = false;
  const stopping = post().then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.exit).not.toHaveBeenCalled();
  expect(router.close).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  expect(JSON.parse(readFileSync(panelStopFile(router.cfg), "utf8"))).toHaveProperty("at");
  draining.resolve();
  expect(await stopping).toMatchObject({ ok: true, stopped: true });
  expect(state.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(299);
  expect(state.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.exit).toHaveBeenCalledOnce();
});

it("a drain failure preserves the stop marker and never schedules process exit", async () => {
  vi.useFakeTimers();
  const router = fake(async () => { throw new Error("fixture repository drain failed"); });
  expect(await post()).toEqual({ ok: false, error: "fixture repository drain failed" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.exit).not.toHaveBeenCalled();
  expect(existsSync(panelStopFile(router.cfg))).toBe(true);
});

it("concurrent stop requests share one drain and one delayed exit", async () => {
  vi.useFakeTimers();
  const draining = deferred(), router = fake(() => draining.promise);
  const first = post(), second = post();
  await vi.advanceTimersByTimeAsync(1000);
  expect(router.close).toHaveBeenCalledOnce();
  expect(state.exit).not.toHaveBeenCalled();
  draining.resolve();
  expect(await first).toMatchObject({ ok: true, stopped: true });
  expect(await second).toMatchObject({ ok: true, stopped: true });
  await vi.advanceTimersByTimeAsync(300);
  expect(state.exit).toHaveBeenCalledOnce();
});

it("cross-origin stop cannot mark, drain or schedule exit", async () => {
  const router = fake(async () => undefined);
  expect(await post("http://foreign.invalid")).toMatchObject({ ok: false });
  expect(router.close).not.toHaveBeenCalled();
  expect(existsSync(panelStopFile(router.cfg))).toBe(false);
  expect(state.exit).not.toHaveBeenCalled();
});

it("the stop route waits for a real Router's tracked repository mutation to release", async () => {
  env = makeEnv();
  sy = open(env, new ScriptedClient(() => reply("unused")));
  state.router = sy;
  const started = deferred(), release = deferred();
  vi.spyOn(repositorySetup, "prepareProjectRepositories").mockImplementation(async () => withRepositoryMutation([env!.repo], async () => {
    started.resolve(); await release.promise; return [];
  }));
  const preparing = sy.prepareRepositories();
  await started.promise;
  const marker = path.join(env.repo, ".git", "meritrouter-mutation.lock");
  expect(existsSync(marker)).toBe(true);
  const stopping = post();
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(state.exit).not.toHaveBeenCalled();
  expect(sy.db.open).toBe(true);
  expect(existsSync(marker)).toBe(true);
  release.resolve();
  await preparing;
  expect(await stopping).toMatchObject({ ok: true, stopped: true });
  expect(existsSync(marker)).toBe(false);
  expect(sy.db.open).toBe(false);
  sy = undefined;
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(state.exit).toHaveBeenCalledOnce();
});
