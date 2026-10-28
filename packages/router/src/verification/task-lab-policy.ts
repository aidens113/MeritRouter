import { loadConfig, type ResolvedConfig } from "../config/load.js";
import type { StoredTask } from "../storage/tasks.js";

/**
 * Why a task's required Lab checks can never run under its own run authority, or null when they
 * might. It mirrors the policy gate `runTaskLabChecks` applies before any Lab effect: the trusted
 * `security.outside_repository` policy, and supervisor authority, which only a supervisor-mode
 * profile holds (Lab checks are declared on coding tasks, so a worker run never has it). When
 * this returns a reason, a repair or escalation would be refused the same way: no retry can
 * produce Lab evidence, so the task settles with the refusal instead of spending another run.
 * Only the trusted configuration file is consulted (as the gate does); an unreadable one is not
 * treated as a deterministic refusal.
 */
export function taskLabPolicyRefusal(cfg: Pick<ResolvedConfig, "configPath">, task: Pick<StoredTask, "spec">): string | null {
  if (!task.spec.constraints.labChecks?.length) return null;
  let trusted: ResolvedConfig;
  try { trusted = loadConfig(cfg.configPath); } catch { return null; }
  const policy = trusted.security.outside_repository;
  if (policy === "disabled") return "required task Lab checks are refused by policy: Lab effects are disabled by security.outside_repository, so no retry can run them";
  if (policy !== "supervisor") return `required task Lab checks are refused by policy: security.outside_repository is ${policy}, and Lab execution needs supervisor authority, so no retry can run them`;
  if (trusted.profiles[task.spec.profile]?.mode !== "supervisor") return `required task Lab checks are refused by policy: a ${task.spec.profile} worker run has no supervisor Lab authority, so no retry can run them`;
  return null;
}
