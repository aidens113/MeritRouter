import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/tasks.js";
import { readStoreIdentity } from "../projects/store-identity.js";
import { ProjectExecutionGrants, ExecutionGrantRefSchema, type ExecutionGrantRef } from "../storage/project-execution-grants.js";
import { LeaseRefSchema, type LeaseRef } from "../storage/task-leases.js";
import { z } from "zod";
import { immediate, newId, type Db } from "../storage/db.js";

export class ProviderClaimCapacityError extends Error { constructor(){super("Split provider claim capacity exhausted");this.name="ProviderClaimCapacityError";} }

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
    /** The provider cooldown last reacted to (a cooldown halves once, not on every refresh). */
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
  executionGrants?: readonly ExecutionGrantRef[];
  leases?: readonly LeaseRef[];
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
  nonce?: string;
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
const LIVE_SQL = `((s.nonce IS NOT NULL OR s.lease_json IS NOT NULL) AND s.kind='request') OR (
  t.state IN ('running','cancel_requested') AND t.lease_expires_at > @now
  AND (s.lease_owner IS NULL OR s.lease_owner = t.lease_owner)
  AND (s.lease_json IS NULL OR (json_extract(s.lease_json,'$[0].runCount')=t.run_count AND json_extract(s.lease_json,'$[0].incarnation')=t.lease_incarnation AND json_extract(s.lease_json,'$[0].project')=t.project_id))
  AND ((s.kind='request' AND s.since>@requestCut) OR (s.kind='claim' AND s.since>@claimCut) OR (s.kind='wait' AND s.seen_at>@waitCut)))`;

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
  private grants: ProjectExecutionGrants | null = null;
  private settings: () => ConcurrencySettings = () => DEFAULT_SETTINGS;
  private requestHoldMaxMs: () => number = () => 3_600_000;
  private readonly wakers = new Set<() => void>();

  constructor(readonly now: () => number = Date.now) {}

  /** Use the store (settings are read live, so a config reload applies). Unattached: no limit. */
  attach(db: Db, settings: () => ConcurrencySettings | undefined, requestHoldMaxMs: () => number): void {
    this.grants = null;
    this.db = db;
    this.settings = () => ({ ...DEFAULT_SETTINGS, ...(settings() ?? {}) });
    this.requestHoldMaxMs = requestHoldMaxMs;
  }

  /** Explicit shared-store mode: slot ownership never queries project task tables. */
  attachCoordination(db: Db, settings: () => ConcurrencySettings | undefined, requestHoldMaxMs: () => number, grants: ProjectExecutionGrants): void {
    if (grants.db !== db || readStoreIdentity(db)?.role !== "coordination") throw new Error("Split capacity requires matching coordination grants");
    this.attach(db, settings, requestHoldMaxMs); this.grants = grants;
  }
  get splitMode(): boolean { return this.grants !== null; }
  private splitHolder(holder: SlotHolder) {
    if (!this.grants) throw new Error("Split capacity not attached");
    const refs = z.array(ExecutionGrantRefSchema).min(1).max(128).parse(holder.executionGrants);
    const leases = z.array(LeaseRefSchema).min(1).max(128).parse(holder.leases);
    if (new Set(refs.map(r=>r.grantId)).size !== refs.length || new Set(leases.map(l=>l.taskId)).size !== leases.length) throw new Error("Duplicate split capacity authority");
    const grants = refs.map(ref=>this.grants!.assertActive(ref)), project=grants[0]!.input.project;
    if(grants.some(g=>g.input.project.projectId!==project.projectId||g.input.project.storeId!==project.storeId||g.input.project.generation!==project.generation))throw new Error("Cross-project split slot");
    const bound=grants.flatMap(g=>g.input.leases);
    if(bound.length!==leases.length||leases.some(l=>bound.filter(b=>canonicalJson(b)===canonicalJson(l)).length!==1))throw new Error("Split slot participant grant mismatch");
    if(holder.leaseOwner!==leases[0]!.owner||holder.taskIds.length!==leases.length||holder.taskIds.some(id=>!leases.some(l=>l.taskId===id)))throw new Error("Split holder participant mismatch");
    return {refs,leases,project};
  }
  /** Public holder IDs are local; coordination keys bind their exact store generation and grants. */
  private storageHolder(holder: SlotHolder): string {
    if (!this.grants) return holder.id;
    const refs = z.array(ExecutionGrantRefSchema).min(1).max(128).parse(holder.executionGrants);
    const grants = refs.map(ref => { const grant = this.grants!.read(ref.grantId); if (!grant || grant.ref.nonce !== ref.nonce) throw new Error("Split holder grant nonce lost"); return grant; });
    const project = grants[0]!.input.project;
    if (grants.some(grant => canonicalJson(grant.input.project) !== canonicalJson(project))) throw new Error("Cross-project split holder");
    return `split_${createHash("sha256").update(canonicalJson({project,id:holder.id,refs:[...refs].sort((a,b)=>a.grantId.localeCompare(b.grantId))})).digest("hex")}`;
  }
  private splitLiveSql = `(s.kind='request' OR (s.execution_grants_json IS NOT NULL AND ((s.kind='claim' AND s.since>@claimCut) OR (s.kind='wait' AND s.seen_at>@waitCut)) AND NOT EXISTS (
    SELECT 1 FROM json_each(s.execution_grants_json) j LEFT JOIN project_execution_grants g ON g.id=json_extract(j.value,'$.grantId')
    LEFT JOIN project_store_registrations p ON p.project_uuid=g.project_uuid
    WHERE g.id IS NULL OR g.nonce!=json_extract(j.value,'$.nonce') OR g.state!='active' OR g.authority_expires_at<=@now
      OR p.state!='registered' OR p.store_uuid!=g.store_uuid OR p.generation!=g.store_generation)))`;

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

  /** Every key of the provider is cooling down: halve once per reported cooldown. */
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
    if(this.grants){this.db!.prepare(`DELETE FROM provider_slots WHERE id IN (SELECT s.id FROM provider_slots s WHERE s.project_uuid IS NOT NULL AND NOT (${this.splitLiveSql}))`).run(this.cuts());return;}
    this.db!
      .prepare(`DELETE FROM provider_slots WHERE id IN (SELECT s.id FROM provider_slots s LEFT JOIN tasks t ON t.id = s.task_id WHERE NOT COALESCE((${LIVE_SQL}),0))`)
      .run(this.cuts());
  }

  private count(platform: string, kind: "request" | "claim" | "wait", extra = "", params: Record<string, unknown> = {}): number {
    if(this.grants) return (this.db!.prepare(`SELECT COUNT(*) AS n FROM provider_slots s WHERE s.platform=@platform AND s.kind=@kind AND (${this.splitLiveSql}) ${extra}`).get({...this.cuts(),platform,kind,...params}) as {n:number}).n;
    return (
      this.db!.prepare(`SELECT COUNT(*) AS n FROM provider_slots s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.platform = @platform AND s.kind = @kind AND (${LIVE_SQL}) ${extra}`).get({
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
    if (!this.enabled && !this.grants) return { id: null, platform, generation: 0 };
    return immediate(this.db!, () => {
      const split = this.grants ? this.splitHolder(holder) : null;
      const storedHolder = this.storageHolder(holder);
      this.purge();
      const now = this.now();
      const r = this.record(platform);
      const held = this.count(platform, "request");
      if (this.enabled && held >= r.limit) return { full: true, platform, held, limit: r.limit, ahead: 0 } as SlotsFull;
      const ahead = this.count(platform, "wait", "AND s.holder != @holder AND (s.priority > @priority OR (s.priority = @priority AND s.since < @since))", {
        holder: storedHolder,
        priority: holder.priority,
        since: holder.since ?? Number.MAX_SAFE_INTEGER,
      });
      if (this.enabled && ahead >= r.limit - held) return { full: true, platform, held, limit: r.limit, ahead } as SlotsFull;
      const id = newId("slot"), nonce = holder.leases === undefined ? undefined : newId("nonce");
      const leases = holder.leases === undefined ? null : JSON.stringify(z.array(LeaseRefSchema).max(256).parse(holder.leases));
      this.db!
        .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at,lease_json,nonce) VALUES (?, ?, 'request', ?, ?, ?, ?, ?, ?,?,?)")
        .run(id, platform, storedHolder, holder.taskIds[0] ?? "", holder.leaseOwner, holder.priority, now, now, leases, nonce ?? null);
      if(split)this.db!.prepare("UPDATE provider_slots SET project_uuid=?,store_uuid=?,store_generation=?,execution_grants_json=? WHERE id=?").run(split.project.projectId,split.project.storeId,split.project.generation,JSON.stringify(split.refs),id);
      this.db!.prepare("DELETE FROM provider_slots WHERE kind = 'wait' AND holder = ?").run(storedHolder);
      if (holder.leases !== undefined) {
        const del = this.db!.prepare("DELETE FROM provider_slots WHERE kind='claim' AND task_id=? AND lease_owner=? AND json_extract(lease_json,'$[0].runCount')=? AND json_extract(lease_json,'$[0].incarnation')=? AND json_extract(lease_json,'$[0].project')=?" + (split ? " AND project_uuid=? AND store_uuid=? AND store_generation=?" : ""));
        for (const lease of holder.leases) del.run(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project, ...(split ? [split.project.projectId,split.project.storeId,split.project.generation] : []));
      } else {
        const del = this.db!.prepare("DELETE FROM provider_slots WHERE kind='claim' AND task_id=? AND lease_json IS NULL");
        for (const t of holder.taskIds) del.run(t);
      }
      return { id, platform, generation: r.generation, ...(nonce ? { nonce } : {}) };
    });
  }

  /** The request was reconciled (or never dispatched): free its slot. */
  release(handle: SlotHandle): void {
    if (!handle.id || !this.db) return;
    try {
      const release=()=>{
        if(this.grants){
          // The live owner frees its slot once its transport is over and the physical receipt is terminal, whatever the
          // outcome (failed, uncertain): accounting stays on the receipt, so holding capacity proves nothing more. Only an
          // undurable dispatch intent or a cost-quarantine incident keeps the hold for explicit reconciliation.
          const pending=this.db!.prepare("SELECT 1 FROM physical_requests WHERE slot_id=? AND slot_nonce=? AND (status='dispatch_intent' OR cost_quarantined=1 OR unbounded_cost=1) LIMIT 1").get(handle.id,handle.nonce??null);
          if(pending)return;
        }
        this.db!.prepare("DELETE FROM provider_slots WHERE id=? AND uncertain=0 AND ((nonce IS NULL AND ? IS NULL) OR nonce=?)").run(handle.id,handle.nonce??null,handle.nonce??null);
      };
      // Serialize the completion check and removal against global beginDispatch intent.
      if(this.grants)immediate(this.db,release);else release();
    } catch {
      // Closing/busy coordination stores retain their physical hold; no expiry proves completion.
    }
    this.wake();
  }

  /** Explicit recovery only from a durable authoritative physical completion receipt. */
  releaseReconciled(handle:SlotHandle):boolean {
    if(!this.grants||!this.db||!handle.id||!handle.nonce)return false;
    const released=immediate(this.db,()=>{
      const receipt=this.db!.prepare("SELECT status,outcome,cost_quarantined,error_code,unbounded_cost FROM physical_requests WHERE slot_id=? AND slot_nonce=?").get(handle.id,handle.nonce);
      const parsed=z.object({status:z.enum(["reserved","dispatch_intent","settled","retired"]),outcome:z.enum(["succeeded","failed","uncertain"]).nullable(),cost_quarantined:z.union([z.literal(0),z.literal(1)]),unbounded_cost:z.union([z.literal(0),z.literal(1)]),error_code:z.string().nullable()}).strict().optional().parse(receipt);
      // A terminal receipt (any outcome) means the transport is over: only a cost incident keeps the hold.
      if(!parsed||parsed.cost_quarantined||parsed.unbounded_cost||!(parsed.status==="retired"||parsed.status==="settled"))return false;
      return this.db!.prepare("DELETE FROM provider_slots WHERE id=? AND nonce=?").run(handle.id,handle.nonce).changes===1;
    });if(released)this.wake();return released;
  }

  /**
   * Recovery sweep: free every split request slot whose exact physical receipt is terminal (settled or retired,
   * no cost incident). Its transport is over whoever settled it (the live owner, startup recovery from a durable
   * outcome, or the operator), so the hold protects nothing; accounting stays on the receipt. A live owner that
   * releases afterwards finds no row. Dispatch intent without a receipt is never touched.
   */
  releaseSettled(): number {
    if(!this.grants||!this.db)return 0;
    const released=immediate(this.db,()=>this.db!.prepare(`DELETE FROM provider_slots WHERE kind='request' AND project_uuid IS NOT NULL AND EXISTS (SELECT 1 FROM physical_requests r
      WHERE r.slot_id=provider_slots.id AND r.slot_nonce=provider_slots.nonce AND r.status IN ('settled','retired') AND r.cost_quarantined=0 AND r.unbounded_cost=0)`).run().changes);
    if(released)this.wake();return released;
  }

  /** Persistence uncertainty retains the exact local transport hold for explicit reconciliation. */
  quarantine(handle: SlotHandle): void {
    if (handle.id && handle.nonce && this.db) this.db.prepare("UPDATE provider_slots SET uncertain=1 WHERE id=? AND nonce=?").run(handle.id, handle.nonce);
  }

  /** Register (or refresh) the holder's place in the queue of each full platform. */
  wait(holder: SlotHolder, platforms: string[]): void {
    if ((!this.enabled && !this.grants) || !holder.taskIds.length) return;
    const now = this.now();
    holder.since ??= now;
    immediate(this.db!, () => {
      const split=this.grants?this.splitHolder(holder):null;
      const storedHolder=this.storageHolder(holder);
      for (const platform of new Set(platforms)) {
        const updated = this.db!.prepare("UPDATE provider_slots SET seen_at = ? WHERE kind = 'wait' AND holder = ? AND platform = ?").run(now, storedHolder, platform);
        if (updated.changes) continue;
        const waitId=newId("slot");
        this.db!
          .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at,lease_json) VALUES (?, ?, 'wait', ?, ?, ?, ?, ?, ?,?)")
          .run(waitId, platform, storedHolder, holder.taskIds[0]!, holder.leaseOwner, holder.priority, holder.since!, now, holder.leases === undefined ? null : JSON.stringify(holder.leases));
        if(split)this.db!.prepare("UPDATE provider_slots SET project_uuid=?,store_uuid=?,store_generation=?,execution_grants_json=? WHERE id=?").run(split.project.projectId,split.project.storeId,split.project.generation,JSON.stringify(split.refs),waitId);
      }
    });
  }

  /** The gate request is over: drop its waits (and, defensively, any slot it still holds). */
  leave(holder: SlotHolder): void {
    if (!this.db) return;
    try {
      const n = this.db.prepare("DELETE FROM provider_slots WHERE holder=? AND uncertain=0 AND (kind='wait' OR (kind='request' AND nonce IS NULL AND lease_json IS NULL))").run(this.storageHolder(holder)).changes;
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

  /** Called only after local claim commit consumed the global execution grant. */
  recordProjectClaim(holder:SlotHolder,platform:string):void {
    if(!this.grants)throw new Error("Split capacity not attached");
    immediate(this.db!,()=>{const bound=this.splitHolder(holder),now=this.now(),storedHolder=this.storageHolder(holder);
      this.purge();
      const existing=this.db!.prepare("SELECT lease_json,execution_grants_json FROM provider_slots WHERE kind='claim' AND holder=? AND platform=?").all(storedHolder,platform) as Array<{lease_json:string;execution_grants_json:string}>;
      if(existing.length===1){
        const row=existing[0]!;
        const set=(values:readonly unknown[])=>JSON.stringify(values.map(value=>canonicalJson(value)).sort());
        const storedLeases=z.array(LeaseRefSchema).min(1).max(128).parse(JSON.parse(row.lease_json)),storedRefs=z.array(ExecutionGrantRefSchema).min(1).max(128).parse(JSON.parse(row.execution_grants_json));
        if(set(storedLeases)!==set(bound.leases)||set(storedRefs)!==set(bound.refs))throw new Error("Split claim binding changed");
        return;
      }
      if(existing.length!==0)throw new Error("Partial split claim binding");
      const used=this.count(platform,"request")+this.count(platform,"claim")+this.count(platform,"wait","AND s.priority>0");
      if(this.enabled&&used+1>this.limit(platform))throw new ProviderClaimCapacityError();
      const first=bound.leases[0]!;
      this.db!.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES(?,?,'claim',?,?,?,0,?,?,?,?,?,?,?)").run(newId("slot"),platform,storedHolder,first.taskId,first.owner,now,now,JSON.stringify(bound.leases),bound.project.projectId,bound.project.storeId,bound.project.generation,JSON.stringify(bound.refs));
    });
  }

  /** The scheduler started a task on this platform: it holds a claim until its first request. */
  recordClaim(taskId: string, leaseOwner: string, platform: string, lease?: LeaseRef): void {
    if(this.grants)throw new Error("Split claims require recordProjectClaim with execution authority");
    if (!this.enabled) return;
    const now = this.now();
    this.db!
      .prepare("INSERT INTO provider_slots (id, platform, kind, holder, task_id, lease_owner, priority, since, seen_at,lease_json) VALUES (?, ?, 'claim', ?, ?, ?, 0, ?, ?,?)")
      .run(newId("slot"), platform, taskId, taskId, leaseOwner, now, now, lease ? JSON.stringify([LeaseRefSchema.parse(lease)]) : null);
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
  if(readStoreIdentity(db)?.role==="coordination")return z.array(z.object({platform:z.string(),kind:z.enum(["request","claim","wait"]),n:z.number().int()})).parse(db.prepare("SELECT platform,kind,COUNT(*) n FROM provider_slots WHERE kind='request' OR (project_uuid IS NOT NULL AND seen_at>?) GROUP BY platform,kind ORDER BY platform,kind").all(now-WAIT_STALE_MS));
  return db
    .prepare(
      `SELECT s.platform AS platform, s.kind AS kind, COUNT(*) AS n FROM provider_slots s LEFT JOIN tasks t ON t.id = s.task_id
        WHERE ${LIVE_SQL} GROUP BY s.platform, s.kind ORDER BY s.platform, s.kind`,
    )
    .all({ now, requestCut: 0, claimCut: now - CLAIM_HOLD_MS, waitCut: now - WAIT_STALE_MS }) as Array<{ platform: string; kind: "request" | "claim" | "wait"; n: number }>;
}


/** One split request slot exactly as an operator recovery read it (every column, so the release is a full compare-and-swap). */
export const SplitRequestSlotSchema = z.object({
  id: z.string().min(1), platform: z.string().min(1), kind: z.literal("request"), holder: z.string().min(1), task_id: z.string().min(1),
  lease_owner: z.string().min(1), priority: z.number().int(), since: z.number(), seen_at: z.number(), lease_json: z.string(), nonce: z.string().min(1),
  uncertain: z.literal(0), project_uuid: z.string().min(1), store_uuid: z.string().min(1), store_generation: z.number().int().positive(),
  execution_grants_json: z.string().min(1),
}).strict();
export type SplitRequestSlot = z.infer<typeof SplitRequestSlotSchema>;

/**
 * Operator absent-owner recovery's release of one split request slot, settled in the same transaction (the
 * owner died in dispatch intent, so no receipt-driven release could apply). It is allowed only inside the caller's coordination transaction, after the broker settled this exact slot's physical
 * receipt `uncertain` with `outcomeDigest` on the operator's proof that the local owner process is gone.
 * It never reads or changes execution grants.
 */
export function releaseOwnerAbsentSlot(db: Db, value: SplitRequestSlot, outcomeDigest: string): void {
  const slot = SplitRequestSlotSchema.parse(value);
  if (!db.inTransaction || readStoreIdentity(db)?.role !== "coordination") throw new Error("Owner-absent slot release requires the coordination transaction");
  const receipt = z.object({ status: z.literal("settled"), outcome: z.literal("uncertain"), outcome_digest: z.literal(z.string().regex(/^[a-f0-9]{64}$/).parse(outcomeDigest)),
    cost_quarantined: z.literal(0), unbounded_cost: z.literal(0), project_uuid: z.literal(slot.project_uuid), store_uuid: z.literal(slot.store_uuid), generation: z.literal(slot.store_generation) }).strict()
    .safeParse(db.prepare("SELECT status,outcome,outcome_digest,cost_quarantined,unbounded_cost,project_uuid,store_uuid,generation FROM physical_requests WHERE slot_id=? AND slot_nonce=?").get(slot.id, slot.nonce));
  if (!receipt.success) throw new Error("Owner-absent slot release lacks its exact uncertain physical receipt");
  const removed = db.prepare(`DELETE FROM provider_slots WHERE id=? AND kind='request' AND nonce=? AND uncertain=0 AND holder=? AND task_id=? AND lease_owner=? AND lease_json=?
    AND platform=? AND priority=? AND since=? AND seen_at=? AND project_uuid=? AND store_uuid=? AND store_generation=? AND execution_grants_json=?`)
    .run(slot.id, slot.nonce, slot.holder, slot.task_id, slot.lease_owner, slot.lease_json, slot.platform, slot.priority, slot.since, slot.seen_at,
      slot.project_uuid, slot.store_uuid, slot.store_generation, slot.execution_grants_json).changes;
  if (removed !== 1) throw new Error("exact transport slot release lost its compare-and-swap");
}
