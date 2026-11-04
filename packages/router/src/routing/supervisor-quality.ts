import { z } from "zod";
import { assessSupervisorRanking, SupervisorRankingEvidenceSchema, SupervisorRankingPolicySchema, type SupervisorEndpointRoute } from "./supervisor-ranking.js";
import { LOCAL_SUPERVISOR_RANKING_POLICY } from "../qualification/supervisor-suite.js";

const score = z.number().min(0).max(1);
export const SupervisorQualityEvidenceSchema = z.object({
  schemaVersion: z.literal(1), endpointId: z.string().min(1), source: z.string().min(1),
  checkedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  classification: z.enum(["frontier", "qualified_supervisor"]),
  confidence: score, trials: z.number().int().positive(),
  scores: z.object({ planning: score, architecture: score, supervision: score, integration: score, review: score, product: score, visual: score.optional() }).strict(),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.expiresAt) <= Date.parse(v.checkedAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Quality evidence must expire after verification" });
});
export const SupervisorQualityRoutingSchema = z.object({
  strategy: z.literal("highest_eligible_quality").default("highest_eligible_quality"),
  minimum_quality: z.enum(["ranked_capable", "best_available", "frontier_or_qualified_supervisor"]).default("ranked_capable"),
  quality_evidence: z.array(SupervisorQualityEvidenceSchema).max(10_000).default([]),
  ranking_policy: SupervisorRankingPolicySchema.nullable().default(null),
  ranking_evidence: z.array(SupervisorRankingEvidenceSchema).max(10_000).default([]),
}).strict().prefault({});
export type SupervisorQualityEvidence = z.infer<typeof SupervisorQualityEvidenceSchema>;
export type SupervisorQualityRouting = z.infer<typeof SupervisorQualityRoutingSchema>;

// Host-owned aggregate port. It never opens a private project store or changes saved policy.
const observedEvidence = new WeakMap<SupervisorQualityRouting, () => unknown[]>();
export function bindSupervisorEvidence(policy: SupervisorQualityRouting, read: () => unknown[]): void { observedEvidence.set(policy, read); }

export interface SupervisorQualityAssessment { eligible: boolean; score: number | null; source: string | null; classification: SupervisorQualityEvidence["classification"] | "benchmark_qualified_supervisor" | null; reason: string }
/** Configured provenance is reviewed/user-owned; vendor names and parameter size are never inferred quality. */
export function assessSupervisorQuality(endpointId: string, policy: SupervisorQualityRouting, now: Date, visualRequired = false, route?: SupervisorEndpointRoute): SupervisorQualityAssessment {
  if (policy.minimum_quality === "ranked_capable") {
    const local = observedEvidence.get(policy)?.() ?? [];
    return assessSupervisorRanking(endpointId, policy.ranking_policy ?? LOCAL_SUPERVISOR_RANKING_POLICY,
      policy.ranking_policy ? policy.ranking_evidence : [...policy.ranking_evidence, ...local], now, route, visualRequired);
  }
  const current = policy.quality_evidence.filter(e => e.endpointId === endpointId && Date.parse(e.checkedAt) <= now.getTime() && Date.parse(e.expiresAt) > now.getTime());
  const scored = current.map(e => {
    const capabilities = [e.scores.planning, e.scores.architecture, e.scores.supervision, e.scores.integration, e.scores.review, e.scores.product, ...(visualRequired ? [e.scores.visual ?? 0] : [])];
    const floor = Math.min(...capabilities);
    const value = capabilities.reduce((a, b) => a + b, 0) / capabilities.length * e.confidence;
    return { evidence: e, floor, value };
  }).filter(e => e.floor >= 0.75 && e.evidence.confidence >= 0.75).sort((a, b) => b.value - a.value || Date.parse(b.evidence.checkedAt) - Date.parse(a.evidence.checkedAt));
  const best = scored[0];
  return best ? { eligible: true, score: best.value, source: best.evidence.source, classification: best.evidence.classification, reason: `verified ${best.evidence.classification}; quality ${best.value.toFixed(3)} (${best.evidence.source})` } : { eligible: policy.minimum_quality === "best_available", score: null, source: null, classification: null, reason: policy.minimum_quality === "best_available" ? "unverified supervisor ability; best_available uses eligible model capacity without benchmark evidence" : "supervisor_quality_unavailable: no current high-confidence evidence meeting every supervisor capability floor" };
}
