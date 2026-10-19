import { resolveOptions } from "./config.js";

export function createServer(options) {
  const opts = resolveOptions(options);
  return { idleCutoffMs: opts.timeoutMs * 2, retries: opts.retries };
}
