import type { ResolvedConfig } from "../config/load.js";
import type { Modality, ProfileName, TierName } from "../config/schema.js";
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
  opts: { now: Date; allowBelowFloor: boolean; qualification: ReturnType<QualificationLookup> },
): string[] {
  const reasons: string[] = [];
  const profile = cfg.profiles[req.profile]!;
  if (ep.status !== "active") reasons.push(ep.statusReason ?? `status is ${ep.status}`);
  if (!ep.available) reasons.push("FreeLLMAPI reports it unavailable (no key or disabled)");
  if (ep.deniedProfiles.includes(req.profile)) reasons.push(`blocked for ${req.profile} tasks by an override`);
  const floor = sizeFloor(cfg, req.profile, req.tier);
  if (ep.totalParametersB !== null && ep.totalParametersB < floor && !opts.allowBelowFloor) {
    reasons.push(`${ep.totalParametersB}B is below the ${floor}B floor for ${req.profile}/${req.tier}`);
  }
  const free = ep.pricing.freeVerified && (ep.pricing.inputUsdPerMillion ?? 0) === 0 && (ep.pricing.outputUsdPerMillion ?? 0) === 0;
  if (!free && !cfg.spend.paid_fallback_enabled) reasons.push("not verified free (paid routing is off)");
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
  deps: { now: Date; qualification: QualificationLookup; health?: ProviderHealthLookup },
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

  const explanations: CandidateExplanation[] = [];
  const eligible: Array<{ ep: ModelEndpoint; ex: CandidateExplanation }> = [];
  for (const ep of endpoints) {
    const qual = deps.qualification(ep.id, req.profile, req.tier);
    const reasons = endpointExclusions(ep, cfg, req, { now: deps.now, allowBelowFloor: belowFloor.has(ep.id), qualification: qual });
    if (blockIds.has(ep.id)) reasons.push(`blocked by routing override for ${req.profile}/${req.tier}`);
    if (forced && !forceIds.has(ep.id)) reasons.push("another model is forced for this task type/tier");
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
  eligible.sort((a, b) => {
    const pa = forced ? 0 : preferIds.indexOf(a.ep.id);
    const pb = forced ? 0 : preferIds.indexOf(b.ep.id);
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0 && pb >= 0 && pa !== pb) return pa - pb;
    const ca = a.ex.coolingDownUntil !== null ? 1 : 0;
    const cb = b.ex.coolingDownUntil !== null ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const sa = a.ep.totalParametersB ?? 0;
    const sb = b.ep.totalParametersB ?? 0;
    if (prefer === "smallest_sufficient") return sa - sb || score(b.ep.id) - score(a.ep.id) || a.ep.id.localeCompare(b.ep.id);
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
