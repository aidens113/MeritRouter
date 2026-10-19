import { resolveOptions } from "./config.js";

export function createClient(options) {
  const opts = resolveOptions(options);
  return {
    describe() {
      return `retries=${opts.retries} timeout=${opts.timeoutMs}ms`;
    },
    deadline(now) {
      return now + opts.timeoutMs;
    },
  };
}
