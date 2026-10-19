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

    const totalWeight = req.participants.reduce((s, p) => s + (p.weight ?? 1), 0);
    const participants: Participant[] = req.participants.map((p) => ({
      taskId: p.taskId,
      leaseOwner: p.leaseOwner,
      budget: p.budget,
      estInputTokens: Math.ceil((estInput * (p.weight ?? 1)) / totalWeight),
      reservedOutputTokens: Math.ceil((req.chat.max_tokens * (p.weight ?? 1)) / totalWeight),
    }));

    for (const ep of req.plan.candidates) {
      if (dispatched >= this.cfg.routing.max_endpoint_fallbacks) break;
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

    if (dispatched === 0) {
      const reasons = attempts.length ? attempts.map((a) => `${a.endpointId}: ${a.outcome}`) : ["no eligible model for this task type and tier"];
      const allTooLarge = attempts.length > 0 && attempts.every((a) => a.outcome.startsWith("skipped (too large)"));
      throw Object.assign(new AdmissionDenied(allTooLarge ? "context_does_not_fit" : "no_eligible_endpoint", reasons.join("; ")), { attempts });
    }
    throw Object.assign(lastCapacityError ?? new GatewayError("pool_exhausted", "all candidate models failed"), { attempts });
  }
}
