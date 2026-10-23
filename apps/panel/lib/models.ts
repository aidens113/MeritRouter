import "server-only";
import type { MeritRouter } from "meritrouter";
import { insights } from "meritrouter";

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
  /** Its provider has a usable key and still lists the model (manual entries: a usable key). */
  available: boolean;
  /** The provider requests are sent to (direct). */
  routeProvider: string;
  requests7d: number;
  succeeded7d: number;
  failed7d: number;
  overrideFields: string[];
  eligibleProfiles: string[];
  eligibleCells: number;
  supportsTools: boolean | null;
  /** Web search inside the model call (null: none known). */
  nativeWebSearch: { via: string; usdPerSearch: number | null; source: string; detail: string; priceDetail?: string | undefined } | null;
}

export function isFree(ep: ModelView["endpoint"]): boolean {
  return ep.pricing.freeVerified && (ep.pricing.inputUsdPerMillion ?? 0) === 0 && (ep.pricing.outputUsdPerMillion ?? 0) === 0;
}

/** Providers with at least one usable key (before cooldowns and limits). */
export function keyedProviders(sy: MeritRouter): Set<string> {
  return new Set(sy.providers.credentials().list().filter((c) => c.unusableReason === null).map((c) => c.provider));
}

/** Whether requests can reach the model: it is available and its provider has a usable key. */
export function reachable(ep: ModelView["endpoint"], keyed: Set<string>): boolean {
  return ep.available && keyed.has(ep.route.provider);
}

export function toRow(sy: MeritRouter, v: ModelView, keyed: Set<string> = keyedProviders(sy)): ModelRow {
  const ep = v.endpoint;
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
    available: reachable(ep, keyed),
    routeProvider: ep.route.provider,
    requests7d: v.stats7d.requests,
    succeeded7d: v.stats7d.succeeded,
    failed7d: v.stats7d.failed + v.stats7d.uncertain,
    overrideFields: v.override ? Object.keys(v.override).filter((k) => (v.override as Record<string, unknown>)[k] !== undefined) : [],
    eligibleProfiles: [...new Set(v.eligibility.filter((c) => c.eligible).map((c) => c.profile))],
    eligibleCells: v.eligibility.filter((c) => c.eligible).length,
    supportsTools: ep.supportsTools,
    nativeWebSearch: ep.nativeWebSearch
      ? { via: ep.nativeWebSearch.via, usdPerSearch: ep.nativeWebSearch.usdPerSearch, source: ep.nativeWebSearch.source, detail: ep.nativeWebSearch.detail, priceDetail: ep.nativeWebSearch.priceDetail }
      : null,
  };
}
