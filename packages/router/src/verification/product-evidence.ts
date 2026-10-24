import { z } from "zod";
import { ProductDigestSchema, ProductEvidenceKindSchema, productDigest } from "./product-spec.js";

const text = z.string().trim().min(1).max(20_000);
export const ProductActorSchema = z.object({ id: text, role: z.enum(["initiator", "delivery_supervisor", "worker", "reviewer", "human", "runtime"]) }).strict();
export const ProductCandidateSchema = z.object({
  repositories: z.record(z.string().min(1), z.object({ head: z.string().regex(/^[a-f0-9]{40,64}$/), tree: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()).refine(v => Object.keys(v).length > 0, "At least one repository is required"),
  testDigest: ProductDigestSchema, recipeDigest: ProductDigestSchema,
  environmentDigest: ProductDigestSchema, dependencyDigest: ProductDigestSchema,
  fixtureDigest: ProductDigestSchema, browserGeneration: z.string().min(1).nullable(),
}).strict();
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export function productCandidateDigest(candidate: unknown): string { return productDigest(ProductCandidateSchema.parse(candidate)); }

/** Receipt validity does not establish trust. Only authenticated runner/reviewer receipts may enter the readiness evaluator. */
export const EvidenceReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: text, criterionIds: z.array(text).min(1),
  kind: ProductEvidenceKindSchema, specDigest: ProductDigestSchema,
  candidateDigest: ProductDigestSchema, actor: ProductActorSchema,
  basis: z.enum(["observed", "claimed"]),
  outcome: z.enum(["pass", "fail", "inconclusive", "not_implemented", "unavailable"]),
  startedAt: z.number().int().nonnegative(), completedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  artifactRefs: z.array(text).min(1), observations: z.array(text).min(1), unknowns: z.array(text),
  /** Authenticated provenance for independence checks, never model-supplied claims of independence. */
  subjectActorIds: z.array(text),
}).strict().superRefine((v, ctx) => {
  if (v.completedAt < v.startedAt) ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Completion precedes start" });
  if (v.expiresAt !== null && v.expiresAt <= v.completedAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must follow completion" });
  if (new Set(v.criterionIds).size !== v.criterionIds.length) ctx.addIssue({ code: "custom", path: ["criterionIds"], message: "Criterion references must be unique" });
});
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;

/** Final decisions are separate authority-bearing records; readiness never manufactures acceptance. */
export const ProductFinalDecisionSchema = z.object({
  schemaVersion: z.literal(1), decision: z.enum(["accept", "reject"]),
  actor: ProductActorSchema.refine(v => v.role === "initiator" || v.role === "human", "Only FINAL initiator or human may decide"),
  specDigest: ProductDigestSchema, candidateDigest: ProductDigestSchema,
  reason: text, at: z.number().int().nonnegative(),
}).strict();
export type ProductFinalDecision = z.infer<typeof ProductFinalDecisionSchema>;
