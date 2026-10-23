import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePanel, panelBuildStale, routerBuildFingerprint, PANEL_ROUTER_FINGERPRINT, PANEL_ROUTER_FINGERPRINT_ALGORITHM, findPanelApp, markPanelStopped, PANEL_DIR_ENV, panelListening, panelStopFile, resetPanelRevive, revivePanel } from "../src/operations/panel.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

// The panel stays reachable while agents use SwitchYard: ensurePanel starts it (detached) when
// nothing answers on panel.port. A fake panel app stands in for `next start`.

let env: Env | undefined;
let dir: string | undefined;
const savedDir = process.env[PANEL_DIR_ENV];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  if (savedDir === undefined) delete process.env[PANEL_DIR_ENV];
  else process.env[PANEL_DIR_ENV] = savedDir;
  env?.cleanup();
  env = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A port nothing listens on (taken and released). */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function envOnPort(port: number, autoStart: boolean): Env {
  return makeEnv({ config: baseConfig({ panel: { port, auto_start: autoStart } }) });
}

/** A fake panel app: `next start -H host -p port` listens and records its pid and SWITCHYARD_CONFIG. */
function fakePanel(opts: { built?: boolean; deps?: boolean } = {}): string {
  dir = mkdtempSync(path.join(tmpdir(), "switchyard-panel-"));
  writeFileSync(path.join(dir, "package.json"), "{}");
  if (opts.deps !== false) {
    const bin = path.join(dir, "node_modules", "next", "dist", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "next"),
      `const fs = require("fs"); const net = require("net"); const a = process.argv;
const port = Number(a[a.indexOf("-p") + 1]); const host = a[a.indexOf("-H") + 1];
fs.writeFileSync("started.json", JSON.stringify({ pid: process.pid, host, config: process.env.SWITCHYARD_CONFIG }));
net.createServer((s) => s.end()).listen(port, host);`,
    );
  }
  if (opts.built !== false) {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "test");
  }
  process.env[PANEL_DIR_ENV] = dir;
  return dir;
}

describe("ensurePanel", () => {
  it("reports a panel that already answers and starts nothing", async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    cleanups.push(() => void srv.close());
    const port = (srv.address() as net.AddressInfo).port;
    env = envOnPort(port, true);
    const app = fakePanel();
    expect(await ensurePanel(env.cfg)).toEqual({ state: "running", url: `http://127.0.0.1:${port}`, detail: `the panel is running at http://127.0.0.1:${port}` });
    expect(existsSync(path.join(app, "started.json"))).toBe(false);
  });

  it("starts the panel detached on 127.0.0.1 with this config when nothing answers, and logs to <storage>/logs/panel.log", async () => {
    const port = await freePort();
    env = envOnPort(port, true);
    const app = fakePanel();
    const r = await ensurePanel(env.cfg, { waitMs: 10_000 });
    const started = JSON.parse(readFileSync(path.join(app, "started.json"), "utf8")) as { pid: number; host: string; config: string };
    // Stop the fake panel and wait until it is gone: it holds panel.log open (Windows EBUSY on cleanup).
    cleanups.push(async () => {
      const alive = () => {
        try {
          process.kill(started.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      if (alive()) process.kill(started.pid);
      for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    });
    expect(r).toMatchObject({ state: "started", url: `http://127.0.0.1:${port}` });
    expect(r.detail).toContain(path.join(env.cfg.storageDir, "logs", "panel.log"));
    expect(started).toMatchObject({ host: "127.0.0.1", config: env.cfg.configPath });
    expect(await panelListening(port)).toBe(true);
    // A second call finds it running.
    expect((await ensurePanel(env.cfg)).state).toBe("running");
  });

  it("leaves a panel the user turned off stopped until an explicit start, which clears the marker", async () => {
    const port = await freePort();
    env = envOnPort(port, true);
    const app = fakePanel();
    markPanelStopped(env.cfg);
    expect(await ensurePanel(env.cfg)).toMatchObject({ state: "stopped", detail: expect.stringMatching(/turned off from its power button/) });
    expect(existsSync(path.join(app, "started.json"))).toBe(false);
    const r = await ensurePanel(env.cfg, { force: true, waitMs: 10_000 });
    const started = JSON.parse(readFileSync(path.join(app, "started.json"), "utf8")) as { pid: number };
    cleanups.push(async () => {
      try {
        process.kill(started.pid);
      } catch {
        // already gone
      }
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(started.pid, 0);
        } catch {
          return;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
    });
    expect(r.state).toBe("started");
    expect(existsSync(panelStopFile(env.cfg))).toBe(false);
  });

  it("a new agent session (resume) forgets a power-off but still respects panel.auto_start off", async () => {
    env = envOnPort(await freePort(), false);
    const app = fakePanel();
    markPanelStopped(env.cfg);
    expect(await ensurePanel(env.cfg, { resume: true })).toMatchObject({ state: "disabled" });
    expect(existsSync(panelStopFile(env.cfg))).toBe(false);
    expect(existsSync(path.join(app, "started.json"))).toBe(false);
  });

  it("agents using SwitchYard revive a panel the user turned off, at most once per 30 s per process", async () => {
    const port = await freePort();
    env = envOnPort(port, true);
    const app = fakePanel();
    markPanelStopped(env.cfg);
    resetPanelRevive();
    const t0 = Date.now();
    const r = await revivePanel(env.cfg, t0);
    const started = JSON.parse(readFileSync(path.join(app, "started.json"), "utf8")) as { pid: number };
    cleanups.push(async () => {
      try {
        process.kill(started.pid);
      } catch {
        // already gone
      }
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(started.pid, 0);
        } catch {
          return;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
    });
    expect(r?.state).toBe("started");
    expect(existsSync(panelStopFile(env.cfg))).toBe(false);
    // Throttled: a burst of tool calls checks once.
    expect(revivePanel(env.cfg, t0 + 1000)).toBeNull();
    expect(revivePanel(env.cfg, t0 + 31_000)).not.toBeNull();
    resetPanelRevive();
  });

  it("does nothing when panel.auto_start is off", async () => {
    env = envOnPort(await freePort(), false);
    const app = fakePanel();
    expect(await ensurePanel(env.cfg)).toMatchObject({ state: "disabled", detail: expect.stringMatching(/panel\.auto_start is off: start it with switchyard panel/) });
    expect(existsSync(path.join(app, "started.json"))).toBe(false);
  });

  it("says how to fix a panel that is missing, not installed, or not built", async () => {
    env = envOnPort(await freePort(), true);
    process.env[PANEL_DIR_ENV] = path.join(tmpdir(), "switchyard-no-panel-here");
    expect(await ensurePanel(env.cfg)).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/no panel app at/) });
    fakePanel({ deps: false });
    expect(findPanelApp()).toEqual({ problem: expect.stringMatching(/dependencies are not installed.*pnpm install/) });
    rmSync(dir!, { recursive: true, force: true });
    fakePanel({ built: false });
    expect(findPanelApp()).toEqual({ problem: expect.stringMatching(/not built: run pnpm -r build/) });
  });
});


describe("packaged panel router fingerprint", () => {
  function fixture() {
    dir = mkdtempSync(path.join(tmpdir(), "switchyard-panel-fingerprint-"));
    const panel = path.join(dir, "panel"), router = path.join(dir, "dist");
    mkdirSync(path.join(panel, ".next"), { recursive: true });mkdirSync(path.join(router, "core"), { recursive: true });
    writeFileSync(path.join(panel, ".next", "BUILD_ID"), "fixture-build");
    writeFileSync(path.join(router, "cli.js"), "export const version=1;\n");writeFileSync(path.join(router, "core", "task.js"), "export const task=true;\n");
    const manifest = path.join(panel, ".next", PANEL_ROUTER_FINGERPRINT);
    const value = { version: 1, algorithm: PANEL_ROUTER_FINGERPRINT_ALGORITHM, buildId: "fixture-build", ...routerBuildFingerprint(router) };
    writeFileSync(manifest, JSON.stringify(value));
    return { panel, router, manifest, value };
  }
  it("matches extracted package content despite changed mtimes and absolute location", () => {
    const f = fixture();
    const time = Date.now() / 1000;
    utimesSync(path.join(f.panel, ".next", "BUILD_ID"), time - 300, time - 300);
    utimesSync(path.join(f.router, "cli.js"), time + 300, time + 300);
    expect(panelBuildStale(f.panel, f.router)).toBeNull();
    const relocated = path.join(dir!, "extracted", "dist");cpSync(f.router, relocated, { recursive: true });
    expect(routerBuildFingerprint(relocated)).toEqual(routerBuildFingerprint(f.router));
    expect(panelBuildStale(f.panel, relocated)).toBeNull();
    writeFileSync(path.join(relocated, "cli.d.ts"), "export declare const version: number;\n");writeFileSync(path.join(relocated, "cli.js.map"), "{\"sources\":[\"different-install-path\"]}");
    expect(routerBuildFingerprint(relocated)).toEqual(routerBuildFingerprint(f.router));
    expect(panelBuildStale(f.panel, relocated)).toBeNull();
  });
  it("detects changed content, path inventory and BUILD_ID independently of timestamps", () => {
    const f = fixture(), cli = path.join(f.router, "cli.js");
    const original = readFileSync(cli, "utf8");writeFileSync(cli, `${original}// changed\n`);
    expect(panelBuildStale(f.panel, f.router)).toMatch(/different router content/);
    writeFileSync(cli, original);expect(panelBuildStale(f.panel, f.router)).toBeNull();
    writeFileSync(path.join(f.router, "extra.js"), original);expect(panelBuildStale(f.panel, f.router)).toMatch(/different router content/);
    rmSync(path.join(f.router, "extra.js"));
    const longId = "x".repeat(200);writeFileSync(path.join(f.panel, ".next", "BUILD_ID"), `${longId}\n`);writeFileSync(f.manifest, JSON.stringify({ ...f.value, buildId: longId }));
    expect(panelBuildStale(f.panel, f.router)).toBeNull();
    writeFileSync(f.manifest, JSON.stringify(f.value));writeFileSync(path.join(f.panel, ".next", "BUILD_ID"), "other-build");
    expect(panelBuildStale(f.panel, f.router)).toMatch(/does not match its router fingerprint/);
  });
  it("rejects malformed, oversized and unsupported metadata instead of hiding stale state", () => {
    const f = fixture();
    for (const value of [{ ...f.value, version: 2 }, { ...f.value, algorithm: "mtime" }, { ...f.value, digest: "bad" }, { ...f.value, files: -1 }, { ...f.value, path: "../private" }]) {
      writeFileSync(f.manifest, JSON.stringify(value));expect(panelBuildStale(f.panel, f.router)).toMatch(/fingerprint is invalid/);
    }
    writeFileSync(f.manifest, "{bad json");expect(panelBuildStale(f.panel, f.router)).toMatch(/fingerprint is invalid/);
    writeFileSync(f.manifest, " ".repeat(5000));expect(panelBuildStale(f.panel, f.router)).toMatch(/fingerprint is invalid/);
  });
  it("does not follow linked router files outside the fingerprint root", () => {
    const f = fixture(), outside = path.join(dir!, "outside");mkdirSync(outside);writeFileSync(path.join(outside, "private.js"), "private");
    symlinkSync(outside, path.join(f.router, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(panelBuildStale(f.panel, f.router)).toMatch(/fingerprint is invalid or unreadable/);
    expect(readFileSync(path.join(outside, "private.js"), "utf8")).toBe("private");
  });
  it("retains the workspace mtime fallback when no packaged fingerprint exists", () => {
    const f = fixture();rmSync(f.manifest);
    const build = path.join(f.panel, ".next", "BUILD_ID"), time = Date.now() / 1000;
    utimesSync(build, time - 300, time - 300);expect(panelBuildStale(f.panel, f.router)).toMatch(/older than the router build/);
    utimesSync(build, time + 300, time + 300);expect(panelBuildStale(f.panel, f.router)).toBeNull();
  });
});
