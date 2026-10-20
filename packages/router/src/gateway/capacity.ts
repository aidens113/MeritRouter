import { z } from "zod";
import { immediate, newId, type Db } from "../storage/db.js";

/** `team.provider_concurrency_*` (see the config schema). */
export interface ConcurrencySettings {
  provider_concurrency_enabled: boolean;
  provider_concurrency_start: number;
  provider_concurrency_increase_after: number;
  provider_concurrency_max: number;
  provider_concurrency_limits: Record<string, number>;
}

const DEFAULT_SETTINGS: ConcurrencySettings = {
  provider_concurrency_enabled: true,
  provider_concurrency_start: 2,
  provider_concurrency_increase_after: 5,
  provider_concurrency_max: 8,
  provider_concurrency_limits: {},
};

/** Why a platform's slots were halved. */
export type ThrottleReason = "rate_limited" | "cooldown" | "circuit_open";

/** One platform's AIMD state, mirrored to `meta` (`concurrency:<platform>`) and shared by every process. */
export const ConcurrencyRecordSchema = z
  .object({
    platform: z.string().min(1),
    /** Model requests that may be in flight on this platform at once. */
    limit: z.number().int().min(1),
    /** Consecutive successful requests since the last change. */
    successes: z.number().int().min(0),
    /**
     * Bumped on every decrease. A failure of a request dispatched under an older generation
     * does not halve again: one burst of 429s from requests sent together halves once.
     */
    generation: z.number().int().min(0),
    lastChange: z.enum(["increase", "decrease"]).nullable(),
    lastReason: z.string().nullable(),
    lastChangeAt: z.number().nullable(),
    /** The FreeLLMAPI cooldown last reacted to (a cooldown halves once, not on every refresh). */
    cooldownResumeAt: z.number().nullable(),
    updatedAt: z.number(),
  })
  .strict();
export type ConcurrencyRecord = z.infer<typeof ConcurrencyRecordSchema>;

export const CONCURRENCY_META_PREFIX = "concurrency:";

/** Waiting requests re-check this often (and immediately when this process frees a slot). */
export const SLOT_POLL_MS = 250;
/** A task the scheduler admitted on a platform keeps a claim there this long, or until its first request. */
export const CLAIM_HOLD_MS = 60_000;
/** A wait row not refreshed for this long belongs to a request that is gone. */
const WAIT_STALE_MS = 15_000;

/** Highest slot count a platform may reach: the configured maximum, lowered by a confirmed per-platform limit. */
export function ceilingFor(s: Pick<ConcurrencySettings, "provider_concurrency_max" | "provider_concurrency_limits">, platform: string): number {
  return Math.max(1, Math.min(s.provider_concurrency_max, s.provider_concurrency_limits[platform] ?? Number.POSITIVE_INFINITY));
}

function freshRecord(s: ConcurrencySettings, platform: string): ConcurrencyRecord {
  return {
    platform,
    limit: Math.min(s.provider_concurrency_start, ceilingFor(s, platform)),
    successes: 0,
    generation: 0,
    lastChange: null,
    lastReason: null,
    lastChangeAt: null,
    cooldownResumeAt: null,
    updatedAt: 0,
  };
}

/** Additive increase: one more slot after `increase_after` consecutive successes, up to the ceiling. */
export function afterSuccess(r: ConcurrencyRecord, s: ConcurrencySettings, now: number): ConcurrencyRecord {
  const ceiling = ceilingFor(s, r.platform);
  const successes = r.successes + 1;
  if (successes < s.provider_concurrency_increase_after) return { ...r, successes, updatedAt: now };
  if (r.limit >= ceiling) return { ...r, limit: ceiling, successes: 0, updatedAt: now };
  return { ...r, limit: r.limit + 1, successes: 0, lastChange: "increase", lastReason: `${s.provider_concurrency_increase_after} consecutive successes`, lastChangeAt: now, updatedAt: now };
}

/** Multiplicative decrease: half the slots (floor 1), and a new generation. */
export function afterThrottle(r: ConcurrencyRecord, reason: ThrottleReason, now: number): ConcurrencyRecord {
  return { ...r, limit: Math.max(1, Math.floor(r.limit / 2)), successes: 0, generation: r.generation + 1, lastChange: "decrease", lastReason: reason, lastChangeAt: now, updatedAt: now };
}

/** A gate request that holds or waits for slots (one per `Gate.request` call). */
export interface SlotHolder {
  id: string;
  /** Participants; the first one's task lease keeps the hold alive. */
  taskIds: string[];
  leaseOwner: string | null;
  /** 1: supervisors and reviewers, served before waiting workers. */
  priority: 0 | 1;
  /** When it first waited (its place in the queue); null until then. */
  since: number | null;
}

/** A held slot: one in-flight request on one platform. */
export interface SlotHandle {
  id: string | null;
  platform: string;
  /** The platform's AIMD generation when the slot was taken. */
  generation: number;
}

export interface SlotsFull {
  full: true;
  platform: string;
  held: number;
  limit: number;
  /** Waiting requests served before this one. */
  ahead: number;
}

export interface PlatformUsage {
  platform: string;
  limit: number;
  ceiling: number;
  /** In-flight requests. */
  requests: number;
  /** Tasks admitted on this platform that have not sent a request yet. */
  claims: number;
  /** Requests waiting for a slot here. */
  waiting: number;
}

/** A row counts while its task holds a live lease (and, per kind, while it is fresh). */
const LIVE_SQL = `t.state IN ('running','cancel_requested') AND t.lease_expires_at > @now
  AND (s.lease_owner IS NULL OR s.lease_owner = t.lease_owner)
  AND ((s.kind = 'request' AND s.since > @requestCut) OR (s.kind = 'claim' AND s.since > @claimCut) OR (s.kind = 'wait' AND s.seen_at > @waitCut))`;

/**
 * Per-provider concurrency. Every platform has a number of slots (AIMD: start at
 * `provider_concurrency_start`, one more after `increase_after` consecutive successes, halved
 * on a 429, a reported cooldown, or a breaker opening; at least 1, at most the ceiling). A slot
 * is one in-flight model request, held from reservation to reconciliation; a prompt batch is one
 * request. Slots, waits, and the AIMD state are rows in the store, so every worker process and
 * the panel see the same numbers; rows of a dead process stop counting when its task lease
 * expires and are deleted on the next acquisition.
 *
 * Nothing that holds a slot ever waits for anything but its own HTTP request, so the limiter
 * cannot deadlock: a request that finds every candidate platform full waits holding nothing,
 * supervisors and reviewers (priority 1) are served before waiting workers, and the scheduler
 * never holds a supervisor back for a slot.
 */
export class ProviderCapacity {
  private db: Db | null = null;
  private settings: () => ConcurrencySettings = () => DEFAULT_SETTINGS;
  private requestHoldMaxMs: () => number = () => 3_600_000;
  private readonly wakers = new Set<() => void>();

  constructor(readonly now: () => number = Date.now) {}

  /** Use the store (settings are read live, so a config reload applies). Unattached: no limit. */
  attach(db: Db, settings: () => ConcurrencySettings | undefined, requestHoldMaxMs: () => number): void {
    this.db = db;
    this.settings = () => ({ ...DEFAULT_SETTINGS, ...(settings() ?? {}) });
    this.requestHoldMaxMs = requestHoldMaxMs;
  }

  get enabled(): boolean {
    return this.db !== null && this.settings().provider_concurrency_enabled;
  }

  ceiling(platform: string): number {
    return ceilingFor(this.settings(), platform);
  }

  /** The platform's AIMD state (a fresh one when none is stored), its limit clamped to the current ceiling. */
  record(platform: string): ConcurrencyRecord {
    const s = this.settings();
    const row = this.db?.prepare("SELECT value FROM meta WHERE key = ?").get(`${CONCURRENCY_META_PREFIX}${platform}`) as { value: string } | undefined;
    let r = freshRecord(s, platform);
    if (row) {
      try {
        const parsed = ConcurrencyRecordSchema.safeParse(JSON.parse(row.value));
        if (parsed.success) r = parsed.data;
      } catch {
        // not JSON: start over
      }
    }
    return { ...r, limit: Math.max(1, Math.min(r.limit, ceilingFor(s, platform))) };
  }

  limit(platform: string): number {
    return this.record(platform).limit;
  }

  private put(r: ConcurrencyRecord): void {
    this.db!.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${CONCURRENCY_META_PREFIX}${r.platform}`, JSON.stringify(r));
  }

  // ---------- AIMD ----------

  /** The platform answered a request successfully. */
  success(platform: string): void {
    if (!this.enabled) return;
    let raised = false;
    try {
      raised = immediate(this.db!, () => {
        const r = this.record(platform);
        const next = afterSuccess(r, this.settings(), this.now());
        this.put(next);
        return next.limit > r.limit;
      });
    } catch {
      // The limit is advisory: a store that is closing or busy never fails a served request.
    }
    if (raised) this.wake();
  }

  /**
   * Halve the platform's slots. With `generation` (the slot's), a failure of a request sent
   * before the last decrease is ignored. Returns whether it halved.
   */
  throttle(platform: string, reason: ThrottleReason, generation?: number, patch: Partial<Pick<ConcurrencyRecord, "cooldownResumeAt">> = {}): boolean {
    if (!this.enabled) return false;
    try {
      return immediate(this.db!, () => {
        const r = this.record(platform);
        if (generation !== undefined && generation < r.generation) return false;
        this.put({ ...afterThrottle(r, reason, this.now()), ...patch });
        return true;
      });
    } catch {
      // Advisory, as above.
      return false;
    }
  }

  /** FreeLLMAPI reported a cooldown for the platform: halve once per reported cooldown. */
  observeCooldown(platform: string, resumeAt: number): void {
    if (!this.enabled || resumeAt <= this.now()) return;
    try {
      if (this.record(platform).cooldownResumeAt === resumeAt) return;
    } catch {
      return;
    }
    this.throttle(platform, "cooldown", undefined, { cooldownResumeAt: resumeAt });
  }

  // ---------- slots ----------

  private cuts(): Record<string, number> {
    const now = this.now();
    return { now, requestCut: now - this.requestHoldMaxMs(), claimCut: now - CLAIM_HOLD_MS, waitCut: now - WAIT_STALE_MS };
  }

  /** Delete rows that no longer count (their task's lease is gone, or they went stale). */
  private purge(): void {
    this.db!
      .prepare(`DELETE FROM provider_slots WHERE id IN (SELECT s.id FROM provider_slots s LEFT JOIN tasks t ON t.id = s.task_id WHERE t.id IS NULL OR NOT (${LIVE_SQL}))`)
      .run(this.cuts());
  }

  private count(platform: string, kind: "request" | "claim" | "wait", extra = "", params: Record<string, unknown> = {}): number {
    return (
      this.db!.prepare(`SELECT COUNT(*) AS n FROM provider_slots s JOIN tasks t ON t.id = s.task_id WHERE s.platform = @platform AND s.kind = @kind AND ${LIVE_SQL} ${extra}`).get({
        ...this.cuts(),
        platform,
        kind,
        ...params,
      }) as { n: number }
    ).n;
  }

  /** Live usage of a platform (also for the panel). */
  usage(platform: string): PlatformUsage {
    return {
      platform,
      limit: this.enabled ? this.limit(platform) : Number.POSITIVE_INFINITY,
      ceiling: this.ceiling(platform),
      requests: this.db ? this.count(platform, "request") : 0,
      claims: this.db ? this.count(platform, "claim") : 0,
      waiting: this.db ? this.count(platform, "wait") : 0,
    };
  }

  /**
   * Take a slot on the platform for one request, or report it full. A free slot goes to this
   * request only when fewer waiting requests rank ahead of it (higher priority, or the same
   * priority and waiting longer) than there are free slots. Taking a slot ends the holder's
   * waits and its tasks' scheduler claims.
   */
  tryAcquire(holder: SlotHolder, platform: string): SlotHandle | SlotsFull {
    if (!this.enabled) return { id: null, platform, generation: 0 };
    return immediate(this.db!, () => {
      this.purge();
      const now = this.now();
      const r = this.record(platform);
      const held = this.count(platform, "request");
      if (held >= r.limit) return { full: true, platform, held, limit: r.limit, ahead: 0 } as SlotsFull;
      const ahead = this.count(platform, "wait", "AND s.holder != @holder AND (s.priority > @priority OR (s.priority = @priority AND s.since < @since))", {
        holder: holder.id,
        priority: holder.priority,
        since: holder.since ?? Number.MAX_SAFE_INTEGER,
      });
      if (ahead >= r.limit - held) return { full: true, platform, held, limit: r.limit, ahead } as SlotsFull;
      const id = newId("slot");
      this.db!
        .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?)")
        .run(id, platform, holder.id, holder.taskIds[0] ?? "", holder.leaseOwner, holder.priority, now, now);
      this.db!.prepare("DELETE FROM provider_slots WHERE kind = 'wait' AND holder = ?").run(holder.id);
      const del = this.db!.prepare("DELETE FROM provider_slots WHERE kind = 'claim' AND task_id = ?");
      for (const t of holder.taskIds) del.run(t);
      return { id, platform, generation: r.generation };
    });
  }

  /** The request was reconciled (or never dispatched): free its slot. */
  release(handle: SlotHandle): void {
    if (!handle.id || !this.db) return;
    try {
      this.db.prepare("DELETE FROM provider_slots WHERE id = ?").run(handle.id);
    } catch {
      // database closed: the row stops counting with the task lease
    }
    this.wake();
  }

  /** Register (or refresh) the holder's place in the queue of each full platform. */
  wait(holder: SlotHolder, platforms: string[]): void {
    if (!this.enabled || !holder.taskIds.length) return;
    const now = this.now();
    holder.since ??= now;
    immediate(this.db!, () => {
      for (const platform of new Set(platforms)) {
        const updated = this.db!.prepare("UPDATE provider_slots SET seen_at = ? WHERE kind = 'wait' AND holder = ? AND platform = ?").run(now, holder.id, platform);
        if (updated.changes) continue;
        this.db!
          .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at) VALUES (?, ?, 'wait', ?, ?, ?, ?, ?, ?)")
          .run(newId("slot"), platform, holder.id, holder.taskIds[0]!, holder.leaseOwner, holder.priority, holder.since!, now);
      }
    });
  }

  /** The gate request is over: drop its waits (and, defensively, any slot it still holds). */
  leave(holder: SlotHolder): void {
    if (!this.db) return;
    try {
      const n = this.db.prepare("DELETE FROM provider_slots WHERE holder = ? AND kind IN ('wait', 'request')").run(holder.id).changes;
      if (n) this.wake();
    } catch {
      // database closed
    }
  }

  /** Resolve after `ms`, when this process frees a slot or raises a limit, or when `signal` aborts. */
  nextWake(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wakers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  // ---------- scheduler admission ----------

  /**
   * For the scheduler: the first platform (in route order) with a slot free for a task that
   * has not started, counting in-flight requests, tasks already admitted there that have not
   * sent a request yet, and supervisors or reviewers waiting there. Null when all are taken.
   */
  admissible(platforms: string[]): { platform: string | null; usage: PlatformUsage[] } {
    if (!this.enabled) return { platform: platforms[0] ?? null, usage: [] };
    this.purge();
    const usage: PlatformUsage[] = [];
    for (const p of platforms) {
      const u = this.usage(p);
      usage.push(u);
      const priorityWaiting = this.count(p, "wait", "AND s.priority > 0");
      if (u.requests + u.claims + priorityWaiting < u.limit) return { platform: p, usage };
    }
    return { platform: null, usage };
  }

  /** The scheduler started a task on this platform: it holds a claim until its first request. */
  recordClaim(taskId: string, leaseOwner: string, platform: string): void {
    if (!this.enabled) return;
    const now = this.now();
    this.db!
      .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at) VALUES (?, ?, 'claim', ?, ?, ?, 0, ?, ?)")
      .run(newId("slot"), platform, taskId, taskId, leaseOwner, now, now);
  }
}

/** AIMD records mirrored to `meta` by any process sharing this store. Invalid rows are skipped. */
export function readConcurrencyRecords(db: Db): ConcurrencyRecord[] {
  const rows = db.prepare("SELECT value FROM meta WHERE key LIKE ?").all(`${CONCURRENCY_META_PREFIX}%`) as { value: string }[];
  const out: ConcurrencyRecord[] = [];
  for (const row of rows) {
    try {
      const r = ConcurrencyRecordSchema.safeParse(JSON.parse(row.value));
      if (r.success) out.push(r.data);
    } catch {
      // not JSON: skip
    }
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform));
}

/** Slot rows by platform and kind that still count at `now` (for the panel; no request-age cut). */
export function liveSlotCounts(db: Db, now: number): Array<{ platform: string; kind: "request" | "claim" | "wait"; n: number }> {
  return db
    .prepare(
      `SELECT s.platform AS platform, s.kind AS kind, COUNT(*) AS n FROM provider_slots s JOIN tasks t ON t.id = s.task_id
        WHERE ${LIVE_SQL} GROUP BY s.platform, s.kind ORDER BY s.platform, s.kind`,
    )
    .all({ now, requestCut: 0, claimCut: now - CLAIM_HOLD_MS, waitCut: now - WAIT_STALE_MS }) as Array<{ platform: string; kind: "request" | "claim" | "wait"; n: number }>;
}
