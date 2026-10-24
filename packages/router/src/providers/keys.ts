import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import type { ProviderCredential } from "./credentials.js";
import type { ProviderError } from "./errors.js";
import { FreeDailyQuotaSchema, limitScopes, MINUTE_MS, DAY_MS, type FreeDailyQuota, type LimitCheck, type LimitScope, type ProviderLimits, type Reservation } from "./limits.js";
import { cooldownMs, type RateLimitSnapshot } from "./rate-limits.js";
import type { ResolvedProvider } from "./registry.js";
import type { KeyLimits } from "./vault.js";

/**
 * Per-key state for direct providers, keyed on the credential ref and kept in the store
 * (`provider_key_state`) so every process and every restart sees the same cooldowns and
 * disabled keys. Selection is round-robin among a provider's keys that are usable, not cooling,
 * not disabled, and have headroom by their last rate-limit snapshot, their free daily quota, and
 * the configured limits. The caller retries the next key after a 429.
 */

/** Why a key is switched off until it is fixed or re-checked. */
export type KeyDisabledReason = "auth_invalid" | "out_of_credits";

export interface KeyState {
  ref: string;
  provider: string | null;
  /** Last four characters of the secret when the key was disabled (a new secret clears it). */
  last4: string | null;
  cooldownUntil: number | null;
  disabledReason: KeyDisabledReason | null;
  disabledAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  /** The last rate-limit snapshot the provider sent for this key. */
  rateLimits: RateLimitSnapshot | null;
  /** The last free daily quota probe (OpenRouter). */
  quota: FreeDailyQuota | null;
  /** Models this key refused (`not_in_plan` or `unknown_model`), by provider model id: when, and the provider's words. */
  planRefusals: Record<string, PlanRefusal>;
  selectedSeq: number;
  updatedAt: number;
}

export interface PlanRefusal {
  at: number;
  message: string;
}

/** A key by ref, or the credential itself (which also records its provider and last four). */
export type KeyRef = string | Pick<ProviderCredential, "ref" | "provider" | "last4">;

export type KeyBlockReason = "unusable" | "excluded" | "auth_invalid" | "out_of_credits" | "not_in_plan" | "cooling" | "exhausted" | "free_quota" | "limit";

export interface KeyAvailability {
  ref: string;
  available: boolean;
  reason: KeyBlockReason | null;
  /** When the key is expected to be usable again; null when unknown or never without a fix. */
  until: number | null;
  detail: string | null;
}

export interface KeySelectOptions {
  /** Estimated tokens of the request (prompt plus output budget); 0 when unknown. */
  estimatedTokens?: number;
  /** Refs already tried for this request. */
  exclude?: Iterable<string>;
  /** The model requested (adds the per-model limit scope). */
  model?: string | null;
  /** The model's stored `rateLimits`, enforced when known. */
  modelLimits?: Partial<KeyLimits> | null;
  /** The request draws on the provider's free daily quota (an OpenRouter `:free` model). */
  freeQuota?: boolean;
  /** Configured-limit counters; without it only key state is considered. */
  limits?: ProviderLimits;
  /** Record the request on the chosen key's limit scopes (needs `limits`). Defaults to true. */
  reserve?: boolean;
}

export type KeySelection =
  | { credential: ProviderCredential; scopes: LimitScope[]; reservation: Reservation | null; blocked: KeyAvailability[] }
  | { credential: null; scopes: null; reservation: null; blocked: KeyAvailability[]; resumeAt: number | null };

/** How long an out-of-credits key rests before one request may check it again. */
export const OUT_OF_CREDITS_RECHECK_MS = 6 * 3_600_000;
/** How long a model the key's plan refused is skipped for that key before one request checks again. */
export const NOT_IN_PLAN_RECHECK_MS = 24 * 3_600_000;
/** Cooldown after a 429 that named no wait; doubles with consecutive failures up to the max. */
export const DEFAULT_COOLDOWN_MS = 30_000;
export const MAX_DEFAULT_COOLDOWN_MS = 15 * MINUTE_MS;

const WindowSchema = z
  .object({
    metric: z.enum(["requests", "tokens", "input_tokens", "output_tokens"]),
    period: z.enum(["minute", "day", "unknown"]),
    limit: z.number().nullable(),
    remaining: z.number().nullable(),
    resetAt: z.number().nullable(),
  })
  .strict();
const SnapshotSchema = z
  .object({ family: z.enum(["openai", "openrouter", "anthropic", "none"]), observedAt: z.number(), retryAfterMs: z.number().nullable(), windows: z.array(WindowSchema) })
  .strict();
const PlanRefusalsSchema = z.record(z.string(), z.object({ at: z.number(), message: z.string() }));

interface StateRow {
  ref: string;
  provider: string | null;
  last4: string | null;
  cooldown_until: number | null;
  disabled_reason: KeyDisabledReason | null;
  disabled_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  last_error_at: number | null;
  last_success_at: number | null;
  rate_limits_json: string | null;
  quota_json: string | null;
  plan_refusals_json: string | null;
  selected_seq: number;
  updated_at: number;
}

function parseStored<T>(schema: z.ZodType<T>, text: string | null): T | null {
  if (text === null) return null;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function fromRow(r: StateRow): KeyState {
  return {
    ref: r.ref,
    provider: r.provider,
    last4: r.last4,
    cooldownUntil: r.cooldown_until,
    disabledReason: r.disabled_reason === "auth_invalid" || r.disabled_reason === "out_of_credits" ? r.disabled_reason : null,
    disabledAt: r.disabled_at,
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    lastSuccessAt: r.last_success_at,
    rateLimits: parseStored(SnapshotSchema, r.rate_limits_json) as RateLimitSnapshot | null,
    quota: parseStored(FreeDailyQuotaSchema, r.quota_json),
    planRefusals: parseStored(PlanRefusalsSchema, r.plan_refusals_json) ?? {},
    selectedSeq: r.selected_seq,
    updatedAt: r.updated_at,
  };
}

const PERIOD_MS = { minute: MINUTE_MS, day: DAY_MS, unknown: MINUTE_MS } as const;

/** Until when a snapshot says the key is out of room for a request of `tokens`; null when it has room. */
export function snapshotBlockedUntil(s: RateLimitSnapshot | null, tokens: number, now: number): { until: number; detail: string } | null {
  if (!s) return null;
  let worst: { until: number; detail: string } | null = null;
  for (const w of s.windows) {
    if (w.remaining === null) continue;
    // A window without a reset time is assumed to last one period from when it was seen.
    const until = w.resetAt ?? s.observedAt + PERIOD_MS[w.period];
    if (until <= now) continue;
    const need = w.metric === "requests" ? 1 : Math.max(tokens, 1);
    if (w.remaining >= need) continue;
    if (!worst || until > worst.until) worst = { until, detail: `${w.metric} per ${w.period}: ${w.remaining} left` };
  }
  return worst;
}

/** Store-backed per-key state and round-robin key selection. */
export class ProviderKeys {
  constructor(
    private readonly db: Db,
    /** The clock every cooldown and window is judged by (injectable for tests). */
    readonly now: () => number = Date.now,
  ) {}

  get(ref: string): KeyState | null {
    const r = this.db.prepare("SELECT * FROM provider_key_state WHERE ref = ?").get(ref) as StateRow | undefined;
    return r ? fromRow(r) : null;
  }

  /** Recorded state for these refs (refs never seen are absent). */
  states(refs: Iterable<string>): Map<string, KeyState> {
    const out = new Map<string, KeyState>();
    const stmt = this.db.prepare("SELECT * FROM provider_key_state WHERE ref = ?");
    for (const ref of refs) {
      const r = stmt.get(ref) as StateRow | undefined;
      if (r) out.set(ref, fromRow(r));
    }
    return out;
  }

  /** Every recorded key state, optionally for one provider. */
  list(provider?: string): KeyState[] {
    const rows = (provider === undefined ? this.db.prepare("SELECT * FROM provider_key_state ORDER BY ref").all() : this.db.prepare("SELECT * FROM provider_key_state WHERE provider = ? ORDER BY ref").all(provider)) as StateRow[];
    return rows.map(fromRow);
  }

  private upsert(key: KeyRef, set: Record<string, unknown>): void {
    const ref = typeof key === "string" ? key : key.ref;
    const provider = typeof key === "string" ? null : key.provider;
    const now = this.now();
    this.db.prepare("INSERT INTO provider_key_state (ref, provider, updated_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET provider = COALESCE(excluded.provider, provider), updated_at = excluded.updated_at").run(ref, provider, now);
    const cols = Object.keys(set);
    if (cols.length) this.db.prepare(`UPDATE provider_key_state SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ref = ?`).run(...cols.map((c) => set[c]), ref);
  }

  /** The key served a request: clear failures, cooldown, and any disable; keep its snapshot. */
  recordSuccess(key: KeyRef, snapshot: RateLimitSnapshot | null = null): void {
    immediate(this.db, () =>
      this.upsert(key, {
        consecutive_failures: 0,
        cooldown_until: null,
        disabled_reason: null,
        disabled_at: null,
        last_success_at: this.now(),
        ...(snapshot ? { rate_limits_json: JSON.stringify(snapshot) } : {}),
      }),
    );
  }

  /**
   * The key's request failed. `rate_limited` cools the key (the provider's wait, else a doubling
   * default); `auth_invalid` (401/403) and `out_of_credits` (402, spend caps) disable it;
   * `server`, `timeout`, and `transport` only count a failure. `not_in_plan` and definite
   * `unknown_model` record the refused `model` on the key (skipped for it, the key stays usable).
   * Bad requests, policy refusals, and aborts say nothing about the key and are ignored.
   */
  recordFailure(key: KeyRef, err: ProviderError, model: string | null = null): void {
    const ref = typeof key === "string" ? key : key.ref;
    const last4 = typeof key === "string" ? undefined : key.last4 || undefined;
    if (err.reason === "not_in_plan" || (err.reason === "unknown_model" && !err.possiblyConsumed)) {
      if (!model) return;
      immediate(this.db, () => {
        const refusals = { ...(this.get(ref)?.planRefusals ?? {}), [model]: { at: this.now(), message: err.message.slice(0, 500) } };
        this.upsert(key, { plan_refusals_json: JSON.stringify(refusals) });
      });
      return;
    }
    if (!["rate_limited", "auth_invalid", "out_of_credits", "server", "timeout", "transport"].includes(err.reason)) return;
    immediate(this.db, () => {
      const now = this.now();
      const prev = this.get(ref);
      const failures = (prev?.consecutiveFailures ?? 0) + 1;
      const set: Record<string, unknown> = { consecutive_failures: failures, last_error: `${err.reason}: ${err.message}`.slice(0, 500), last_error_at: now };
      if (err.rateLimits) set.rate_limits_json = JSON.stringify(err.rateLimits);
      if (err.reason === "rate_limited") {
        const told = err.retryAfterMs ?? (err.rateLimits ? cooldownMs(err.rateLimits) : null);
        const wait = told ?? Math.min(MAX_DEFAULT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS * 2 ** Math.min(20, failures - 1));
        set.cooldown_until = Math.max(prev?.cooldownUntil ?? 0, now + wait);
      } else if (err.reason === "auth_invalid" || err.reason === "out_of_credits") {
        set.disabled_reason = err.reason;
        set.disabled_at = now;
        if (last4 !== undefined) set.last4 = last4;
      }
      this.upsert(key, set);
    });
  }

  /** Store a free daily quota probe result for the key. */
  recordQuota(key: KeyRef, quota: FreeDailyQuota): void {
    immediate(this.db, () => this.upsert(key, { quota_json: JSON.stringify(quota) }));
  }

  /** Clear a disable, cooldown, and plan refusals (the user fixed, re-keyed, or re-enabled the key). */
  clear(ref: string): void {
    this.db.prepare("UPDATE provider_key_state SET disabled_reason = NULL, disabled_at = NULL, cooldown_until = NULL, consecutive_failures = 0, plan_refusals_json = NULL, updated_at = ? WHERE ref = ?").run(this.now(), ref);
  }

  /** Drop all state for a key (it was removed). */
  forget(ref: string): void {
    this.db.prepare("DELETE FROM provider_key_state WHERE ref = ?").run(ref);
  }

  /**
   * Whether a key can take a request now, from its credential, its state, and (with `limits`)
   * the configured limits. `siblings` lets quota-group limits see every member.
   */
  availability(provider: ResolvedProvider, cred: ProviderCredential, state: KeyState | null, opts: KeySelectOptions & { siblings?: ReadonlyArray<ProviderCredential> } = {}): KeyAvailability & { scopes: LimitScope[]; check: LimitCheck | null } {
    const now = this.now();
    const tokens = opts.estimatedTokens ?? 0;
    const scopes = limitScopes(provider, cred, { ...(opts.siblings ? { siblings: opts.siblings } : {}), model: opts.model ?? null, modelLimits: opts.modelLimits ?? null });
    const res = (reason: KeyBlockReason | null, until: number | null = null, detail: string | null = null, check: LimitCheck | null = null) => ({ ref: cred.ref, available: reason === null, reason, until, detail, scopes, check });
    if (cred.unusableReason) return res("unusable", null, cred.unusableReason);
    if (state?.disabledReason) {
      // A different secret under the same ref (an env var changed) is a new key.
      const replaced = !!state.last4 && !!cred.last4 && state.last4 !== cred.last4;
      if (!replaced) {
        if (state.disabledReason === "auth_invalid") return res("auth_invalid", null, state.lastError);
        const recheck = (state.disabledAt ?? 0) + OUT_OF_CREDITS_RECHECK_MS;
        if (recheck > now) return res("out_of_credits", recheck, state.lastError);
      }
    }
    const refused = opts.model ? state?.planRefusals[opts.model] : undefined;
    if (refused && refused.at + NOT_IN_PLAN_RECHECK_MS > now) return res("not_in_plan", refused.at + NOT_IN_PLAN_RECHECK_MS, refused.message);
    if (state?.cooldownUntil && state.cooldownUntil > now) return res("cooling", state.cooldownUntil, state.lastError);
    const exhausted = snapshotBlockedUntil(state?.rateLimits ?? null, tokens, now);
    if (exhausted) return res("exhausted", exhausted.until, exhausted.detail);
    if (opts.freeQuota && state?.quota && state.quota.remaining !== null && state.quota.remaining <= 0 && state.quota.resetAt > now)
      return res("free_quota", state.quota.resetAt, `free daily requests: ${state.quota.used ?? "?"}/${state.quota.limit ?? "?"} used`);
    if (opts.limits) {
      const check = opts.limits.check(scopes, tokens);
      if (!check.ok) return res("limit", check.resumeAt, check.blocked.map((b) => `${b.scope} ${b.metric} ${b.used}/${b.limit}`).join("; "), check);
      return res(null, null, null, check);
    }
    return res(null);
  }

  /**
   * Pick the provider's next key: round-robin (least recently chosen first, then declared
   * order) among available keys, recording the choice. With `limits` and `reserve` (the
   * default), the request is recorded on the key's limit scopes in the same transaction. When
   * no key is available, `resumeAt` is the earliest time one is expected back (null: unknown).
   */
  select(provider: ResolvedProvider, credentials: ReadonlyArray<ProviderCredential>, opts: KeySelectOptions = {}): KeySelection {
    const creds = credentials.filter((c) => c.provider === provider.id);
    const exclude = new Set(opts.exclude ?? []);
    return immediate(this.db, () => {
      const states = this.states(creds.map((c) => c.ref));
      const blocked: KeyAvailability[] = [];
      const order = creds.map((c, i) => ({ c, i, seq: states.get(c.ref)?.selectedSeq ?? 0 })).sort((a, b) => a.seq - b.seq || a.i - b.i);
      for (const { c } of order) {
        if (exclude.has(c.ref)) {
          blocked.push({ ref: c.ref, available: false, reason: "excluded", until: null, detail: "already tried" });
          continue;
        }
        const a = this.availability(provider, c, states.get(c.ref) ?? null, { ...opts, siblings: creds });
        if (!a.available) {
          blocked.push({ ref: a.ref, available: false, reason: a.reason, until: a.until, detail: a.detail });
          continue;
        }
        let reservation: Reservation | null = null;
        if (opts.limits && (opts.reserve ?? true)) {
          const r = opts.limits.reserve(a.scopes, opts.estimatedTokens ?? 0);
          if (!r.ok) {
            blocked.push({ ref: c.ref, available: false, reason: "limit", until: r.check.resumeAt, detail: "limit reached" });
            continue;
          }
          reservation = r.reservation;
        }
        const top = Math.max(0, ...creds.map((x) => states.get(x.ref)?.selectedSeq ?? 0));
        this.upsert(c, { selected_seq: top + 1 });
        return { credential: c, scopes: a.scopes, reservation, blocked };
      }
      const times = blocked.filter((b) => b.reason !== "excluded").map((b) => b.until);
      const resumeAt = times.length && times.some((t) => t !== null) ? Math.min(...times.filter((t): t is number => t !== null)) : null;
      return { credential: null, scopes: null, reservation: null, blocked, resumeAt };
    });
  }
}
