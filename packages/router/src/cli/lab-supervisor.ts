import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { LabSupervisorLease } from "../operations/lab-supervisor.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function serveLabs(sy: MeritRouter): Promise<void> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  lease.claim();
  let stopped = false;
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const stop = () => { stopped = true; closing ??= sy.labs.close().catch(error => { failure ??= error; }); };
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

export async function stopLabSupervisor(sy: MeritRouter): Promise<boolean> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  const previous = lease.read();
  if (!previous || !lease.requestStop()) return false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = lease.read();
    if (!state || state.owner !== previous.owner || state.expiresAt <= Date.now()) return true;
    await pause(100);
  }
  throw new MeritRouterError("lab_invalid_state", "Labs supervisor is still shutting down; no process was forcibly terminated");
}
