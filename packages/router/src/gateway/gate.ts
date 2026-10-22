import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { Admission, type Participant } from "../admission/admission.js";
import type { RequestLedger } from "../admission/request-ledger.js";
import { SqliteRequestLedger } from "../admission/sqlite-request-ledger.js";
import { AdmissionDenied, GatewayError, type AdmissionDenialReason } from "../core/errors.js";
import type { ModelEndpoint } from "../models/catalog.js";
import type { RoutePlan } from "../routing/select.js";
import { fitsEndpoint } from "../routing/select.js";
import type { ChatRequest, ChatResponse, ProviderStatus } from "./types.js";
import { estimateTokens } from "./types.js";
import { CircuitBreakers, countsAsProviderFailure } from "./breaker.js";
import { ProviderCapacity, SLOT_POLL_MS, type SlotHandle, type SlotHolder } from "./capacity.js";
import { newId } from "../storage/db.js";
import { requestPaid, stickyOrder } from "../routing/select.js";
import type { ProviderClient } from "../providers/client.js";
import { probeClient, requestDirect, type DirectRuntime } from "./direct.js";
import { NOT_IN_PLAN_RECHECK_MS } from "../providers/keys.js";
import { quarantineReason } from "./quarantine.js";

export type { DirectRuntime } from "./direct.js";

export interface GateRequest {
  plan: RoutePlan;
  executionId: string;
  purpose: string;
  /** Participants with their share of the physical request (one for ordinary tasks). */
  participants: Array<Omit<Participant, "estInputTokens" | "reservedOutputTokens"> & { weight?: number }>;
  chat: Omit<ChatRequest, "model">;
  signal?: AbortSignal;
  /**
   * The endpoint that served this conversation's last turn: tried first while it is healthy
   * (breaker closed, not cooling down, not excluded) and still a candidate (see `stickyOrder`).
   */
  preferEndpointId?: string | null;
  /** Endpoints this request must not use (a retry after one cut a tool call short). */
  avoidEndpointIds?: readonly string[];
  /** A stable conversation id, sent as `prompt_cache_key` where the provider takes one. */
  cacheKey?: string;
}

export interface GateAttempt {
  endpointId: string;
  outcome: string;
  /** The admission denial behind a skipped endpoint (a paid budget), when there was one. */
  denial?: AdmissionDenialReason;
}

export interface GateResponse {
  requestId: string;
  response: ChatResponse;
  endpoint: ModelEndpoint;
  attempts: GateAttempt[];
  estimatedInputTokens: number;
}

/** Key-derived statuses are local reads; recompute at most this often unless an outcome invalidates them. */
const STATUS_TTL_MS = 1000;

/**
 * Provider health for routing: each provider's health derived from SwitchYard's own key state
 * (`ProviderRuntime.statuses`) and this process's per-provider circuit breakers, so route
 * ordering can push cooling or failing providers to the end and the gate can skip providers
 * whose breaker is open.
 *
 * Key-derived status is reported once per provider. A platform name that is not a provider id
 * (configured paid endpoints use `paid:<provider>`) reads its provider's status through
 * `statusPlatform`; breakers and concurrency slots stay keyed per platform name, and a cooling
 * provider halves the slots of every platform name that reads its status.
 */
export class ProviderHealth {
  private cache: { at: number; byPlatform: Map<string, ProviderStatus> } | null = null;
  /** Platform names seen that read another platform's status (alias -> provider id). */
  private readonly aliases = new Map<string, string>();
  readonly breakers: CircuitBreakers;
  /** Per-provider concurrency slots and their AIMD limits (see gateway/capacity.ts). */
  readonly capacity: ProviderCapacity;

  constructor(
    private readonly now: () => number = Date.now,
    /** Providers' health from key state (synchronous store reads); null reports nothing. */
    private readonly source: (() => ProviderStatus[]) | null = null,
    /** The provider id whose key-derived status a platform name reads (`paid:x` -> `x`); identity when omitted. */
    private readonly statusPlatform: ((platform: string) => string) | null = null,
  ) {
    this.breakers = new CircuitBreakers(now);
    this.capacity = new ProviderCapacity(now);
  }

  /** Every cooling provider halves its concurrency once per cooldown, under its own name and its aliases'. */
  private observeCooldown(p: ProviderStatus, platforms: Iterable<string>): void {
    if (p.status !== "rate_limited" || p.resumeAt === null) return;
    for (const platform of platforms) this.capacity.observeCooldown(platform, p.resumeAt);
  }

  private statuses(): Map<string, ProviderStatus> {
    if (!this.source) return new Map();
    if (this.cache && this.now() - this.cache.at < STATUS_TTL_MS) return this.cache.byPlatform;
    let list: ProviderStatus[] = [];
    try {
      list = this.source();
    } catch {
      list = [];
    }
    this.cache = { at: this.now(), byPlatform: new Map(list.map((p) => [p.platform, p])) };
    // Every key of a provider cooling halves its concurrency (once per cooldown).
    for (const p of list) this.observeCooldown(p, [p.platform, ...[...this.aliases].filter(([, id]) => id === p.platform).map(([alias]) => alias)]);
    return this.cache.byPlatform;
  }

  private status(platform: string): ProviderStatus | undefined {
    const id = this.statusPlatform?.(platform) ?? platform;
    if (id === platform) return this.statuses().get(platform);
    const known = this.aliases.has(platform);
    if (!known) this.aliases.set(platform, id);
    const s = this.statuses().get(id);
    // A newly seen alias catches up on a cooldown already in progress.
    if (!known && s) this.observeCooldown(s, [platform]);
    return s;
  }

  /** The reported cooldown (while it lasts) and, when the platform's breaker is open, until when. */
  lookup = (platform: string): { status: string; resumeAt: number | null; circuitOpenUntil?: number } | undefined => {
    const circuit = this.breakers.blockedUntil(platform);
    const s = this.status(platform);
    const known = s && !(s.status === "rate_limited" && s.resumeAt !== null && s.resumeAt <= this.now());
    if (!known) return circuit !== null ? { status: "healthy", resumeAt: null, circuitOpenUntil: circuit } : undefined;
    return { status: s.status, resumeAt: s.resumeAt, ...(circuit !== null ? { circuitOpenUntil: circuit } : {}) };
  };

  /**
   * Feed one dispatched attempt's result to the platform's breaker and its concurrency limit
   * (null error: it answered). `generation` is the slot's AIMD generation: a 429 halves the
   * platform's slots once per generation, and so does a breaker opening. `keyLevel` marks a
   * provider's key failing on its own (429, invalid key, out of credits): key rotation and key
   * health handle it, so it never counts toward the breaker; a 429 still halves the slots.
   */
  recordOutcome(platform: string, err: GatewayError | null, generation?: number, opts: { keyLevel?: boolean } = {}): void {
    this.cache = null;
    if (!err) {
      this.breakers.success(platform);
      this.capacity.success(platform);
      return;
    }
    if (err.kind === "aborted") return this.breakers.release(platform);
    if (opts.keyLevel) {
      this.breakers.release(platform);
      if (err.kind === "rate_limited" || err.status === 429) this.capacity.throttle(platform, "rate_limited", generation);
      return;
    }
    const cooling = this.status(platform);
    const coolingReported = cooling?.status === "rate_limited" && (cooling.resumeAt === null || cooling.resumeAt > this.now());
    const wasOpen = this.breakers.get(platform).state === "open";
    if (countsAsProviderFailure(err, coolingReported)) this.breakers.failure(platform, `${err.kind}: ${err.message}`);
    // A 4xx, auth, or unknown-model answer came from something that is up.
    else if (!["rate_limited", "pool_exhausted"].includes(err.kind)) this.breakers.success(platform);
    else this.breakers.release(platform);
    const throttled = (err.kind === "rate_limited" || err.status === 429) && this.capacity.throttle(platform, "rate_limited", generation);
    if (!throttled && !wasOpen && this.breakers.get(platform).state === "open") this.capacity.throttle(platform, "circuit_open", generation);
  }

  /** Re-read key-derived health now (another process may have changed key state). */
  async refresh(): Promise<void> {
    this.cache = null;
    this.statuses();
  }

  snapshot(): ProviderStatus[] {
    return [...this.statuses().values()];
  }
}

/**
 * The single path for every model request: per-endpoint fit, atomic admission (one reservation
 * per attempt), dispatch to the endpoint's provider through SwitchYard's keys (see
 * gateway/direct.ts), served-model verification, and reconciliation. Falls back across ranked
 * endpoints only for capacity-type failures, up to routing.max_endpoint_fallbacks free and
 * paid.max_paid_attempts paid dispatched endpoints.
 */
export class Gate {
  private closing = false;
  private readonly inFlight = new Set<Promise<GateResponse>>();
  readonly ledger: RequestLedger;
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    readonly admission: Admission,
    readonly health: ProviderHealth,
    /** Providers (free and paid), their keys, and the spend ledger. */
    readonly direct: DirectRuntime,
    ledger?: RequestLedger,
  ) {
    this.ledger = ledger ?? new SqliteRequestLedger(admission, direct.spend);
    // Settings are read live (a config reload mutates cfg in place); state is mirrored to meta.
    health.breakers.attach(db, () => cfg.routing.circuit_breaker);
    // A request slot older than every attempt's timeout belongs to a request that is gone.
    health.capacity.attach(db, () => cfg.team, () => (cfg.providers.request_timeout_seconds * 2 + 60) * 1000);
  }

  /**
   * The provider client discovery's tool probe uses: through breakers, slots, free keys, and
   * key state like any routed request (AGENTS.md: every model request goes through Gate).
   */
  probeClient(): Pick<ProviderClient, "complete"> {
    return probeClient({ cfg: this.cfg, health: this.health, direct: this.direct });
  }

  /**
   * Whether a sticky endpoint may go first: its platform's breaker is closed, it is not cooling
   * down, and the gate does not exclude it. Key availability and context fit are checked when
   * it is tried; a skip there falls through to the normal order.
   */
  private stickyHealthy(ep: ModelEndpoint): boolean {
    if (this.health.breakers.blockedUntil(ep.providerId) !== null) return false;
    const h = this.health.lookup(ep.providerId);
    if (h?.status === "rate_limited" && (h.resumeAt === null || h.resumeAt > this.health.breakers.now())) return false;
    return this.excluded(ep) === null;
  }

  /** The candidates in the order this request tries them (stickiness and exclusions applied). */
  private candidatesFor(req: GateRequest): ModelEndpoint[] {
    const avoid = new Set(req.avoidEndpointIds ?? []);
    const list = avoid.size ? req.plan.candidates.filter((c) => !avoid.has(c.id)) : req.plan.candidates;
    return this.cfg.routing.sticky_endpoints ? stickyOrder(list, req.preferEndpointId, (ep) => this.stickyHealthy(ep)) : list;
  }

  /** Supervisors and independent reviewers are served before waiting workers. */
  private priorityOf(req: GateRequest): 0 | 1 {
    if (req.purpose === "supervisor" || req.purpose === "verification") return 1;
    return this.cfg.profiles[req.plan.profile]?.mode === "supervisor" ? 1 : 0;
  }

  /**
   * Take a slot on the endpoint's platform, then its breaker admission. Null (recorded as a
   * skipped attempt) when either refuses; a full platform is added to `full`.
   */
  private admit(ep: ModelEndpoint, holder: SlotHolder, attempts: GateAttempt[], full: Set<string>, breaker: (ep: ModelEndpoint) => boolean): SlotHandle | null {
    const slot = this.health.capacity.tryAcquire(holder, ep.providerId);
    if ("full" in slot) {
      full.add(ep.providerId);
      attempts.push({ endpointId: ep.id, outcome: `skipped: provider slots full for ${ep.providerId} (${slot.held}/${slot.limit} in flight${slot.ahead ? `, ${slot.ahead} waiting ahead` : ""})` });
      return null;
    }
    if (breaker(ep)) return slot;
    this.health.capacity.release(slot);
    return null;
  }

  /**
   * A served-model violation quarantines the endpoint: the provider answered with a different
   * model than requested. An explicit acknowledgement permits a retry, never a later violation.
   */
  quarantined(ep: ModelEndpoint): string | null {
    return quarantineReason(this.db, ep.id);
  }

  /**
   * Why the gate will not send to this endpoint now, for routing to leave it out: quarantine, or
   * every usable key's plan refused the model recently (`planRefused`). Only the first is a
   * quarantine; the panel shows them apart.
   */
  excluded(ep: ModelEndpoint): string | null {
    return this.quarantined(ep) ?? this.planRefused(ep);
  }

  /** "Not in the plan of any <provider> key" when every usable key's plan refused the model within the recheck window (rechecked after a day). */
  planRefused(ep: ModelEndpoint): string | null {
    if (ep.route.kind !== "direct") return null;
    const rt = this.direct.providers;
    const creds = rt.credentials().list(ep.route.provider).filter((c) => c.unusableReason === null);
    if (!creds.length) return null;
    const now = rt.now();
    let latest = 0;
    for (const c of creds) {
      const r = rt.keys.get(c.ref)?.planRefusals[ep.route.model];
      if (!r || r.at + NOT_IN_PLAN_RECHECK_MS <= now) return null;
      latest = Math.max(latest, r.at);
    }
    return `not in the plan of any ${ep.route.provider} key (refused ${new Date(latest).toISOString().slice(0, 16)}Z; rechecked a day later)`;
  }

  /**
   * Send one request. When every candidate's platform is out of concurrency slots (and nothing
   * was dispatched), wait without holding anything until a slot frees, up to one request
   * timeout; then fail `rate_limited` so the executor defers the task for capacity.
   */
  async request(req: GateRequest): Promise<GateResponse> {
    if (this.closing) throw new Error("model request gate is closed");
    // Register before invoking even a synchronously executing adapter/hook (it may close).
    const run = Promise.resolve().then(() => this.performRequest(req));
    this.inFlight.add(run);
    try { return await run; }
    finally { this.inFlight.delete(run); }
  }

  /** Stop new routed requests and drain accounting before its SQLite connection closes. */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.inFlight]);
  }

  private async performRequest(req: GateRequest): Promise<GateResponse> {
    const holder: SlotHolder = { id: newId("h"), taskIds: req.participants.map((p) => p.taskId), leaseOwner: req.participants[0]?.leaseOwner ?? null, priority: this.priorityOf(req), since: null };
    const started = Date.now();
    const maxWaitMs = this.cfg.providers.request_timeout_seconds * 1000;
    try {
      for (;;) {
        const r = await this.round(req, holder);
        if (!("full" in r)) return r;
        if (req.signal?.aborted) throw Object.assign(new GatewayError("aborted", "aborted while waiting for a provider slot"), { attempts: r.attempts });
        if (Date.now() - started >= maxWaitMs) {
          throw Object.assign(new GatewayError("rate_limited", `provider slots full for ${r.full.join(", ")} for ${Math.round(maxWaitMs / 1000)} s`, undefined, 5000, false), { attempts: r.attempts });
        }
        this.health.capacity.wait(holder, r.full);
        await this.health.capacity.nextWake(SLOT_POLL_MS, req.signal);
      }
    } finally {
      this.health.capacity.leave(holder);
    }
  }

  /** One pass over the candidates; `full` when nothing was dispatched because slots were taken. */
  private async round(req: GateRequest, holder: SlotHolder): Promise<GateResponse | { full: string[]; attempts: GateAttempt[] }> {
    const estInput = estimateTokens(req.chat.messages, req.chat.tools);
    const attempts: GateAttempt[] = [];
    const full = new Set<string>();
    let lastCapacityError: GatewayError | null = null;
    let dispatched = 0;
    let dispatchedPaid = 0;
    // Earliest time a platform skipped for its open breaker admits a probe.
    let circuitRetryAt: number | null = null;
    // Earliest time an endpoint skipped for having no usable key expects one back.
    let keyRetryAt: number | null = null;
    /** Takes the platform's breaker admission (or its one half-open probe); false records a skip. */
    const admitted = (ep: ModelEndpoint): boolean => {
      if (this.health.breakers.admit(ep.providerId)) return true;
      const until = this.health.breakers.blockedUntil(ep.providerId) ?? this.health.breakers.now();
      circuitRetryAt = Math.min(circuitRetryAt ?? until, until);
      attempts.push({ endpointId: ep.id, outcome: `skipped: circuit open for ${ep.providerId}` });
      return false;
    };

    const totalWeight = req.participants.reduce((s, p) => s + (p.weight ?? 1), 0);
    const participants: Participant[] = req.participants.map((p) => ({
      taskId: p.taskId,
      leaseOwner: p.leaseOwner,
      budget: p.budget,
      estInputTokens: Math.ceil((estInput * (p.weight ?? 1)) / totalWeight),
      reservedOutputTokens: Math.ceil((req.chat.max_tokens * (p.weight ?? 1)) / totalWeight),
    }));

    for (const ep of this.candidatesFor(req)) {
      const paid = requestPaid(ep, this.cfg, req.plan);
      // Free and paid attempts are limited separately: free fallbacks never use up paid slots.
      if (paid ? dispatchedPaid >= this.cfg.paid.max_paid_attempts : dispatched >= this.cfg.routing.max_endpoint_fallbacks) continue;
      const misfit = fitsEndpoint(ep, estInput, req.chat.max_tokens);
      if (misfit) {
        attempts.push({ endpointId: ep.id, outcome: `skipped (too large): ${misfit}` });
        continue;
      }
      const q = this.excluded(ep);
      if (q) {
        attempts.push({ endpointId: ep.id, outcome: `skipped: ${q}` });
        continue;
      }
      const r = await requestDirect({ cfg: this.cfg, ledger: this.ledger, assertDispatch: participants => this.admission.assertDispatch(participants), health: this.health, direct: this.direct }, ep, req, participants, estInput, attempts, (e) => this.admit(e, holder, attempts, full, admitted));
      if (r.kind === "skip") {
        if (r.resumeAt !== null) keyRetryAt = Math.min(keyRetryAt ?? r.resumeAt, r.resumeAt);
        continue;
      }
      if (paid) dispatchedPaid++;
      else dispatched++;
      if (r.kind === "failed") {
        lastCapacityError = r.error;
        continue;
      }
      return { requestId: r.requestId, response: r.response, endpoint: ep, attempts, estimatedInputTokens: estInput };
    }

    if (dispatched === 0 && dispatchedPaid === 0) {
      // Every dispatchable platform is out of slots: the caller waits for one.
      if (full.size) return { full: [...full], attempts };
      // Every dispatchable model sits behind an open breaker or has no usable key yet: wait for
      // capacity rather than fail.
      if (circuitRetryAt !== null || keyRetryAt !== null) {
        const at = Math.min(circuitRetryAt ?? Infinity, keyRetryAt ?? Infinity);
        const wait = Math.max(1000, at - this.health.breakers.now());
        const why = circuitRetryAt !== null && keyRetryAt !== null ? "circuit open or no usable key" : circuitRetryAt !== null ? "circuit open" : "no usable key";
        throw Object.assign(new GatewayError("rate_limited", `${why} for every remaining provider; next ${circuitRetryAt === at ? "probe" : "key"} in ${Math.ceil(wait / 1000)} s`, undefined, wait, false), { attempts });
      }
      const reasons = attempts.length ? attempts.map((a) => `${a.endpointId}: ${a.outcome}`) : ["no eligible model for this task type and tier"];
      const allTooLarge = attempts.length > 0 && attempts.every((a) => a.outcome.startsWith("skipped (too large)"));
      const paidOnly = attempts.length > 0 && attempts.every((a) => a.outcome.startsWith("skipped (paid budget)"));
      // Only a project's own paid cap stood in the way: say so (other projects may still route paid).
      const projectPaid = paidOnly && attempts.every((a) => a.denial === "project_paid_budget_exhausted");
      throw Object.assign(new AdmissionDenied(allTooLarge ? "context_does_not_fit" : projectPaid ? "project_paid_budget_exhausted" : paidOnly ? "paid_budget_exhausted" : "no_eligible_endpoint", reasons.join("; ")), { attempts });
    }
    throw Object.assign(lastCapacityError ?? new GatewayError("pool_exhausted", "all candidate models failed"), { attempts });
  }
}
