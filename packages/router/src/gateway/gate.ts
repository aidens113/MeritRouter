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
import type { DirectClient } from "../paid/direct.js";
import type { KeyVault } from "../paid/vault.js";
import { worstCaseUsd, type PaidSpend } from "../paid/spend.js";

export interface PaidRuntime {
  vault: KeyVault;
  spend: PaidSpend;
  client: DirectClient;
}

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

/** Gateway errors after which trying the next ranked model is reasonable. */
const FALLBACK_KINDS = new Set(["rate_limited", "pool_exhausted", "server", "timeout", "transport", "bad_request"]);

/** Cached GET /v1/providers so route ordering can skip platforms that are cooling down. */
export class ProviderHealth {
  private cache: { at: number; byPlatform: Map<string, ProviderStatus> } | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly client: InferenceClient,
    private readonly now: () => number = Date.now,
  ) {}

  lookup = (platform: string): { status: string; resumeAt: number | null } | undefined => {
    const s = this.cache?.byPlatform.get(platform);
    if (!s) return undefined;
    if (s.status === "rate_limited" && s.resumeAt !== null && s.resumeAt <= this.now()) return undefined;
    return { status: s.status, resumeAt: s.resumeAt };
  };

  async refresh(maxAgeMs = 30_000): Promise<void> {
    if (!this.client.providers) return;
    if (this.cache && this.now() - this.cache.at < maxAgeMs) return;
    this.inflight ??= this.client
      .providers()
      .then((list) => {
        this.cache = { at: this.now(), byPlatform: new Map(list.map((p) => [p.platform, p])) };
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
    return [...(this.cache?.byPlatform.values() ?? [])];
  }
}

/**
 * The single path for every model request: per-endpoint fit, chain verification, atomic
 * admission (one reservation per attempt), dispatch to that endpoint's single-model chain,
 * served-model verification, and reconciliation. Falls back across ranked endpoints only for
 * capacity-type failures, up to routing.max_endpoint_fallbacks dispatched attempts.
 */
export class Gate {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly client: InferenceClient,
    readonly admission: Admission,
    private readonly chains: ChainManager,
    readonly health: ProviderHealth,
    readonly paid: PaidRuntime | null = null,
  ) {}

  /** An endpoint with a served-model violation stays blocked until its chain is re-verified. */
  quarantined(ep: ModelEndpoint): string | null {
    const last = this.chains.latest(ep.chainName);
    const since = last?.ok ? last.verifiedAt : 0;
    const row = this.db
      .prepare("SELECT policy_violation FROM model_requests WHERE endpoint_id = ? AND policy_violation IS NOT NULL AND reserved_at > ? ORDER BY reserved_at DESC LIMIT 1")
      .get(ep.id, since) as { policy_violation: string } | undefined;
    return row ? `quarantined after a policy violation: ${row.policy_violation}` : null;
  }

  async request(req: GateRequest): Promise<GateResponse> {
    const estInput = estimateTokens(req.chat.messages, req.chat.tools);
    const attempts: GateAttempt[] = [];
    let lastCapacityError: GatewayError | null = null;
    let dispatched = 0;
    let dispatchedPaid = 0;

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
      // Free and paid attempts are limited separately: free fallbacks never use up paid slots.
      if (direct ? dispatchedPaid >= this.cfg.paid.max_paid_attempts : dispatched >= this.cfg.routing.max_endpoint_fallbacks) continue;
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
        const r = await this.requestDirect(ep, req, participants, estInput, attempts);
        if (r === "skip") continue;
        dispatchedPaid++;
        if (r instanceof GatewayError) {
          lastCapacityError = r;
          continue;
        }
        return { requestId: r.requestId, response: r.response, endpoint: ep, attempts, estimatedInputTokens: estInput };
      }
      const unverified = await this.chains.ensureVerified(ep);
      if (unverified) {
        attempts.push({ endpointId: ep.id, outcome: `skipped: ${unverified}` });
        continue;
      }

      const reservation = this.admission.reserve({
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
      dispatched++;
      const chat: ChatRequest = { ...req.chat, model: `auto:${ep.chainName}` };
      if (!ep.supportsStructuredOutput) delete chat.response_format;

      let response: ChatResponse;
      try {
        response = await this.client.complete(chat, req.signal);
      } catch (err) {
        const ge = err instanceof GatewayError ? err : new GatewayError("transport", (err as Error).message ?? String(err), undefined, undefined, true);
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

      const t = response.telemetry;
      let violation: string | undefined;
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
      if (violation) {
        attempts.push({ endpointId: ep.id, outcome: "policy_violation" });
        throw Object.assign(new GatewayError("policy_violation", `${violation}; response discarded and ${ep.id} quarantined`), { attempts });
      }
      attempts.push({ endpointId: ep.id, outcome: "succeeded" });
      return { requestId: reservation.requestId, response, endpoint: ep, attempts, estimatedInputTokens: estInput };
    }

    if (dispatched === 0 && dispatchedPaid === 0) {
      const reasons = attempts.length ? attempts.map((a) => `${a.endpointId}: ${a.outcome}`) : ["no eligible model for this task type and tier"];
      const allTooLarge = attempts.length > 0 && attempts.every((a) => a.outcome.startsWith("skipped (too large)"));
      const paidOnly = attempts.length > 0 && attempts.every((a) => a.outcome.startsWith("skipped (paid budget)"));
      throw Object.assign(new AdmissionDenied(allTooLarge ? "context_does_not_fit" : paidOnly ? "paid_budget_exhausted" : "no_eligible_endpoint", reasons.join("; ")), { attempts });
    }
    throw Object.assign(lastCapacityError ?? new GatewayError("pool_exhausted", "all candidate models failed"), { attempts });
  }

  /**
   * One direct paid attempt: pick a key with headroom, reserve the worst-case cost with the
   * request, call the provider once, verify the served model, and settle the cost.
   */
  private async requestDirect(
    ep: ModelEndpoint,
    req: GateRequest,
    participants: Participant[],
    estInput: number,
    attempts: GateAttempt[],
  ): Promise<"skip" | GatewayError | { requestId: string; response: ChatResponse }> {
    const route = ep.route as { kind: "direct"; provider: string; model: string };
    const provider = this.cfg.paid.providers[route.provider];
    if (!this.paid || !provider) {
      attempts.push({ endpointId: ep.id, outcome: "skipped: paid runtime unavailable" });
      return "skip";
    }
    const price = { in: ep.pricing.inputUsdPerMillion ?? Infinity, out: ep.pricing.outputUsdPerMillion ?? Infinity };
    const worst = worstCaseUsd(estInput, req.chat.max_tokens, price);
    const key = this.paid.spend.pickKey(route.provider, worst);
    if (!key) {
      attempts.push({ endpointId: ep.id, outcome: `skipped (paid budget): no ${route.provider} key with $${worst.toFixed(4)} headroom` });
      return "skip";
    }
    let reservation;
    try {
      reservation = this.admission.reserve({
        executionId: req.executionId,
        profile: req.plan.profile,
        purpose: req.purpose,
        gatewayModel: `direct:${route.provider}/${route.model}`,
        endpointId: ep.id,
        tier: req.plan.tier,
        routeNote: `paid via key ${key.label || key.id}; worst case $${worst.toFixed(4)}`,
        estInputTokens: estInput,
        reservedOutputTokens: req.chat.max_tokens,
        participants,
        paid: { spend: this.paid.spend, keyId: key.id, provider: route.provider, worstCaseUsd: worst, price },
      });
    } catch (err) {
      if (err instanceof AdmissionDenied && err.reason === "paid_budget_exhausted") {
        attempts.push({ endpointId: ep.id, outcome: `skipped (paid budget): ${err.message}` });
        return "skip";
      }
      throw err;
    }
    const chat = { ...req.chat };
    if (!ep.supportsStructuredOutput) delete chat.response_format;
    let response: ChatResponse;
    try {
      response = await this.paid.client.complete({
        providerName: route.provider,
        provider,
        apiKey: this.paid.vault.secret(key.id),
        model: route.model,
        chat,
        timeoutMs: this.cfg.gateway.request_timeout_seconds * 1000,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      const ge = err instanceof GatewayError ? err : new GatewayError("transport", (err as Error).message ?? String(err), undefined, undefined, true);
      this.admission.reconcile(reservation, { kind: ge.possiblyConsumed ? "uncertain" : "failed", ...(ge.status !== undefined ? { httpStatus: ge.status } : {}), errorKind: ge.kind, errorMessage: ge.message });
      attempts.push({ endpointId: ep.id, outcome: ge.kind });
      if (req.signal?.aborted || ge.kind === "aborted") throw Object.assign(ge, { attempts });
      if (FALLBACK_KINDS.has(ge.kind)) return ge;
      throw Object.assign(ge, { attempts });
    }
    // Providers often report a dated variant of the requested model id.
    const served = response.telemetry.servedModel;
    const violation =
      served && served !== route.model && !served.startsWith(`${route.model}-`) && !served.endsWith(`/${route.model}`)
        ? `requested ${route.model} but ${route.provider} served ${served}`
        : undefined;
    this.admission.reconcile(reservation, { kind: "succeeded", response, servedEndpointId: violation ? null : ep.id, ...(violation ? { policyViolation: violation } : {}) });
    if (violation) {
      attempts.push({ endpointId: ep.id, outcome: "policy_violation" });
      throw Object.assign(new GatewayError("policy_violation", `${violation}; response discarded and ${ep.id} quarantined`), { attempts });
    }
    attempts.push({ endpointId: ep.id, outcome: "succeeded" });
    return { requestId: reservation.requestId, response };
  }
}
