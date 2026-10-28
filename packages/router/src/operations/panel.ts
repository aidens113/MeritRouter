import { createHash } from "node:crypto";
import { z } from "zod";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, lstatSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config/load.js";
import { logsDirFor } from "./daemon.js";

// The web panel stays reachable while agents use MeritRouter: the MCP server and `meritrouter
// worker` start it when nothing answers on `panel.port` (`panel.auto_start`), and the MCP server
// checks again every minute. It runs as its own detached process (`next start` on 127.0.0.1), so
// it outlives the session that started it; two processes starting it at once is harmless (the
// second cannot bind the port and exits). Its output goes to `<storage>/logs/panel.log`.
//
// Turning the panel off (its power button) leaves a marker, `<storage>/panel.stopped`: idle
// background checks then leave it off. Agents using MeritRouter again bring it back on their own
// (`revivePanel`: every MCP tool call, a new MCP session, `meritrouter run` and `submit`), as does an
// explicit start (`force`: `meritrouter panel`, the MCP `panel` tool).

/** Overrides where the built panel app lives (default: `apps/panel` of the checkout this package runs from). */
export const PANEL_DIR_ENV = "MERITROUTER_PANEL_DIR";
/** How long a start waits for the panel to answer before reporting it as still starting. */
const START_WAIT_MS = 20_000;

export type PanelState = "running" | "started" | "starting" | "stopped" | "disabled" | "unavailable";

/** The marker the power button leaves: background checks do not restart a panel the user turned off. */
export const panelStopFile = (cfg: Pick<ResolvedConfig, "storageDir">): string => path.join(cfg.storageDir, "panel.stopped");

/** How often one process revives the panel at most (a busy agent makes many tool calls). */
export const REVIVE_EVERY_MS = 30_000;
let lastRevive = 0;

/**
 * Agents are using MeritRouter: bring the panel back if nothing answers, even one the user turned
 * off (the marker is cleared), unless `panel.auto_start` is off. Throttled per process, never
 * throws, and never blocks the caller (the start runs in the background).
 */
export function revivePanel(cfg: ResolvedConfig, now = Date.now()): Promise<PanelStatus> | null {
  if (now - lastRevive < REVIVE_EVERY_MS) return null;
  lastRevive = now;
  return ensurePanel(cfg, { resume: true }).catch(() => null as unknown as PanelStatus);
}

/** Forget the throttle (tests). */
export function resetPanelRevive(): void {
  lastRevive = 0;
}

/** Record that the user turned the panel off (call before the panel process exits). */
export function markPanelStopped(cfg: Pick<ResolvedConfig, "storageDir">, by = "the panel's power button"): void {
  mkdirSync(cfg.storageDir, { recursive: true });
  writeFileSync(panelStopFile(cfg), JSON.stringify({ at: new Date().toISOString(), by }));
}

/**
 * The power button: record the stop (`markPanelStopped`), then end this process once the response
 * has had time to leave (`exit` after `delayMs`). Agents keep running; a new agent session or
 * `meritrouter panel` starts the panel again.
 */
export function turnPanelOff(cfg: Pick<ResolvedConfig, "storageDir">, opts: { delayMs?: number; exit?: () => void } = {}): { stoppedAt: string; marker: string } {
  markPanelStopped(cfg);
  return schedulePanelExit(cfg, opts);
}

function schedulePanelExit(cfg: Pick<ResolvedConfig, "storageDir">, opts: { delayMs?: number; exit?: () => void }): { stoppedAt: string; marker: string } {
  const exit = opts.exit ?? (() => process.exit(0));
  setTimeout(exit, opts.delayMs ?? 300).unref?.();
  return { stoppedAt: new Date().toISOString(), marker: panelStopFile(cfg) };
}

const drainingPanels = new WeakMap<object, Promise<{ stoppedAt: string; marker: string }>>();

/**
 * The API power button drains its process-local Router before scheduling exit. Repository
 * preparation, reports and other tracked work must release their ownership first. A failed
 * drain retains the stop marker and evidence; it never schedules a forced process exit.
 */
export function turnPanelOffAfterDrain(router: { cfg: Pick<ResolvedConfig, "storageDir">; close(): Promise<void> }, opts: { delayMs?: number; exit?: () => void } = {}): Promise<{ stoppedAt: string; marker: string }> {
  const existing = drainingPanels.get(router);
  if (existing) return existing;
  const stopping = Promise.resolve().then(async () => {
    markPanelStopped(router.cfg);
    await router.close();
    return schedulePanelExit(router.cfg, opts);
  });
  drainingPanels.set(router, stopping);
  void stopping.catch(() => { if (drainingPanels.get(router) === stopping) drainingPanels.delete(router); });
  return stopping;
}

export interface PanelStatus {
  state: PanelState;
  url: string;
  /** What happened, or how to fix it (an unbuilt panel, say). */
  detail: string;
  /** The panel build is older than the router build it bundles (see `panelBuildStale`). */
  warning?: string;
}

export const panelUrl = (cfg: ResolvedConfig): string => `http://127.0.0.1:${cfg.panel.port}`;

/** Whether something accepts connections on 127.0.0.1:`port`. */
export function panelListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The built panel (a production build and its `next` binary), or why it cannot start. */
export function findPanelApp(packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")): { dir: string; nextBin: string; runtimeModules?: string } | { problem: string } {
  const bundled = path.join(packageRoot, "bundled-panel");
  const checkout = path.resolve(packageRoot, "../../apps/panel");
  // A workspace runs its real app; generated package staging may be replaced during prepack.
  // An explicit operator override still wins. Installed packages have no checkout app.
  const dir = process.env[PANEL_DIR_ENV] || (existsSync(path.join(checkout, "package.json")) ? checkout : bundled);
  if (!existsSync(path.join(dir, "package.json"))) return { problem: `no panel app at ${dir} (reinstall meritrouter, or set ${PANEL_DIR_ENV} to a built checkout panel)` };
  let nextBin: string;
  try {
    nextBin = dir === bundled || existsSync(path.join(dir, "runtime-modules"))
      ? createRequire(path.join(dir, "package.json")).resolve("next/dist/bin/next")
      : path.join(dir, "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(nextBin)) throw new Error("missing Next runtime");
  } catch {
    return { problem: `the panel's dependencies are not installed in ${dir}: reinstall meritrouter (checkout: pnpm install at the repository root)` };
  }
  if (!existsSync(path.join(dir, ".next", "BUILD_ID"))) return { problem: `the panel is not built: run pnpm -r build at the repository root` };
  const runtimeModules = path.join(dir, "runtime-modules");
  return { dir, nextBin, ...(existsSync(runtimeModules) ? { runtimeModules } : {}) };
}

/** The router build this module runs from (`dist/`; `src/` under the tests). */
export function routerBuildDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The newest file modification time under `dir` (0 when it has no files). */
function newestFileMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/** Written only into the generated packaged panel, never the development checkout build. */
export const PANEL_ROUTER_FINGERPRINT = "router-build.json";
export const PANEL_ROUTER_FINGERPRINT_ALGORITHM = "sha256-runtime-path-content-v1";
const RouterFingerprintSchema = z.object({
  version: z.literal(1), algorithm: z.literal(PANEL_ROUTER_FINGERPRINT_ALGORITHM),
  buildId: z.string().min(1).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.number().int().positive().max(20000),
}).strict();

/** Deterministic path/content inventory; extraction mtimes and absolute installation paths are irrelevant. */
export function routerBuildFingerprint(dir: string): { digest: string; files: number } {
  const entries: Array<{ name: string; digest: string }> = [];
  let bytes = 0;
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, ...name.split("/"));
      if (entry.isSymbolicLink()) throw new Error("router build contains a symbolic link");
      if (entry.isDirectory()) { walk(name); continue; }
      if (!entry.isFile()) throw new Error("router build contains a non-regular file");
      // Declaration/source-map changes do not change executable packaged router behavior.
      if (/\.d\.[cm]?ts$/.test(name) || name.endsWith(".map")) continue;
      const size = statSync(file).size;
      bytes += size;
      if (entries.length >= 20000 || bytes > 256 * 1024 * 1024) throw new Error("router build exceeds fingerprint limits");
      entries.push({ name, digest: createHash("sha256").update(readFileSync(file)).digest("hex") });
    }
  };
  walk("");
  if (!entries.length) throw new Error("router build is empty");
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify([entry.name, entry.digest])).update("\n");
  return { digest: hash.digest("hex"), files: entries.length };
}

/**
 * Why the panel's production build is out of date, or null. Turbopack bundles the router into
 * the panel's server chunks although `next.config.ts` lists it in `serverExternalPackages`: it
 * externalizes only modules whose real path is under `node_modules`, and the pnpm workspace link
 * resolves to `packages/router`. So a router change reaches the panel only through a panel
 * rebuild. Packaged builds carry a content fingerprint bound to their BUILD_ID; checkout builds
 * without one retain the BUILD_ID-versus-router mtime check.
 */
export function panelBuildStale(panelDir: string, routerDir = routerBuildDir()): string | null {
  const id = path.join(panelDir, ".next", "BUILD_ID");
  if (!existsSync(id)) return null;
  const fingerprint = path.join(panelDir, ".next", PANEL_ROUTER_FINGERPRINT);
  if (existsSync(fingerprint)) {
    const repair = "reinstall meritrouter, or rebuild the router and packaged panel together";
    try {
      const metadata = lstatSync(fingerprint), build = lstatSync(id);
      if (!metadata.isFile() || metadata.size > 4096 || !build.isFile() || build.size > 4096) return `the panel's router build fingerprint is invalid: ${repair}`;
      const expected = RouterFingerprintSchema.parse(JSON.parse(readFileSync(fingerprint, "utf8")));
      if (expected.buildId !== readFileSync(id, "utf8").trim()) return `the panel build does not match its router fingerprint: ${repair}`;
      const actual = routerBuildFingerprint(routerDir);
      return actual.digest === expected.digest && actual.files === expected.files ? null : `the panel build bundles different router content: ${repair}`;
    } catch {
      return `the panel's router build fingerprint is invalid or unreadable: ${repair}`;
    }
  }
  const built = statSync(id).mtimeMs;
  const router = newestFileMtime(routerDir);
  if (router <= built) return null;
  const at = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  return `the panel build (${at(built)} UTC) is older than the router build (${at(router)} UTC) and runs the older router code: rebuild it with pnpm -r build (or pnpm --filter meritrouter-panel build), then restart the panel`;
}

/** For `meritrouter doctor`: whether the panel is built, and built after the router. */
export function panelBuildCheck(): { ok: boolean; detail: string } {
  const app = findPanelApp();
  if ("problem" in app) return { ok: false, detail: app.problem };
  const stale = panelBuildStale(app.dir);
  return stale ? { ok: false, detail: stale } : { ok: true, detail: `built at ${app.dir}, matching the router build` };
}

/**
 * Make sure the panel answers on `panel.port`: start it (detached) when nothing does and
 * `panel.auto_start` is on. A panel the user turned off stays off unless `force` (an explicit
 * start, which also clears the marker and starts it even with `panel.auto_start` off). Never
 * throws: the result says what happened.
 */
export async function ensurePanel(cfg: ResolvedConfig, opts: { waitMs?: number; force?: boolean; resume?: boolean } = {}): Promise<PanelStatus> {
  const url = panelUrl(cfg);
  const warned = (st: PanelStatus): PanelStatus => {
    const app = findPanelApp();
    const warning = "problem" in app ? null : panelBuildStale(app.dir);
    return warning ? { ...st, detail: `${st.detail}; warning: ${warning}`, warning } : st;
  };
  if (await panelListening(cfg.panel.port)) return warned({ state: "running", url, detail: `the panel is running at ${url}` });
  // resume (a new agent session): forget a power-off, but keep panel.auto_start's say.
  if (opts.force || opts.resume) rmSync(panelStopFile(cfg), { force: true });
  else if (existsSync(panelStopFile(cfg))) return { state: "stopped", url, detail: `the panel was turned off from its power button; meritrouter panel or a new agent session starts it again` };
  if (!cfg.panel.auto_start && !opts.force) return { state: "disabled", url, detail: `nothing answers at ${url} and panel.auto_start is off: start it with meritrouter panel` };
  const app = findPanelApp();
  if ("problem" in app) return { state: "unavailable", url, detail: `the panel cannot start: ${app.problem}` };
  let logFile: string;
  try {
    const logs = logsDirFor(cfg.storageDir);
    mkdirSync(logs, { recursive: true });
    logFile = path.join(logs, "panel.log");
    const out = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [app.nextBin, "start", "-H", "127.0.0.1", "-p", String(cfg.panel.port)], {
        cwd: app.dir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        env: {
          ...process.env,
          MERITROUTER_CONFIG: cfg.configPath,
          MERITROUTER_ROUTER_CLI: path.join(routerBuildDir(), "cli.js"),
          ...(app.runtimeModules ? { NODE_PATH: [app.runtimeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) } : {}),
        },
      });
      child.unref();
    } finally {
      // The child has its own handle; this process keeps none (it may start the panel many times).
      closeSync(out);
    }
  } catch (err) {
    return { state: "unavailable", url, detail: `the panel could not be started: ${(err as Error).message}` };
  }
  const deadline = Date.now() + (opts.waitMs ?? START_WAIT_MS);
  while (Date.now() < deadline) {
    if (await panelListening(cfg.panel.port)) return warned({ state: "started", url, detail: `started the panel at ${url} (log: ${logFile})` });
    await new Promise((r) => setTimeout(r, 300));
  }
  return warned({ state: "starting", url, detail: `the panel was started but does not answer at ${url} yet; see ${logFile}` });
}
