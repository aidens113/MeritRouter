import { describe, expect, it } from "vitest";
import { DeliverySpecSchema, deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { EvidenceReceiptSchema, ProductFinalDecisionSchema, productCandidateDigest, type EvidenceReceipt, type ProductCandidate } from "../src/verification/product-evidence.js";
import { evaluateProductReadiness } from "../src/verification/product-readiness.js";

const digest = "a".repeat(64);
function spec(): DeliverySpec {
  return DeliverySpecSchema.parse({ schemaVersion: 1, id: "social", revision: 1, source: { ref: "app:docs/spec.md", digest }, originalInstruction: "Build a usable social app", ownerId: "final", users: ["local user"], platforms: ["desktop", "mobile"], workflows: ["Publish a post and refresh"], dataInvariants: ["Published posts survive restart"], interfaceContracts: [], visualRequirements: ["Mobile controls remain reachable"], failureStates: ["Upload failure is visible"], securityRequirements: ["Accounts cannot edit other users"], exclusions: [], setupRecipeRefs: ["app:start"], criteria: [{ id: "publish", priority: "critical", behavior: "Publish persists on restart", applicability: { status: "applicable" }, requiredEvidence: ["structural", "journey", "persistence", "visual"] }] });
}
function candidate(): ProductCandidate {
  return { repositories: { app: { head: "b".repeat(40), tree: "c".repeat(40) } }, testDigest: digest, recipeDigest: digest, environmentDigest: digest, dependencyDigest: digest, fixtureDigest: digest, browserGeneration: "chrome-1" };
}
function receipts(s = spec(), c = candidate()): EvidenceReceipt[] {
  return s.criteria[0]!.requiredEvidence.map(kind => EvidenceReceiptSchema.parse({ schemaVersion: 1, id: kind, criterionIds: ["publish"], kind, specDigest: deliverySpecDigest(s), candidateDigest: productCandidateDigest(c), actor: { id: "reviewer", role: "reviewer" }, basis: "observed", outcome: "pass", startedAt: 1, completedAt: 2, expiresAt: null, artifactRefs: [`artifact:${kind}`], observations: ["Actual behavior observed"], unknowns: [], subjectActorIds: ["implementer"] }));
}
function evaluate(evidence = receipts(), s = spec(), c = candidate()) { return evaluateProductReadiness({ spec: s, candidate: c, evidence, now: 10 }); }

describe("product readiness is distinct from task completion and final acceptance", () => {
  it("returns ready for FINAL review only after complete observed coverage", () => {
    expect(evaluate()).toMatchObject({ status: "ready_for_final_review", blockers: [], coverage: [{ status: "satisfied" }] });
    expect(evaluate()).not.toHaveProperty("accepted");
  });
  it("blocks a green build with inert buttons, untested persistence and no visual inspection", () => {
    const result = evaluate(receipts().filter(r => r.kind === "structural"));
    expect(result.status).toBe("blocked");
    expect(result.blockers.map(b => b.kind)).toEqual(["journey", "persistence", "visual"]);
  });
  it.each(["claimed", "inconclusive", "not_implemented", "unavailable", "unknown", "future", "expired"])("blocks %s evidence", mode => {
    const evidence = receipts();
    const r = evidence[1]!;
    if (mode === "claimed") r.basis = "claimed";
    else if (mode === "unknown") r.unknowns = ["Refresh not checked"];
    else if (mode === "future") r.completedAt = 20;
    else if (mode === "expired") r.expiresAt = 9;
    else r.outcome = mode as "inconclusive" | "not_implemented" | "unavailable";
    expect(evaluate(evidence).status).toBe("blocked");
  });
  it.each(["head", "tree", "testDigest", "recipeDigest", "environmentDigest", "dependencyDigest", "fixtureDigest", "browserGeneration"])("invalidates receipts when %s changes", field => {
    const c = candidate();
    if (field === "head" || field === "tree") c.repositories.app![field] = "d".repeat(40);
    else if (field === "browserGeneration") c.browserGeneration = "chrome-2";
    else c[field as "testDigest"] = "d".repeat(64);
    expect(evaluate(receipts(), spec(), c).status).toBe("blocked");
  });
  it("invalidates receipts on authored spec or structured revision change", () => {
    const s = spec(); s.revision++;
    expect(evaluate(receipts(), s).status).toBe("blocked");
    s.source.digest = "d".repeat(64);
    expect(evaluate(receipts(), s).status).toBe("blocked");
  });
  it("does not erase a current observed failure with another green receipt", () => {
    const failure = { ...receipts()[1]!, id: "broken-hydration", outcome: "fail" as const };
    expect(evaluate([...receipts(), failure]).blockers).toContainEqual(expect.objectContaining({ code: "failed_evidence", kind: "journey" }));
  });
  it("rejects self-review and worker-claimed visual approval", () => {
    for (const actor of [{ id: "implementer", role: "reviewer" as const }, { id: "worker2", role: "worker" as const }]) {
      const evidence = receipts(); evidence[3]!.actor = actor;
      expect(evaluate(evidence).status).toBe("blocked");
    }
  });
  it("blocks duplicate evidence IDs and unknown criterion references", () => {
    expect(evaluate([...receipts(), receipts()[0]!]).status).toBe("blocked");
    const evidence = receipts(); evidence[0]!.criterionIds.push("invented");
    expect(evaluate(evidence).status).toBe("blocked");
  });
  it("refuses critical waivers and duplicate criteria", () => {
    const s = spec();
    expect(DeliverySpecSchema.safeParse({ ...s, criteria: [{ ...s.criteria[0], applicability: { status: "not_applicable", reason: "Hard", approvedBy: "worker" } }] }).success).toBe(false);
    expect(DeliverySpecSchema.safeParse({ ...s, criteria: [...s.criteria, ...s.criteria] }).success).toBe(false);
  });
  it("allows explicit noncritical applicability and reports optional unmet criteria", () => {
    const s = spec();
    s.criteria.push({ ...s.criteria[0]!, id: "optional", priority: "optional" });
    s.criteria.push({ ...s.criteria[0]!, id: "cli-no-ui", priority: "required", applicability: { status: "not_applicable", reason: "CLI task", approvedBy: "final" } });
    const result = evaluate(receipts(s), s);
    expect(result.status).toBe("ready_for_final_review");
    expect(result.coverage.map(c => c.status)).toEqual(["satisfied", "optional_unmet", "not_applicable"]);
  });
  it("canonicalizes object keys but binds full spec content", () => {
    const s = spec(); expect(deliverySpecDigest({ ...s, id: s.id })).toBe(deliverySpecDigest(s));
    expect(deliverySpecDigest({ ...s, originalInstruction: "Different scope" })).not.toBe(deliverySpecDigest(s));
  });
  it("keeps FINAL authority separate and refuses delegated acceptance", () => {
    const decision = { schemaVersion: 1, decision: "accept", actor: { id: "final", role: "initiator" }, specDigest: deliverySpecDigest(spec()), candidateDigest: productCandidateDigest(candidate()), reason: "Personally reviewed", at: 10 };
    expect(ProductFinalDecisionSchema.safeParse(decision).success).toBe(true);
    expect(ProductFinalDecisionSchema.safeParse({ ...decision, actor: { id: "delegate", role: "delivery_supervisor" } }).success).toBe(false);
  });
});
