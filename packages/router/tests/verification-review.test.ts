import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { baseResult, type RunContext, type SupervisorServices } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { gradeReview, loadSuite, reviewEvalRevision, REVIEW_EVAL_POLICY } from "../src/qualification/runner.js";
import { qualificationStat } from "../src/qualification/stats.js";
import { validateVerdict } from "../src/verification/review.js";
import { autoCriterionId, WorkerTaskSchema, type WorkerResult } from "../src/core/task.js";
import { compileContract } from "../src/verification/contract.js";
import { budgetInputFor } from "../src/admission/admission.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

// The author routes first at T3 (most capable); the reviewer is another family on another platform.
const AUTHOR = endpoint({ providerId: "openrouter", gatewayModelId: "alpha/alpha-1:free", totalParametersB: 700 });
const REVIEWER = endpoint({ providerId: "groq", gatewayModelId: "beta/beta-2", totalParametersB: 400 });
const A = AUTHOR.id;
const B = REVIEWER.id;

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;
const has = (req: ChatRequest, tool: string) => !!req.tools?.some((t) => t.function.name === tool);
const isReviewer = (req: ChatRequest) => has(req, "submit_verdict");
const userText = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const isRepair = (req: ChatRequest) => userText(req).includes("Previous attempt");

/** What a scripted reviewer reads out of the evidence package. */
function pkg(req: ChatRequest) {
  const t = userText(req);
  return {
    revision: /examinedRevision: (\S+)/.exec(t)![1]!,
    policy: /policyVersion: (\S+)/.exec(t)![1]!,
    ids: [...t.matchAll(/^- (\S+) \[verify: /gm)].map((m) => m[1]!),
    patchRef: /## Patch against the base \((artifact:[A-Za-z0-9_-]+)/.exec(t)?.[1] ?? null,
    patchText: /```diff\n([\s\S]*?)```/.exec(t)?.[1] ?? "",
    logRefs: [...t.matchAll(/\(log (artifact:[A-Za-z0-9_-]+)\)/g)].map((m) => m[1]!),
    text: t,
  };
}

type Outcome = "pass" | "fail" | "inconclusive";
function verdict(req: ChatRequest, outcome: Outcome, o: { failId?: string; reason?: string; missing?: string[]; action?: string; targeted?: string[] } = {}) {
  const p = pkg(req);
  const ref = p.patchRef ?? p.logRefs[0] ?? "inline";
  const per = (id: string): Outcome => (outcome === "pass" ? "pass" : outcome === "fail" ? (id === (o.failId ?? p.ids[0]) ? "fail" : "pass") : id === (o.failId ?? p.ids[0]) ? "inconclusive" : "pass");
  return {
    verdict: outcome,
    examinedRevision: p.revision,
    policyVersion: p.policy,
    criteria: p.ids.map((id) => ({ id, outcome: per(id), evidenceRefs: per(id) === "inconclusive" ? [] : [ref], ...(per(id) !== "pass" ? { reason: o.reason ?? "see the patch" } : {}) })),
    blockingFindings: outcome === "fail" ? [{ description: o.reason ?? "defect", evidenceRefs: [ref], criterionId: o.failId ?? p.ids[0] }] : [],
    missingEvidence: outcome === "inconclusive" ? (o.missing ?? ["evidence not provided"]) : [],
    recommendedAction: o.action ?? (outcome === "pass" ? "accept" : outcome === "fail" ? "repair" : "needs_supervisor"),
    ...(o.targeted ? { targetedChecks: o.targeted } : {}),
  };
}

const CHECK = `node -e "process.exit(0)"`;
const SUB = { id: "sub", text: "subtract(a, b) returns a - b", verify: "review" };
const implement = (o: Record<string, unknown> = {}) => ({
  profile: "implement",
  label: "subtract",
  goal: "Add subtract(a, b) to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty: "T3" },
  constraints: { acceptanceCriteria: [SUB], allowedPaths: ["src/**"], checks: [CHECK] },
  ...o,
});
const ADD = "export function add";
const withSubtract = (body: string) => `export function subtract(a: number, b: number) {\n  return ${body};\n}\n\n${ADD}`;

/** A native coding author: attempt 1 writes subtract with `first`; a repair rewrites it to `fixed`. */
function codingAuthor(req: ChatRequest, first: string, fixed: string) {
  const s = servedFor(sy!, req);
  if (toolCount(req) === 0) {
    const edit = isRepair(req)
      ? call("replace_in_file", { path: "src/app.ts", old_text: `  return ${first};\n}\n\n${ADD}`, new_text: `  return ${fixed};\n}\n\n${ADD}` }, "e2")
      : call("replace_in_file", { path: "src/app.ts", old_text: ADD, new_text: withSubtract(first) }, "e1");
    return reply(null, { ...s, toolCalls: [edit] });
  }
  return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
}

function envWith(extra: Record<string, unknown> = {}, endpoints: unknown[] = [AUTHOR, REVIEWER], files?: Record<string, string>) {
  return makeEnv({ config: baseConfig({ coding: { runner: "native" }, ...extra }), endpoints, ...(files ? { files } : {}) });
}

async function result(id: string, seconds = 90) {
  const out = await sy!.awaitResults([id], { timeoutSeconds: seconds });
  expect(out.timedOut).toBe(false);
  return out.completed[0]!;
}

/** Requests charged to the task never exceed its contract's total, and review stays inside its allowance. */
function expectWithinAllocation(id: string) {
  const b = sy!.contract(id)!.contract.budget;
  const used = sy!.gate.admission.taskTotals(id).requests;
  const by = sy!.gate.admission.taskTotalsByPurpose(id);
  expect(used).toBeLessThanOrEqual(b.total);
  expect(by.verification).toBeLessThanOrEqual(b.review);
  expect(b.total).toBe(b.classification + b.execution + b.review + b.repair);
  expect(by.repair).toBeLessThanOrEqual(b.repair);
  expect(by.classification + by.execution).toBeLessThanOrEqual(b.classification + b.execution);
  return { used, by, budget: b };
}

describe("deep review", () => {
  it("passes a correct patch: an independent reviewer in a child session, purpose verification", async () => {
    env = envWith();
    const reviewerRequests: ChatRequest[] = [];
    sy = open(env, new ScriptedClient((req) => {
      if (isReviewer(req)) {
        reviewerRequests.push(structuredClone(req));
        return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] });
      }
      return codingAuthor(req, "a - b", "a - b");
    }), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(r.verification!.criteria).toEqual([expect.objectContaining({ id: "sub", outcome: "passed" })]);
    const [review] = r.verification!.reviews!;
    expect(review).toMatchObject({ attempt: 1, reviewer: B, verdict: "pass", qualified: false, flags: ["reviewer_unqualified"], qualification: "review" });
    // The reviewer saw the contract, the patch, and the check log, bound to the submitted revision.
    const p = pkg(reviewerRequests[0]!);
    expect(p.patchText).toContain("return a - b");
    expect(p.logRefs).toHaveLength(1);
    expect(p.text).toContain("Author's claim (unverified");
    expect(review!.revision).toBe(p.revision);
    // Independence: the author's endpoint served execution, never verification.
    const served = sy.gate.admission.servedEndpointsByPurpose(sub!.taskId);
    expect(served.execution).toEqual([A]);
    expect(served.verification).toEqual([B]);
    // The review is a child session of the implementer's session.
    const sessions = sy.sessions.list({ taskId: sub!.taskId });
    const impl = sessions.find((s) => s.role === "implementer")!;
    const rev = sessions.find((s) => s.role === "reviewer")!;
    expect(rev).toMatchObject({ parentSessionId: impl.id, status: "completed" });
    expect(review!.sessionId).toBe(rev.id);
    expectWithinAllocation(sub!.taskId);
  }, 120_000);

  it("fails a seeded defect, repairs once from the submitted revision, and passes the re-review", async () => {
    env = envWith();
    const authorRequests: ChatRequest[] = [];
    sy = open(env, new ScriptedClient((req) => {
      if (isReviewer(req)) {
        const ok = pkg(req).patchText.includes("return a - b");
        return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", ok ? verdict(req, "pass") : verdict(req, "fail", { failId: "sub", reason: "subtract returns a + b" }))] });
      }
      authorRequests.push(structuredClone(req));
      return codingAuthor(req, "a + b", "a - b");
    }), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const id = sub!.taskId;
    const r = await result(id);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(r.verification!.reviews!.map((x) => x.verdict)).toEqual(["fail", "pass"]);
    const events = sy.tasks.events(id, 500);
    // Exactly one repair, at T3 (no higher tier), continuing from the submitted revision.
    const repairs = events.filter((e) => e.type === "quality_repair");
    expect(repairs).toHaveLength(1);
    const start = (repairs[0]!.data as { startFrom: string | null }).startFrom;
    expect(start).toMatch(/^[0-9a-f]{40}$/);
    const ready = events.filter((e) => e.type === "worktree_ready").map((e) => e.data as { startCommit?: string });
    expect(ready).toHaveLength(2);
    expect(ready[1]!.startCommit).toBe(start);
    // The repair's brief carried the reviewer's finding; its edit only applies on top of attempt 1.
    const repairBrief = authorRequests.find((q) => isRepair(q) && toolCount(q) === 0)!;
    expect(userText(repairBrief)).toContain("Reviewer: subtract returns a + b");
    const patch = sy.artifacts.read(r.patchRefs[0]!)!.content.toString("utf8");
    expect(patch).toContain("+  return a - b;");
    expect(patch).not.toContain("+  return a + b;");
    expect(sy.sessions.list({ taskId: id }).filter((s) => s.role === "implementer")).toHaveLength(2);
    const { by } = expectWithinAllocation(id);
    expect(by.repair).toBeGreaterThan(0);
    expect(by.verification).toBe(2);
  }, 120_000);

  it("a defect only the reviewer sees, still there after the one repair, goes to the supervisor", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient((req) => {
      if (isReviewer(req)) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "fail", { failId: "sub", reason: "subtract is wrong" }))] });
      return codingAuthor(req, "a + b", "b - a");
    }), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "failed" });
    expect(r.verification!.reviews!.map((x) => x.verdict)).toEqual(["fail", "fail"]);
    expect(sy.tasks.events(sub!.taskId, 500).filter((e) => e.type === "quality_repair")).toHaveLength(1);
    expect(r.verification!.reasons.join("\n")).toMatch(/supervisor decides/);
    // The supervisor may overrule the reviewer (recorded), or reject.
    expect(sy.acceptTask(sub!.taskId, { by: { kind: "supervisor", id: "supervisor:job" }, reason: "b - a is what the caller expects here" }).acceptanceStatus).toBe("met");
    expectWithinAllocation(sub!.taskId);
  }, 120_000);

  it("repairs read-only work too: a failed criterion re-runs once and is re-reviewed", async () => {
    env = envWith();
    let authorRuns = 0;
    sy = open(env, new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isReviewer(req)) {
        const ok = pkg(req).text.includes("Summary: add is in src/app.ts");
        return reply(null, { ...s, toolCalls: [call("submit_verdict", ok ? verdict(req, "pass") : verdict(req, "fail", { reason: "names the wrong file" }))] });
      }
      if (toolCount(req) === 0) authorRuns++;
      const summary = isRepair(req) ? "add is in src/app.ts" : "add is in README.md";
      return reply(null, { ...s, toolCalls: [call("submit_result", { ...goodOutput(1, "inline"), summary })] });
    }), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Where is add defined?", repositoryAliases: ["core"], context: { inlineText: "src/app.ts defines add" }, hints: { difficulty: "T3" }, constraints: { acceptanceCriteria: ["names the file that defines add"] } }]);
    const r = await result(sub!.taskId);
    expect(authorRuns).toBe(2);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed", summary: "add is in src/app.ts" });
    expect(r.verification!.reviews!.map((x) => x.verdict)).toEqual(["fail", "pass"]);
    expectWithinAllocation(sub!.taskId);
  }, 120_000);
});

describe("missing evidence", () => {
  it("an inconclusive verdict goes to the supervisor without a repair", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isReviewer(req)) return reply(null, { ...s, toolCalls: [call("submit_verdict", verdict(req, "inconclusive", { missing: ["the production log the answer cites was not provided"], reason: "cannot see the log" }))] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "inline"))] });
    }), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "How often did signups fail last week?", repositoryAliases: ["core"], context: { inlineText: "no log attached" }, hints: { difficulty: "T3" }, constraints: { acceptanceCriteria: ["reports the count from the production log"] } }]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "inconclusive" });
    expect(r.verification!.reviews![0]).toMatchObject({ verdict: "inconclusive", missingEvidence: ["the production log the answer cites was not provided"] });
    expect(sy.tasks.events(sub!.taskId, 500).some((e) => e.type === "quality_repair")).toBe(false);
    expectWithinAllocation(sub!.taskId);
  }, 120_000);

  it("a targeted check the reviewer asks for runs once on the submitted revision, then the re-review decides", async () => {
    // A check nobody declared, which the coding allowlist permits (no shell metacharacters).
    const PROBE = "node probe.mjs";
    env = envWith({ coding: { runner: "native", allowed_commands: [PROBE] } }, [AUTHOR, REVIEWER], {
      "src/app.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "probe.mjs": 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("src/app.ts", "utf8").includes("a - b") ? 0 : 1);\n',
    });
    let reviews = 0;
    sy = open(env, new ScriptedClient((req) => {
      if (isReviewer(req)) {
        reviews++;
        const p = pkg(req);
        const probed = p.text.includes(`\`${PROBE}\` exit 0`);
        return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", probed ? verdict(req, "pass") : verdict(req, "inconclusive", { missing: ["no check exercises subtract"], action: "run_targeted_check", targeted: [PROBE] }))] });
      }
      return codingAuthor(req, "a - b", "a - b");
    }), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(reviews).toBe(2);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    const probe = r.checks.find((c) => c.command === PROBE)!;
    expect(probe).toMatchObject({ exitCode: 0, revision: r.checks[0]!.revision });
    expect(sy.tasks.events(sub!.taskId, 500).filter((e) => e.type === "targeted_check")).toHaveLength(1);
    expectWithinAllocation(sub!.taskId);
  }, 120_000);
});

describe("reviewer independence and qualification", () => {
  it("the author's endpoint never reviews: with no other model the review is inconclusive and no request is spent", async () => {
    env = envWith({}, [AUTHOR]);
    const client = new ScriptedClient((req) => {
      if (isReviewer(req)) throw new Error("the author must never review its own work");
      return codingAuthor(req, "a - b", "a - b");
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "inconclusive" });
    expect(r.verification!.reviews![0]).toMatchObject({ verdict: null, reviewer: null, stopReason: expect.stringMatching(/no eligible reviewer/) });
    expect(client.requests.some(isReviewer)).toBe(false);
    expect(sy.gate.admission.taskTotalsByPurpose(sub!.taskId).verification).toBe(0);
  }, 120_000);

  it("prefers another model family, even over a bigger model of the author's family", async () => {
    const sibling = endpoint({ providerId: "cerebras", gatewayModelId: "alpha/alpha-2", totalParametersB: 900 });
    env = envWith({}, [AUTHOR, sibling, REVIEWER]);
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const plan = sy.router.planReviewer({ profile: "review", tier: "T3", inputModalities: ["text"], avoidEndpoints: [A], avoidFamilies: ["alpha"], avoidProviders: ["openrouter"], minTotalParametersB: 100, reviewer: { family: "review", tier: "T3", threshold: 0.6, mode: "preferred", name: "review" } });
    expect(plan.candidates.map((c) => c.id)).toEqual([B, sibling.id]);
    expect(plan.explanations.find((e) => e.endpointId === A)!.reasons).toContain("served this task; an independent reviewer must be a different model");
  });

  it("reviewer_qualification required, or a strict level, refuses unqualified reviewers; qualified ones review", async () => {
    env = envWith({ verification: { reviewer_qualification: "required" } });
    const client = new ScriptedClient((req) => {
      if (isReviewer(req)) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] });
      return codingAuthor(req, "a - b", "a - b");
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const [first] = await sy.submitTasks([implement()]);
    const r1 = await result(first!.taskId);
    expect(r1).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "inconclusive" });
    expect(r1.verification!.reasons.join("\n")).toMatch(/no review-qualified reviewer/);
    expect(client.requests.some(isReviewer)).toBe(false);

    // Qualify the reviewer on T3 review evaluations (review and review_strict: 8 of 8 passes).
    sy.db.prepare("INSERT INTO qualification_runs (id, endpoint_id, suite_version, status, started_at) VALUES ('q1', ?, 'test', 'finished', 0)").run(B);
    for (let i = 0; i < 8; i++) sy.db.prepare("INSERT INTO qualification_results (run_id, endpoint_id, eval_id, family, tier, trial, outcome, created_at) VALUES ('q1', ?, ?, 'review', 'T3', 1, 'pass', 0)").run(B, `e${i}`);
    const [second] = await sy.submitTasks([implement({ label: "subtract-2" })]);
    const r2 = await result(second!.taskId);
    expect(r2).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(r2.verification!.reviews![0]).toMatchObject({ reviewer: B, qualified: true, flags: [] });

    // Strict (critical) needs review_strict: the same reviewer qualifies, and acceptance stays with the supervisor.
    const [third] = await sy.submitTasks([implement({ label: "subtract-3", importance: "critical", importanceReason: "billing" })]);
    const r3 = await result(third!.taskId);
    expect(r3).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "passed" });
    expect(r3.verification!.reviews![0]).toMatchObject({ reviewer: B, qualified: true, qualification: "review_strict" });
  }, 180_000);
});

describe("budget", () => {
  it("the total is what is reserved (classification + execution + review + repair); 24 is only the ceiling", () => {
    env = makeEnv();
    const total = (raw: Record<string, unknown>, tier: "T1" | "T2" | "T3") => {
      const spec = WorkerTaskSchema.parse(raw);
      const r = compileContract({ taskId: "t", spec, tier, tags: null, rulebookFingerprint: null, policy: env!.cfg.verification, budget: budgetInputFor(env!.cfg, spec, tier, 0), now: 0 });
      if (!r.ok) throw new Error(r.message);
      return { level: r.contract.verification.level, ...r.contract.budget };
    };
    const analyze = { profile: "analyze", goal: "Why does it crash?", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["root cause"] } };
    const impl = { profile: "implement", goal: "Add subtract", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } };
    // summarize T1 standard: execution 4, one repair at T2 (4), no review.
    expect(total(summarizeTask(), "T1")).toEqual({ level: "standard", total: 8, classification: 0, execution: 4, review: 0, repair: 4, unallocated: 16 });
    // implement T2 standard: execution 8, a repair at T3 (8), and the deep review its repaired result needs (4).
    expect(total(impl, "T2")).toEqual({ level: "standard", total: 20, classification: 0, execution: 8, review: 4, repair: 8, unallocated: 4 });
    // analyze T3 deep: execution 6, review 4, a repair at T3 (6).
    expect(total(analyze, "T3")).toEqual({ level: "deep", total: 16, classification: 0, execution: 6, review: 4, repair: 6, unallocated: 8 });
    // strict (critical summarize at T1): execution 4, review 6, a repair at T2 (4; still strict there).
    expect(total(summarizeTask({ importance: "critical", importanceReason: "billing" }), "T1")).toEqual({ level: "strict", total: 14, classification: 0, execution: 4, review: 6, repair: 4, unallocated: 10 });
    // An explicit task budget is the ceiling: review is never dropped, execution and repair shrink.
    expect(total(summarizeTask({ importance: "critical", importanceReason: "billing", budget: { maxModelRequests: 9 } }), "T1")).toEqual({ level: "strict", total: 9, classification: 0, execution: 3, review: 6, repair: 0, unallocated: 0 });
  });

  it("a level raised by the actual result draws its review from the room under the ceiling, or ends skipped_budget", async () => {
    // Standard T2 coding with same-tier repairs (no T3 review reserved up front); a changed path
    // under src/auth/** raises it to deep on the result.
    env = makeEnv({
      config: baseConfig({ routing: { escalate_on_failure: false }, verification: { rules: [{ id: "auth-deep", when: { changed_paths: ["src/auth/**"] }, require_at_least: "deep" }] } }),
      endpoints: [AUTHOR, REVIEWER],
    });
    const coding = {
      run: async (ctx: RunContext) => ({
        state: "completed" as const,
        result: baseResult({
          stopReason: "worker_submitted",
          summary: "added login",
          checks: [{ command: CHECK, exitCode: 0, logRef: ctx.artifacts.write({ taskId: ctx.taskId, kind: "check_log", label: CHECK, content: "exit 0\n", extension: ".log" }), revision: "tree-1" }],
          changedPaths: ["src/auth/login.ts"],
          scopeViolation: [],
          protectedPathsChanged: [],
          baseCommits: { core: "0".repeat(40) },
        }),
        evidence: { revision: "tree-1" },
      }),
    };
    sy = open(env, new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] })), { worker: true, coding });
    const task = (o: Record<string, unknown> = {}) => implement({ hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["login exists"], allowedPaths: ["src/**"], checks: [CHECK] }, ...o });

    const [roomy] = await sy.submitTasks([task({ label: "roomy" })]);
    const r1 = await result(roomy!.taskId);
    const b1 = sy.contract(roomy!.taskId)!.contract.budget;
    expect(b1).toMatchObject({ total: 16, execution: 8, review: 0, repair: 8, unallocated: 8 });
    expect(r1.verification).toMatchObject({ level: "deep", raisedFrom: "standard" });
    expect(r1).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(r1.verification!.reviews![0]).toMatchObject({ verdict: "pass", reviewer: expect.any(String) });
    const raised = sy.tasks.events(roomy!.taskId, 200).find((e) => e.type === "verification_raised")!;
    expect(raised.data).toMatchObject({ from: "standard", to: "deep", reserveAdjustment: { review: { from: 0, to: 4, fromUnallocated: 4, wanted: 4 } } });
    const used1 = sy.gate.admission.taskTotalsByPurpose(roomy!.taskId);
    expect(used1.verification).toBeGreaterThan(0);
    expect(used1.verification).toBeLessThanOrEqual(4);
    expect(sy.gate.admission.taskTotals(roomy!.taskId).requests).toBeLessThanOrEqual(b1.total + b1.unallocated);

    // An explicit budget of 16 leaves no room: the level stays deep and the review is skipped.
    // (Another goal: the same contract and revision would reuse the first task's cached verdict.)
    const [tight] = await sy.submitTasks([task({ label: "tight", goal: "Add login to src/auth/login.ts", budget: { maxModelRequests: 16 } })]);
    const r2 = await result(tight!.taskId);
    expect(sy.contract(tight!.taskId)!.contract.budget).toMatchObject({ total: 16, unallocated: 0 });
    expect(r2.verification).toMatchObject({ level: "deep", raisedFrom: "standard" });
    expect(r2).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "skipped_budget" });
    expect(r2.verification!.reasons.join("\n")).toMatch(/deep review needs 4 request\(s\); the contract reserved 0 and only 0 more fit under the ceiling/);
    expect(sy.gate.admission.taskTotalsByPurpose(tight!.taskId).verification).toBe(0);
  }, 120_000);

  it("total requests never exceed the contract allocation, even when the reviewer never decides", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient((req) => {
      // A reviewer that keeps reading and never submits.
      if (isReviewer(req)) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("read_file", { alias: "core", path: "src/app.ts" }, `r${toolCount(req)}`)] });
      return codingAuthor(req, "a - b", "a - b");
    }), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement()]);
    const r = await result(sub!.taskId);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "skipped_budget" });
    const { by, budget } = expectWithinAllocation(sub!.taskId);
    // Half the allowance is kept for a re-review while a repair is possible: 2 of 4.
    expect(budget.review).toBe(4);
    expect(by.verification).toBe(2);
  }, 120_000);

  it("reserves sit on top of a small profile cap; only an explicit task budget can be too small", async () => {
    env = makeEnv({ config: baseConfig({ profiles: { ...(baseConfig().profiles as Record<string, unknown>), summarize: { mode: "completion", min_total_parameters_b: 30, max_model_requests: 2, max_output_tokens: 2000, classify: "never" } } }), endpoints: [AUTHOR, REVIEWER] });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))));
    // Strict needs 6 review requests; summarize's execution cap is 2: accepted, total 24.
    const [ok] = await sy.submitTasks([summarizeTask({ importance: "critical", importanceReason: "billing data" })]);
    expect(ok!.state).toBe("queued");
    await expect(sy.submitTasks([summarizeTask({ importance: "critical", importanceReason: "billing data", budget: { maxModelRequests: 6 } })])).rejects.toThrow(/verification_budget_insufficient/);
  });
});

describe("integrate_task", () => {
  it("records the acceptance only after the integration succeeded", async () => {
    env = envWith();
    // T2 with no checks: not_verified, so integrating needs accept: true and a reason.
    sy = open(env, new ScriptedClient((req) => codingAuthor(req, "a - b", "a - b")), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([implement({ hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } })]);
    const id = sub!.taskId;
    expect((await result(id)).acceptanceStatus).toBe("not_verified");

    // A job integration worktree whose branch conflicts with the task's edit.
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString();
    const base = git(env.repo, "rev-parse", "HEAD").trim();
    const wt = path.join(env.dir, "job-wt");
    git(env.repo, "worktree", "add", "-q", "-b", "job", wt, base);
    git(wt, "rm", "-q", "src/app.ts");
    git(wt, "commit", "-q", "-m", "conflicting change");
    const s = sy;
    const services: SupervisorServices = {
      submitTasks: (raw, o) => s.submitTasks(raw, o),
      awaitResults: (ids, o) => s.awaitResults(ids, o),
      getTask: (x) => {
        const t = s.tasks.get(x);
        return t ? { spec: t.spec, state: t.row.state, result: t.result } : null;
      },
      cancelTasks: (ids) => s.cancelTasks(ids),
      acceptTask: (x, i) => s.acceptTask(x, i),
      rejectTask: (x, i) => s.rejectTask(x, i),
    };
    const st: SupervisorState = {
      ctx: { services, taskId: "job-1", cfg: env.cfg, signal: new AbortController().signal } as unknown as RunContext,
      db: s.db,
      actor: { agent: "supervisor:job", role: "supervisor", model: null, job: "job-1", task: "job-1", tier: "T3" },
      repos: new Map([["core", { alias: "core", worktree: wt, branch: "job", baseSha: base }]]),
      briefChecks: new Set(),
      children: new Map([["subtract", id]]),
    };
    const integrate = supervisorTools(st).find((t) => t.def.function.name === "integrate_task")!;
    const decisions = () => (s.tasks.get(id)!.result as WorkerResult).verification!.decisions;

    const conflict = await integrate.run({ task_id: "subtract", accept: true, reason: "read the patch" }, {} as HarnessEnv);
    expect(conflict).toMatch(/conflict integrating .* no acceptance was recorded/);
    expect(decisions()).toEqual([]);
    expect(s.tasks.get(id)!.result!.acceptanceStatus).toBe("not_verified");

    git(wt, "reset", "-q", "--hard", base);
    const done = await integrate.run({ task_id: "subtract", accept: true, reason: "read the patch" }, {} as HarnessEnv);
    expect(done).toMatch(/integrated 1 commit\(s\).*your acceptance is recorded/);
    expect(decisions()).toEqual([expect.objectContaining({ decision: "accepted", reason: "read the patch" })]);
    expect(s.tasks.get(id)!.result!.acceptanceStatus).toBe("met");
    git(env.repo, "worktree", "remove", "--force", wt);
  }, 120_000);
});

describe("reviewer qualification", () => {
  const reviewEvals = () => loadSuite().evals.filter((e) => e.family === "review");
  const ids = (e: ReturnType<typeof reviewEvals>[number]) => e.task.acceptanceCriteria.map((_, i) => autoCriterionId(i));
  const asResult = (data: unknown) => ({ executionStatus: "completed" as const, stopReason: "worker_submitted", data });

  it("grading on per-criterion outcomes rejects an approve-everything reviewer and qualifies an accurate one", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const evals = reviewEvals();
    expect(evals.length).toBeGreaterThanOrEqual(8);
    sy.db.prepare("INSERT INTO qualification_runs (id, endpoint_id, suite_version, status, started_at) VALUES ('q1', 'x', 'test', 'finished', 0)").run();
    const record = (endpointId: string, e: (typeof evals)[number], outcome: string) =>
      sy!.db.prepare("INSERT INTO qualification_results (run_id, endpoint_id, eval_id, family, tier, trial, outcome, created_at) VALUES ('q1', ?, ?, 'review', ?, 1, ?, 0)").run(endpointId, e.id, e.tier, outcome);

    for (const e of evals) {
      const approveAll = { verdict: "pass", examinedRevision: reviewEvalRevision(e), policyVersion: REVIEW_EVAL_POLICY, criteria: ids(e).map((id) => ({ id, outcome: "pass", evidenceRefs: ["inline"] })), blockingFindings: [], missingEvidence: [], recommendedAction: "accept" };
      const g = gradeReview(e, asResult(approveAll));
      expect(g.outcome, `${e.id}: ${g.detail}`).toBe(e.review!.kind === "correct" || e.review!.kind === "style" ? "pass" : "fail");
      record("approver", e, g.outcome);

      const exp = e.review!.expect;
      const accurate = {
        verdict: exp.verdict,
        examinedRevision: reviewEvalRevision(e),
        policyVersion: REVIEW_EVAL_POLICY,
        criteria: ids(e).map((id) => {
          const want = exp.criteria[id]!;
          const outcome = Array.isArray(want) ? want[0]! : want;
          return { id, outcome, evidenceRefs: outcome === "inconclusive" ? [] : ["inline"], ...(outcome !== "pass" ? { reason: "see the evidence" } : {}) };
        }),
        blockingFindings: exp.verdict === "fail" ? [{ description: "defect", evidenceRefs: ["inline"] }] : [],
        missingEvidence: exp.verdict === "inconclusive" ? ["the evidence is not in the package"] : [],
        recommendedAction: exp.verdict === "pass" ? "accept" : exp.verdict === "fail" ? "repair" : "needs_supervisor",
      };
      const a = gradeReview(e, asResult(accurate));
      expect(a.outcome, `${e.id}: ${a.detail}`).toBe("pass");
      record("accurate", e, a.outcome);
    }
    // Counted over every tier from T1 up: the approver passes half (correct and style kinds).
    expect(qualificationStat(sy.db, env.cfg, "approver", "review", "T1")).toMatchObject({ passRate: 0.5, qualified: false });
    expect(qualificationStat(sy.db, env.cfg, "accurate", "review", "T1")).toMatchObject({ passRate: 1, qualified: true });
  });

  it("a malformed or unbound verdict fails grading", () => {
    const e = reviewEvals().find((x) => x.review!.kind === "defect")!;
    expect(gradeReview(e, asResult({ verdict: "fail" })).outcome).toBe("fail");
    const wrongRevision = { verdict: "pass", examinedRevision: "eval-other", policyVersion: REVIEW_EVAL_POLICY, criteria: ids(e).map((id) => ({ id, outcome: "pass", evidenceRefs: ["inline"] })), blockingFindings: [], missingEvidence: [], recommendedAction: "accept" };
    expect(gradeReview(e, asResult(wrongRevision)).detail).toMatch(/examinedRevision/);
    // Internally inconsistent: a failed criterion under a pass verdict.
    const v = validateVerdict({ ...wrongRevision, examinedRevision: reviewEvalRevision(e), criteria: ids(e).map((id, i) => ({ id, outcome: i === 0 ? "fail" : "pass", evidenceRefs: ["inline"], reason: "x" })) }, { criteria: ids(e).map((id) => ({ id })), revision: reviewEvalRevision(e), policyVersion: REVIEW_EVAL_POLICY, universe: null });
    expect(v.ok).toBe(false);
  });

  it("a review eval runs through the pipeline pinned to one model and is graded on its verdict", async () => {
    env = envWith({ qualification: { min_trials: 1 } });
    // An approve-everything model.
    sy = open(env, new ScriptedClient((req) => {
      const t = userText(req);
      const revision = /examinedRevision: (\S+)/.exec(t)![1]!;
      const ids2 = [...t.matchAll(/^- (\S+) \[verify: /gm)].map((m) => m[1]!);
      const data = { verdict: "pass", examinedRevision: revision, policyVersion: REVIEW_EVAL_POLICY, criteria: ids2.map((id) => ({ id, outcome: "pass", evidenceRefs: ["inline"] })), blockingFindings: [], missingEvidence: [], recommendedAction: "accept" };
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", { ...goodOutput(1, "inline"), data })] });
    }), { worker: true });
    const run = await sy.qualifier.start(A, { evalIds: ["review-range-correct", "review-range-defect"], trials: 1 });
    const until = Date.now() + 60_000;
    let rows: Array<{ eval_id: string; outcome: string; family: string }> = [];
    while (Date.now() < until) {
      await sy.qualifier.gradePending();
      rows = sy.db.prepare("SELECT eval_id, outcome, family FROM qualification_results WHERE run_id = ? ORDER BY eval_id").all(run.runId) as typeof rows;
      if (rows.length === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(rows).toEqual([
      { eval_id: "review-range-correct", outcome: "pass", family: "review" },
      { eval_id: "review-range-defect", outcome: "fail", family: "review" },
    ]);
  }, 120_000);
});
