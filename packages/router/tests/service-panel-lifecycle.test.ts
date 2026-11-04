import { afterEach, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import { MeritRouter } from "../src/core/service.js";
import { ensurePanel, markPanelStopped, PANEL_DIR_ENV, panelListening, PANEL_AVAILABILITY_EVERY_MS } from "../src/operations/panel.js";
import { baseConfig, makeEnv, ScriptedClient, reply } from "./helpers.js";

const panelChildren = vi.hoisted(() => new Map<string, Array<{ child: ChildProcess; closed: Promise<void> }>>());
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
    const child = actual.spawn(command, args, options);
    const owned = panelChildren.get(String(options.cwd));
    if (owned) owned.push({ child, closed: new Promise<void>(resolve => child.once("close", () => resolve())) });
    return child;
  } };
});

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const originalPanel = process.env[PANEL_DIR_ENV];
let retainFixture = false;
afterEach(async context => {
  retainFixture = context.task.result?.state === "fail";
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  if (originalPanel === undefined) delete process.env[PANEL_DIR_ENV]; else process.env[PANEL_DIR_ENV] = originalPanel;
});
async function until(predicate: () => boolean | Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error("temporary panel condition did not become true");
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function fixture(auto = true, readyDelay = 0, built = true) {
  const port = await freePort();
  const env = makeEnv({ config: baseConfig({ panel: { auto_start: auto, port } }) });
  cleanups.push(() => {
    if (retainFixture) console.error(`retained failed panel fixture config/logs: ${env.dir}`);
    else env.cleanup();
  });
  const app = mkdtempSync(path.join(tmpdir(), "mr-service-panel-"));
  const children: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
  panelChildren.set(app, children);
  cleanups.push(() => {
    if (retainFixture) console.error(`retained failed panel fixture app: ${app}`);
    else rmSync(app, { recursive: true, force: true });
  });
  writeFileSync(path.join(app, "package.json"), "{}");
  const binary = path.join(app, "node_modules", "next", "dist", "bin");
  mkdirSync(binary, { recursive: true });
  writeFileSync(path.join(binary, "next"), String.raw`const fs=require("node:fs"),net=require("node:net"),a=process.argv;
fs.appendFileSync("started.jsonl",JSON.stringify({pid:process.pid,config:process.env.MERITROUTER_CONFIG})+"\n");
setTimeout(()=>net.createServer(s=>s.end()).listen(Number(a[a.indexOf("-p")+1]),"127.0.0.1"),${readyDelay});`);
  if (built) { mkdirSync(path.join(app, ".next")); writeFileSync(path.join(app, ".next", "BUILD_ID"), "fixture"); }
  process.env[PANEL_DIR_ENV] = app;
  const starts = () => existsSync(path.join(app, "started.jsonl")) ? readFileSync(path.join(app, "started.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; config: string }) : [];
  const stopChild = async (owned: typeof children[number]) => {
    if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill();
    // PID disappearance can precede cwd/log handle release on Windows.
    await owned.closed;
  };
  const stop = async (pid: number) => {
    const owned = children.find(entry => entry.child.pid === pid);
    if (!owned) throw new Error(`unowned fake panel PID ${pid}`);
    await stopChild(owned);
  };
  cleanups.push(async () => {
    if (retainFixture) console.error("failed panel child state before cleanup", children.map(({ child }) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })));
    for (const owned of children) await stopChild(owned);
    panelChildren.delete(app);
  });
  const client = new ScriptedClient(() => reply("unused fake provider"));
  const open = (options: { worker?: boolean; panelLifecycle?: "automatic" | "passive" } = {}) => {
    const service = new MeritRouter(env.cfg, { ...options, providerFetch: client.fetch });
    cleanups.push(() => service.close());
    return service;
  };
  return { env, port, app, starts, stop, open, client };
}

it("SDK worker construction automatically starts one shared panel; close leaves it reachable", async () => {
  const f = await fixture(), service = f.open({ worker: true });
  await Promise.all([ensurePanel(f.env.cfg), ensurePanel(f.env.cfg)]);
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(1);
  expect(f.starts()[0]!.config).toBe(f.env.cfg.configPath);
  expect(f.client.requests).toHaveLength(0);
  await service.close();
  expect(await panelListening(f.port)).toBe(true);
});
it("an ordinary SDK instance also starts the UI while the panel backend explicitly stays passive", async () => {
  const f = await fixture(), service = f.open({ worker: false });
  await until(() => panelListening(f.port));
  const passive = f.open({ worker: false, panelLifecycle: "passive" });
  await passive.close(); await service.close();
  expect(f.starts()).toHaveLength(1);
  expect(await panelListening(f.port)).toBe(true);
});
it.each(["configured_off", "passive"] as const)("never starts a process for %s", async kind => {
  const f = await fixture(kind !== "configured_off");
  const service = f.open({ worker: false, ...(kind === "passive" ? { panelLifecycle: "passive" as const } : {}) });
  await new Promise(resolve => setTimeout(resolve, 200));
  await service.close();
  expect(f.starts()).toHaveLength(0);
  expect(await panelListening(f.port)).toBe(false);
});
it("periodic availability recovers a crash but preserves a manual stop until a new service session", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = await fixture(), service = f.open();
  await until(() => panelListening(f.port));
  await ensurePanel(f.env.cfg); // Finish the original owned startup acknowledgement before injecting a later crash.
  await f.stop(f.starts()[0]!.pid);
  await vi.advanceTimersByTimeAsync(PANEL_AVAILABILITY_EVERY_MS);
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(2);
  await ensurePanel(f.env.cfg);
  markPanelStopped(f.env.cfg);
  await f.stop(f.starts()[1]!.pid);
  await vi.advanceTimersByTimeAsync(PANEL_AVAILABILITY_EVERY_MS);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.starts()).toHaveLength(2);
  expect(await panelListening(f.port)).toBe(false);
  const another = f.open();
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(3);
  await another.close(); await service.close();
});
it("close immediately retires startup and cannot spawn from a late constructor continuation", async () => {
  const f = await fixture(), service = f.open();
  await service.close();
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(f.starts()).toHaveLength(0);
  expect(await panelListening(f.port)).toBe(false);
});
it("closing one subscriber cannot cancel another service's shared startup", async () => {
  const f = await fixture(), first = f.open(), second = f.open();
  await first.close();
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(1);
  await second.close();
  expect(await panelListening(f.port)).toBe(true);
});
it("close does not wait for readiness or stop a detached panel already spawned by its owner", async () => {
  const f = await fixture(true, 1200), service = f.open();
  await until(() => f.starts().length === 1);
  const started = Date.now();
  await service.close();
  expect(Date.now() - started).toBeLessThan(1000);
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(1);
});
it("missing build is nonfatal to SDK construction and close", async () => {
  const f = await fixture(true, 0, false), service = f.open();
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(f.starts()).toHaveLength(0);
  await expect(service.close()).resolves.toBeUndefined();
});
it("a config reload targets the new port without stopping the shared old panel", async () => {
  const f = await fixture(), service = f.open();
  await until(() => panelListening(f.port));
  const newPort = await freePort();
  const raw = YAML.parse(readFileSync(f.env.cfg.configPath, "utf8"));
  raw.panel.port = newPort;
  writeFileSync(f.env.cfg.configPath, YAML.stringify(raw));
  const modified = new Date(Date.now() + 2000); utimesSync(f.env.cfg.configPath, modified, modified);
  expect(service.reloadIfChanged().reloaded).toBe(true);
  await until(() => panelListening(newPort));
  expect(f.starts()).toHaveLength(2);
  expect(await panelListening(f.port)).toBe(true);
  await service.close();
});

it("an explicit forced start cannot inherit a concurrent automatic disabled result", async () => {
  const f = await fixture(false);
  const automatic = ensurePanel(f.env.cfg);
  const forced = ensurePanel(f.env.cfg, { force: true });
  const results = await Promise.all([automatic, forced]);
  expect(results[1]!.state).not.toBe("disabled");
  await until(() => panelListening(f.port));
  expect(f.starts()).toHaveLength(1);
});
