import { z } from "zod";
import { immediate, newId, type Db } from "../storage/db.js";
import type { RequestCredential } from "./client.js";
import type { ProviderCredential } from "./credentials.js";
import { expandUrl, requestHeaders, type ResolvedProvider } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";
import type { KeyLimits } from "./vault.js";

/**
 * Configured request and token limits (`rpm`, `rpd`, `tpm`, `tpd`) enforced as sliding windows
 * over the `provider_usage` table, so every process on one store shares them and they survive a
 * restart. Scopes:
 * - `provider:<id>`: the provider's own limits (`providers.<id>.rpm` ...), over all its keys.
 * - `key:<ref>`: a key's own limits, for a key outside any quota group.
 * - `group:<provider>:<group>`: keys sharing one provider quota; the tightest limit any member
 *   declares applies to their combined usage.
 * - `model:<unit>:<model>`: a model's stored `rateLimits` (when known), per key or quota group.
 * Every reservation records usage on every scope it names, limited or not, so a limit added
 * later sees recent history.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

export type LimitMetric = keyof KeyLimits;

/** One counter the request draws on, with the limits that apply to it (null or absent: none). */
export interface LimitScope {
  id: string;
  limits: Partial<KeyLimits>;
}

/** A limit the request would exceed. */
export interface LimitBlock {
  scope: string;
  metric: LimitMetric;
  limit: number;
  /** Requests or tokens already counted in the window. */
  used: number;
  /** When enough usage leaves the window for this request to fit; null when it never fits. */
  resumeAt: number | null;
}

export interface LimitCheck {
  ok: boolean;
  blocked: LimitBlock[];
  /** When every block has cleared (the latest resume time); null when ok or when one never clears. */
  resumeAt: number | null;
}

/** Usage recorded for one request; settle it with the real token count, or release it. */
export interface Reservation {
  id: string;
  scopes: string[];
  at: number;
  tokens: number;
}

export type ReserveResult = { ok: true; reservation: Reservation; check: LimitCheck } | { ok: false; reservation: null; check: LimitCheck };

export interface ScopeUsage {
  requestsMinute: number;
  requestsDay: number;
  tokensMinute: number;
  tokensDay: number;
}

const METRICS: ReadonlyArray<{ metric: LimitMetric; windowMs: number; tokens: boolean }> = [
  { metric: "rpm", windowMs: MINUTE_MS, tokens: false },
  { metric: "rpd", windowMs: DAY_MS, tokens: false },
  { metric: "tpm", windowMs: MINUTE_MS, tokens: true },
  { metric: "tpd", windowMs: DAY_MS, tokens: true },
];

const limitValue = (l: Partial<KeyLimits>, m: LimitMetric): number | null => {
  const v = l[m];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
};

export function hasLimits(l: Partial<KeyLimits> | null | undefined): boolean {
  return !!l && METRICS.some((m) => limitValue(l, m.metric) !== null);
}

/** Per-metric minimum of the limits that are set; null where none is. */
export function tightestLimits(list: ReadonlyArray<Partial<KeyLimits>>): KeyLimits {
  const out: KeyLimits = { rpm: null, rpd: null, tpm: null, tpd: null };
  for (const l of list)
    for (const { metric } of METRICS) {
      const v = limitValue(l, metric);
      if (v !== null) out[metric] = out[metric] === null ? v : Math.min(out[metric]!, v);
    }
  return out;
}

/** The quota group a key draws on (its own, else the provider's), or null. */
export function quotaGroupOf(provider: Pick<ResolvedProvider, "quotaGroup">, cred: Pick<ProviderCredential, "quotaGroup">): string | null {
  return cred.quotaGroup ?? provider.quotaGroup ?? null;
}

/** The counter that stands for a key's provider quota: its quota group, or the key itself. */
export function quotaUnit(provider: Pick<ResolvedProvider, "id" | "quotaGroup">, cred: Pick<ProviderCredential, "ref" | "quotaGroup">): string {
  const group = quotaGroupOf(provider, cred);
  return group ? `group:${provider.id}:${group}` : `key:${cred.ref}`;
}

export interface ScopeOptions {
  /** The provider's other keys, so a quota group's limits include every member's. */
  siblings?: ReadonlyArray<ProviderCredential>;
  /** The model requested; adds a per-model scope when given. */
  model?: string | null;
  /** The model's stored `rateLimits`, enforced when known. */
  modelLimits?: Partial<KeyLimits> | null;
}

/** Every scope a request through `cred` to `provider` (and optionally a model) draws on. */
export function limitScopes(provider: ResolvedProvider, cred: ProviderCredential, opts: ScopeOptions = {}): LimitScope[] {
  const scopes: LimitScope[] = [{ id: `provider:${provider.id}`, limits: provider.limits }];
  const group = quotaGroupOf(provider, cred);
  const unit = quotaUnit(provider, cred);
  if (group) {
    const members = [cred, ...(opts.siblings ?? []).filter((s) => s.ref !== cred.ref && s.provider === cred.provider && quotaGroupOf(provider, s) === group)];
    scopes.push({ id: unit, limits: tightestLimits(members.map((m) => m.limits)) });
  } else scopes.push({ id: unit, limits: cred.limits });
  if (opts.model) scopes.push({ id: `model:${unit}:${opts.model}`, limits: opts.modelLimits ?? {} });
  return scopes;
}

interface UsageRow {
  at: number;
  tokens: number;
}

/** Sliding-window counters for configured and per-model limits. */
export class ProviderLimits {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private events(scope: string, since: number): UsageRow[] {
    return this.db.prepare("SELECT at, tokens FROM provider_usage WHERE scope = ? AND at > ? ORDER BY at, id").all(scope, since) as UsageRow[];
  }

  private checkAt(scopes: ReadonlyArray<LimitScope>, tokens: number, now: number): LimitCheck {
    const blocked: LimitBlock[] = [];
    for (const scope of scopes) {
      if (!hasLimits(scope.limits)) continue;
      const day = this.events(scope.id, now - DAY_MS);
      for (const { metric, windowMs, tokens: isTokens } of METRICS) {
        const limit = limitValue(scope.limits, metric);
        if (limit === null) continue;
        const inWindow = windowMs === DAY_MS ? day : day.filter((e) => e.at > now - windowMs);
        const cost = (e: UsageRow) => (isTokens ? e.tokens : 1);
        // A request of unknown size still needs at least one token of headroom.
        const need = isTokens ? Math.max(tokens, 1) : 1;
        const used = inWindow.reduce((s, e) => s + cost(e), 0);
        if (used + need <= limit) continue;
        let resumeAt: number | null = null;
        if (need <= limit) {
          let left = used;
          for (const e of inWindow) {
            left -= cost(e);
            if (left + need <= limit) {
              resumeAt = e.at + windowMs;
              break;
            }
          }
        }
        blocked.push({ scope: scope.id, metric, limit, used, resumeAt });
      }
    }
    const resumeAt = blocked.length && blocked.every((b) => b.resumeAt !== null) ? Math.max(...blocked.map((b) => b.resumeAt!)) : null;
    return { ok: blocked.length === 0, blocked, resumeAt };
  }

  /** Whether a request of `tokens` (estimated; 0 when unknown) fits every scope now. */
  check(scopes: ReadonlyArray<LimitScope>, tokens = 0): LimitCheck {
    return this.checkAt(scopes, tokens, this.now());
  }

  /**
   * Check and, when the request fits, record it on every scope in one write transaction, so
   * concurrent processes cannot both take the last slot. Also prunes usage older than a day.
   */
  reserve(scopes: ReadonlyArray<LimitScope>, tokens = 0): ReserveResult {
    return immediate(this.db, () => {
      const now = this.now();
      this.db.prepare("DELETE FROM provider_usage WHERE at <= ?").run(now - DAY_MS);
      const check = this.checkAt(scopes, tokens, now);
      if (!check.ok) return { ok: false as const, reservation: null, check };
      const id = newId("pu");
      const ids = [...new Set(scopes.map((s) => s.id))];
      const ins = this.db.prepare("INSERT INTO provider_usage (scope, at, tokens, reservation) VALUES (?, ?, ?, ?)");
      for (const scope of ids) ins.run(scope, now, Math.max(0, Math.round(tokens)), id);
      return { ok: true as const, reservation: { id, scopes: ids, at: now, tokens }, check };
    });
  }

  /** Replace a reservation's estimated tokens with the tokens the provider reported. */
  settle(reservation: Reservation | string, tokens: number): void {
    const id = typeof reservation === "string" ? reservation : reservation.id;
    this.db.prepare("UPDATE provider_usage SET tokens = ? WHERE reservation = ?").run(Math.max(0, Math.round(tokens)), id);
  }

  /** Drop a reservation whose request never reached the provider. */
  release(reservation: Reservation | string): void {
    const id = typeof reservation === "string" ? reservation : reservation.id;
    this.db.prepare("DELETE FROM provider_usage WHERE reservation = ?").run(id);
  }

  /** Requests and tokens counted in a scope's minute and day windows. */
  usage(scope: string): ScopeUsage {
    const now = this.now();
    const day = this.events(scope, now - DAY_MS);
    const minute = day.filter((e) => e.at > now - MINUTE_MS);
    const sum = (l: UsageRow[]) => l.reduce((s, e) => s + e.tokens, 0);
    return { requestsMinute: minute.length, requestsDay: day.length, tokensMinute: sum(minute), tokensDay: sum(day) };
  }
}

/** OpenRouter's free-model daily request quota for one key (`GET /api/v1/key`). */
export interface FreeDailyQuota {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** The next 00:00 UTC after the probe (the documented reset). */
  resetAt: number;
  checkedAt: number;
}

const QuotaCountSchema = z.number().finite().min(0).nullable().optional();
const KeyInfoSchema = z
  .object({
    data: z
      .object({
        free_model_daily_requests: z.object({ used: QuotaCountSchema, limit: QuotaCountSchema, remaining: QuotaCountSchema }).loose().nullable().optional(),
      })
      .loose(),
  })
  .loose();

export const FreeDailyQuotaSchema = z
  .object({ used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(), resetAt: z.number(), checkedAt: z.number() })
  .strict();

/** The next 00:00 UTC strictly after `t`. */
export function nextUtcMidnight(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface QuotaProbeOptions {
  provider: ResolvedProvider;
  credential: RequestCredential;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Ask the provider's key-info endpoint (`keyInfoUrl`; only OpenRouter documents one) for the
 * key's free-model daily quota. Returns null when the response does not report it. Throws a
 * classified `ProviderError` on HTTP failure (401 for a bad key, for instance) and an `Error`
 * for a provider without a key-info endpoint.
 */
export async function probeFreeDailyQuota(opts: QuotaProbeOptions): Promise<FreeDailyQuota | null> {
  const { provider } = opts;
  if (!provider.keyInfoUrl) throw new Error(`provider ${provider.id} has no key-info endpoint`);
  const now = opts.now ?? Date.now;
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const res = await requestJson(
    fetchFn,
    {
      provider: provider.id,
      url: expandUrl(provider.keyInfoUrl, provider, opts.credential.accountId ?? provider.accountId),
      headers: requestHeaders(provider, opts.credential.apiKey),
      timeoutMs: opts.timeoutMs ?? 15_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      rateLimitHeaders: provider.rateLimitHeaders,
    },
    now,
  );
  const parsed = KeyInfoSchema.safeParse(res.json);
  const q = parsed.success ? parsed.data.data.free_model_daily_requests : null;
  if (!q) return null;
  const used = q.used ?? null;
  const limit = q.limit ?? null;
  if (used === null && limit === null && (q.remaining ?? null) === null) return null;
  const remaining = q.remaining ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null);
  const checkedAt = now();
  return { used, limit, remaining, resetAt: nextUtcMidnight(checkedAt), checkedAt };
}
