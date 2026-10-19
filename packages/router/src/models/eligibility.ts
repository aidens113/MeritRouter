import type { ProfileConfig, ProfileName } from "../config/schema.js";
import type { ModelEndpoint, EndpointCatalog } from "./catalog.js";
import { endpointsApprovedFor } from "./catalog.js";

export interface StaticPolicy {
  now: Date;
  maxMetadataAgeDays: number;
  paidRoutingAllowed: boolean;
}

export interface RequestRequirements {
  inputTokens: number;
  outputTokens: number;
  needsTools: boolean;
  needsImages: boolean;
  needsStructuredOutput: boolean;
}

/** Request-independent checks: approval, size floor, pricing, freshness, enabled. */
export function staticIneligibility(
  ep: ModelEndpoint,
  profileName: ProfileName,
  profile: ProfileConfig,
  policy: StaticPolicy,
): string[] {
  const reasons: string[] = [];
  if (!ep.enabled) reasons.push("endpoint disabled in catalog");
  if (!ep.approvedProfiles.includes(profileName)) reasons.push(`not approved for profile ${profileName}`);
  if (ep.totalParametersB === null) {
    reasons.push("total parameter count unknown");
  } else if (ep.totalParametersB < profile.min_total_parameters_b) {
    reasons.push(`total parameters ${ep.totalParametersB}B below floor ${profile.min_total_parameters_b}B`);
  }
  const free =
    ep.pricing.freeVerified && ep.pricing.inputUsdPerMillion === 0 && ep.pricing.outputUsdPerMillion === 0;
  if (!free && !policy.paidRoutingAllowed) reasons.push("not verified free and paid routing is disabled");
  const checked = Date.parse(ep.checkedAt);
  const ageDays = (policy.now.getTime() - checked) / 86_400_000;
  if (!Number.isFinite(checked) || ageDays > policy.maxMetadataAgeDays) {
    reasons.push(`metadata stale (checked ${ep.checkedAt}, limit ${policy.maxMetadataAgeDays} days)`);
  }
  if (ep.contextLimitTokens === null) reasons.push("served context limit unknown");
  if (ep.outputLimitTokens === null) reasons.push("served output limit unknown");
  if (profile.requires_structured_output && !ep.supportsStructuredOutput) {
    reasons.push("profile requires structured output");
  }
  if ((profile.requires_tools ?? profile.mode !== "completion") && !ep.supportsTools) {
    reasons.push("profile requires tool calling");
  }
  return reasons;
}

export interface PoolAssessment {
  profile: ProfileName;
  gatewayModel: string;
  members: ModelEndpoint[];
  /** Approved members that fail static checks; any entry makes the pool unroutable. */
  violations: Array<{ endpointId: string; reasons: string[] }>;
  routable: boolean;
  /** Smallest served context/output across members: requests must fit every member. */
  contextLimitTokens: number;
  outputLimitTokens: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsStructuredOutput: boolean;
}

/**
 * The gateway chooses among pool members, so the package cannot steer one request to a
 * particular member. A pool is routable only when every approved member is eligible, and
 * request limits are the minimum across members.
 */
export function assessPool(
  catalog: EndpointCatalog,
  profileName: ProfileName,
  profile: ProfileConfig,
  policy: StaticPolicy,
): PoolAssessment {
  const members = endpointsApprovedFor(catalog, profileName);
  const violations = members
    .map((ep) => ({ endpointId: ep.id, reasons: staticIneligibility(ep, profileName, profile, policy) }))
    .filter((v) => v.reasons.length > 0);
  const routable = members.length > 0 && violations.length === 0;
  const min = (vals: Array<number | null>) =>
    vals.length === 0 || vals.some((v) => v === null) ? 0 : Math.min(...(vals as number[]));
  return {
    profile: profileName,
    gatewayModel: profile.gateway_model,
    members,
    violations,
    routable,
    contextLimitTokens: min(members.map((m) => m.contextLimitTokens)),
    outputLimitTokens: min(members.map((m) => m.outputLimitTokens)),
    supportsTools: members.length > 0 && members.every((m) => m.supportsTools),
    supportsImages: members.length > 0 && members.every((m) => m.supportsImages),
    supportsStructuredOutput: members.length > 0 && members.every((m) => m.supportsStructuredOutput),
  };
}

/** Request-specific fit against an already-assessed pool. Returns denial reasons. */
export function requestFit(pool: PoolAssessment, req: RequestRequirements): string[] {
  const reasons: string[] = [];
  if (!pool.routable) {
    if (pool.members.length === 0) reasons.push(`no endpoints approved for ${pool.profile}`);
    for (const v of pool.violations) reasons.push(`${v.endpointId}: ${v.reasons.join("; ")}`);
    return reasons;
  }
  if (req.outputTokens > pool.outputLimitTokens) {
    reasons.push(`requested output ${req.outputTokens} exceeds pool output limit ${pool.outputLimitTokens}`);
  }
  if (req.inputTokens + req.outputTokens > pool.contextLimitTokens) {
    reasons.push(
      `estimated input ${req.inputTokens} + output ${req.outputTokens} exceeds pool context limit ${pool.contextLimitTokens}`,
    );
  }
  if (req.needsTools && !pool.supportsTools) reasons.push("request uses tools; not every pool member supports tool calling");
  if (req.needsImages && !pool.supportsImages) reasons.push("request includes images; not every pool member supports images");
  if (req.needsStructuredOutput && !pool.supportsStructuredOutput) {
    reasons.push("request needs structured output; not every pool member supports it");
  }
  return reasons;
}
