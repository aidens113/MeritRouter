// Running SwitchYard's MCP server: options, project choice, the panel, and the transport.
//
// One process serves one project of the install (decision D8 of docs/working/projects.md):
// `--project <slug>`, else SWITCHYARD_PROJECT, else the only project, else the project whose
// repository contains the working directory; with none, it refuses to start and lists the
// projects. Tools default to that project (and the brain tools work in its brain). It runs the
// worker loop in-process unless `--no-worker` (when a daemon already runs the worker for every
// project); in-process jobs continue only while this process lives (state is persisted
// incrementally and recovered on the next start). It keeps the web panel reachable while it
// runs (`panel.auto_start`; see operations/panel.ts).
//
// Transports: stdio (default; the client launches this process) or Streamable HTTP (`--http`,
// see mcp/http.ts). Both are started by `switchyard mcp` and by `node dist/mcp.js`.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/load.js";
import { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import { selectableProjects } from "../admin/insights.js";
import { PROJECT_ENV, requireProject } from "../cli/project-select.js";
import { ensurePanel } from "../operations/panel.js";
import { MCP_TOKEN_ENV, httpAccessProblem, serveHttp } from "./http.js";
import { buildMcpServer } from "./tools.js";

export const MCP_DEFAULT_HOST = "127.0.0.1";
export const MCP_DEFAULT_PORT = 4478;

export interface McpOptions {
  config?: string;
  project?: string;
  /** Run the worker loop in this process (false with --no-worker). */
  worker: boolean;
  /** Streamable HTTP instead of stdio. */
  http: boolean;
  host: string;
  port: number;
}

/** The MCP server's flags, as parsed by node:util parseArgs (the CLI's or mcp.ts's own). */
export const MCP_FLAGS = {
  config: { type: "string" },
  project: { type: "string" },
  "no-worker": { type: "boolean", default: false },
  http: { type: "boolean", default: false },
  host: { type: "string" },
  port: { type: "string" },
} as const;

/** Options from parsed flags. `--host` or `--port` alone also selects HTTP. */
export function mcpOptions(values: Record<string, unknown>): McpOptions {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const host = str(values.host);
  const portText = str(values.port);
  const port = portText === undefined ? MCP_DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new SwitchyardError("usage", `--port takes 0-65535, got ${JSON.stringify(portText)}`);
  return {
    ...(str(values.config) ? { config: str(values.config)! } : {}),
    ...(str(values.project) ? { project: str(values.project)! } : {}),
    worker: values["no-worker"] !== true,
    http: values.http === true || host !== undefined || portText !== undefined,
    host: host ?? MCP_DEFAULT_HOST,
    port,
  };
}

/** Options from a command line: [--config <file>] [--project <slug>] [--no-worker] [--http] [--host <h>] [--port <n>]. */
export function parseMcpArgv(argv: string[]): McpOptions {
  const { values } = parseArgs({ args: argv, strict: false, allowPositionals: true, options: MCP_FLAGS });
  return mcpOptions(values);
}

/** Diagnostics go to stderr: on stdio, stdout carries the protocol. */
const log = (line: string) => process.stderr.write(`switchyard mcp: ${line}\n`);

/**
 * Serve until the client disconnects (stdio), or until SIGINT/SIGTERM. Resolves after the
 * service is closed; the caller exits the process.
 */
export async function runMcpServer(opts: McpOptions, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = env[MCP_TOKEN_ENV]?.trim() || undefined;
  // Refuse an unsafe HTTP setup before opening anything.
  const problem = opts.http ? httpAccessProblem(opts.host, token) : null;
  if (problem) throw new SwitchyardError("usage", problem);

  const cfg = loadConfig(opts.config);
  const sy = new Switchyard(cfg, { worker: opts.worker });
  let project: string;
  try {
    project = requireProject(selectableProjects(sy), { flag: opts.project, env: env[PROJECT_ENV], cwd: process.cwd() }).slug;
  } catch (err) {
    await sy.close();
    throw err;
  }
  // Recovery belongs to the process that runs the worker (the daemon, with --no-worker).
  if (opts.worker) sy.recover();
  // The panel stays reachable while agents use this server: started now if nothing answers, and
  // checked again every minute (a crashed panel comes back; one the user turned off stays off).
  // Never blocks the MCP handshake. A new server turns a panel the user switched off back on (force); the minute checks respect it.
  const keepPanel = (force: boolean) => void ensurePanel(cfg, { force }).then((p) => p.state !== "running" && p.state !== "stopped" && log(p.detail));
  keepPanel(true);
  const panelTimer = setInterval(() => keepPanel(false), 60_000);
  panelTimer.unref();
  const ctx = { sy, cfg, project };

  let stopTransport: () => Promise<void>;
  try {
    if (opts.http) {
      const h = await serveHttp({ host: opts.host, port: opts.port, token, build: () => buildMcpServer(ctx) });
      stopTransport = h.close;
      log(`serving project ${project} at ${h.url} (${token ? `requests must carry ${MCP_TOKEN_ENV}` : "no token: loopback clients only"})`);
    } else {
      const server = buildMcpServer(ctx);
      await server.connect(new StdioServerTransport());
      stopTransport = () => server.close();
    }
  } catch (err) {
    clearInterval(panelTimer);
    await sy.close();
    throw err;
  }

  return new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      clearInterval(panelTimer);
      void stopTransport()
        .catch(() => undefined)
        .then(() => sy.close())
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    // A stdio client ends the session by closing our stdin. An HTTP server ignores stdin (it may
    // run detached with no stdin at all).
    if (!opts.http) process.stdin.on("close", shutdown);
  });
}
