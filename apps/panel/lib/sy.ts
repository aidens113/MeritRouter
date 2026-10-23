import "server-only";
import path from "node:path";
import { MeritRouter, loadConfig } from "meritrouter";

/**
 * One MeritRouter per panel process. The panel never runs the worker loop: tasks execute in the
 * MCP server (inside Claude Code) or `meritrouter worker`, which share the same SQLite database.
 */
type Holder = { sy: MeritRouter | null; error: string | null; configPath: string; at: number };

const KEY = Symbol.for("meritrouter.panel.instance");
const g = globalThis as unknown as Record<symbol, Holder | undefined>;

export function configPathFor(): string {
  const explicit = process.env.MERITROUTER_CONFIG;
  // The config is read at runtime; tell Turbopack not to trace these paths at build time.
  return explicit ? path.resolve(/* turbopackIgnore: true */ process.cwd(), explicit) : path.resolve(/* turbopackIgnore: true */ process.cwd(), "../../meritrouter.config.yaml");
}

function open(): Holder {
  const configPath = configPathFor();
  try {
    const cfg = loadConfig(configPath);
    const sy = new MeritRouter(cfg, { worker: false });
    // Library calls such as submitTasks()/resumeTask() (used by qualification) kick the in-process
    // scheduler even with worker: false, which would run tasks inside the panel. Stopping the
    // scheduler makes every kick a no-op; a real worker (MCP server or `meritrouter worker`)
    // claims the work from the shared database instead.
    void (sy as unknown as { scheduler: { stop(): Promise<void> } }).scheduler.stop();
    // Make every configured repository a usable git repository (created, set up with git, first
    // snapshot committed, as needed); what was done shows on the project overview.
    void sy.prepareRepositories().catch(() => undefined);
    return { sy, error: null, configPath, at: Date.now() };
  } catch (err) {
    return { sy: null, error: (err as Error).message, configPath, at: Date.now() };
  }
}

/** The shared instance, or the reason it could not be opened (missing/invalid config). */
export function getSy(): { sy: MeritRouter; error: null; configPath: string } | { sy: null; error: string; configPath: string } {
  let h = g[KEY];
  // Retry a failed open every few seconds so fixing the config does not need a restart.
  if (!h || (!h.sy && Date.now() - h.at > 3000)) {
    h = open();
    g[KEY] = h;
  }
  if (h.sy) {
    // Pick up edits made by the CLI, a worker, or a text editor, and prepare repositories they added.
    if (h.sy.reloadIfChanged().reloaded) void h.sy.prepareRepositories().catch(() => undefined);
    return { sy: h.sy, error: null, configPath: h.configPath };
  }
  return { sy: null, error: h.error ?? "unknown error", configPath: h.configPath };
}

export class NotConfigured extends Error {
  constructor(
    message: string,
    readonly configPath: string,
  ) {
    super(message);
  }
}

/** For route handlers: the instance or a thrown NotConfigured. */
export function requireSy(): MeritRouter {
  const r = getSy();
  if (!r.sy) throw new NotConfigured(r.error, r.configPath);
  return r.sy;
}
