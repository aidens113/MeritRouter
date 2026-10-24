import { z } from "zod";

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
  minimum_quality: z.literal("frontier_or_qualified_supervisor").default("frontier_or_qualified_supervisor"),
  quality_evidence: z.array(SupervisorQualityEvidenceSchema).max(10_000).default([]),
}).strict().prefault({});
export type SupervisorQualityEvidence = z.infer<typeof SupervisorQualityEvidenceSchema>;
export type SupervisorQualityRouting = z.infer<typeof SupervisorQualityRoutingSchema>;

export interface SupervisorQualityAssessment { eligible: boolean; score: number; source: string | null; classification: SupervisorQualityEvidence["classification"] | null; reason: string }
/** Configured provenance is reviewed/user-owned; vendor names and parameter size are never inferred quality. */
export function assessSupervisorQuality(endpointId: string, policy: SupervisorQualityRouting, now: Date, visualRequired = false): SupervisorQualityAssessment {
  const current = policy.quality_evidence.filter(e => e.endpointId === endpointId && Date.parse(e.checkedAt) <= now.getTime() && Date.parse(e.expiresAt) > now.getTime());
  const scored = current.map(e => {
    const capabilities = [e.scores.planning, e.scores.architecture, e.scores.supervision, e.scores.integration, e.scores.review, e.scores.product, ...(visualRequired ? [e.scores.visual ?? 0] : [])];
    const floor = Math.min(...capabilities);
    const value = capabilities.reduce((a, b) => a + b, 0) / capabilities.length * e.confidence;
    return { evidence: e, floor, value };
  }).filter(e => e.floor >= 0.75 && e.evidence.confidence >= 0.75).sort((a, b) => b.value - a.value || Date.parse(b.evidence.checkedAt) - Date.parse(a.evidence.checkedAt));
  const best = scored[0];
  return best ? { eligible: true, score: best.value, source: best.evidence.source, classification: best.evidence.classification, reason: `verified ${best.evidence.classification}; quality ${best.value.toFixed(3)} (${best.evidence.source})` } : { eligible: false, score: 0, source: null, classification: null, reason: "supervisor_quality_unavailable: no current high-confidence evidence meeting every supervisor capability floor" };
}
