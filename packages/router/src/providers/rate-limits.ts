import type { RateLimitHeaderFamily, RateLimitHeaderSpec, RateLimitPeriod } from "./registry.js";

export type RateLimitMetric = "requests" | "tokens" | "input_tokens" | "output_tokens";

/** One limit window a provider reported. Values the provider omitted are null. */
export interface RateLimitWindow {
  metric: RateLimitMetric;
  period: RateLimitPeriod;
  limit: number | null;
  remaining: number | null;
  /** When the window resets (epoch ms). */
  resetAt: number | null;
}

/** Normalized rate-limit state from one response's headers. */
export interface RateLimitSnapshot {
  family: RateLimitHeaderFamily;
  observedAt: number;
  /** From `retry-after` (seconds or HTTP date), as a delay from `observedAt`. */
  retryAfterMs: number | null;
  windows: RateLimitWindow[];
}

/** Headers kept for audit on telemetry: rate-limit state and request ids, never credentials. */
const AUDIT_HEADER = /^(x-ratelimit-|anthropic-ratelimit-|retry-after$|x-request-id$|request-id$)/i;

export function auditHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (AUDIT_HEADER.test(k)) out[k.toLowerCase()] = v;
  });
  return out;
}

/** `retry-after`: delay seconds or an HTTP date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A reset header value as an absolute time (epoch ms). Accepts Go-style durations (`6m0s`,
 * `7.66s`, `250ms`), bare numbers (epoch ms, epoch seconds, or a delay in seconds by
 * magnitude), and ISO/RFC 3339 dates.
 */
export function parseResetValue(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n >= 1e12) return Math.round(n);
    if (n >= 1e9) return Math.round(n * 1000);
    return now + Math.round(n * 1000);
  }
  if (/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(v)) {
    let ms = 0;
    for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(m[1]) * DURATION_UNIT_MS[m[2]!]!;
    return now + Math.round(ms);
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function num(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function windowFrom(h: Headers, metric: RateLimitMetric, period: RateLimitPeriod, names: { limit: string; remaining: string; reset: string }, now: number): RateLimitWindow | null {
  const limit = num(h, names.limit);
  const remaining = num(h, names.remaining);
  const resetAt = parseResetValue(h.get(names.reset), now);
  if (limit === null && remaining === null && resetAt === null) return null;
  return { metric, period, limit, remaining, resetAt };
}

/**
 * Parse a response's rate-limit headers into one normalized snapshot. Families:
 * `openai` (`x-ratelimit-{limit,remaining,reset}-{requests,tokens}` plus `-day` variants),
 * `openrouter` (`x-ratelimit-{limit,remaining,reset}`), `anthropic`
 * (`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`).
 * `retry-after` is read for every family.
 */
export function parseRateLimitHeaders(h: Headers, spec: RateLimitHeaderSpec, now: number): RateLimitSnapshot {
  const windows: RateLimitWindow[] = [];
  const add = (w: RateLimitWindow | null) => {
    if (w) windows.push(w);
  };
  if (spec.family === "openai") {
    for (const metric of ["requests", "tokens"] as const) {
      const period = metric === "requests" ? spec.requestsPeriod : spec.tokensPeriod;
      add(windowFrom(h, metric, period, { limit: `x-ratelimit-limit-${metric}`, remaining: `x-ratelimit-remaining-${metric}`, reset: `x-ratelimit-reset-${metric}` }, now));
      add(windowFrom(h, metric, "day", { limit: `x-ratelimit-limit-${metric}-day`, remaining: `x-ratelimit-remaining-${metric}-day`, reset: `x-ratelimit-reset-${metric}-day` }, now));
    }
  } else if (spec.family === "openrouter") {
    add(windowFrom(h, "requests", spec.requestsPeriod, { limit: "x-ratelimit-limit", remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" }, now));
  } else if (spec.family === "anthropic") {
    const metrics: Array<[RateLimitMetric, string]> = [
      ["requests", "requests"],
      ["tokens", "tokens"],
      ["input_tokens", "input-tokens"],
      ["output_tokens", "output-tokens"],
    ];
    for (const [metric, name] of metrics) {
      const period = metric === "requests" ? spec.requestsPeriod : spec.tokensPeriod;
      add(windowFrom(h, metric, period, { limit: `anthropic-ratelimit-${name}-limit`, remaining: `anthropic-ratelimit-${name}-remaining`, reset: `anthropic-ratelimit-${name}-reset` }, now));
    }
  }
  return { family: spec.family, observedAt: now, retryAfterMs: parseRetryAfter(h.get("retry-after"), now), windows };
}

/**
 * How long until the key may be used again: `retry-after` when given, otherwise the latest
 * reset among exhausted windows (remaining 0). Null when the headers do not say.
 */
export function cooldownMs(s: RateLimitSnapshot): number | null {
  if (s.retryAfterMs !== null) return s.retryAfterMs;
  const exhausted = s.windows.filter((w) => w.remaining === 0 && w.resetAt !== null).map((w) => w.resetAt! - s.observedAt);
  return exhausted.length ? Math.max(0, ...exhausted) : null;
}
