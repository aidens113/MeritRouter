import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config/load.js";
import { logsDirFor } from "./daemon.js";

// The web panel stays reachable while agents use SwitchYard: the MCP server and `switchyard
// worker` start it when nothing answers on `panel.port` (`panel.auto_start`), and the MCP server
// checks again every minute. It runs as its own detached process (`next start` on 127.0.0.1), so
// it outlives the session that started it; two processes starting it at once is harmless (the
// second cannot bind the port and exits). Its output goes to `<storage>/logs/panel.log`.

/** Overrides where the built panel app lives (default: `apps/panel` of the checkout this package runs from). */
export const PANEL_DIR_ENV = "SWITCHYARD_PANEL_DIR";
/** How long a start waits for the panel to answer before reporting it as still starting. */
const START_WAIT_MS = 20_000;

export type PanelState = "running" | "started" | "starting" | "disabled" | "unavailable";

export interface PanelStatus {
  state: PanelState;
  url: string;
  /** What happened, or how to fix it (an unbuilt panel, say). */
  detail: string;
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
export function findPanelApp(): { dir: string; nextBin: string } | { problem: string } {
  // dist/operations/panel.js -> the repository root is four levels up.
  const dir = process.env[PANEL_DIR_ENV] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/panel");
  const nextBin = path.join(dir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(path.join(dir, "package.json"))) return { problem: `no panel app at ${dir} (it ships with a repository checkout; set ${PANEL_DIR_ENV} to its folder)` };
  if (!existsSync(nextBin)) return { problem: `the panel's dependencies are not installed in ${dir}: run pnpm install at the repository root` };
  if (!existsSync(path.join(dir, ".next", "BUILD_ID"))) return { problem: `the panel is not built: run pnpm -r build at the repository root` };
  return { dir, nextBin };
}

/**
 * Make sure the panel answers on `panel.port`: start it (detached) when nothing does and
 * `panel.auto_start` is on. Never throws: the result says what happened.
 */
export async function ensurePanel(cfg: ResolvedConfig, opts: { waitMs?: number } = {}): Promise<PanelStatus> {
  const url = panelUrl(cfg);
  if (await panelListening(cfg.panel.port)) return { state: "running", url, detail: `the panel is running at ${url}` };
  if (!cfg.panel.auto_start) return { state: "disabled", url, detail: `nothing answers at ${url} and panel.auto_start is off: start it with switchyard panel` };
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
        env: { ...process.env, SWITCHYARD_CONFIG: cfg.configPath },
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
    if (await panelListening(cfg.panel.port)) return { state: "started", url, detail: `started the panel at ${url} (log: ${logFile})` };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { state: "starting", url, detail: `the panel was started but does not answer at ${url} yet; see ${logFile}` };
}
