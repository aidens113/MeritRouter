import type { ResolvedConfig } from "../../config/load.js";
import type { CodingRunner } from "../../core/executor.js";
import { NativeCodingRunner } from "./native.js";

/**
 * MeritRouter's own coding worker (native.ts). An earlier external/OpenCode/command runner
 * always failed closed (no enforced OS repository sandbox: `worker_sandbox_unavailable`) and
 * implied a capability that never existed; `coding.runner` now only accepts "native"
 * (config/schema.ts refuses any other value at config parse, with that history in the message).
 * `task-tools.ts` and `policy-gateway.ts` in this directory are unrelated: they back the
 * in-process MCP task bridge used directly by the native runner's own tests, not an external
 * agent process.
 */
export function createCodingRunner(_cfg: ResolvedConfig): CodingRunner {
  return new NativeCodingRunner();
}
