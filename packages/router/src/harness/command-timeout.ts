import type { ResolvedConfig } from "../config/load.js";

/** One command policy for operation clocks, recipe execution and advertised defaults. */
export function commandTimeoutMs(cfg: Pick<ResolvedConfig, "execution">, explicitMs?: number, checkLimitMs = Infinity): number {
  return Math.min(explicitMs ?? cfg.execution.check_timeout_seconds * 1000, checkLimitMs, 300000);
}
