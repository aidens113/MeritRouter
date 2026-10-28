import type { MeritRouter } from "../core/service.js";
import type { LabManager } from "../labs/lab.js";
import { MeritRouterError } from "../core/errors.js";
import { LabSupervisorLease } from "../operations/lab-supervisor.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Every live split project's own Lab manager (each holds that project's retained Labs in its
 * project-local store). A project without a live or openable store has nothing to supervise; it is
 * looked for again on the next pass. Empty in a legacy installation, whose Labs are all `sy.labs`.
 */
function projectManagers(sy: MeritRouter): LabManager[] {
  if (sy.layout !== "split") return [];
  const out = new Set<LabManager>();
  for (const slug of sy.projects.slugs()) {
    try {
      const labs = sy.labsFor(slug);
      if (labs !== sy.labs) out.add(labs);
    } catch { /* no project-local store yet, or it is unavailable */ }
  }
  return [...out];
}

/**
 * The installation's Labs supervisor: crash restarts, adoption, idle stops and queued controls for
 * retained Labs. It ticks the installation manager and, in a split installation, every project's
 * own manager, recovering each once when first seen. One project's failure is reported and does not
 * stop the others from being supervised.
 */
export async function serveLabs(sy: MeritRouter, options: { onProjectError?: (error: unknown) => void } = {}): Promise<void> {
  const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
  lease.claim();
  let stopped = false;
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const supervised = new Set<LabManager>();
  const lastError = new Map<LabManager, string>();
  const reportProject = options.onProjectError ?? ((error: unknown) => { process.stderr.write(`labs serve: ${(error as Error)?.message ?? String(error)}\n`); });
  const closeAll = () => Promise.all([sy.labs.close(), ...[...supervised].map(labs => labs.close())]).then(() => undefined);
  const stop = () => { stopped = true; closing ??= closeAll().catch(error => { failure ??= error; }); };
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
      for (const labs of projectManagers(sy)) {
        if (stopped) break;
        try {
          if (!supervised.has(labs)) {
            supervised.add(labs);
            await labs.recover();
          }
          await labs.tick();
          lastError.delete(labs);
        } catch (error) {
          // Reported once per distinct failure, not on every 200 ms pass.
          const message = (error as Error)?.message ?? String(error);
          if (lastError.get(labs) !== message) { lastError.set(labs, message); reportProject(error); }
        }
      }
      await pause(200);
    }
    await closing;
    if (failure) throw failure;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await closeAll();
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
