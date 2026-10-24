import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { compileContract, declaredEvaluatorChanges } from "../src/verification/contract.js";
import { runNamedChecks, type EvaluatorReviewOutcome } from "../src/verification/checks.js";
import { validateVerdict } from "../src/verification/review.js";
import { verifyOutcome, verificationBudgetShortfall } from "../src/core/acceptance.js";
import { baseResult } from "../src/runners/types.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

const revision = "a".repeat(40), base = "b".repeat(40), snapshot = "artifact:immutable_snapshot";
const config = () => parseConfig(baseConfig({ verification: { max_total_requests_per_task: 20, failure: { max_quality_retries: 0 }, budget: { review_requests: { deep: 12, strict: 12 } } } }), path.join(tmpdir(), "evaluator-config.yaml"));
function spec() { return WorkerTaskSchema.parse({ profile: "implement", goal: "Improve add tests", repositoryAliases: ["core"], writableRepository: "core", context: { baseCommits: { core: base } }, constraints: { allowedPaths: ["tests/**"], acceptanceCriteria: [{ id: "coverage", text: "Preserve add coverage", verify: "evidence" }] } }); }
function contract() {
  const cfg = config(), s = spec();
  const compiled = compileContract({ taskId: "task", spec: s, tier: "T1", tags: null, rulebookFingerprint: null, policy: cfg.verification, budget: { total: 20, tierExecution: 20, nextTierExecution: null, classificationUsed: 0 }, evaluatorChangeExpected: declaredEvaluatorChanges(s, cfg.coding.protected_paths), now: 0 });
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.contract;
}
function trustedReview(): EvaluatorReviewOutcome { return { verdict: "pass", revision, policyVersion: contract().fingerprints.policy, changedPaths: ["tests/add.test.ts"], reviewerEndpointId: "reviewer", authorEndpointIds: ["author"], snapshotRefs: [snapshot], evidenceRefs: [snapshot], reason: "Original assertions and negative cases preserved against candidate implementation" }; }
function subject(review: EvaluatorReviewOutcome | null = null) { return { contract: contract(), mode: "coding" as const, revision, evaluatorReview: review, result: baseResult({ executionStatus: "completed", stopReason: "worker_submitted", changedPaths: ["tests/add.test.ts"], scopeViolation: [], protectedPathsChanged: ["tests/add.test.ts"], baseCommits: { core: base } }) }; }
const gate = (review: EvaluatorReviewOutcome | null = null) => runNamedChecks(subject(review)).checks.find(c => c.name === "evaluator_change_review")!;

describe("evaluator change independent gate", () => {
  it("predicts writable test scope and protects review capacity before execution", () => {
    const cfg = config(), c = contract();
    expect(declaredEvaluatorChanges(spec(), cfg.coding.protected_paths)).toBe(true);
    expect(c.verification).toMatchObject({ level: "deep", review: { required: true, independent: true }, requiredChecks: expect.arrayContaining(["evaluator_change_review"]) });
    expect(c.budget).toMatchObject({ review: 12, execution: 8 });
    expect(c.verification.rulesMatched).toContain("evaluator-changes-required");
    const raw = spec(); raw.budget = { maxModelRequests: 12 };
    expect(verificationBudgetShortfall(cfg, raw, null)).toContain("verification_budget_insufficient");
  });
  it("does not predict evaluator writes merely because tests are read-only context", () => {
    const raw = spec(); raw.constraints.allowedPaths = ["src/**"]; raw.context.fileRefs = ["core:tests/add.test.ts"];
    expect(declaredEvaluatorChanges(raw, config().coding.protected_paths)).toBe(false);
  });
  it("keeps unreviewed green edited tests pending rather than not implemented or passed", () => {
    expect(gate()).toMatchObject({ required: true, outcome: "not_run" });
    expect(gate(trustedReview())).toMatchObject({ outcome: "passed" });
  });
  it.each(["revision", "policy", "paths", "self", "missing-snapshot"])("blocks %s review provenance", field => {
    const review = trustedReview();
    if (field === "revision") review.revision = "c".repeat(40);
    if (field === "policy") review.policyVersion = "old-policy";
    if (field === "paths") review.changedPaths = ["tests/other.test.ts"];
    if (field === "self") review.reviewerEndpointId = "author";
    if (field === "missing-snapshot") review.evidenceRefs = [];
    expect(gate(review).outcome).not.toBe("passed");
  });
  it("test weakening remains unmet even if all criterion reviews claim pass", () => {
    const s = subject();
    const verified = verifyOutcome(config().verification, { contract: s.contract, sha256: "digest", createdAt: 0 }, "coding", { state: "completed", result: s.result, evidence: { revision } }, 100, { review: { verdict: "fail", criteria: [{ id: "coverage", outcome: "pass" }], evaluatorChangeReview: { ...trustedReview(), verdict: "fail", reason: "Regression assertion was replaced with assert.equal(1,1)" } } });
    expect(verified.decision.acceptanceStatus).toBe("unmet");
    expect(verified.result.verification?.checks).toContainEqual(expect.objectContaining({ name: "evaluator_change_review", outcome: "failed" }));
  });
  it("requires structured baseline/candidate comparison in the actual terminal verdict", () => {
    const raw = { verdict: "pass", examinedRevision: revision, policyVersion: "policy", criteria: [{ id: "coverage", outcome: "pass", evidenceRefs: [snapshot] }], blockingFindings: [], missingEvidence: [], recommendedAction: "accept" };
    const expected = { criteria: [{ id: "coverage" }], revision, policyVersion: "policy", universe: { refs: new Map([[snapshot, null]]) }, evaluatorChanges: { paths: ["tests/add.test.ts"], snapshotRefs: [snapshot] } };
    expect(validateVerdict(raw, expected).ok).toBe(false);
    expect(validateVerdict({ ...raw, evaluatorChangeReview: { verdict: "pass", changedPaths: ["tests/add.test.ts"], evidenceRefs: [snapshot], reason: "Compared immutable before/after assertions" } }, expected).ok).toBe(true);
  });
});

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const author = endpoint({ providerId: "openrouter", gatewayModelId: "author/frontier:free", totalParametersB: 700 });
const reviewer = endpoint({ providerId: "groq", gatewayModelId: "reviewer/review", totalParametersB: 400 });
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

it.each(["pass", "fail", "unavailable"])("actually routes an independent evaluator reviewer: %s", async mode => {
  env = makeEnv({ config: baseConfig({ coding: { runner: "native" }, verification: { failure: { max_quality_retries: 0 } } }), endpoints: mode === "unavailable" ? [author] : [author, reviewer], files: { "src/app.ts": "export const add = (a,b) => a+b;\n", "tests/add.test.ts": "assert.equal(add(1,2),3);\n" } });
  let packageText = "";
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (req.tools?.some(tool => tool.function.name === "submit_verdict")) {
      packageText = String(req.messages[1]!.content);
      const rev = /examinedRevision: (\S+)/.exec(packageText)![1]!, policy = /policyVersion: (\S+)/.exec(packageText)![1]!;
      const ref = /Cite (artifact:[A-Za-z0-9_-]+)/.exec(packageText)![1]!;
      return reply(null, { ...served, toolCalls: [call("submit_verdict", { verdict: mode, examinedRevision: rev, policyVersion: policy, criteria: [{ id: "coverage", outcome: "pass", evidenceRefs: [ref] }], evaluatorChangeReview: { verdict: mode, changedPaths: ["tests/add.test.ts"], evidenceRefs: [ref], reason: mode === "fail" ? "Original regression assertion replaced with tautology" : "Original regression assertion retained; adds negative coverage" }, blockingFindings: [], missingEvidence: [], recommendedAction: mode === "fail" ? "repair" : "accept" })] });
    }
    if (!req.messages.some(message => message.role === "tool")) return reply(null, { ...served, toolCalls: [call("replace_in_file", { path: "tests/add.test.ts", old_text: "assert.equal(add(1,2),3);", new_text: mode === "fail" ? "assert.equal(1,1);" : "assert.equal(add(1,2),3);\nassert.equal(add(-1,1),0);" })] });
    return reply(null, { ...served, toolCalls: [call("submit_result", goodOutput(1, "core:tests/add.test.ts#L1"))] });
  });
  sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
  const [submitted] = await sy.submitTasks([{ profile: "implement", goal: "Improve regression tests without weakening them", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T3" }, constraints: { allowedPaths: ["tests/**"], acceptanceCriteria: [{ id: "coverage", text: "Preserve regression coverage", verify: "review" }] } }]);
  const results = await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 60 });
  expect(results.pending).toHaveLength(0);
  const result = results.completed[0]!;
  expect(result.verification?.checks.find(c => c.name === "evaluator_change_review")?.outcome).toBe(mode === "pass" ? "passed" : mode === "fail" ? "failed" : "not_run");
  expect(result.acceptanceStatus).toBe(mode === "pass" ? "met" : mode === "fail" ? "unmet" : "needs_supervisor");
  if (mode !== "unavailable") {
    expect(packageText).toContain("assert.equal(add(1,2),3)");
    expect(packageText).toContain("Required independent evaluator change review");
    expect(result.verification?.reviews?.[0]?.reviewer).toBe(reviewer.id);
    expect(sy.gate.admission.servedEndpointsByPurpose(submitted!.taskId).verification).toEqual([reviewer.id]);
  }
}, 90_000);
