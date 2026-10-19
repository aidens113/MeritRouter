import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { Importance, TierName, VerificationConfig } from "../src/config/schema.js";
import { criteria, criterionTexts, WorkerResultSchema, WorkerTaskSchema, type WorkerResult, type WorkerTaskInput } from "../src/core/task.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { evaluatePolicy, reevaluateOnResult, resolveLevel, policyFingerprint } from "../src/verification/policy.js";
import { allocateBudget, compileContract, contractDigest, ContractStore, type AcceptanceContract, type BudgetInput } from "../src/verification/contract.js";
import { runNamedChecks, checkRunOutcome, type CheckedResult } from "../src/verification/checks.js";
import { applySupervisorDecision, decide, verificationRecord } from "../src/verification/decide.js";
import { baseConfig } from "./helpers.js";

const CONFIG_PATH = path.join(tmpdir(), "switchyard-verification", "switchyard.config.yaml");

function policy(verification: Record<string, unknown> = {}): VerificationConfig {
  return parseConfig(baseConfig({ verification }), CONFIG_PATH).verification;
}

function spec(o: Partial<WorkerTaskInput> & { constraints?: WorkerTaskInput["constraints"] } = {}) {
  return WorkerTaskSchema.parse({ profile: "implement", goal: "Fix add()", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["add works"], checks: ["npm test"] }, ...o });
}

const BUDGET: BudgetInput = { total: 16, tierExecution: 4, nextTierExecution: 8, classificationUsed: 0 };

function compile(o: { spec?: ReturnType<typeof spec>; tier?: TierName; tags?: Record<string, unknown> | null; policy?: VerificationConfig; budget?: Partial<BudgetInput>; parent?: { taskId: string; importance: Importance } } = {}): AcceptanceContract {
  const r = compileContract({
    taskId: "t1",
    spec: o.spec ?? spec(),
    tier: o.tier ?? "T1",
    tags: (o.tags ?? null) as never,
    rulebookFingerprint: "rb:1",
    policy: o.policy ?? policy(),
    budget: { ...BUDGET, ...o.budget },
    parent: o.parent ?? null,
    now: 1000,
  });
  if (!r.ok) throw new Error(r.message);
  return r.contract;
}

function codingResult(o: Partial<CheckedResult> = {}): CheckedResult {
  return {
    executionStatus: "completed",
    stopReason: "agent_finished",
    findings: [],
    checks: [{ command: "npm test", exitCode: 0, logRef: "artifact:log1", revision: "abc1234", artifactDigest: "d1" }],
    unresolvedCriteria: [],
    artifactRefs: [],
    patchRefs: ["artifact:patch1"],
    changedPaths: ["src/app.ts"],
    scopeViolation: [],
    protectedPathsChanged: [],
    ...o,
  };
}

describe("verification config", () => {
  it("defaults match the Design policy", () => {
    const p = policy();
    expect(p.default_importance).toBe("normal");
    expect(p.strict_acceptor).toBe("supervisor");
    expect(p.matrix).toEqual({
      T1: { low: "basic", normal: "standard", high: "deep", critical: "strict" },
      T2: { low: "standard", normal: "standard", high: "deep", critical: "strict" },
      T3: { low: "deep", normal: "deep", high: "deep", critical: "strict" },
    });
    expect(resolveLevel(p, "basic").checks).toEqual(["output_contract", "evidence_provenance", "scope", "protected_paths"]);
    expect(resolveLevel(p, "standard").checks).toEqual(["output_contract", "evidence_provenance", "scope", "protected_paths", "declared_checks", "criterion_evidence"]);
    const deep = resolveLevel(p, "deep");
    expect(deep.review).toEqual({ required: true, qualification: "review", minTotalParametersB: 100, independent: true });
    expect(deep.acceptance).toBe("automatic");
    const strict = resolveLevel(p, "strict");
    expect(strict.review).toEqual({ required: true, qualification: "review_strict", minTotalParametersB: 100, independent: true });
    expect(strict.acceptance).toBe("supervisor");
    expect(p.budget).toEqual({ review_requests: { deep: 4, strict: 6 }, repair_requests: "same_as_execution_at_next_tier" });
    expect(p.failure).toEqual({ max_quality_retries: 1, on_insufficient_evidence: "needs_supervisor", on_verification_budget_exhausted: "verification_pending" });
    expect(p.floors.map((f) => f.id)).toEqual(["risk-critical", "risk-public-api"]);
    expect(p.rules.map((r) => r.id)).toEqual(["refactor", "evaluator-changes"]);
    expect(policyFingerprint(p)).toMatch(/^1:[0-9a-f]{8}$/);
    expect(policyFingerprint(policy({ default_importance: "high" }))).not.toBe(policyFingerprint(p));
  });

  it("rejects extends cycles, unreserved reviews, and duplicate rule ids", () => {
    expect(() => policy({ levels: { basic: { extends: "strict" } } })).toThrow(/extends cycle/);
    expect(() => policy({ budget: { review_requests: { strict: 6 } } })).toThrow(/deep requires review/);
    expect(() => policy({ rules: [{ id: "a", when: { profiles: ["implement"] }, require_at_least: "deep" }, { id: "a", when: { profiles: ["review"] }, require_at_least: "deep" }] })).toThrow(/duplicate/);
    expect(() => policy({ rules: [{ id: "a", when: {}, require_at_least: "deep" }] })).toThrow(/at least one key/);
  });
});

describe("task importance and criteria", () => {
  it("plain-string criteria still validate and get ids c1..cn", () => {
    const s = spec({ constraints: { acceptanceCriteria: ["one", "two"], checks: ["npm test"] } });
    expect(s.importance).toBeUndefined();
    expect(criteria(s)).toEqual([
      { id: "c1", text: "one", verify: "check", checks: ["npm test"] },
      { id: "c2", text: "two", verify: "check", checks: ["npm test"] },
    ]);
    expect(criterionTexts(s)).toEqual(["one", "two"]);
    const ro = spec({ profile: "inspect", writableRepository: undefined, constraints: { acceptanceCriteria: ["find it"] } } as never);
    expect(criteria(ro)).toEqual([{ id: "c1", text: "find it", verify: "evidence", checks: [] }]);
  });

  it("accepts criterion objects and validates ids, checks, and importance reasons", () => {
    const s = spec({ constraints: { acceptanceCriteria: ["plain", { id: "api", text: "API unchanged", verify: "review" }, { id: "tests", text: "tests pass", checks: ["npm test"] }], checks: ["npm test", "npm run lint"] } });
    expect(criteria(s).map((c) => [c.id, c.verify, c.checks])).toEqual([
      ["c1", "check", ["npm test", "npm run lint"]],
      ["api", "review", []],
      ["tests", "check", ["npm test"]],
    ]);
    expect(() => spec({ constraints: { acceptanceCriteria: ["a", { id: "c1", text: "dup" }] } })).toThrow(/c1 is used more than once/);
    expect(() => spec({ constraints: { acceptanceCriteria: [{ id: "x", text: "t", checks: ["npm run e2e"] }], checks: ["npm test"] } })).toThrow(/not in constraints.checks/);
    expect(() => spec({ importance: "critical" })).toThrow(/importanceReason/);
    expect(spec({ importance: "critical", importanceReason: "auth code" }).importance).toBe("critical");
    expect(() => spec({ verification: { atLeast: "extreme" } } as never)).toThrow();
  });
});

describe("policy: matrix, floors, rules, merge", () => {
  const base = { profile: "implement" as const, tags: null, paths: [], protectedPathsChanged: null, criteria: [{ id: "c1", text: "x", verify: "evidence" as const, checks: [] }] };

  it("the matrix picks the level from tier and importance", () => {
    const p = policy();
    const level = (tier: TierName, importance: Importance) => evaluatePolicy(p, { ...base, tier, requestedImportance: importance }).level;
    expect(level("T1", "low")).toBe("basic");
    expect(level("T1", "normal")).toBe("standard");
    expect(level("T1", "high")).toBe("deep");
    expect(level("T2", "low")).toBe("standard");
    expect(level("T3", "low")).toBe("deep");
    expect(level("T3", "critical")).toBe("strict");
    const def = evaluatePolicy(p, { ...base, tier: "T1" });
    expect(def.importance).toMatchObject({ importance: "normal", requested: "normal", source: { kind: "default" } });
  });

  it("floors raise importance and the strongest wins; the parent job is a floor", () => {
    const p = policy();
    const sec = evaluatePolicy(p, { ...base, tier: "T1", requestedImportance: "low", tags: { risk: ["public_api_change", "security"] } });
    expect(sec.importance.importance).toBe("critical");
    expect(sec.importance.source).toEqual({ kind: "floor", id: "risk-critical", importance: "critical" });
    expect(sec.level).toBe("strict");
    const api = evaluatePolicy(p, { ...base, tier: "T2", tags: { risk: ["public_api_change"] } });
    expect([api.importance.importance, api.level]).toEqual(["high", "deep"]);
    const child = evaluatePolicy(p, { ...base, tier: "T1", parent: { taskId: "job1", importance: "high" } });
    expect(child.importance.source).toEqual({ kind: "parent", id: "job1", importance: "high" });
    expect(evaluatePolicy(policy({ inherit_parent_importance: false }), { ...base, tier: "T1", parent: { taskId: "job1", importance: "high" } }).importance.importance).toBe("normal");
  });

  it("rules raise the level, checks combine as a union, and task settings only raise", () => {
    const p = policy({
      rules: [
        { id: "auth", when: { changed_paths: ["src/auth/**"] }, require_at_least: "deep", add_checks: ["declared_checks", "secret_scan"] },
        { id: "infra", when: { profiles: ["implement"], tags: { risk: ["build_config"] } }, require_at_least: "strict" },
      ],
    });
    const r = evaluatePolicy(p, { ...base, tier: "T1", paths: ["src/auth/login.ts"], tags: { risk: ["build_config"] }, addChecks: ["license_scan"] });
    expect(r.level).toBe("strict");
    expect(r.rulesMatched).toEqual(["auth", "infra", "task-add-checks"]);
    expect(r.checks.filter((c) => c === "declared_checks")).toHaveLength(1);
    expect(r.checks).toEqual(expect.arrayContaining(["secret_scan", "license_scan", "output_contract"]));
    // Refactors need at least deep; a review criterion forces deep; atLeast cannot lower.
    expect(evaluatePolicy(policy(), { ...base, tier: "T1", tags: { kind: "refactor" } }).level).toBe("deep");
    expect(evaluatePolicy(policy(), { ...base, tier: "T1", criteria: [{ id: "c1", text: "x", verify: "review", checks: [] }] }).rulesMatched).toContain("criterion-review");
    expect(evaluatePolicy(policy(), { ...base, tier: "T2", atLeast: "basic" }).level).toBe("standard");
    expect(evaluatePolicy(policy(), { ...base, tier: "T1", atLeast: "deep" }).level).toBe("deep");
    // Path rules see only the declared paths before dispatch.
    expect(evaluatePolicy(p, { ...base, tier: "T1", paths: ["src/app.ts"] }).level).toBe("standard");
  });

  it("re-evaluation on the result can raise the level after the fact", () => {
    const p = policy({ rules: [{ id: "auth-critical", when: { changed_paths: ["src/auth/**"] }, importance: "critical" }] });
    const c = compile({ policy: p });
    expect([c.verification.level, c.importance.level]).toEqual(["standard", "normal"]);
    const re = reevaluateOnResult(p, c, { changedPaths: ["src/auth/token.ts"], protectedPathsChanged: [] });
    expect(re).toMatchObject({ level: "strict", raisedFrom: "standard", importance: "critical", importanceSource: "rule:auth-critical", raised: true, acceptance: "supervisor" });
    expect(re.newRules).toEqual(["auth-critical"]);
    const prot = reevaluateOnResult(policy(), compile(), { changedPaths: ["tests/app.test.ts"], protectedPathsChanged: ["tests/app.test.ts"] });
    expect(prot).toMatchObject({ level: "deep", raisedFrom: "standard", raised: true });
    expect(prot.checks).toContain("evaluator_change_review");
    expect(prot.review.required).toBe(true);
  });

  it("a worker cannot lower the level: only actual changes are inputs and the contract is the floor", () => {
    const c = compile({ spec: spec({ verification: { atLeast: "deep" } }) });
    expect(c.verification.level).toBe("deep");
    const same = reevaluateOnResult(policy(), c, { changedPaths: ["src/app.ts"], protectedPathsChanged: [] });
    expect(same).toMatchObject({ level: "deep", raisedFrom: null, raised: false });
    // Even a policy edited since (everything basic, no review) cannot weaken a compiled contract.
    const weak = policy({ levels: { deep: { extends: "standard" }, strict: { extends: "deep" } }, matrix: { T1: { low: "basic", normal: "basic", high: "basic", critical: "basic" } }, rules: [{ id: "noop", when: { profiles: ["summarize"] }, add_checks: ["x"] }] });
    const strictC = compile({ spec: spec({ importance: "critical", importanceReason: "payments" }) });
    const re = reevaluateOnResult(weak, strictC, { changedPaths: [], protectedPathsChanged: [] });
    expect(re).toMatchObject({ level: "strict", importance: "critical", acceptance: "supervisor" });
    expect(re.review.required).toBe(true);
    expect(re.checks).toEqual(expect.arrayContaining(strictC.verification.requiredChecks));
  });
});

describe("contract: budget allocation, digest, immutability", () => {
  it("allocates classification, review, execution, then repair out of the total", () => {
    const p = policy();
    const std = { level: "standard" as const, review: resolveLevel(p, "standard").review };
    const deep = { level: "deep" as const, review: resolveLevel(p, "deep").review };
    expect(allocateBudget(p, std, { total: 16, tierExecution: 4, nextTierExecution: 8, classificationUsed: 1 })).toEqual({
      ok: true,
      allocation: { total: 13, classification: 1, execution: 4, review: 0, repair: 8, unallocated: 3 },
    });
    expect(allocateBudget(p, deep, { total: 16, tierExecution: 12, nextTierExecution: null, classificationUsed: 0 })).toEqual({
      ok: true,
      allocation: { total: 16, classification: 0, execution: 12, review: 4, repair: 0, unallocated: 0 },
    });
    // Review is reserved before execution: a tight total squeezes execution, never review.
    expect(allocateBudget(p, deep, { total: 6, tierExecution: 8, nextTierExecution: 12, classificationUsed: 1 })).toMatchObject({ ok: true, allocation: { review: 4, execution: 1, repair: 0 } });
    expect(allocateBudget(policy({ budget: { repair_requests: 2 } }), std, { total: 16, tierExecution: 4, nextTierExecution: 8, classificationUsed: 0 })).toMatchObject({ allocation: { repair: 2, unallocated: 10 } });
    expect(allocateBudget(p, deep, { total: 4, tierExecution: 4, nextTierExecution: 8, classificationUsed: 0 })).toEqual({ ok: false, needed: 5, available: 4 });
  });

  it("rejects at compile with verification_budget_insufficient and never lowers the level", () => {
    const r = compileContract({ taskId: "t1", spec: spec({ importance: "high", importanceReason: "release blocker" }), tier: "T1", tags: null, rulebookFingerprint: null, policy: policy(), budget: { total: 3, tierExecution: 3, nextTierExecution: 3, classificationUsed: 0 }, now: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("verification_budget_insufficient");
    expect([r.needed, r.available, r.evaluation.level]).toEqual([5, 3, "deep"]);
  });

  it("compiles the contract with criteria, scope, importance source, budget, and fingerprints", () => {
    const c = compile({ spec: spec({ constraints: { acceptanceCriteria: ["a", { id: "doc", text: "documented" }], checks: ["npm test"], allowedPaths: ["src/**"] } }), tags: { kind: "fix_bug", risk: ["public_api_change"] }, budget: { classificationUsed: 1 } });
    expect(c.criteria.map((x) => `${x.id}:${x.verify}`)).toEqual(["c1:check", "doc:evidence"]);
    expect(c.scope).toEqual({ repositoryAliases: ["core"], writableRepository: "core", allowedPaths: ["src/**"], baseCommits: {} });
    expect(c.importance).toMatchObject({ level: "high", requested: "normal", source: "floor:risk-public-api" });
    expect(c.verification).toMatchObject({ level: "deep", matrixLevel: "deep", strictAcceptor: "supervisor", maxQualityRetries: 1 });
    expect(c.budget).toEqual({ total: 16, classification: 1, execution: 4, review: 4, repair: 7, unallocated: 0 });
    expect(c.fingerprints).toEqual({ rulebook: "rb:1", policy: policyFingerprint(policy()) });
  });

  describe("ContractStore", () => {
    let dir: string | undefined;
    let db: Db | undefined;
    afterEach(() => {
      db?.close();
      db = undefined;
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("stores once, refuses a different contract and row updates, and verifies the digest", () => {
      dir = mkdtempSync(path.join(tmpdir(), "switchyard-contract-"));
      db = openDatabase(dir);
      new TaskStore(db).submit([spec({ id: "t1" })]);
      const store = new ContractStore(db);
      const c = compile();
      const saved = store.save(c);
      expect(saved).toEqual({ sha256: contractDigest(c), created: true });
      expect(store.save(structuredClone(c))).toEqual({ sha256: saved.sha256, created: false });
      expect(() => store.save({ ...c, goal: "something else" })).toThrow(/contracts never change/);
      expect(() => db!.prepare("UPDATE task_contracts SET contract_json = '{}' WHERE task_id = 't1'").run()).toThrow(/immutable/);
      const got = store.get("t1")!;
      expect(got.sha256).toBe(saved.sha256);
      expect(got.contract).toEqual(c);
      expect(store.get("nope")).toBeNull();
      // The digest is over canonical JSON: key order does not matter.
      const reordered = Object.fromEntries(Object.entries(c).reverse()) as AcceptanceContract;
      expect(contractDigest(reordered)).toBe(saved.sha256);
    });
  });
});

describe("checks and the V1 decision", () => {
  const p = policy();

  it("a coding result with every check passing on the submitted revision is met", () => {
    const c = compile();
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "abc1234", artifactDigest: "d1" });
    expect(report.checks.every((x) => x.outcome === "passed")).toBe(true);
    const d = decide({ policy: p, contract: c, executionStatus: "completed", report });
    expect(d).toMatchObject({ verificationStatus: "passed", acceptanceStatus: "met", action: "accept", unresolvedCriterionIds: [] });
    const rec = verificationRecord({ contract: c, contractSha256: contractDigest(c), report, decision: d });
    expect(rec).toMatchObject({ level: "standard", raisedFrom: null, importance: "normal", importanceSource: "default", contractSha256: contractDigest(c) });
  });

  it("checks bound to another revision or artifact are stale and the result goes to the supervisor", () => {
    const c = compile();
    expect(checkRunOutcome("npm test", codingResult().checks, "def5678").outcome).toBe("stale");
    expect(checkRunOutcome("npm test", codingResult().checks, "abc1234", "d2").outcome).toBe("stale");
    expect(checkRunOutcome("npm test", [{ command: "npm test", exitCode: 0, logRef: "artifact:l" }], "abc1234").outcome).toBe("stale");
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "def5678" });
    expect(report.checks.find((x) => x.name === "declared_checks")!.outcome).toBe("stale");
    expect(report.criteria[0]!.outcome).toBe("stale");
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report })).toMatchObject({ verificationStatus: "inconclusive", acceptanceStatus: "needs_supervisor", action: "await_supervisor" });
    expect(decide({ policy: policy({ failure: { on_insufficient_evidence: "not_verified" } }), contract: c, executionStatus: "completed", report }).acceptanceStatus).toBe("not_verified");
  });

  it("a failing check is a defect with one repair; a check that cannot run is not", () => {
    const c = compile();
    const failed = runNamedChecks({ contract: c, mode: "coding", result: codingResult({ checks: [{ command: "npm test", exitCode: 1, logRef: "artifact:l", revision: "abc1234" }] }), revision: "abc1234" });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: failed })).toMatchObject({ verificationStatus: "failed", acceptanceStatus: "unmet", action: "repair", unresolvedCriterionIds: ["c1"] });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: failed, qualityRetriesUsed: 1 }).action).toBe("none");
    const env = runNamedChecks({ contract: c, mode: "coding", result: codingResult({ checks: [{ command: "npm test", exitCode: 127, logRef: "artifact:l", revision: "abc1234" }] }), revision: "abc1234" });
    expect(env.checks.find((x) => x.name === "declared_checks")!.outcome).toBe("environment_failure");
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: env })).toMatchObject({ verificationStatus: "inconclusive", acceptanceStatus: "needs_supervisor" });
    const scope = runNamedChecks({ contract: c, mode: "coding", result: codingResult({ scopeViolation: ["package.json"] }), revision: "abc1234" });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: scope }).acceptanceStatus).toBe("unmet");
    const none = runNamedChecks({ contract: c, mode: "coding", result: codingResult({ changedPaths: [] }), revision: "abc1234" });
    expect(none.checks.find((x) => x.name === "output_contract")!.outcome).toBe("failed");
  });

  it("read-only claims stay not_verified, a self-reported unmet is unmet, and bad provenance fails", () => {
    const c = compile({ spec: spec({ profile: "inspect", writableRepository: undefined, constraints: { acceptanceCriteria: ["find the bug", "name the file"] } } as never) });
    const result: CheckedResult = { executionStatus: "completed", stopReason: "submitted", findings: [{ description: "x", evidenceRefs: ["core:src/app.ts#L1-L2"] }], checks: [], unresolvedCriteria: [], artifactRefs: [], patchRefs: [] };
    const claims = [
      { id: "c1", status: "met" as const, evidenceRefs: ["core:src/app.ts#L1"] },
      { id: "c2", status: "unknown" as const, evidenceRefs: [] },
    ];
    const report = runNamedChecks({ contract: c, mode: "read_only", result, revision: null, selfReport: claims });
    expect(report.criteria.map((x) => x.outcome)).toEqual(["claimed", "unknown"]);
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report })).toMatchObject({ verificationStatus: "passed", acceptanceStatus: "not_verified", unresolvedCriterionIds: ["c1", "c2"] });
    const unmet = runNamedChecks({ contract: c, mode: "read_only", result, revision: null, selfReport: [claims[0]!, { id: "c2", status: "unmet", evidenceRefs: [] }] });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: unmet }).acceptanceStatus).toBe("unmet");
    const bad = runNamedChecks({ contract: c, mode: "read_only", result: { ...result, findings: [{ description: "x", evidenceRefs: ["not a ref"] }] }, revision: null, selfReport: claims });
    expect(bad.checks.find((x) => x.name === "evidence_provenance")!.outcome).toBe("failed");
  });

  it("deep waits for a review; budget exhaustion is recorded; a passing review with criteria meets", () => {
    const c = compile({ spec: spec({ constraints: { acceptanceCriteria: ["tests pass", { id: "api", text: "API unchanged", verify: "review" }], checks: ["npm test"] } }), budget: { total: 16 } });
    expect(c.verification.level).toBe("deep");
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "abc1234", artifactDigest: "d1" });
    expect(report.criteria.map((x) => x.outcome)).toEqual(["passed", "pending_review"]);
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report })).toMatchObject({ verificationStatus: "pending", acceptanceStatus: "needs_supervisor" });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report, verificationBudgetExhausted: true }).verificationStatus).toBe("skipped_budget");
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report, review: { verdict: "inconclusive" } }).acceptanceStatus).toBe("needs_supervisor");
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report, review: { verdict: "pass", criteria: [{ id: "api", outcome: "pass" }] } })).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    // A review pass never overrides a failed check.
    const failed = runNamedChecks({ contract: c, mode: "coding", result: codingResult({ checks: [{ command: "npm test", exitCode: 2, logRef: "artifact:l", revision: "abc1234", artifactDigest: "d1" }] }), revision: "abc1234", artifactDigest: "d1" });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report: failed, review: { verdict: "pass", criteria: [{ id: "c1", outcome: "pass" }, { id: "api", outcome: "pass" }] } }).acceptanceStatus).toBe("unmet");
  });

  it("a required check this version cannot run never passes", () => {
    const c = compile({ spec: spec({ verification: { addChecks: ["license_scan"] } }) });
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "abc1234" });
    expect(report.checks.find((x) => x.name === "license_scan")).toMatchObject({ required: true, outcome: "not_implemented" });
    expect(decide({ policy: p, contract: c, executionStatus: "completed", report }).acceptanceStatus).toBe("needs_supervisor");
  });

  it("strict ends needs_supervisor until the supervisor accepts it", () => {
    const c = compile({ spec: spec({ importance: "critical", importanceReason: "payments" }), budget: { total: 20 } });
    expect(c.verification.level).toBe("strict");
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "abc1234", artifactDigest: "d1" });
    const d = decide({ policy: p, contract: c, executionStatus: "completed", report, review: { verdict: "pass" } });
    expect(d).toMatchObject({ verificationStatus: "passed", acceptanceStatus: "needs_supervisor", action: "await_supervisor" });
    const by = { kind: "supervisor" as const, id: "job-1" };
    expect(applySupervisorDecision(d, c, { decision: "accept", by, at: 5 })).toMatchObject({ ok: false, code: "reason_required" });
    expect(applySupervisorDecision(d, c, { decision: "accept", by, reason: "matches the goal and spec", at: 5 })).toMatchObject({ ok: true, acceptanceStatus: "met", record: { decision: "accepted", by, reason: "matches the goal and spec", at: 5 } });
    expect(applySupervisorDecision(d, c, { decision: "reject", by, reason: "misses the refund case", at: 5 })).toMatchObject({ ok: true, acceptanceStatus: "unmet" });
    expect(applySupervisorDecision({ acceptanceStatus: "unmet" }, c, { decision: "accept", by, reason: "looks fine", at: 5 })).toMatchObject({ ok: false, code: "cannot_accept_unmet" });
    const human = compile({ spec: spec({ importance: "critical", importanceReason: "payments" }), policy: policy({ strict_acceptor: "human" }), budget: { total: 20 } });
    expect(applySupervisorDecision(d, human, { decision: "accept", by, reason: "ok", at: 5 })).toMatchObject({ ok: false, code: "human_acceptance_required" });
    expect(applySupervisorDecision(d, human, { decision: "accept", by: { kind: "human", id: "aiden" }, reason: "ok", at: 5 })).toMatchObject({ ok: true, acceptanceStatus: "met" });
  });

  it("results recorded without verification fields still parse; new fields are accepted", () => {
    const legacy = {
      taskId: "t1", executionStatus: "completed", acceptanceStatus: "not_verified", stopReason: "", summary: "", findings: [], artifactRefs: [], patchRefs: [], baseCommits: {},
      checks: [{ command: "npm test", exitCode: 0, logRef: "artifact:l" }], unresolvedCriteria: [],
      usage: { modelRequests: 0, providerAttempts: 0, providerAttemptsExact: true, tokenUsageBasis: "unknown", batchId: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reportedCostUsd: null, estimatedCostUsd: null },
      servedEndpoints: [],
    };
    const parsed: WorkerResult = WorkerResultSchema.parse(legacy);
    expect(parsed.verificationStatus).toBeUndefined();
    const c = compile();
    const report = runNamedChecks({ contract: c, mode: "coding", result: codingResult(), revision: "abc1234", artifactDigest: "d1" });
    const d = decide({ policy: p, contract: c, executionStatus: "completed", report });
    const withV = WorkerResultSchema.parse({ ...legacy, acceptanceStatus: "needs_supervisor", verificationStatus: d.verificationStatus, verification: verificationRecord({ contract: c, contractSha256: null, report, decision: d }), scopeViolation: [], protectedPathsChanged: [], changedPaths: ["src/app.ts"], checks: [{ ...legacy.checks[0], revision: "abc1234", artifactDigest: "d1" }] });
    expect(withV.verification!.decisions).toEqual([]);
  });
});
