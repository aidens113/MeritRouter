import { z } from "zod";
import type { Db } from "../storage/db.js";
import type { GatewayError } from "../core/errors.js";

/** `routing.circuit_breaker` (see the config schema). */
export interface BreakerSettings {
  enabled: boolean;
  failure_threshold: number;
  open_seconds: number;
  max_open_seconds: number;
}

export type BreakerState = "closed" | "open" | "half_open";

/** One provider's breaker, as kept in memory and mirrored to `meta` (`circuit:<platform>`). */
export const BreakerRecordSchema = z
  .object({
    platform: z.string().min(1),
    state: z.enum(["closed", "open", "half_open"]),
    /** Consecutive counted failures while closed. */
    failures: z.number().int().min(0),
    /** Consecutive openings without a successful probe; sets the backoff (doubling). */
    opens: z.number().int().min(0),
    openedAt: z.number().nullable(),
    /** While open: when a probe may go through. */
    openUntil: z.number().nullable(),
    /** A half-open probe is in flight (process-local; read back as false). */
    probing: z.boolean(),
    lastFailure: z.string().nullable(),
    lastFailureAt: z.number().nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type BreakerRecord = z.infer<typeof BreakerRecordSchema>;

export const BREAKER_META_PREFIX = "circuit:";

/** Error kinds that say a provider (or the way to it) is failing, not the request or the model. */
const PROVIDER_FAILURES = new Set(["server", "timeout", "transport"]);
/** Capacity errors: counted only when no cooldown explains them. */
const CAPACITY = new Set(["rate_limited", "pool_exhausted"]);

/**
 * Whether a failed attempt counts toward opening the provider's breaker: 5xx, timeouts, and
 * connection errors always; a 429 (or a 5xx capacity answer) only when the provider is not in a
 * cooldown FreeLLMAPI already reported, since cooling providers are handled by cooldown ordering.
 * Request errors (4xx), served-model violations, aborts, and invalid output never count.
 */
export function countsAsProviderFailure(err: Pick<GatewayError, "kind" | "status">, coolingReported: boolean): boolean {
  if (PROVIDER_FAILURES.has(err.kind)) return true;
  if (CAPACITY.has(err.kind)) return !coolingReported && (err.status === undefined || err.status === 429 || err.status >= 500);
  return false;
}

/** Backoff for the n-th consecutive opening (n >= 1): open_seconds doubled per opening, capped. */
export function openDurationMs(s: Pick<BreakerSettings, "open_seconds" | "max_open_seconds">, opens: number): number {
  const base = s.open_seconds * 1000;
  const cap = Math.max(base, s.max_open_seconds * 1000);
  return Math.min(cap, base * 2 ** Math.min(30, Math.max(0, opens - 1)));
}

const DEFAULT_SETTINGS: BreakerSettings = { enabled: true, failure_threshold: 5, open_seconds: 30, max_open_seconds: 900 };

/**
 * Per-provider circuit breakers. Closed: requests flow and consecutive counted failures add up;
 * at the threshold the breaker opens. Open: the provider is skipped until `openUntil`, then the
 * breaker goes half-open and admits exactly one probe. A probe that succeeds closes it; one that
 * fails re-opens it for twice as long (up to the cap). Any response from the provider counts as
 * success. State lives in this process and is mirrored to `meta` so other processes (the panel)
 * can show it and a restarted worker keeps an open breaker.
 */
export class CircuitBreakers {
  private readonly byPlatform = new Map<string, BreakerRecord>();
  private db: Db | null = null;
  private settings: () => BreakerSettings = () => DEFAULT_SETTINGS;

  constructor(readonly now: () => number = Date.now) {}

  /** Persist to (and restore from) `meta`, reading settings live (config reloads apply). */
  attach(db: Db, settings: () => BreakerSettings): void {
    this.db = db;
    this.settings = settings;
    for (const r of readBreakerRecords(db)) {
      if (this.byPlatform.has(r.platform)) continue;
      // A probe in flight belonged to a process that is gone: half-open again, ready to probe.
      this.byPlatform.set(r.platform, r.state === "half_open" ? { ...r, probing: false } : r);
    }
  }

  private get enabled(): boolean {
    return this.settings().enabled;
  }

  /** Current record for a platform (a closed, zeroed one when unknown). */
  get(platform: string): BreakerRecord {
    return this.byPlatform.get(platform) ?? { platform, state: "closed", failures: 0, opens: 0, openedAt: null, openUntil: null, probing: false, lastFailure: null, lastFailureAt: null, updatedAt: 0 };
  }

  list(): BreakerRecord[] {
    return [...this.byPlatform.values()].map((r) => ({ ...r }));
  }

  /**
   * For routing: when the platform should be treated as unavailable (a time, or now while a
   * probe is in flight), else null. An open breaker whose time has passed is available again,
   * so the next request becomes its probe.
   */
  blockedUntil(platform: string): number | null {
    if (!this.enabled) return null;
    const r = this.byPlatform.get(platform);
    if (!r || r.state === "closed") return null;
    const now = this.now();
    if (r.state === "open" && r.openUntil !== null && r.openUntil > now) return r.openUntil;
    if (r.state === "half_open" && r.probing) return now;
    return null;
  }

  /**
   * Called right before dispatching to a platform. False: skip it. True when closed, or when this
   * caller takes the single half-open probe (it must then report an outcome or `release`).
   */
  admit(platform: string): boolean {
    if (!this.enabled) return true;
    const r = this.byPlatform.get(platform);
    if (!r || r.state === "closed") return true;
    const now = this.now();
    if (r.state === "open") {
      if (r.openUntil !== null && r.openUntil > now) return false;
      this.put({ ...r, state: "half_open", probing: true, updatedAt: now });
      return true;
    }
    if (r.probing) return false;
    this.put({ ...r, probing: true, updatedAt: now });
    return true;
  }

  /** The provider answered: close the breaker and forget counted failures. */
  success(platform: string): void {
    const r = this.byPlatform.get(platform);
    if (!r || (r.state === "closed" && r.failures === 0)) return;
    this.put({ ...r, state: "closed", failures: 0, opens: 0, openedAt: null, openUntil: null, probing: false, updatedAt: this.now() });
  }

  /** A counted failure: open at the threshold, or re-open (longer) when it was the probe. */
  failure(platform: string, detail: string): void {
    if (!this.enabled) return;
    const s = this.settings();
    const now = this.now();
    const r = this.get(platform);
    const base = { ...r, lastFailure: detail.slice(0, 300), lastFailureAt: now, updatedAt: now };
    if (r.state === "half_open") {
      const opens = r.opens + 1;
      this.put({ ...base, state: "open", opens, openedAt: now, openUntil: now + openDurationMs(s, opens), probing: false });
      return;
    }
    // Late failures of requests admitted before the breaker opened change nothing but the record.
    if (r.state === "open") {
      this.put(base);
      return;
    }
    const failures = r.failures + 1;
    if (failures >= s.failure_threshold) {
      const opens = Math.max(1, r.opens + 1);
      this.put({ ...base, state: "open", failures, opens, openedAt: now, openUntil: now + openDurationMs(s, opens), probing: false });
    } else this.put({ ...base, failures });
  }

  /** The admitted request ended without telling anything about the provider (aborted, skipped). */
  release(platform: string): void {
    const r = this.byPlatform.get(platform);
    if (r?.state === "half_open" && r.probing) this.put({ ...r, probing: false, updatedAt: this.now() });
  }

  private put(r: BreakerRecord): void {
    this.byPlatform.set(r.platform, r);
    if (!this.db) return;
    try {
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${BREAKER_META_PREFIX}${r.platform}`, JSON.stringify(r));
    } catch {
      // The mirror is informational; routing uses the in-memory state.
    }
  }
}

/** Breaker records mirrored to `meta` by any process sharing this store. Invalid rows are skipped. */
export function readBreakerRecords(db: Db): BreakerRecord[] {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(`${BREAKER_META_PREFIX}%`) as { key: string; value: string }[];
  const out: BreakerRecord[] = [];
  for (const row of rows) {
    try {
      const r = BreakerRecordSchema.safeParse(JSON.parse(row.value));
      if (r.success) out.push(r.data);
    } catch {
      // not JSON: skip
    }
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform));
}
