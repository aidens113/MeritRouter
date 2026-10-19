import type { ResolvedConfig } from "../config/load.js";
import type { Modality, PaidPolicy, ProfileName, TierName } from "../config/schema.js";
import type { ModelEndpoint, RoutingOverride } from "../models/catalog.js";

export interface RouteRequirements {
  profile: ProfileName;
  tier: TierName;
  inputModalities: Modality[];
  needsStructuredOutput: boolean;
  /** Per-task forced endpoint (supervisor `routing.endpointId`). Cannot bypass size floors. */
  forcedEndpointId?: string;
  /** Qualification runs evaluate models that are not yet qualified. */
  skipQualification?: boolean;
  /** Paid policy for this request; defaults to paid.tiers[tier]. Roles (supervisor) override it. */
  paidPolicy?: PaidPolicy;
}

/** A model costs money when it is not verified free (direct paid routes always are). */
export function isPaid(ep: ModelEndpoint): boolean {
  if (ep.route.kind === "direct") return true;
  return !(ep.pricing.freeVerified && (ep.pricing.inputUsdPerMillion ?? 0) === 0 && (ep.pricing.outputUsdPerMillion ?? 0) === 0);
}

export function paidPolicyFor(cfg: ResolvedConfig, req: RouteRequirements): PaidPolicy {
  if (!cfg.paid.enabled) return "never";
  return req.paidPolicy ?? cfg.paid.tiers[req.tier];
}

export interface QualificationLookup {
  /** Pass rate and trial count for (endpoint, task family, tier), or null when unqualified. */
  (endpointId: string, profile: ProfileName, tier: TierName): { passRate: number; trials: number; qualified: boolean } | null;
}

export interface ProviderHealthLookup {
  (platform: string): { status: string; resumeAt: number | null } | undefined;
}

export interface CandidateExplanation {
  endpointId: string;
  displayName: string;
  totalParametersB: number | null;
  eligible: boolean;
  /** Plain-language reasons the model is excluded (empty when eligible). */
  reasons: string[];
  /** Why it is where it is in the order. */
  via: "forced" | "preferred" | "automatic" | null;
  rank: number | null;
  qualification: { passRate: number; trials: number; qualified: boolean } | null;
  coolingDownUntil: number | null;
  belowFloorAllowed: boolean;
}

export interface RoutePlan {
  profile: ProfileName;
  tier: TierName;
  floorB: number;
  candidates: ModelEndpoint[];
  explanations: CandidateExplanation[];
  /** Set when a force override applies; only forced models are candidates. */
  forced: boolean;
  belowFloorEndpoints: Set<string>;
}

function overrideApplies(o: RoutingOverride, profile: ProfileName, tier: TierName): boolean {
  return o.enabled && (o.profile === null || o.profile === profile) && (o.tier === null || o.tier === tier);
}

export function sizeFloor(cfg: ResolvedConfig, profile: ProfileName, tier: TierName): number {
  return Math.max(cfg.profiles[profile]!.min_total_parameters_b, cfg.tiers[tier].min_total_parameters_b);
}

/** Checks independent of request size. Returns plain-language exclusion reasons. */
export function endpointExclusions(
  ep: ModelEndpoint,
  cfg: ResolvedConfig,
  req: RouteRequirements,
  opts: { now: Date; allowBelowFloor: boolean; qualification: ReturnType<QualificationLookup>; paidPlatforms?: Set<string> },
): string[] {
  const reasons: string[] = [];
  const profile = cfg.profiles[req.profile]!;
  if (ep.status !== "active") reasons.push(ep.statusReason ?? `status is ${ep.status}`);
  if (!ep.available && ep.status === "active") reasons.push(ep.route.kind === "direct" ? "no enabled paid key for this provider" : "FreeLLMAPI reports it unavailable (no key or disabled)");
  if (ep.deniedProfiles.includes(req.profile)) reasons.push(`blocked for ${req.profile} tasks by an override`);
  const floor = sizeFloor(cfg, req.profile, req.tier);
  if (ep.totalParametersB !== null && ep.totalParametersB < floor && !opts.allowBelowFloor && !ep.ignoreSizeFloor) {
    reasons.push(`${ep.totalParametersB}B is below the ${floor}B floor for ${req.profile}/${req.tier}`);
  }
  if (ep.route.kind === "chain") {
    // FreeLLMAPI is the free network only: anything not verified free is excluded there.
    if (isPaid(ep)) reasons.push("not verified free (FreeLLMAPI routes are free-only; add paid models under paid.models)");
    if (opts.paidPlatforms?.has(ep.providerId)) reasons.push(`a FreeLLMAPI key on ${ep.providerId} is marked paid, so free routing could bill it`);
  } else {
    const policy = paidPolicyFor(cfg, req);
    if (!cfg.paid.enabled) reasons.push("paid routing is disabled (paid.enabled)");
    else if (policy === "never") reasons.push(`paid models are not allowed for ${req.tier} (paid.tiers.${req.tier} = never)`);
    if (ep.pricing.inputUsdPerMillion === null || ep.pricing.outputUsdPerMillion === null) reasons.push("price unknown: set it in paid.models or a pricing_url");
  }
  const ageDays = (opts.now.getTime() - Date.parse(ep.checkedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > cfg.models.max_metadata_age_days) {
    reasons.push(`metadata is ${Math.floor(ageDays)} days old (limit ${cfg.models.max_metadata_age_days}); rescan`);
  }
  if (ep.contextLimitTokens === null) reasons.push("context limit unknown");
  if (ep.outputLimitTokens === null) reasons.push("output limit unknown");
  for (const m of req.inputModalities) if (!ep.inputModalities.includes(m)) reasons.push(`cannot read ${m} input`);
  if (profile.mode !== "completion" && !ep.supportsTools) reasons.push("no tool calling (required for repository work)");
  if ((req.needsStructuredOutput || profile.requires_structured_output) && !ep.supportsStructuredOutput) reasons.push("no structured output");
  if (cfg.qualification.required && !req.skipQualification && !opts.qualification?.qualified) {
    reasons.push(opts.qualification ? `not qualified for ${req.profile}/${req.tier} (pass rate ${(opts.qualification.passRate * 100).toFixed(0)}% over ${opts.qualification.trials} trials)` : `not yet qualified for ${req.profile}/${req.tier}`);
  }
  return reasons;
}

/**
 * Build the ordered candidate list for a task. Order: forced models only (if any force override
 * applies), else preferred models first, then automatic order by the tier's preference.
 * Platforms FreeLLMAPI reports as cooling down move to the end.
 */
export function planRoute(
  cfg: ResolvedConfig,
  endpoints: ModelEndpoint[],
  overrides: RoutingOverride[],
  req: RouteRequirements,
  deps: { now: Date; qualification: QualificationLookup; health?: ProviderHealthLookup; paidPlatforms?: Set<string>; quarantined?: (ep: ModelEndpoint) => string | null },
): RoutePlan {
  const applicable = overrides.filter((o) => overrideApplies(o, req.profile, req.tier));
  const forceIds = new Set<string>(applicable.filter((o) => o.kind === "force").map((o) => o.endpointId));
  if (req.forcedEndpointId) {
    forceIds.clear();
    forceIds.add(req.forcedEndpointId);
  }
  const belowFloor = new Set(
    applicable.filter((o) => o.kind === "force" && o.allowBelowFloor && !req.forcedEndpointId).map((o) => o.endpointId),
  );
  const preferIds = applicable.filter((o) => o.kind === "prefer").map((o) => o.endpointId);
  const blockIds = new Set(applicable.filter((o) => o.kind === "block").map((o) => o.endpointId));
  const forced = forceIds.size > 0;
  const prefer = cfg.tiers[req.tier].prefer;
  const policy = paidPolicyFor(cfg, req);

  const explanations: CandidateExplanation[] = [];
  const eligible: Array<{ ep: ModelEndpoint; ex: CandidateExplanation }> = [];
  for (const ep of endpoints) {
    const qual = deps.qualification(ep.id, req.profile, req.tier);
    const reasons = endpointExclusions(ep, cfg, req, {
      now: deps.now,
      allowBelowFloor: belowFloor.has(ep.id),
      qualification: qual,
      ...(deps.paidPlatforms ? { paidPlatforms: deps.paidPlatforms } : {}),
    });
    if (blockIds.has(ep.id)) reasons.push(`blocked by routing override for ${req.profile}/${req.tier}`);
    const q = deps.quarantined?.(ep);
    if (q) reasons.push(q);
    if (forced && !forceIds.has(ep.id)) reasons.push("another model is forced for this task type/tier");
    if (policy === "premium" && !isPaid(ep) && !forced) reasons.push("premium routing uses paid models only");
    const h = deps.health?.(ep.providerId);
    const cooling = h?.status === "rate_limited" && cfg.routing.respect_provider_cooldowns ? (h.resumeAt ?? Date.now() + 60_000) : null;
    const ex: CandidateExplanation = {
      endpointId: ep.id,
      displayName: ep.displayName ?? ep.gatewayModelId,
      totalParametersB: ep.totalParametersB,
      eligible: reasons.length === 0,
      reasons,
      via: null,
      rank: null,
      qualification: qual,
      coolingDownUntil: cooling,
      belowFloorAllowed: belowFloor.has(ep.id),
    };
    explanations.push(ex);
    if (ex.eligible) eligible.push({ ep, ex });
  }

  const score = (id: string) => deps.qualification(id, req.profile, req.tier)?.passRate ?? 0;
  // Paid models go after free ones unless the policy prefers them.
  const paidRank = (ep: ModelEndpoint) => (isPaid(ep) ? (policy === "preferred" ? 0 : 1) : policy === "preferred" ? 1 : 0);
  eligible.sort((a, b) => {
    const pa = forced ? 0 : preferIds.indexOf(a.ep.id);
    const pb = forced ? 0 : preferIds.indexOf(b.ep.id);
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0 && pb >= 0 && pa !== pb) return pa - pb;
    const ra = paidRank(a.ep);
    const rb = paidRank(b.ep);
    if (ra !== rb) return ra - rb;
    const ca = a.ex.coolingDownUntil !== null ? 1 : 0;
    const cb = b.ex.coolingDownUntil !== null ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const sa = a.ep.totalParametersB ?? (a.ep.ignoreSizeFloor ? 1e6 : 0);
    const sb = b.ep.totalParametersB ?? (b.ep.ignoreSizeFloor ? 1e6 : 0);
    if (prefer === "smallest_sufficient") {
      // Among paid models, cheaper first; among free models, smaller first.
      if (isPaid(a.ep) && isPaid(b.ep)) return (a.ep.pricing.outputUsdPerMillion ?? 0) - (b.ep.pricing.outputUsdPerMillion ?? 0) || a.ep.id.localeCompare(b.ep.id);
      return sa - sb || score(b.ep.id) - score(a.ep.id) || a.ep.id.localeCompare(b.ep.id);
    }
    return score(b.ep.id) - score(a.ep.id) || sb - sa || a.ep.id.localeCompare(b.ep.id);
  });
  eligible.forEach((e, i) => {
    e.ex.rank = i + 1;
    e.ex.via = forced ? "forced" : preferIds.includes(e.ep.id) ? "preferred" : "automatic";
  });
  explanations.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.endpointId.localeCompare(b.endpointId));
  return {
    profile: req.profile,
    tier: req.tier,
    floorB: sizeFloor(cfg, req.profile, req.tier),
    candidates: eligible.map((e) => e.ep),
    explanations,
    forced,
    belowFloorEndpoints: belowFloor,
  };
}

/** Request-size fit for one endpoint. */
export function fitsEndpoint(ep: ModelEndpoint, inputTokens: number, outputTokens: number): string | null {
  if (ep.outputLimitTokens !== null && outputTokens > ep.outputLimitTokens) return `output ${outputTokens} exceeds ${ep.outputLimitTokens}`;
  if (ep.contextLimitTokens !== null && inputTokens + outputTokens > ep.contextLimitTokens) {
    return `~${inputTokens} input + ${outputTokens} output exceeds context ${ep.contextLimitTokens}`;
  }
  return null;
}

/** Smallest limits across the first N candidates, so a request can fall back among them. */
export function planLimits(plan: RoutePlan, n: number): { contextLimitTokens: number; outputLimitTokens: number } {
  const top = plan.candidates.slice(0, Math.max(1, n));
  if (top.length === 0) return { contextLimitTokens: 0, outputLimitTokens: 0 };
  return {
    contextLimitTokens: Math.min(...top.map((c) => c.contextLimitTokens ?? 0)),
    outputLimitTokens: Math.min(...top.map((c) => c.outputLimitTokens ?? 0)),
  };
}
