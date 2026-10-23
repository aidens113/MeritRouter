import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MeritRouter } from "../core/service.js";
import { z } from "zod";
import { MeritRouterError } from "../core/errors.js";
import { immediate, type Db } from "../storage/db.js";

const KEY = "lab_supervisor_v1";
const TTL = 15_000;
const State = z.object({ owner: z.string().regex(/^[a-f0-9]{48}$/), pid: z.number().int().positive(), configPath: z.string().min(1), expiresAt: z.number().int(), ready: z.boolean(), stopRequested: z.boolean() }).strict();
export type LabSupervisorState = z.infer<typeof State>;

/** Explicit human actions may start service supervision without executing model work. */
export async function ensureLabSupervisor(sy: MeritRouter, cliPath?: string): Promise<void> {
  const moduleCli = fileURLToPath(new URL("../cli.js", import.meta.url));
  cliPath ??= [process.env.MERITROUTER_ROUTER_CLI, path.resolve(process.cwd(), "../dist/cli.js"), path.resolve(process.cwd(), "../../packages/router/dist/cli.js"), ...(path.basename(moduleCli) === "cli.js" ? [moduleCli] : [])].find((candidate): candidate is string => !!candidate && existsSync(candidate));
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  const previous = lease.read();
  if (previous && previous.expiresAt > Date.now() && path.resolve(previous.configPath) !== path.resolve(sy.cfg.configPath)) throw new MeritRouterError("conflict", "Labs supervisor uses a different configuration for this storage directory");
  if (previous?.ready && !previous.stopRequested && previous.expiresAt > Date.now()) return;
  if (!previous || previous.expiresAt <= Date.now()) {
    if (!cliPath || !existsSync(cliPath)) throw new MeritRouterError("lab_invalid_state", "Build the router before starting Labs supervision, or run meritrouter labs serve from the installed package");
    const logs = path.join(sy.cfg.storageDir, "logs");
    mkdirSync(logs, { recursive: true });
    const fd = openSync(path.join(logs, "labs.log"), "a");
    const env: NodeJS.ProcessEnv = { ...process.env, MERITROUTER_CONFIG: sy.cfg.configPath };
    delete env.MERITROUTER_PROJECT;
    try {
      const child = spawn(process.execPath, [cliPath, "labs", "serve", "--config", sy.cfg.configPath], { cwd: path.dirname(sy.cfg.configPath), env, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } finally { closeSync(fd); }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = lease.read();
    if (state?.ready && !state.stopRequested && state.expiresAt > Date.now()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new MeritRouterError("lab_invalid_state", "Labs supervisor did not become ready within 30 seconds; inspect storage/logs/labs.log");
}

/** A renewable singleton lease; no PID is used as authority to terminate a process. */
export class LabSupervisorLease {
  readonly owner = randomBytes(24).toString("hex");
  constructor(readonly db: Db, readonly configPath: string, readonly now: () => number = Date.now) {}
  read(): LabSupervisorState | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(KEY) as { value: string } | undefined;
    return row ? State.parse(JSON.parse(row.value)) : null;
  }
  private write(state: LabSupervisorState): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(State.parse(state)));
  }
  claim(): LabSupervisorState {
    return immediate(this.db, () => {
      const current = this.read();
      if (current && current.expiresAt > this.now()) throw new MeritRouterError("conflict", "a Labs supervisor already holds the install lease");
      const state = { owner: this.owner, pid: process.pid, configPath: this.configPath, expiresAt: this.now() + TTL, ready: false, stopRequested: false };
      this.write(state);
      return state;
    });
  }
  heartbeat(ready = true): LabSupervisorState {
    return immediate(this.db, () => {
      const current = this.read();
      if (!current || current.owner !== this.owner || current.expiresAt <= this.now()) throw new MeritRouterError("conflict", "Labs supervisor lease expired or changed owner");
      const state = { ...current, ready, expiresAt: this.now() + TTL };
      this.write(state);
      return state;
    });
  }
  requestStop(): boolean {
    return immediate(this.db, () => {
      const current = this.read();
      if (!current || current.expiresAt <= this.now()) return false;
      this.write({ ...current, stopRequested: true });
      return true;
    });
  }
  release(): void {
    immediate(this.db, () => {
      if (this.read()?.owner === this.owner) this.db.prepare("DELETE FROM meta WHERE key=?").run(KEY);
    });
  }
}
