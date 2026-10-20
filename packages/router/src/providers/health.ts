import type { ProviderStatus } from "../gateway/types.js";
import type { ProviderCredential } from "./credentials.js";
import type { KeyAvailability, KeyState, ProviderKeys } from "./keys.js";
import type { ProviderLimits } from "./limits.js";
import type { RateLimitSnapshot } from "./rate-limits.js";
import type { ResolvedProvider } from "./registry.js";

/**
 * Provider health computed from SwitchYard's own key state, in the `ProviderStatus` shape the circuit breakers, adaptive slots, routing,
 * and the panel already consume:
 * - `healthy`: at least one key can take a request now.
 * - `invalid`: every usable key is disabled (bad key, or out of credits) and needs the user.
 * - `rate_limited`: no key can serve now but some will (cooldown, exhausted window, free daily
 *   quota, configured limit); `resumeAt` is the earliest expected return, null when unknown.
 * - `unknown`: the provider has no usable key at all (none configured, all disabled in config,
 *   env vars unset).
 */

export interface ProviderHealthDetail {
  status: ProviderStatus;
  /** Every credential of the provider, usable or not, with why it cannot serve. */
  keys: KeyAvailability[];
}

export interface ProviderHealthOptions {
  /** Count configured limits (an exhausted limit makes a key unavailable). */
  limits?: ProviderLimits;
}

/** Fraction of requests left across keys: per key its tightest current request window. */
function requestsRemainingPct(states: ReadonlyArray<KeyState | undefined>, now: number): number | null {
  let remaining = 0;
  let limit = 0;
  for (const s of states) {
    const snap: RateLimitSnapshot | null = s?.rateLimits ?? null;
    if (!snap) continue;
    let best: { remaining: number; limit: number } | null = null;
    for (const w of snap.windows) {
      if (w.metric !== "requests" || w.limit === null || w.limit <= 0 || w.remaining === null) continue;
      // A window that has reset since the snapshot no longer tells anything.
      if (w.resetAt !== null && w.resetAt <= now) continue;
      if (!best || w.remaining / w.limit < best.remaining / best.limit) best = { remaining: w.remaining, limit: w.limit };
    }
    if (best) {
      remaining += Math.max(0, best.remaining);
      limit += best.limit;
    }
  }
  return limit > 0 ? Math.round((100 * remaining) / limit) : null;
}

/**
 * The key's last error while it still describes the key: recorded after its last success. An
 * error a later success resolved is history, not health (key state keeps it for display).
 */
export function currentError(state: Pick<KeyState, "lastError" | "lastErrorAt" | "lastSuccessAt"> | null | undefined): { message: string; at: number } | null {
  if (!state || state.lastError === null || state.lastErrorAt === null) return null;
  if (state.lastSuccessAt !== null && state.lastSuccessAt >= state.lastErrorAt) return null;
  return { message: state.lastError, at: state.lastErrorAt };
}

/** Health of one provider from its credentials and their recorded state. */
export function providerHealth(provider: ResolvedProvider, credentials: ReadonlyArray<ProviderCredential>, keys: ProviderKeys, opts: ProviderHealthOptions = {}): ProviderHealthDetail {
  const creds = credentials.filter((c) => c.provider === provider.id);
  const states = keys.states(creds.map((c) => c.ref));
  const avail = creds.map((c) => {
    const a = keys.availability(provider, c, states.get(c.ref) ?? null, { siblings: creds, ...(opts.limits ? { limits: opts.limits } : {}) });
    return { ref: a.ref, available: a.available, reason: a.reason, until: a.until, detail: a.detail };
  });
  const usable = avail.filter((a) => a.reason !== "unusable");
  const disabled = (a: KeyAvailability) => a.reason === "auth_invalid" || a.reason === "out_of_credits";
  let status: ProviderStatus["status"];
  let resumeAt: number | null = null;
  if (!usable.length || !provider.enabled) status = "unknown";
  else if (usable.some((a) => a.available)) status = "healthy";
  else if (usable.every(disabled)) status = "invalid";
  else {
    status = "rate_limited";
    const times = usable.filter((a) => !disabled(a)).map((a) => a.until);
    resumeAt = times.every((t) => t !== null) ? Math.min(...(times as number[])) : null;
  }
  // The newest error that no later success on the same key resolved.
  const recorded = [...states.values()]
    .map(currentError)
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.at - a.at);
  const now = keys.now();
  return {
    status: {
      platform: provider.id,
      status,
      keys: usable.length,
      resumeAt,
      requestsRemainingPct: requestsRemainingPct(usable.map((a) => states.get(a.ref)), now),
      lastError: recorded[0]?.message ?? null,
    },
    keys: avail,
  };
}

/** `ProviderStatus` for every provider that has at least one credential. */
export function providerStatuses(providers: ReadonlyMap<string, ResolvedProvider>, credentials: ReadonlyArray<ProviderCredential>, keys: ProviderKeys, opts: ProviderHealthOptions = {}): ProviderStatus[] {
  const ids = new Set(credentials.map((c) => c.provider));
  const out: ProviderStatus[] = [];
  for (const id of ids) {
    const p = providers.get(id);
    if (p) out.push(providerHealth(p, credentials, keys, opts).status);
  }
  return out;
}
