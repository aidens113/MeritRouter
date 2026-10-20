import "server-only";
import type { Switchyard } from "switchyard-router";
import { insights } from "switchyard-router";

export type ModelView = ReturnType<typeof insights.modelsView>[number];

export interface ModelRow {
  id: string;
  name: string;
  providerId: string;
  gatewayModelId: string;
  status: "active" | "pending_confirmation" | "disabled" | "removed" | "quarantined";
  statusReason: string | null;
  headline: string;
  totalB: number | null;
  activeB: number | null;
  params: { source: string; confidence: string; confirmed: boolean; evidence: Array<{ source: string; totalB: number | null; activeB: number | null; detail: string }> };
  modalities: string[];
  contextTokens: number | null;
  outputTokens: number | null;
  outputSource: string;
  free: boolean;
  freeSource: string;
  chain: "verified" | "failed" | "unchecked";
  chainDetail: string | null;
  requests7d: number;
  succeeded7d: number;
  failed7d: number;
  overrideFields: string[];
  eligibleProfiles: string[];
  eligibleCells: number;
  supportsTools: boolean | null;
}

export function isFree(ep: ModelView["endpoint"]): boolean {
  return ep.pricing.freeVerified && (ep.pricing.inputUsdPerMillion ?? 0) === 0 && (ep.pricing.outputUsdPerMillion ?? 0) === 0;
}

export function chainState(sy: Switchyard, v: ModelView): { state: ModelRow["chain"]; detail: string | null } {
  if (!v.chain) return { state: "unchecked", detail: sy.cfg.gateway.require_verified_chains ? "Not verified yet. A scan (or the first request) verifies it." : "Not verified; chain verification is turned off (gateway.require_verified_chains)." };
  return v.chain.ok ? { state: "verified", detail: `Verified ${new Date(v.chain.verifiedAt).toLocaleString("en-GB")}` } : { state: "failed", detail: v.chain.problems.join("; ") };
}

export function toRow(sy: Switchyard, v: ModelView): ModelRow {
  const ep = v.endpoint;
  const c = chainState(sy, v);
  return {
    id: ep.id,
    name: ep.displayName ?? ep.gatewayModelId,
    providerId: ep.providerId,
    gatewayModelId: ep.gatewayModelId,
    status: v.quarantined ? "quarantined" : ep.status,
    statusReason: v.quarantined ?? ep.statusReason,
    headline: v.headline,
    totalB: ep.totalParametersB,
    activeB: ep.activeParametersB,
    params: { source: ep.params.source, confidence: ep.params.confidence, confirmed: ep.params.confirmed, evidence: ep.params.evidence },
    modalities: ep.inputModalities,
    contextTokens: ep.contextLimitTokens,
    outputTokens: ep.outputLimitTokens,
    outputSource: ep.outputLimitSource,
    free: isFree(ep),
    freeSource: ep.pricing.source,
    chain: c.state,
    chainDetail: c.detail,
    requests7d: v.stats7d.requests,
    succeeded7d: v.stats7d.succeeded,
    failed7d: v.stats7d.failed + v.stats7d.uncertain,
    overrideFields: v.override ? Object.keys(v.override).filter((k) => (v.override as Record<string, unknown>)[k] !== undefined) : [],
    eligibleProfiles: [...new Set(v.eligibility.filter((c) => c.eligible).map((c) => c.profile))],
    eligibleCells: v.eligibility.filter((c) => c.eligible).length,
    supportsTools: ep.supportsTools,
  };
}
