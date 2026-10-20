import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import { Admission, type Participant } from "../admission/admission.js";
import { AdmissionDenied, GatewayError } from "../core/errors.js";
import type { ModelEndpoint } from "../models/catalog.js";
import type { ChainManager } from "../models/chains.js";
import type { RoutePlan } from "../routing/select.js";
import { fitsEndpoint } from "../routing/select.js";
import type { ChatRequest, ChatResponse, InferenceClient, ProviderStatus } from "./types.js";
import { estimateTokens } from "./types.js";
import { CircuitBreakers, countsAsProviderFailure } from "./breaker.js";
import { ProviderCapacity, SLOT_POLL_MS, type SlotHandle, type SlotHolder } from "./capacity.js";
import { newId } from "../storage/db.js";
import { isPaid } from "../routing/select.js";
import type { ProviderClient } from "../providers/client.js";
import { FALLBACK_KINDS, probeClient, requestDirect, type DirectRuntime } from "./direct.js";

export type { DirectRuntime } from "./direct.js";

export interface GateRequest {
  plan: RoutePlan;
  executionId: string;
  purpose: string;
  /** Participants with their share of the physical request (one for ordinary tasks). */
  participants: Array<Omit<Participant, "estInputTokens" | "reservedOutputTokens"> & { weight?: number }>;
  chat: Omit<ChatRequest, "model">;
  signal?: AbortSignal;
}

export interface GateAttempt {
  endpointId: string;
  outcome: string;
}

export interface GateResponse {
  requestId: string;
  response: ChatResponse;
  endpoint: ModelEndpoint;
  attempts: GateAttempt[];
  estimatedInputTokens: number;
}

/** Key-derived statuses are local reads; recompute at most this often unless an outcome invalidates them. */
const DIRECT_STATUS_TTL_MS = 1000;

/**
 * Provider health for routing: direct providers' health derived from SwitchYard's own key state
 * (`ProviderRuntime.statuses`), cached GET /v1/providers for FreeLLMAPI platforms, and this
 * process's per-provider circuit breakers, so route ordering can push cooling or failing
 * platforms to the end and the gate can skip platforms whose breaker is open.
 */
export class ProviderHealth {
  private cache: { at: number; byPlatform: Map<string, ProviderStatus> } | null = null;
  private directCache: { at: number; byPlatform: Map<string, ProviderStatus> } | null = null;
  private inflight: Promise<void> | null = null;
  readonly breakers: CircuitBreakers;
  /** Per-provider concurrency slots and their AIMD limits (see gateway/capacity.ts). */
  readonly capacity: ProviderCapacity;

  constructor(
    private readonly client: InferenceClient,
    private readonly now: () => number = Date.now,
    /** Direct providers' health from key state (synchronous store reads). */
    private readonly direct: (() => ProviderStatus[]) | null = null,
  ) {
    this.breakers = new CircuitBreakers(now);
    this.capacity = new ProviderCapacity(now);
  }

  private directStatuses(): Map<string, ProviderStatus> {
    if (!this.direct) return new Map();
    if (this.directCache && this.now() - this.directCache.at < DIRECT_STATUS_TTL_MS) return this.directCache.byPlatform;
    let list: ProviderStatus[] = [];
    try {
      list = this.direct();
    } catch {
      list = [];
    }
    this.directCache = { at: this.now(), byPlatform: new Map(list.map((p) => [p.platform, p])) };
    // Every key of a provider cooling halves its concurrency (once per cooldown).
    for (const p of list) if (p.status === "rate_limited" && p.resumeAt !== null) this.capacity.observeCooldown(p.platform, p.resumeAt);
    return this.directCache.byPlatform;
  }

  /** A direct provider's key-derived status wins over FreeLLMAPI's report unless it knows nothing. */
  private status(platform: string): ProviderStatus | undefined {
    const d = this.directStatuses().get(platform);
    if (d && d.status !== "unknown") return d;
    return this.cache?.byPlatform.get(platform) ?? d;
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
   * direct provider's key failing on its own (429, invalid key, out of credits): key rotation and
   * key health handle it, so it never counts toward the breaker; a 429 still halves the slots.
   */
  recordOutcome(platform: string, err: GatewayError | null, generation?: number, opts: { keyLevel?: boolean } = {}): void {
    this.directCache = null;
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

  async refresh(maxAgeMs = 30_000): Promise<void> {
    this.directCache = null;
    this.directStatuses();
    if (!this.client.providers) return;
    if (this.cache && this.now() - this.cache.at < maxAgeMs) return;
    this.inflight ??= this.client
      .providers()
      .then((list) => {
        this.cache = { at: this.now(), byPlatform: new Map(list.map((p) => [p.platform, p])) };
        // A reported cooldown halves the platform's concurrency (once per cooldown).
        for (const p of list) if (p.status === "rate_limited" && p.resumeAt !== null) this.capacity.observeCooldown(p.platform, p.resumeAt);
      })
      .catch(() => {
        this.cache = { at: this.now(), byPlatform: this.cache?.byPlatform ?? new Map() };
      })
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
  }

  snapshot(): ProviderStatus[] {
    const merged = new Map(this.cache?.byPlatform ?? []);
    for (const [platform, s] of this.directStatuses()) if (s.status !== "unknown" || !merged.has(platform)) merged.set(platform, s);
    return [...merged.values()];
  }
}

/**
 * The single path for every model request: per-endpoint fit, atomic admission (one reservation
 * per attempt), dispatch (a direct provider through SwitchYard's keys, see gateway/direct.ts, or
 * a FreeLLMAPI single-model chain), served-model verification, and reconciliation. Falls back
 * across ranked endpoints only for capacity-type failures, up to routing.max_endpoint_fallbacks
 * free and paid.max_paid_attempts paid dispatched endpoints.
 */
export class Gate {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly client: InferenceClient,
    readonly admission: Admission,
    private readonly chains: ChainManager,
    readonly health: ProviderHealth,
    /** Direct providers (free and paid); null routes only FreeLLMAPI chains. */
    readonly direct: DirectRuntime | null = null,
  ) {
    // Settings are read live (a config reload mutates cfg in place); state is mirrored to meta.
    health.breakers.attach(db, () => cfg.routing.circuit_breaker);
    // A request slot older than every attempt's timeout belongs to a request that is gone.
    health.capacity.attach(db, () => cfg.team, () => (Math.max(cfg.gateway.request_timeout_seconds, cfg.providers.request_timeout_seconds) * 2 + 60) * 1000);
  }

  /**
   * The provider client discovery's tool probe uses: through breakers, slots, free keys, and
   * key state like any routed request (AGENTS.md: every model request goes through Gate).
   */
  probeClient(): Pick<ProviderClient, "complete"> | null {
    return this.direct ? probeClient({ cfg: this.cfg, health: this.health, direct: this.direct }) : null;
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

  /** An endpoint with a served-model violation stays blocked until its chain is re-verified. */
  quarantined(ep: ModelEndpoint): string | null {
    const last = this.chains.latest(ep.chainName);
    const since = last?.ok ? last.verifiedAt : 0;
    const row = this.db
      .prepare("SELECT policy_violation FROM model_requests WHERE endpoint_id = ? AND policy_violation IS NOT NULL AND reserved_at > ? ORDER BY reserved_at DESC LIMIT 1")
      .get(ep.id, since) as { policy_violation: string } | undefined;
    return row ? `quarantined after a policy violation: ${row.policy_violation}` : null;
  }

  /**
   * Send one request. When every candidate's platform is out of concurrency slots (and nothing
   * was dispatched), wait without holding anything until a slot frees, up to one request
   * timeout; then fail `rate_limited` so the executor defers the task for capacity.
   */
  async request(req: GateRequest): Promise<GateResponse> {
    const holder: SlotHolder = { id: newId("h"), taskIds: req.participants.map((p) => p.taskId), leaseOwner: req.participants[0]?.leaseOwner ?? null, priority: this.priorityOf(req), since: null };
    const started = Date.now();
    const maxWaitMs = this.cfg.gateway.request_timeout_seconds * 1000;
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
    // Earliest time a direct endpoint skipped for having no usable key expects one back.
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

    for (const ep of req.plan.candidates) {
      const direct = ep.route.kind === "direct";
      const paid = direct && isPaid(ep);
      // Free and paid attempts are limited separately: free fallbacks never use up paid slots.
      if (paid ? dispatchedPaid >= this.cfg.paid.max_paid_attempts : dispatched >= this.cfg.routing.max_endpoint_fallbacks) continue;
      const misfit = fitsEndpoint(ep, estInput, req.chat.max_tokens);
      if (misfit) {
        attempts.push({ endpointId: ep.id, outcome: `skipped (too large): ${misfit}` });
        continue;
      }
      const q = this.quarantined(ep);
      if (q) {
        attempts.push({ endpointId: ep.id, outcome: `skipped: ${q}` });
        continue;
      }
      if (direct) {
        if (!this.direct) {
          attempts.push({ endpointId: ep.id, outcome: "skipped: direct providers unavailable" });
          continue;
        }
        const r = await requestDirect({ cfg: this.cfg, admission: this.admission, health: this.health, direct: this.direct }, ep, req, participants, estInput, attempts, (e) => this.admit(e, holder, attempts, full, admitted));
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
      const unverified = await this.chains.ensureVerified(ep);
      if (unverified) {
        attempts.push({ endpointId: ep.id, outcome: `skipped: ${unverified}` });
        continue;
      }
      const slot = this.admit(ep, holder, attempts, full, admitted);
      if (!slot) continue;

      let reservation;
      try {
        reservation = this.admission.reserve({
          executionId: req.executionId,
          profile: req.plan.profile,
          purpose: req.purpose,
          gatewayModel: `auto:${ep.chainName}`,
          endpointId: ep.id,
          tier: req.plan.tier,
          routeNote: req.plan.belowFloorEndpoints.has(ep.id) ? "forced below size floor" : null,
          estInputTokens: estInput,
          reservedOutputTokens: req.chat.max_tokens,
          participants,
        });
      } catch (err) {
        this.health.breakers.release(ep.providerId);
        this.health.capacity.release(slot);
        throw err;
      }
      dispatched++;
      const chat: ChatRequest = { ...req.chat, model: `auto:${ep.chainName}` };
      if (!ep.supportsStructuredOutput) delete chat.response_format;

      // The slot is held from reservation to reconciliation.
      let response: ChatResponse;
      let violation: string | undefined;
      try {
        try {
          response = await this.client.complete(chat, req.signal);
        } catch (err) {
          const ge = err instanceof GatewayError ? err : new GatewayError("transport", (err as Error).message ?? String(err), undefined, undefined, true);
          this.health.recordOutcome(ep.providerId, req.signal?.aborted ? new GatewayError("aborted", ge.message) : ge, slot.generation);
          this.admission.reconcile(reservation, {
            kind: ge.possiblyConsumed ? "uncertain" : "failed",
            ...(ge.status !== undefined ? { httpStatus: ge.status } : {}),
            errorKind: ge.kind,
            errorMessage: ge.message,
          });
          attempts.push({ endpointId: ep.id, outcome: ge.kind });
          if (req.signal?.aborted || ge.kind === "aborted") throw Object.assign(ge, { attempts });
          if (FALLBACK_KINDS.has(ge.kind)) {
            lastCapacityError = ge;
            continue;
          }
          throw Object.assign(ge, { attempts });
        }

        this.health.recordOutcome(ep.providerId, null, slot.generation);
        const t = response.telemetry;
        if (!t.servedModel) violation = "gateway did not report the served model";
        else if (t.servedModel !== ep.gatewayModelId || (t.servedProvider !== null && t.servedProvider !== ep.providerId)) {
          violation = `chain ${ep.chainName} for ${ep.id} was served by ${t.servedProvider ?? "?"}/${t.servedModel}`;
        }
        this.admission.reconcile(reservation, {
          kind: "succeeded",
          response,
          servedEndpointId: violation ? null : ep.id,
          ...(violation ? { policyViolation: violation } : {}),
        });
      } finally {
        this.health.capacity.release(slot);
      }
      if (violation) {
        attempts.push({ endpointId: ep.id, outcome: "policy_violation" });
        throw Object.assign(new GatewayError("policy_violation", `${violation}; response discarded and ${ep.id} quarantined`), { attempts });
      }
      attempts.push({ endpointId: ep.id, outcome: "succeeded" });
      return { requestId: reservation.requestId, response, endpoint: ep, attempts, estimatedInputTokens: estInput };
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
      throw Object.assign(new AdmissionDenied(allTooLarge ? "context_does_not_fit" : paidOnly ? "paid_budget_exhausted" : "no_eligible_endpoint", reasons.join("; ")), { attempts });
    }
    throw Object.assign(lastCapacityError ?? new GatewayError("pool_exhausted", "all candidate models failed"), { attempts });
  }
}
