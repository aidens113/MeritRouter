import { statSync } from "node:fs";
import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName } from "../config/schema.js";
import { Admission, type Participant } from "../admission/admission.js";
import { AdmissionDenied, GatewayError } from "../core/errors.js";
import { assessPool, requestFit, type PoolAssessment } from "../models/eligibility.js";
import { findServedEndpoints } from "../models/catalog.js";
import type { ChatRequest, ChatResponse, InferenceClient } from "./types.js";
import { estimateTokens } from "./types.js";
import type { PoolVerifier } from "../models/pool-verify.js";

export interface GateRequest {
  profile: ProfileName;
  executionId: string;
  purpose: string;
  /** Participants with their share of the physical request (one for ordinary tasks). */
  participants: Array<Omit<Participant, "estInputTokens" | "reservedOutputTokens"> & { weight?: number }>;
  chat: Omit<ChatRequest, "model">;
  needsImages?: boolean;
  signal?: AbortSignal;
}

export interface GateResponse {
  requestId: string;
  response: ChatResponse;
  servedEndpointId: string;
  estimatedInputTokens: number;
}

/**
 * The single path for every model request the package makes: pool eligibility, request fit,
 * atomic admission, dispatch to the gateway, served-model verification, and reconciliation.
 */
export class Gate {
  readonly admission: Admission;

  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly client: InferenceClient,
    admission: Admission,
    private readonly verifier: PoolVerifier | null,
    private readonly now: () => number = Date.now,
  ) {
    this.admission = admission;
  }

  pool(profile: ProfileName): PoolAssessment {
    const p = this.cfg.profiles[profile];
    if (!p) throw new AdmissionDenied("no_eligible_endpoint", `profile ${profile} is not configured`);
    const assessment = assessPool(this.cfg.catalog, profile, p, {
      now: new Date(this.now()),
      maxMetadataAgeDays: this.cfg.models.max_metadata_age_days,
      paidRoutingAllowed: this.cfg.spend.paid_fallback_enabled,
    });
    const quarantine = this.quarantineReason(p.gateway_model);
    if (quarantine) {
      return { ...assessment, routable: false, violations: [...assessment.violations, { endpointId: "<pool>", reasons: [quarantine] }] };
    }
    return assessment;
  }

  /**
   * A served-model policy violation quarantines the pool until the catalog file changes
   * (the operator must fix the gateway chain and re-verify the catalog).
   */
  private quarantineReason(gatewayModel: string): string | null {
    let catalogMtime = 0;
    try {
      catalogMtime = statSync(this.cfg.catalog.sourcePath).mtimeMs;
    } catch {
      // In-memory catalogs (tests) have no file; any violation quarantines.
    }
    const row = this.db
      .prepare(
        "SELECT served_model, policy_violation FROM model_requests WHERE gateway_model = ? AND policy_violation IS NOT NULL AND reserved_at > ? ORDER BY reserved_at DESC LIMIT 1",
      )
      .get(gatewayModel, catalogMtime) as { served_model: string | null; policy_violation: string } | undefined;
    return row ? `quarantined after policy violation: ${row.policy_violation}` : null;
  }

  async request(req: GateRequest): Promise<GateResponse> {
    const pool = this.pool(req.profile);
    if (pool.routable && this.verifier) {
      const denial = await this.verifier.ensureVerified(req.profile);
      if (denial) throw new AdmissionDenied("no_eligible_endpoint", denial);
    }
    const estInput = estimateTokens(req.chat.messages, req.chat.tools);
    const reasons = requestFit(pool, {
      inputTokens: estInput,
      outputTokens: req.chat.max_tokens,
      needsTools: Boolean(req.chat.tools?.length),
      needsImages: req.needsImages ?? false,
      needsStructuredOutput: req.chat.response_format?.type === "json_schema",
    });
    if (reasons.length) {
      const reason = pool.routable ? "context_does_not_fit" : "no_eligible_endpoint";
      throw new AdmissionDenied(reason, reasons.join("; "));
    }

    const totalWeight = req.participants.reduce((s, p) => s + (p.weight ?? 1), 0);
    const participants: Participant[] = req.participants.map((p) => ({
      taskId: p.taskId,
      leaseOwner: p.leaseOwner,
      budget: p.budget,
      estInputTokens: Math.ceil((estInput * (p.weight ?? 1)) / totalWeight),
      reservedOutputTokens: Math.ceil((req.chat.max_tokens * (p.weight ?? 1)) / totalWeight),
    }));
    const reservation = this.admission.reserve({
      executionId: req.executionId,
      profile: req.profile,
      purpose: req.purpose,
      gatewayModel: pool.gatewayModel,
      estInputTokens: estInput,
      reservedOutputTokens: req.chat.max_tokens,
      participants,
    });

    let response: ChatResponse;
    try {
      response = await this.client.complete({ ...req.chat, model: pool.gatewayModel }, req.signal);
    } catch (err) {
      const ge =
        err instanceof GatewayError ? err : new GatewayError("transport", (err as Error).message ?? String(err), undefined, undefined, true);
      this.admission.reconcile(reservation, {
        kind: ge.possiblyConsumed ? "uncertain" : "failed",
        ...(ge.status !== undefined ? { httpStatus: ge.status } : {}),
        errorKind: ge.kind,
        errorMessage: ge.message,
      });
      throw ge;
    }

    const served = response.telemetry.servedModel;
    const provider = response.telemetry.servedProvider;
    const matches = served ? findServedEndpoints(this.cfg.catalog, provider, served) : [];
    const endpoint = matches[0];
    let violation: string | undefined;
    if (!served) violation = "gateway did not report the served model";
    else if (matches.length === 0) violation = `served route ${provider ?? "?"}/${served} is not in the endpoint catalog`;
    else {
      const unapproved = matches.filter((m) => !pool.members.some((p) => p.id === m.id));
      if (unapproved.length) {
        violation = `served route ${provider ?? "?"}/${served} maps to endpoint(s) not approved for ${req.profile}: ${unapproved.map((u) => u.id).join(", ")}`;
      }
    }
    this.admission.reconcile(reservation, {
      kind: "succeeded",
      response,
      servedEndpointId: endpoint?.id ?? null,
      ...(violation ? { policyViolation: violation } : {}),
    });
    if (violation) {
      throw new GatewayError("policy_violation", `${violation}; response discarded and pool ${pool.gatewayModel} quarantined`);
    }
    return { requestId: reservation.requestId, response, servedEndpointId: endpoint!.id, estimatedInputTokens: estInput };
  }
}
