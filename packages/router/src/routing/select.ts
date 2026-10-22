import type { ResolvedConfig } from "../config/load.js";
import type { Modality, PaidPolicy, ProfileName, TierName } from "../config/schema.js";
import type { ModelEndpoint, RoutingOverride } from "../models/catalog.js";
import { alwaysSearches, nativeSearchUse, type NativeSearchUse } from "./native-search.js";

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
  /** Endpoints that may not serve this request (a reviewer never reviews work it served). */
  avoidEndpoints?: string[];
  /** Model families and platforms ranked after the others (independence: prefer a different lineage). */
  avoidFamilies?: string[];
  avoidProviders?: string[];
  /** Raises the size floor (a verification level's reviewer floor). */
  minTotalParametersB?: number;
  /**
   * Reviewer qualification, kept separate from worker qualification: it replaces the
   * qualification.required check. required: unqualified reviewers are excluded; preferred:
   * qualified reviewers are ranked first.
   */
  reviewer?: ReviewerQualificationRequirement;
  /**
   * The task's `hints.web`: true prefers models whose provider searches inside the call (and
   * turns that search on); false excludes models that always search. Unset: neither.
   */
  web?: boolean;
}

export interface ReviewerQualificationRequirement {
  /** Qualification family (review) and the tier its evaluations count from. */
  family: string;
  tier: TierName;
  /** Pass rate needed (qualification.pass_threshold, or the review_strict threshold). */
  threshold: number;
  mode: "preferred" | "required";
  /** Name shown in reasons and records (review, review_strict). */
  name: string;
}

/**
 * A model's lineage, for reviewer independence: the first word of the model name without its
 * organisation prefix ("meta-llama/llama-3.3-70b" -> "llama", "qwen/qwen3-235b" -> "qwen").
 */
export function modelFamily(ep: Pick<ModelEndpoint, "gatewayModelId" | "providerModelId">): string {
  const name = (ep.providerModelId ?? ep.gatewayModelId).toLowerCase().split("/").pop()!.replace(/^meta-/, "");
  return /^[a-z]+/.exec(name)?.[0] ?? name;
}

/**
 * A model costs money unless it is verified free at $0. A free endpoint stays free at dispatch
 * because the gate serves it only through keys that cannot be charged (see `freeKeyOnly`); a
 * priced one obeys the paid policy, budgets, and spend tracking.
 */
export function isPaid(ep: Pick<ModelEndpoint, "pricing">): boolean {
  return !(ep.pricing.freeVerified && (ep.pricing.inputUsdPerMillion ?? 0) === 0 && (ep.pricing.outputUsdPerMillion ?? 0) === 0);
}

/**
 * Whether a free endpoint may only use `free_tier` keys: it is free because a free key serves it
 * (`freeBasis: key`, or unrecorded), not because the model itself is `:free` or $0. Any other
 * key would bill it at a price nobody recorded.
 */
export function freeKeyOnly(ep: Pick<ModelEndpoint, "pricing" | "route">): boolean {
  if (isPaid(ep)) return false;
  if (ep.pricing.freeBasis === "model") return false;
  return ep.pricing.freeBasis === "key" || !/:free$/.test(ep.route.model);
}

export function paidPolicyFor(cfg: ResolvedConfig, req: Pick<RouteRequirements, "paidPolicy" | "tier">): PaidPolicy {
  if (!cfg.paid.enabled) return "never";
  return req.paidPolicy ?? cfg.paid.tiers[req.tier];
}

/** The native search one request to `ep` runs under this plan (null: none). */
export function planSearch(ep: Pick<ModelEndpoint, "nativeWebSearch">, cfg: ResolvedConfig, plan: Pick<RoutePlan, "web" | "paidPolicy" | "tier">): NativeSearchUse | null {
  const policy = plan.paidPolicy ?? paidPolicyFor(cfg, { tier: plan.tier });
  return nativeSearchUse(ep, cfg, { web: plan.web, paidAllowed: cfg.paid.enabled && policy !== "never" });
}

/**
 * A request to `ep` under this plan costs money: the model is priced, or the native search it
 * runs is (a positive or unknown price per search).
 */
export function requestPaid(ep: Pick<ModelEndpoint, "pricing" | "nativeWebSearch">, cfg: ResolvedConfig, plan: Pick<RoutePlan, "web" | "paidPolicy" | "tier">): boolean {
  return isPaid(ep) || (planSearch(ep, cfg, plan)?.charged ?? false);
}

export interface QualificationLookup {
  /**
   * Pass rate and trial count for (endpoint, task family, tier), or null when unqualified. With
   * `family`, that family (e.g. review) at its tier and threshold instead of the profile's.
   */
  (endpointId: string, profile: ProfileName, tier: TierName, family?: { family: string; tier: TierName; threshold: number }): { passRate: number; trials: number; qualified: boolean } | null;
}

export interface ProviderHealthLookup {
  /** A reported cooldown, and `circuitOpenUntil` while the platform's circuit breaker is open. */
  (platform: string): { status: string; resumeAt: number | null; circuitOpenUntil?: number | null } | undefined;
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
  /** Set while the platform's circuit breaker is open: ranked after cooling platforms, skipped by the gate. */
  circuitOpenUntil: number | null;
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
  /** The task's `hints.web` (see `RouteRequirements.web`); unset in plans built elsewhere. */
  web?: boolean | null;
  /** The paid policy the plan was built under (decides whether a priced native search may run). */
  paidPolicy?: PaidPolicy;
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
  if (!ep.available && ep.status === "active") reasons.push("no enabled key for this provider");
  if (ep.deniedProfiles.includes(req.profile)) reasons.push(`blocked for ${req.profile} tasks by an override`);
  const floor = Math.max(sizeFloor(cfg, req.profile, req.tier), req.minTotalParametersB ?? 0);
  if (ep.totalParametersB !== null && ep.totalParametersB < floor && !opts.allowBelowFloor && !ep.ignoreSizeFloor) {
    reasons.push(`${ep.totalParametersB}B is below the ${floor}B floor for ${req.profile}/${req.tier}`);
  }
  // A model that searches on every request: its answers are web content, and a priced search makes every request paid.
  const always = alwaysSearches(ep);
  if (always && req.web === false) reasons.push("searches the web on every request (always_on); this task must not touch the web (hints.web: false)");
  const searchCharged = always && ep.nativeWebSearch!.usdPerSearch !== 0;
  if (isPaid(ep) || searchCharged) {
    const policy = paidPolicyFor(cfg, req);
    if (!cfg.paid.enabled) reasons.push(isPaid(ep) ? "paid routing is disabled (paid.enabled)" : "paid routing is disabled (paid.enabled) and its web search on every request is priced");
    else if (policy === "never") reasons.push(`paid models are not allowed for ${req.tier} (paid.tiers.${req.tier} = never)`);
    if (isPaid(ep) && (ep.pricing.inputUsdPerMillion === null || ep.pricing.outputUsdPerMillion === null)) reasons.push("price unknown: set it in paid.models or a pricing_url");
    if (searchCharged && ep.nativeWebSearch!.usdPerSearch === null) reasons.push("web search price unknown (it searches on every request): set nativeWebSearch.usdPerSearch in an override");
  }
  const ageDays = (opts.now.getTime() - Date.parse(ep.checkedAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > cfg.models.max_metadata_age_days) {
    reasons.push(`metadata is ${Math.floor(ageDays)} days old (limit ${cfg.models.max_metadata_age_days}); rescan`);
  }
  if (ep.contextLimitTokens === null) reasons.push("context limit unknown");
  if (ep.outputLimitTokens === null) reasons.push("output limit unknown");
  for (const m of req.inputModalities) if (!ep.inputModalities.includes(m)) reasons.push(`cannot read ${m} input`);
  if (profile.mode !== "completion" && ep.supportsTools !== true) reasons.push(ep.supportsTools === null ? "tool calling unknown (required for repository work; set it in an override)" : "no tool calling (required for repository work)");
  if ((req.needsStructuredOutput || profile.requires_structured_output) && ep.supportsStructuredOutput !== true) reasons.push(ep.supportsStructuredOutput === null ? "structured output unknown" : "no structured output");
  if (req.reviewer) {
    if (req.reviewer.mode === "required" && !opts.qualification?.qualified) {
      reasons.push(opts.qualification ? `not qualified as a ${req.reviewer.name} reviewer (pass rate ${(opts.qualification.passRate * 100).toFixed(0)}% over ${opts.qualification.trials} trials)` : `not yet qualified as a ${req.reviewer.name} reviewer`);
    }
  } else if (cfg.qualification.required && !req.skipQualification && !opts.qualification?.qualified) {
    reasons.push(opts.qualification ? `not qualified for ${req.profile}/${req.tier} (pass rate ${(opts.qualification.passRate * 100).toFixed(0)}% over ${opts.qualification.trials} trials)` : `not yet qualified for ${req.profile}/${req.tier}`);
  }
  return reasons;
}

/**
 * Build the ordered candidate list for a task. Order: forced models only (if any force override
 * applies), else preferred models first, then automatic order by the tier's preference.
 * Providers whose keys are all cooling down move to the end, and platforms whose circuit
 * breaker is open go after those (the gate skips them until a probe is due).
 */
export function planRoute(
  cfg: ResolvedConfig,
  endpoints: ModelEndpoint[],
  overrides: RoutingOverride[],
  req: RouteRequirements,
  deps: { now: Date; qualification: QualificationLookup; health?: ProviderHealthLookup; quarantined?: (ep: ModelEndpoint) => string | null },
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
  const avoid = new Set(req.avoidEndpoints ?? []);
  const qualify = (id: string) => (req.reviewer ? deps.qualification(id, req.profile, req.tier, req.reviewer) : deps.qualification(id, req.profile, req.tier));
  for (const ep of endpoints) {
    const qual = qualify(ep.id);
    const reasons = endpointExclusions(ep, cfg, req, {
      now: deps.now,
      allowBelowFloor: belowFloor.has(ep.id),
      qualification: qual,
    });
    if (blockIds.has(ep.id)) reasons.push(`blocked by routing override for ${req.profile}/${req.tier}`);
    if (avoid.has(ep.id)) reasons.push("served this task; an independent reviewer must be a different model");
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
      circuitOpenUntil: h?.circuitOpenUntil ?? null,
      belowFloorAllowed: belowFloor.has(ep.id),
    };
    explanations.push(ex);
    if (ex.eligible) eligible.push({ ep, ex });
  }

  const score = (id: string) => qualify(id)?.passRate ?? 0;
  const families = new Set(req.avoidFamilies ?? []);
  const providers = new Set(req.avoidProviders ?? []);
  // Reviewers: qualified first (preferred mode), then another model family, then another platform.
  const independence = (e: { ep: ModelEndpoint; ex: CandidateExplanation }) =>
    (req.reviewer && !e.ex.qualification?.qualified ? 4 : 0) + (families.has(modelFamily(e.ep)) ? 2 : 0) + (providers.has(e.ep.providerId) ? 1 : 0);
  const searchPlan = { web: req.web ?? null, paidPolicy: policy, tier: req.tier };
  // Paid requests (a priced model, or a priced native search) go after free ones unless the policy prefers them.
  const paidRank = (ep: ModelEndpoint) => (requestPaid(ep, cfg, searchPlan) ? (policy === "preferred" ? 0 : 1) : policy === "preferred" ? 1 : 0);
  // A task that needs the web prefers models that search inside the call (with the search on under
  // this plan); any other task takes a model that searches on every request only after the rest.
  const webRank = (ep: ModelEndpoint) => (req.web === true ? (planSearch(ep, cfg, searchPlan) ? 0 : 1) : alwaysSearches(ep) ? 1 : 0);
  eligible.sort((a, b) => {
    const pa = forced ? 0 : preferIds.indexOf(a.ep.id);
    const pb = forced ? 0 : preferIds.indexOf(b.ep.id);
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0 && pb >= 0 && pa !== pb) return pa - pb;
    const ra = paidRank(a.ep);
    const rb = paidRank(b.ep);
    if (ra !== rb) return ra - rb;
    const wa = webRank(a.ep);
    const wb = webRank(b.ep);
    if (wa !== wb) return wa - wb;
    const ia = independence(a);
    const ib = independence(b);
    if (ia !== ib) return ia - ib;
    const ca = a.ex.circuitOpenUntil !== null ? 2 : a.ex.coolingDownUntil !== null ? 1 : 0;
    const cb = b.ex.circuitOpenUntil !== null ? 2 : b.ex.coolingDownUntil !== null ? 1 : 0;
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
    floorB: Math.max(sizeFloor(cfg, req.profile, req.tier), req.minTotalParametersB ?? 0),
    candidates: eligible.map((e) => e.ep),
    explanations,
    forced,
    belowFloorEndpoints: belowFloor,
    web: req.web ?? null,
    paidPolicy: policy,
  };
}

/**
 * Endpoint stickiness: the candidates with `preferId` (the endpoint that served the
 * conversation's last turn) moved to the front, so the provider's prompt cache keeps serving the
 * prefix. The order is unchanged when that endpoint is not a candidate, is not `healthy`, or is
 * paid while a free candidate ranks ahead of it (stickiness never spends money).
 */
export function stickyOrder(candidates: ModelEndpoint[], preferId: string | null | undefined, healthy: (ep: ModelEndpoint) => boolean): ModelEndpoint[] {
  if (!preferId) return candidates;
  const i = candidates.findIndex((c) => c.id === preferId);
  if (i <= 0) return candidates;
  const ep = candidates[i]!;
  if (isPaid(ep) && candidates.slice(0, i).some((c) => !isPaid(c))) return candidates;
  if (!healthy(ep)) return candidates;
  return [ep, ...candidates.slice(0, i), ...candidates.slice(i + 1)];
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
