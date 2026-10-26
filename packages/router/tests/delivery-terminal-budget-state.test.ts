import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { productCandidateDigest, type ProductCandidate, type EvidenceReceipt } from "../src/verification/product-evidence.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const hash = "a".repeat(64);
const specification: DeliverySpec = { schemaVersion: 1, id: "terminal-budget", revision: 1, source: { ref: "fixture:spec", digest: hash }, originalInstruction: "Deliver independently checked fixture behavior", ownerId: "FINAL", users: ["fixture user"], platforms: ["fixture browser"], workflows: ["observe fixture transition"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [], criteria: [{ id: "behavior", priority: "required", behavior: "Current fixture behavior is independently observed", applicability: { status: "applicable" }, requiredEvidence: ["structural", "journey", "visual", "independent_review"] }] };
async function fixture(options: { terminal?: "budget_exhausted" | "failed" | "cancelled" | "completed"; evidence?: boolean; handoff?: boolean; completeJob?: boolean; activeGrandchild?: boolean } = {}) {
  const config = baseConfig();
  Object.assign(config.profiles, { supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 20 } });
  env = makeEnv({ config });
  const provider = new ScriptedClient(() => reply("unused"));
  sy = open(env, provider, { worker: false });
  const [job, child] = await sy.submitTasks([
    { id: "job", label: "job", profile: "supervise", goal: specification.originalInstruction, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["current behavior observed"] } },
    { id: "historical", label: "historical", parentTaskId: "job", profile: options.activeGrandchild ? "supervise" : "inspect", goal: "Historical superseded attempt", repositoryAliases: ["core"], budget: { maxModelRequests: 4 }, constraints: { acceptanceCriteria: ["historical attempt"] } },
  ]);
  expect([job!.taskId, child!.taskId]).toEqual(["job", "historical"]);
  sy.tasks.claim("fixture-owner", { maxConcurrent: 2, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000, supervisorProfiles: ["supervise"], maxSupervisors: 2 });
  const captured = capturedLease(sy.tasks.get("historical")!);
  const executionId = sy.admission.createExecution("task", options.activeGrandchild ? "supervise" : "inspect", [{ taskId: "historical", itemId: "historical" }]);
  // Four already-spent fixture reservations reach the historical task's original cap.
  for (let i = 0; i < 4; i++) {
    const reservation = sy.admission.reserve({ executionId, profile: options.activeGrandchild ? "supervise" : "inspect", purpose: "fixture-history", gatewayModel: "fixture/model", endpointId: "fixture/model", tier: "T3", estInputTokens: 8, reservedOutputTokens: 10, participants: [{ taskId: "historical", leaseOwner: "fixture-owner", lease: captured, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 0 }, estInputTokens: 8, reservedOutputTokens: 10 }] });
    sy.admission.reconcile(reservation, { kind: "uncertain", errorKind: "fixture_old_attempt", errorMessage: "Historical fixture request remains charged" });
  }
  if (options.activeGrandchild) sy.tasks.submit([WorkerTaskSchema.parse({ id: "grandchild", parentTaskId: "historical", profile: "inspect", goal: "Still queued descendant", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] } })], { project: "demo" });
  const terminal = options.terminal ?? "budget_exhausted";
  const result = { ...syntheticResult("historical", terminal, "historical superseded outcome"), acceptanceStatus: "unmet" as const, unresolvedCriteria: ["Historical attempt was not accepted"] };
  sy.tasks.finish("historical", "fixture-owner", result, terminal);
  const store = new ProductDeliveries(sy.db);
  const candidate: ProductCandidate = { repositories: { core: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo, encoding: "utf8" }).trim(), tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: env.repo, encoding: "utf8" }).trim() } }, testDigest: hash, recipeDigest: hash, environmentDigest: hash, dependencyDigest: hash, fixtureDigest: hash, browserGeneration: "fixture-browser" };
  store.saveSpec("job", "demo", specification); store.setCandidate("job", "demo", candidate);
  if (options.evidence !== false) for (const kind of specification.criteria[0]!.requiredEvidence) {
    const independent = kind === "visual" || kind === "independent_review";
    const at = Date.now();
    const evidence: EvidenceReceipt = { schemaVersion: 1, id: `fixture-${kind}`, criterionIds: ["behavior"], kind, specDigest: deliverySpecDigest(specification), candidateDigest: productCandidateDigest(candidate), actor: { id: independent ? "fixture-independent-reviewer" : "fixture-runtime", role: independent ? "reviewer" : "runtime" }, basis: "observed", outcome: "pass", startedAt: at, completedAt: at, expiresAt: null, artifactRefs: [sy.artifacts.write({ taskId: "job", kind: "fixture_observation", label: kind, content: `Controlled fixture observed ${kind} for ${productCandidateDigest(candidate)}` })], observations: [`Controlled current-candidate ${kind} observation`], unknowns: [], subjectActorIds: ["fixture-implementer"] };
    store.recordEvidence("job", "demo", evidence);
  }
  for (const stage of ["prepare", "plan", "implement", "integrate", "validate"] as const) store.transition("job", "demo", stage);
  if (options.evidence !== false && options.handoff !== false) store.transition("job", "demo", "handoff");
  if (options.completeJob !== false) sy.tasks.finish("job", "fixture-owner", syntheticResult("job", "completed", "supervisor_completed"), "completed");
  const decision = { schemaVersion: 1, decision: "accept", actor: { id: "FINAL", role: "initiator" }, specDigest: deliverySpecDigest(specification), candidateDigest: productCandidateDigest(candidate), reason: "Independent current fixture checks reviewed", at: Date.now() };
  return { store, candidate, decision, provider };
}
function history() {
  return { task: sy!.tasks.get("historical"), events: sy!.tasks.events("historical", 100), charges: sy!.db.prepare("SELECT * FROM request_charges WHERE task_id='historical' ORDER BY request_id").all(), requests: sy!.db.prepare("SELECT * FROM model_requests ORDER BY id").all(), totals: sy!.admission.taskTotals("historical") };
}

it.each(["budget_exhausted", "failed", "cancelled", "completed"] as const)("allows separate FINAL after a terminal %s historical attempt without rewriting it", async terminal => {
  const f = await fixture({ terminal }), before = history();
  expect(before.totals.requests).toBe(4);
  expect(f.store.status("job", "demo")).toMatchObject({ stage: "handoff", accepted: false, finalDecision: null, readiness: { status: "ready_for_final_review" } });
  sy!.cancelTasks(["historical"], "demo");
  expect(history()).toEqual(before);
  f.store.finalDecision("job", "demo", f.decision);
  expect(f.store.status("job", "demo")).toMatchObject({ accepted: true, finalDecision: { decision: "accept", actor: { id: "FINAL" } } });
  expect(history()).toEqual(before);
  expect(sy!.tasks.get("historical")!.result!.acceptanceStatus).toBe("unmet");
  expect(f.provider.requests).toHaveLength(0);
});
it("budget exhaustion never supplies missing observed evidence", async () => {
  const f = await fixture({ evidence: false }), before = history();
  expect(() => f.store.finalDecision("job", "demo", f.decision)).toThrow(/unresolved evidence/);
  expect(f.store.status("job", "demo")?.accepted).toBe(false);
  expect(history()).toEqual(before);
});
it.each(["queued", "waiting_for_dependencies", "waiting_for_capacity", "running", "cancel_requested", "interrupted"] as const)("still refuses unfinished descendant state %s", async state => {
  const f = await fixture();
  sy!.db.prepare("UPDATE tasks SET state=?,result_json=NULL,finished_at=NULL WHERE id='historical'").run(state);
  const before = history();
  expect(() => f.store.finalDecision("job", "demo", f.decision)).toThrow(/all delegated work to be terminal/);
  expect(history()).toEqual(before);
  expect(f.store.status("job", "demo")?.finalDecision).toBeNull();
});
it("still traverses an exhausted sub-supervisor to reject its active grandchild", async () => {
  const f = await fixture({ activeGrandchild: true }), before = history(), grandchild = sy!.tasks.get("grandchild");
  expect(() => f.store.finalDecision("job", "demo", f.decision)).toThrow(/all delegated work to be terminal/);
  expect(history()).toEqual(before); expect(sy!.tasks.get("grandchild")).toEqual(grandchild);
});
it.each(["handoff", "completed"] as const)("retains the required %s delivery boundary", async boundary => {
  const f = await fixture({ handoff: boundary !== "handoff", completeJob: boundary !== "completed" });
  expect(() => f.store.finalDecision("job", "demo", f.decision)).toThrow(/completed delivery at handoff/);
});
it.each(["specDigest", "candidateDigest"] as const)("refuses a mismatched exact %s despite terminal exhausted history", async field => {
  const f = await fixture();
  expect(() => f.store.finalDecision("job", "demo", { ...f.decision, [field]: "0".repeat(64) })).toThrow(/does not match current delivery/);
  expect(f.store.status("job", "demo")?.finalDecision).toBeNull();
});
it("new candidate identity still invalidates old observed evidence", async () => {
  const f = await fixture();
  const candidate = { ...f.candidate, repositories: { core: { head: "c".repeat(40), tree: "d".repeat(40) } } };
  f.store.setCandidate("job", "demo", candidate);
  expect(() => f.store.finalDecision("job", "demo", { ...f.decision, candidateDigest: productCandidateDigest(candidate) })).toThrow(/unresolved evidence/);
});
it("keeps project isolation while ignoring an unrelated foreign-project active descendant", async () => {
  const f = await fixture();
  sy!.tasks.submit([WorkerTaskSchema.parse({ id: "foreign", parentTaskId: "job", profile: "inspect", goal: "Foreign project fixture", constraints: { acceptanceCriteria: ["inspect"] } })], { project: "other" });
  const before = sy!.tasks.get("foreign");
  expect(() => f.store.finalDecision("job", "other", f.decision)).toThrow(/does not match current delivery/);
  f.store.finalDecision("job", "demo", f.decision);
  expect(f.store.status("job", "demo")?.accepted).toBe(true);
  expect(f.store.status("job", "other")).toBeNull(); expect(sy!.tasks.get("foreign")).toEqual(before);
});
