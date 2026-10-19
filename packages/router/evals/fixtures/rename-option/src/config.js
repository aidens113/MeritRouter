export const DEFAULTS = { retries: 2, timeoutMs: 5000 };

/** Merge user options over defaults. */
export function resolveOptions(options = {}) {
  return { ...DEFAULTS, ...options };
}
