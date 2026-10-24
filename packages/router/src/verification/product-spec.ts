import { createHash } from "node:crypto";
import { z } from "zod";

export const ProductDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ProductEvidenceKindSchema = z.enum(["structural", "component", "security", "runtime", "journey", "persistence", "visual", "usability", "independent_review", "evaluator_change_review"]);
export type ProductEvidenceKind = z.infer<typeof ProductEvidenceKindSchema>;
const text = z.string().trim().min(1).max(20_000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

export const ProductCriterionSchema = z.object({
  id,
  priority: z.enum(["critical", "required", "optional"]),
  behavior: text,
  applicability: z.discriminatedUnion("status", [
    z.object({ status: z.literal("applicable") }).strict(),
    z.object({ status: z.literal("not_applicable"), reason: text, approvedBy: id }).strict(),
  ]),
  requiredEvidence: z.array(ProductEvidenceKindSchema).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.requiredEvidence).size !== value.requiredEvidence.length) ctx.addIssue({ code: "custom", path: ["requiredEvidence"], message: "Evidence kinds must be unique" });
  if (value.priority === "critical" && value.applicability.status !== "applicable") ctx.addIssue({ code: "custom", path: ["applicability"], message: "Critical criteria cannot be waived" });
});

/** Structured spec references immutable authored content; it is not a second editable document. */
export const DeliverySpecSchema = z.object({
  schemaVersion: z.literal(1), id, revision: z.number().int().positive(),
  source: z.object({ ref: text, digest: ProductDigestSchema }).strict(),
  originalInstruction: text, ownerId: id,
  users: z.array(text).min(1), platforms: z.array(text).min(1),
  workflows: z.array(text), dataInvariants: z.array(text), interfaceContracts: z.array(text),
  visualRequirements: z.array(text), failureStates: z.array(text), securityRequirements: z.array(text),
  exclusions: z.array(text), setupRecipeRefs: z.array(text),
  criteria: z.array(ProductCriterionSchema).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.criteria.map(c => c.id)).size !== value.criteria.length) ctx.addIssue({ code: "custom", path: ["criteria"], message: "Criterion IDs must be unique" });
});
export type DeliverySpec = z.infer<typeof DeliverySpecSchema>;

/** Key ordering is irrelevant; array order remains part of the versioned contract. */
export function productDigest(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical) : entry !== null && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : entry;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function deliverySpecDigest(spec: unknown): string { return productDigest(DeliverySpecSchema.parse(spec)); }
