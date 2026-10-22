import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../core/service.js";
import { SwitchyardError } from "../core/errors.js";
import { LabSupervisorLease } from "../operations/lab-supervisor.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Start only the lab-service supervisor. This never starts a model worker. */
export async function ensureLabSupervisor(sy: Switchyard, cliPath: string): Promise<void> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  const previous = lease.read();
  if (previous?.ready && !previous.stopRequested && previous.expiresAt > Date.now()) return;
  if (!previous || previous.expiresAt <= Date.now()) {
    const logs = path.join(sy.cfg.storageDir, "logs");
    mkdirSync(logs, { recursive: true });
    const fd = openSync(path.join(logs, "labs.log"), "a");
    try {
      const child = spawn(process.execPath, [cliPath, "labs", "serve", "--config", sy.cfg.configPath], { cwd: path.dirname(sy.cfg.configPath), env: { ...process.env, SWITCHYARD_CONFIG: sy.cfg.configPath }, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } finally { closeSync(fd); }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = lease.read();
    if (state?.ready && !state.stopRequested && state.expiresAt > Date.now()) return;
    await pause(100);
  }
  throw new SwitchyardError("lab_invalid_state", "Labs supervisor did not become ready within 30 seconds; inspect storage/logs/labs.log");
}

export async function serveLabs(sy: Switchyard): Promise<void> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  lease.claim();
  let stopped = false;
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const stop = () => { stopped = true; closing ??= sy.labs.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const heartbeat = setInterval(() => {
    try { if (lease.heartbeat(!stopped).stopRequested) stop(); }
    catch (error) { failure = error; stop(); }
  }, 1000);
  try {
    await sy.labs.recover();
    lease.heartbeat(true);
    while (!stopped) {
      sy.reloadIfChanged();
      await sy.labs.tick();
      await pause(200);
    }
    await closing;
    if (failure) throw failure;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await sy.labs.close();
    lease.release();
  }
}

export async function stopLabSupervisor(sy: Switchyard): Promise<boolean> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  const previous = lease.read();
  if (!previous || !lease.requestStop()) return false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = lease.read();
    if (!state || state.owner !== previous.owner || state.expiresAt <= Date.now()) return true;
    await pause(100);
  }
  throw new SwitchyardError("lab_invalid_state", "Labs supervisor is still shutting down; no process was forcibly terminated");
}
