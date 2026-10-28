import { loadConfig, type ResolvedConfig } from "../config/load.js";
import type { WorkerTask } from "../core/task.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";
import type { Db } from "../storage/db.js";
import { capturedLease } from "../storage/task-leases.js";
import type { StoredTask } from "../storage/tasks.js";

/**
 * The policy gate for a task's required Lab checks, shared by the gate itself
 * (`runTaskLabChecks`) and verification's no-retry decision: the reason the checks are refused,
 * or null when they may run. It reads the trusted `security.outside_repository` policy, then asks
 * `supervisorAuthority` (the run's live supervisor privilege, `currentSupervisorAuthority`).
 * An unreadable trusted configuration throws, so the gate fails closed.
 */
export function taskLabPolicyRefusal(cfg: Pick<ResolvedConfig, "configPath">, spec: Pick<WorkerTask, "profile" | "constraints">, supervisorAuthority: () => boolean): string | null {
  if (!spec.constraints.labChecks?.length) return null;
  const policy = loadConfig(cfg.configPath).security.outside_repository;
  if (policy === "disabled") return "required task Lab checks are refused by policy: Lab effects are disabled by security.outside_repository, so no retry can run them";
  if (policy !== "supervisor") return `required task Lab checks are refused by policy: security.outside_repository is ${policy}, and Lab execution needs supervisor authority, so no retry can run them`;
  if (!supervisorAuthority()) return `required task Lab checks are refused by policy: this ${spec.profile} run has no supervisor Lab authority, so no retry can run them`;
  return null;
}

/**
 * The same gate evaluated for a running task's own claim, for verification: when it refuses, a
 * repair or escalation of this task would be refused the same way, so the task settles with the
 * reason instead of spending a run. A task without a readable claim or trusted configuration is
 * not treated as a deterministic refusal (verification then keeps its ordinary retry rules).
 */
export function taskLabRetryRefusal(d: { cfg: ResolvedConfig; db: Db; now: () => number }, task: StoredTask): string | null {
  if (!task.spec.constraints.labChecks?.length) return null;
  try { return taskLabPolicyRefusal(d.cfg, task.spec, () => currentSupervisorAuthority(d.db, d.cfg, capturedLease(task), d.now())); }
  catch { return null; }
}
