import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { SwitchyardError } from "../core/errors.js";

/**
 * `switchyard daemon`: runs `switchyard worker` as a child process and restarts it when it dies,
 * with exponential backoff and a cap on restarts per window. When the cap is hit the daemon exits
 * non-zero so the service manager (systemd, launchd, Task Scheduler) applies its own policy.
 * Logs go to `<storage>/logs/`: `daemon.log` (lifecycle) and `worker.log` (the worker's output).
 * One daemon per install (storage directory): its one worker serves every project, with fair
 * claiming across them (storage/fair-claim.ts); there are no per-project daemons.
 */

export const LOGS_DIR = "logs";
export const DAEMON_LOG = "daemon.log";
export const WORKER_LOG = "worker.log";
export const DAEMON_LOCK = "daemon.pid";
/** `switchyard daemon stop` writes this file; a running daemon sees it, stops its worker, and exits. */
export const DAEMON_STOP = "daemon.stop";
/** Output of a daemon started in the background by `switchyard daemon start`. */
export const DAEMON_OUT = "daemon.out";
const ROTATE_BYTES = 10 * 1024 * 1024;

export const logsDirFor = (storageDir: string) => path.join(storageDir, LOGS_DIR);

export const RestartPolicySchema = z
  .object({
    /** Delay before the first restart after a failure. */
    initialDelayMs: z.number().int().nonnegative().default(1000),
    /** Backoff ceiling. */
    maxDelayMs: z.number().int().positive().default(60_000),
    multiplier: z.number().min(1).default(2),
    /** Restarts allowed inside `windowMs` before the daemon gives up. */
    maxRestarts: z.number().int().positive().default(5),
    windowMs: z.number().int().positive().default(10 * 60_000),
    /** A worker that ran at least this long resets the backoff. */
    stableAfterMs: z.number().int().positive().default(60_000),
  })
  .strict();
export type RestartPolicyConfig = z.infer<typeof RestartPolicySchema>;

export type RestartDecision = { action: "restart"; delayMs: number; attempt: number; restartsInWindow: number } | { action: "give_up"; reason: string };

/** Pure restart policy: feed it each unrequested child exit; it says when (or whether) to restart. */
export class RestartPolicy {
  readonly config: RestartPolicyConfig;
  private restarts: number[] = [];
  private consecutive = 0;

  constructor(config: z.input<typeof RestartPolicySchema> = {}) {
    this.config = RestartPolicySchema.parse(config);
  }

  onExit(now: number, ranMs: number): RestartDecision {
    const c = this.config;
    if (ranMs >= c.stableAfterMs) this.consecutive = 0;
    this.restarts = this.restarts.filter((t) => now - t < c.windowMs);
    if (this.restarts.length >= c.maxRestarts) {
      return { action: "give_up", reason: `${this.restarts.length} restarts within ${Math.round(c.windowMs / 1000)}s` };
    }
    const delayMs = Math.min(c.maxDelayMs, Math.round(c.initialDelayMs * c.multiplier ** this.consecutive));
    this.consecutive++;
    this.restarts.push(now);
    return { action: "restart", delayMs, attempt: this.consecutive, restartsInWindow: this.restarts.length };
  }
}

/** The part of a ChildProcess the daemon uses (a fake in tests). */
export interface DaemonChild {
  readonly pid?: number | undefined;
  readonly stdout?: Readable | null;
  readonly stderr?: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type DaemonSpawn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => DaemonChild;

export const defaultSpawn: DaemonSpawn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

export interface DaemonOptions {
  /** Executable and arguments of the worker (normally node, the CLI, `worker --config <file>`). */
  command: string;
  args: string[];
  cwd: string;
  /** `<storage>/logs`; created when missing. */
  logsDir: string;
  policy?: z.input<typeof RestartPolicySchema>;
  /** Grace period after asking the worker to stop before it is killed. */
  stopTimeoutMs?: number;
  spawn?: DaemonSpawn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Poll for a stop request file (`<logs>/daemon.stop`) every this many ms (0: never). */
  stopPollMs?: number;
}

export interface DaemonExit {
  reason: "stopped" | "gave_up";
  detail: string;
  starts: number;
  lastExit: { code: number | null; signal: string | null } | null;
}

/** Supervises one worker child process under a `RestartPolicy`. */
export class Daemon {
  readonly policy: RestartPolicy;
  private readonly spawnFn: DaemonSpawn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: DaemonChild | null = null;
  private childExited: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private workerLog: WriteStream | null = null;
  starts = 0;

  constructor(private readonly opts: DaemonOptions) {
    this.policy = new RestartPolicy(opts.policy ?? {});
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Append one line to `daemon.log`. */
  log(message: string): void {
    mkdirSync(this.opts.logsDir, { recursive: true });
    appendFileSync(path.join(this.opts.logsDir, DAEMON_LOG), `${new Date(this.now()).toISOString()} ${message}\n`);
  }

  /** Run until `stop()` or until the policy gives up. */
  async run(): Promise<DaemonExit> {
    mkdirSync(this.opts.logsDir, { recursive: true });
    rotateIfLarge(path.join(this.opts.logsDir, WORKER_LOG));
    rotateIfLarge(path.join(this.opts.logsDir, DAEMON_LOG));
    this.workerLog = createWriteStream(path.join(this.opts.logsDir, WORKER_LOG), { flags: "a" });
    this.log(`daemon ${process.pid} started: ${[this.opts.command, ...this.opts.args].join(" ")}`);
    let lastExit: DaemonExit["lastExit"] = null;
    const stopFile = path.join(this.opts.logsDir, DAEMON_STOP);
    rmSync(stopFile, { force: true });
    const pollMs = this.opts.stopPollMs ?? 500;
    const poll = pollMs > 0
      ? setInterval(() => {
          if (!existsSync(stopFile)) return;
          rmSync(stopFile, { force: true });
          this.log("stop requested (daemon stop)");
          void this.stop();
        }, pollMs)
      : null;
    try {
      while (!this.stopping) {
        const startedAt = this.now();
        const exit = await this.runOnce();
        lastExit = exit;
        const ranMs = this.now() - startedAt;
        if (this.stopping) break;
        const decision = this.policy.onExit(this.now(), ranMs);
        const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
        if (decision.action === "give_up") {
          this.log(`worker exited (${how}) after ${ranMs}ms; giving up: ${decision.reason}`);
          return { reason: "gave_up", detail: decision.reason, starts: this.starts, lastExit };
        }
        this.log(`worker exited (${how}) after ${ranMs}ms; restart ${decision.restartsInWindow}/${this.policy.config.maxRestarts} in window in ${decision.delayMs}ms`);
        await Promise.race([this.sleep(decision.delayMs), new Promise<void>((r) => (this.wake = r))]);
        this.wake = null;
      }
      this.log("daemon stopped");
      return { reason: "stopped", detail: "stop requested", starts: this.starts, lastExit };
    } finally {
      if (poll) clearInterval(poll);
      await new Promise<void>((r) => (this.workerLog ? this.workerLog.end(r) : r()));
      this.workerLog = null;
    }
  }

  private runOnce(): Promise<{ code: number | null; signal: string | null }> {
    this.starts++;
    return new Promise((resolve) => {
      let settled = false;
      const done = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        this.child = null;
        resolve({ code, signal });
      };
      let child: DaemonChild;
      try {
        child = this.spawnFn(this.opts.command, this.opts.args, { cwd: this.opts.cwd, env: this.opts.env ?? process.env });
      } catch (err) {
        this.log(`spawn failed: ${(err as Error).message}`);
        done(null, null);
        return;
      }
      this.child = child;
      this.childExited = new Promise<void>((r) => {
        child.on("exit", (code, signal) => {
          done(code, signal);
          r();
        });
        child.on("error", (err) => {
          this.log(`worker error: ${err.message}`);
          done(null, null);
          r();
        });
      });
      if (this.workerLog) {
        child.stdout?.pipe(this.workerLog, { end: false });
        child.stderr?.pipe(this.workerLog, { end: false });
      }
      this.log(`worker started (pid ${child.pid ?? "?"}, start ${this.starts})`);
    });
  }

  /**
   * Stop the worker and the daemon. SIGTERM first (on Windows this terminates the process; the
   * worker's sessions and leases are recovered on the next start), SIGKILL after the grace period.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    const child = this.child;
    const exited = this.childExited;
    if (!child || !exited) return;
    this.log("stopping worker");
    child.kill("SIGTERM");
    const timeout = this.opts.stopTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), timeout);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.log(`worker did not stop within ${timeout}ms; killing`);
      child.kill("SIGKILL");
      await exited;
    }
  }
}

function rotateIfLarge(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // Another process has the file open (Windows); keep appending.
  }
}

const LockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string(), configPath: z.string() }).strict();
export type DaemonLock = z.infer<typeof LockSchema>;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The daemon recorded in `<logs>/daemon.pid`, and whether its process is still alive. */
export function readDaemonLock(logsDir: string): (DaemonLock & { alive: boolean }) | null {
  const file = path.join(logsDir, DAEMON_LOCK);
  if (!existsSync(file)) return null;
  try {
    const lock = LockSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { ...lock, alive: isAlive(lock.pid) };
  } catch {
    return null;
  }
}

/**
 * One daemon per storage directory. A lock left by a dead process is replaced. Returns the
 * release function.
 */
export function acquireDaemonLock(logsDir: string, configPath: string, pid = process.pid): () => void {
  const existing = readDaemonLock(logsDir);
  if (existing && existing.alive && existing.pid !== pid) {
    throw new SwitchyardError("conflict", `a daemon (pid ${existing.pid}, started ${existing.startedAt}) is already running for this storage directory`);
  }
  mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, DAEMON_LOCK);
  writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString(), configPath } satisfies DaemonLock));
  return () => {
    const now = readDaemonLock(logsDir);
    if (now?.pid === pid) rmSync(file, { force: true });
  };
}

/** Ask the daemon recorded under `logsDir` to stop (it polls for the request file). */
export function requestDaemonStop(logsDir: string): void {
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(path.join(logsDir, DAEMON_STOP), `${new Date().toISOString()} ${process.pid}
`);
}

/** Whether a process id is still running. */
export function processAlive(pid: number): boolean {
  return isAlive(pid);
}
