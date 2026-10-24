import { z } from "zod";
import { DeliverySpecSchema, ProductDigestSchema, ProductEvidenceKindSchema, deliverySpecDigest } from "./product-spec.js";
import { EvidenceReceiptSchema, ProductCandidateSchema, productCandidateDigest, type EvidenceReceipt } from "./product-evidence.js";

export const ProductReadinessInputSchema = z.object({ spec: DeliverySpecSchema, candidate: ProductCandidateSchema, evidence: z.array(EvidenceReceiptSchema).max(10_000), now: z.number().int().nonnegative().optional() }).strict();
export type ProductReadinessInput = z.infer<typeof ProductReadinessInputSchema>;
export const ProductReadinessBlockerSchema = z.object({ criterionId: z.string().nullable(), kind: ProductEvidenceKindSchema.nullable(), code: z.enum(["missing_evidence", "failed_evidence", "invalid_evidence"]), detail: z.string().min(1) }).strict();
export type ProductReadinessBlocker = z.infer<typeof ProductReadinessBlockerSchema>;
export const ProductReadinessSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["ready_for_final_review", "blocked"]), specDigest: ProductDigestSchema, candidateDigest: ProductDigestSchema,
  coverage: z.array(z.object({ criterionId: z.string().min(1), status: z.enum(["satisfied", "missing", "not_applicable", "optional_unmet"]), evidenceIds: z.array(z.string().min(1)) }).strict()),
  blockers: z.array(ProductReadinessBlockerSchema),
}).strict();
export type ProductReadiness = z.infer<typeof ProductReadinessSchema>;

/** Deterministic coverage gate over trusted receipts. A passing build cannot cover journeys or visual review. */
export function evaluateProductReadiness(input: ProductReadinessInput): ProductReadiness {
  const { spec, candidate, evidence, now = Date.now() } = ProductReadinessInputSchema.parse(input);
  const specDigest = deliverySpecDigest(spec), candidateDigest = productCandidateDigest(candidate);
  const blockers: ProductReadinessBlocker[] = [];
  const ids = new Set<string>(), criterionIds = new Set(spec.criteria.map(c => c.id));
  for (const receipt of evidence) {
    if (ids.has(receipt.id)) blockers.push({ criterionId: null, kind: receipt.kind, code: "invalid_evidence", detail: `Duplicate receipt ID ${receipt.id}` });
    ids.add(receipt.id);
    if (receipt.criterionIds.some(id => !criterionIds.has(id))) blockers.push({ criterionId: null, kind: receipt.kind, code: "invalid_evidence", detail: `Unknown criterion reference in ${receipt.id}` });
  }
  const current = (r: EvidenceReceipt) => r.specDigest === specDigest && r.candidateDigest === candidateDigest && r.completedAt <= now && (r.expiresAt === null || r.expiresAt > now);
  const valid = (r: EvidenceReceipt) => current(r) && r.basis === "observed" && r.unknowns.length === 0 &&
    (r.kind !== "independent_review" && r.kind !== "evaluator_change_review" && r.kind !== "visual" && r.kind !== "usability" ||
      (r.actor.role === "reviewer" || r.actor.role === "initiator" || r.actor.role === "human") && r.subjectActorIds.length > 0 && !r.subjectActorIds.includes(r.actor.id));
  const coverage = spec.criteria.map(criterion => {
    if (criterion.applicability.status === "not_applicable") return { criterionId: criterion.id, status: "not_applicable" as const, evidenceIds: [] };
    const local: ProductReadinessBlocker[] = [], evidenceIds: string[] = [];
    for (const kind of criterion.requiredEvidence) {
      const matches = evidence.filter(r => r.kind === kind && r.criterionIds.includes(criterion.id));
      const passed = matches.filter(r => valid(r) && r.outcome === "pass");
      evidenceIds.push(...passed.map(r => r.id));
      // A newer pass cannot silently erase an observed defect; repair needs a new candidate identity.
      if (matches.some(r => current(r) && r.basis === "observed" && r.outcome === "fail")) local.push({ criterionId: criterion.id, kind, code: "failed_evidence", detail: `Observed failure for ${kind}` });
      else if (!passed.length) local.push({ criterionId: criterion.id, kind, code: "missing_evidence", detail: `Missing current independently applicable observed ${kind} evidence` });
    }
    if (criterion.priority !== "optional") blockers.push(...local);
    return { criterionId: criterion.id, status: local.length ? criterion.priority === "optional" ? "optional_unmet" as const : "missing" as const : "satisfied" as const, evidenceIds: [...new Set(evidenceIds)] };
  });
  return ProductReadinessSchema.parse({ schemaVersion: 1, status: blockers.length ? "blocked" : "ready_for_final_review", specDigest, candidateDigest, coverage, blockers });
}
