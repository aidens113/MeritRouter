import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { baseResult, type RunContext, type SupervisorServices } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { revertCommits } from "../src/attribution/index.js";
import { auditSampled } from "../src/verification/audit.js";
import { cachedVerdict, calibrationUndoHook, sameRevision, taskConfirmation, verdictOutcome, verdictRecords } from "../src/verification/calibration.js";
import { calibrationOverview, usageByPurpose } from "../src/admin/calibration.js";
import { baseConfig, commitAll, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

// The author routes first (most capable); the reviewer is another family on another platform.
const AUTHOR = endpoint({ providerId: "openrouter", gatewayModelId: "alpha/alpha-1:free", totalParametersB: 700 });
const REVIEWER = endpoint({ providerId: "groq", gatewayModelId: "beta/beta-2", totalParametersB: 400 });
const A = AUTHOR.id;
const B = REVIEWER.id;

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const toolCount = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").length;
const isReviewer = (req: ChatRequest) => !!req.tools?.some((t) => t.function.name === "submit_verdict");
const userText = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const isRepair = (req: ChatRequest) => userText(req).includes("Previous attempt");
const isAudit = (req: ChatRequest) => userText(req).includes("Audit: review the submitted work");

/** A verdict bound to the evidence package the reviewer (or auditor) was shown. */
function verdict(req: ChatRequest, outcome: "pass" | "fail", policy?: string) {
  const t = userText(req);
  const ids = [...t.matchAll(/^- (\S+) \[verify: /gm)].map((m) => m[1]!);
  const ref = /## Patch against the base \((artifact:[A-Za-z0-9_-]+)/.exec(t)?.[1] ?? /\(log (artifact:[A-Za-z0-9_-]+)\)/.exec(t)?.[1] ?? "inline";
  return {
    verdict: outcome,
    examinedRevision: /examinedRevision: (\S+)/.exec(t)![1]!,
    policyVersion: policy ?? /policyVersion: (\S+)/.exec(t)![1]!,
    criteria: ids.map((id) => ({ id, outcome, evidenceRefs: [ref], ...(outcome === "fail" ? { reason: "wrong" } : {}) })),
    blockingFindings: outcome === "fail" ? [{ description: "the answer is wrong", evidenceRefs: [ref] }] : [],
    missingEvidence: [],
    recommendedAction: outcome === "pass" ? "accept" : "repair",
  };
}

function envWith(extra: Record<string, unknown> = {}) {
  return makeEnv({ config: baseConfig({ coding: { runner: "native" }, ...extra }), endpoints: [AUTHOR, REVIEWER] });
}

async function result(id: string, seconds = 90) {
  const out = await sy!.awaitResults([id], { timeoutSeconds: seconds });
  expect(out.timedOut).toBe(false);
  return out.completed[0]!;
}

const CHECK = `node -e "process.exit(0)"`;
const deps = () => ({ db: sy!.db, tasks: sy!.tasks, artifacts: sy!.artifacts });

describe("verdict records and the verdict cache", () => {
  /** A coding runner that submits the same revision (tree-1) every time, except for the task labelled "other". */
  const fixedRevision = {
    run: async (ctx: RunContext) => {
      const revision = ctx.spec.label === "other" ? "tree-2" : "tree-1";
      return {
        state: "completed" as const,
        result: baseResult({
          stopReason: "worker_submitted",
          summary: "added login",
          checks: [{ command: CHECK, exitCode: 0, logRef: ctx.artifacts.write({ taskId: ctx.taskId, kind: "check_log", label: CHECK, content: "exit 0\n", extension: ".log" }), revision }],
          changedPaths: ["src/login.ts"],
          scopeViolation: [],
          protectedPathsChanged: [],
          baseCommits: { core: "0".repeat(40) },
        }),
        evidence: { revision },
      };
    },
  };
  const task = (o: Record<string, unknown> = {}) => ({
    profile: "implement",
    goal: "Add login to src/login.ts",
    repositoryAliases: ["core"],
    writableRepository: "core",
    hints: { difficulty: "T3" },
    constraints: { acceptanceCriteria: ["login exists"], allowedPaths: ["src/**"], checks: [CHECK] },
    ...o,
  });

  it("records each verdict and reuses a decisive one for the same contract, artifact, policy, and sources, never for a higher level", async () => {
    env = envWith();
    let reviews = 0;
    sy = open(env, new ScriptedClient((req) => {
      reviews++;
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] });
    }), { worker: true, coding: fixedRevision });

    const [first] = await sy.submitTasks([task({ label: "first" })]);
    const r1 = await result(first!.taskId);
    expect(r1).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(reviews).toBe(1);
    const [rec1] = verdictRecords(sy.db, { taskId: first!.taskId });
    // (This runner makes no model request, so any endpoint is independent of the author.)
    expect(rec1).toMatchObject({ purpose: "verification", reviewer: expect.any(String), level: "deep", verdict: "pass", qualified: false, revision: "tree-1", cachedFrom: null });
    expect(rec1!.cacheKey).toMatch(/^vk-/);
    expect(rec1!.requests).toBeGreaterThan(0);

    // The same contract and revision on another task: the verdict is reused, no reviewer runs.
    const [second] = await sy.submitTasks([task({ label: "second" })]);
    const r2 = await result(second!.taskId);
    expect(r2).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    expect(reviews).toBe(1);
    expect(sy.gate.admission.taskTotalsByPurpose(second!.taskId).verification).toBe(0);
    expect(r2.verification!.reviews![0]).toMatchObject({ verdict: "pass", reviewer: rec1!.reviewer, requests: 0, sessionId: null, flags: expect.arrayContaining(["cached_verdict"]) });
    expect(verdictRecords(sy.db, { taskId: second!.taskId })[0]).toMatchObject({ cachedFrom: rec1!.id, cacheKey: rec1!.cacheKey, requests: 0 });
    expect(sy.tasks.events(second!.taskId, 200).find((e) => e.type === "review_cached")?.data).toMatchObject({ from: rec1!.id, fromTask: first!.taskId });

    // Another revision is another artifact: the reviewer runs.
    const [other] = await sy.submitTasks([task({ label: "other" })]);
    await result(other!.taskId);
    expect(reviews).toBe(2);

    // A higher level (strict) is never satisfied by a deep verdict: no reuse (and no review_strict reviewer here).
    const [strict] = await sy.submitTasks([task({ label: "strict", importance: "critical", importanceReason: "auth" })]);
    const r4 = await result(strict!.taskId);
    expect(r4.verification!.level).toBe("strict");
    expect(sy.tasks.events(strict!.taskId, 200).some((e) => e.type === "review_cached")).toBe(false);
    expect(r4.verification!.reviews?.[0]?.flags ?? []).not.toContain("cached_verdict");
  }, 120_000);

  it("is off with verification.cache_verdicts: false", async () => {
    env = envWith({ verification: { cache_verdicts: false } });
    let reviews = 0;
    sy = open(env, new ScriptedClient((req) => {
      reviews++;
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] });
    }), { worker: true, coding: fixedRevision });
    for (const label of ["one", "two"]) await result((await sy.submitTasks([task({ label })]))[0]!.taskId);
    expect(reviews).toBe(2);
    expect(verdictRecords(sy.db).map((v) => v.cachedFrom)).toEqual([null, null]);
  }, 120_000);
});

describe("confirmation signals", () => {
  const ADD = "export function add";
  /** A native coding author that adds subtract(a, b), then submits. */
  function codingAuthor(req: ChatRequest) {
    const s = servedFor(sy!, req);
    if (toolCount(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: ADD, new_text: `export function subtract(a: number, b: number) {\n  return a - b;\n}\n\n${ADD}` }, "e1")] });
    return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
  }

  it("integration and a passing job check confirm a passed result; a seeded undo makes the pass a false approval", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient((req) => (isReviewer(req) ? reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", verdict(req, "pass"))] }) : codingAuthor(req))), { worker: true, coding: createCodingRunner(env.cfg) });
    const [sub] = await sy.submitTasks([
      {
        profile: "implement",
        label: "subtract",
        goal: "Add subtract(a, b) to src/app.ts",
        repositoryAliases: ["core"],
        writableRepository: "core",
        hints: { difficulty: "T3" },
        constraints: { acceptanceCriteria: [{ id: "sub", text: "subtract(a, b) returns a - b", verify: "review" }], allowedPaths: ["src/**"], checks: [CHECK] },
      },
    ]);
    const id = sub!.taskId;
    const r = await result(id);
    expect(r).toMatchObject({ acceptanceStatus: "met", verificationStatus: "passed" });
    // The criterion_evidence row reflects the criterion the review passed (it was pending_review before).
    expect(r.verification!.checks.find((c) => c.name === "criterion_evidence")).toMatchObject({ outcome: "passed", detail: "sub: passed (review)" });
    const [v] = verdictRecords(sy.db, { taskId: id });
    expect(v).toMatchObject({ verdict: "pass", reviewer: B });
    expect(taskConfirmation(deps(), id)).toMatchObject({ status: "unconfirmed" });
    expect(verdictOutcome(v!, taskConfirmation(deps(), id)!)).toBe("pending");
    // The verdict is in the cache for its level and below, never for a higher level or for its own author.
    const lookup = (o: Partial<Parameters<typeof cachedVerdict>[1]> = {}) => cachedVerdict(deps(), { key: v!.cacheKey!, level: "deep", qualification: "review", requirementMode: "preferred", avoid: [], ...o })?.id ?? null;
    expect(lookup()).toBe(v!.id);
    expect(lookup({ level: "standard" })).toBe(v!.id);
    expect(lookup({ level: "strict", qualification: "review_strict", requirementMode: "required" })).toBeNull();
    expect(lookup({ avoid: [B] })).toBeNull();
    expect(lookup({ requirementMode: "required" })).toBeNull(); // the reviewer was not qualified

    // A job integration worktree; the supervisor integrates, runs the job check, then undoes the task.
    const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, stdio: "pipe" }).toString();
    const base = git(env.repo, "rev-parse", "HEAD").trim();
    const wt = path.join(env.dir, "job-wt");
    git(env.repo, "worktree", "add", "-q", "-b", "job", wt, base);
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
      ctx: { services, taskId: "job-1", cfg: env.cfg, signal: new AbortController().signal, tasks: s.tasks, artifacts: s.artifacts } as unknown as RunContext,
      db: s.db,
      actor: { agent: "supervisor:job", role: "supervisor", model: null, job: "job-1", task: "job-1", tier: "T3" },
      repos: new Map([["core", { alias: "core", worktree: wt, branch: "job", baseSha: base }]]),
      briefChecks: new Set([CHECK]),
      children: new Map([["subtract", id]]),
    };
    const tool = (name: string) => supervisorTools(st).find((t) => t.def.function.name === name)!;
    expect(await tool("integrate_task").run({ task_id: "subtract" }, {} as HarnessEnv)).toMatch(/integrated 1 commit\(s\)/);
    expect(await tool("run_check").run({ command: CHECK }, {} as HarnessEnv)).toMatch(/exit 0/);
    const confirmed = taskConfirmation(deps(), id)!;
    expect(confirmed).toMatchObject({ status: "confirmed", jobChecks: { passed: 1, failed: 0, outcome: "passed" } });
    expect(confirmed.integratedAt).not.toBeNull();
    expect(verdictOutcome(v!, confirmed)).toBe("correct");
    expect(sy.tasks.events(id, 200).some((e) => e.type === "integrated")).toBe(true);

    // The supervisor later undoes the task's change through attribution: an escaped defect.
    expect(await tool("undo").run({ kind: "task", target: "subtract", reason: "subtract breaks the calculator contract" }, {} as HarnessEnv)).toMatch(/reverted 1 commit/);
    const escaped = taskConfirmation(deps(), id)!;
    expect(escaped).toMatchObject({ status: "escaped_defect" });
    expect(escaped.reasons.join(" ")).toMatch(/undone through attribution: subtract breaks/);
    expect(verdictOutcome(v!, escaped)).toBe("false_approval");
    expect(sy.tasks.events(id, 200).find((e) => e.type === "undone")?.data).toMatchObject({ kind: "commits", reason: "subtract breaks the calculator contract", by: "supervisor:job" });

    const view = calibrationOverview(sy);
    expect(view.reviewers.find((x) => x.reviewer === B)).toMatchObject({ reviews: 1, pass: 1, falseApprovals: 1, confirmedCorrect: 0, falseRejections: 0, acceptedTasks: 1 });
    expect(view.verified[0]).toMatchObject({ level: "all", passed: 1, escaped: 1, confirmed: 0 });
    expect(view.verified.find((x) => x.level === "deep")).toMatchObject({ passed: 1, escaped: 1 });
    expect(view.contradicted.map((x) => [x.taskId, x.outcome])).toEqual([[id, "false_approval"]]);
    // A verdict calibration contradicted is never reused from the cache.
    expect(lookup()).toBeNull();
    git(env.repo, "worktree", "remove", "--force", wt);
  }, 120_000);

  it("a reviewer fail overturned by acceptance is a false rejection; the fail that led to a repair is not judged", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isReviewer(req)) return reply(null, { ...s, toolCalls: [call("submit_verdict", verdict(req, "fail"))] });
      return reply(null, { ...s, toolCalls: [call("submit_result", { ...goodOutput(1, "inline"), summary: isRepair(req) ? "add is in src/app.ts (rechecked)" : "add is in src/app.ts" })] });
    }), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Where is add defined?", repositoryAliases: ["core"], context: { inlineText: "src/app.ts defines add" }, hints: { difficulty: "T3" }, constraints: { acceptanceCriteria: ["names the file that defines add"] } }]);
    const id = sub!.taskId;
    const r = await result(id);
    expect(r).toMatchObject({ acceptanceStatus: "needs_supervisor", verificationStatus: "failed" });
    const recs = verdictRecords(sy.db, { taskId: id });
    expect(recs.map((x) => x.verdict)).toEqual(["fail", "fail"]);
    expect(sameRevision(recs[0]!.revision, recs[1]!.revision)).toBe(false);

    sy.acceptTask(id, { by: { kind: "human", id: "cli:test" }, reason: "the answer is right; the reviewer misread it" });
    const c = taskConfirmation(deps(), id)!;
    expect(c).toMatchObject({ status: "confirmed", decision: { decision: "accepted", by: "human:cli:test" } });
    expect(recs.map((x) => verdictOutcome(x, c))).toEqual(["led_to_repair", "false_rejection"]);
    const view = calibrationOverview(sy);
    expect(view.reviewers.find((x) => x.reviewer === B)).toMatchObject({ reviews: 2, fail: 2, falseRejections: 1, ledToRepair: 1, falseApprovals: 0 });
    expect(view.totals).toMatchObject({ verdicts: 2, decisive: 2, inconclusive: 0, inconclusiveRate: 0, falseRejections: 1 });
  }, 120_000);

  it("the undo hook records every task whose commits an undo took back", async () => {
    env = envWith();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: env!.repo, stdio: "pipe" }).toString();
    const [t1] = await sy.submitTasks([{ profile: "summarize", goal: "one", context: { inlineText: "x" }, constraints: { acceptanceCriteria: ["y"] } }]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(env.repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "change a", "--trailer", `Task: ${t1!.taskId}`, "--trailer", "Agent: implementer:x");
    writeFileSync(path.join(env.repo, "b.txt"), "b\n");
    commitAll(env.repo, "unattributed change");
    const head = git("rev-parse", "HEAD").trim();
    const first = git("rev-parse", "HEAD~1").trim();
    await revertCommits(env.repo, [first, head], { agent: "human", role: "human" }, "both wrong", { onUndone: calibrationUndoHook(sy.db, sy.tasks, { jobId: null, now: Date.now }) });
    const rows = sy.db.prepare("SELECT task_id, kind FROM verification_signals").all();
    expect(rows).toEqual([{ task_id: t1!.taskId, kind: "undone" }]);
  }, 60_000);
});

describe("audit sampling", () => {
  it("samples deterministically and is off by default", () => {
    expect(auditSampled("t_x", 0)).toBe(false);
    expect(auditSampled("t_x", 1)).toBe(true);
    const ids = Array.from({ length: 400 }, (_, i) => `t_${i}`);
    const share = ids.filter((id) => auditSampled(id, 0.25)).length / ids.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.35);
    expect(ids.map((id) => auditSampled(id, 0.25))).toEqual(ids.map((id) => auditSampled(id, 0.25)));
    env = envWith();
    expect(env.cfg.verification.audit_sample_rate).toBe(0);
  });

  it("audits a passed result in the background with purpose audit; it never changes acceptance", async () => {
    env = envWith({ verification: { audit_sample_rate: 1 } });
    sy = open(env, new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      // The auditor disagrees: an audit verdict is recorded, the accepted result stays as it is.
      if (isAudit(req)) return reply(null, { ...s, toolCalls: [call("submit_result", { ...goodOutput(1, "inline"), data: verdict(req, "fail") })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "inline"))] });
    }), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Where is add defined?", repositoryAliases: ["core"], context: { inlineText: "src/app.ts defines add" }, hints: { difficulty: "T1" }, constraints: { acceptanceCriteria: ["names the file"] } }]);
    const id = sub!.taskId;
    const r = await result(id);
    expect(r.verificationStatus).toBe("passed");
    const before = { acceptance: r.acceptanceStatus, by: sy.gate.admission.taskTotalsByPurpose(id) };

    // The scheduler's tick sweeps; wait for the audit to be recorded.
    const until = Date.now() + 60_000;
    let audit: { decision: string; status: string; audit_task_id: string | null; reviewer: string | null } | undefined;
    while (Date.now() < until) {
      await sy.auditor.sweep();
      audit = sy.db.prepare("SELECT decision, status, audit_task_id, reviewer FROM verification_audits WHERE task_id = ?").get(id) as typeof audit;
      if (audit?.status === "done") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    // The auditor never authored the task.
    const authors = sy.gate.admission.servedEndpointsByPurpose(id).execution;
    expect(authors.length).toBeGreaterThan(0);
    expect(audit).toMatchObject({ decision: "sampled", status: "done" });
    expect(authors).not.toContain(audit!.reviewer);
    const auditor = audit!.reviewer!;
    const auditTask = sy.tasks.get(audit!.audit_task_id!)!;
    expect((auditTask.row as unknown as { purpose: string }).purpose).toBe("audit");
    expect(auditTask.spec).toMatchObject({ profile: "review", routing: { endpointId: auditor }, budget: { maxModelRequests: 4, maxPaidUsd: 0 } });
    // The audit task is never audited itself, and never reviewed.
    expect(sy.db.prepare("SELECT COUNT(*) AS n FROM verification_audits WHERE task_id = ?").get(auditTask.row.id)).toEqual({ n: 0 });

    const [rec] = verdictRecords(sy.db, { taskId: id, purpose: "audit" });
    expect(rec).toMatchObject({ purpose: "audit", reviewer: auditor, verdict: "fail", auditTaskId: auditTask.row.id, level: "standard" });
    expect(rec!.record.flags).toContain("audit");
    expect(rec!.requests).toBeGreaterThan(0);
    expect(sy.tasks.events(id, 200).find((e) => e.type === "audit_completed")?.data).toMatchObject({ verdict: "fail", disagrees: true });

    // Acceptance and the audited task's own usage are untouched; the audit is charged to purpose audit.
    const after = sy.tasks.get(id)!.result!;
    expect(after.acceptanceStatus).toBe(before.acceptance);
    expect(after.verification!.decisions).toEqual([]);
    expect(sy.gate.admission.taskTotalsByPurpose(id)).toEqual(before.by);
    expect(usageByPurpose(sy, 0).find((u) => u.purpose === "audit")!.requests).toBe(rec!.requests);
    const view = calibrationOverview(sy);
    expect(view.audits.decisions).toMatchObject({ sampled: 1 });
    expect(view.reviewers.find((x) => x.reviewer === auditor)).toMatchObject({ audits: 1, fail: 1 });
  }, 120_000);

  it("skips audits while the package allocation is tight", async () => {
    env = envWith({ verification: { audit_sample_rate: 1 }, allocation: { max_model_requests_per_hour: 4 } });
    sy = open(env, new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", goodOutput(1, "inline"))] })), { worker: true });
    const [sub] = await sy.submitTasks([{ profile: "inspect", goal: "Where is add defined?", repositoryAliases: ["core"], context: { inlineText: "src/app.ts defines add" }, hints: { difficulty: "T1" }, constraints: { acceptanceCriteria: ["names the file"] } }]);
    expect((await result(sub!.taskId)).verificationStatus).toBe("passed");
    // (The worker's tick may have decided it first; either way it is decided once.)
    const d = await sy.auditor.consider(sub!.taskId);
    expect(d.decision).toBe("skipped_capacity");
    expect(d.reason).toMatch(/hourly package allocation is tight/);
    expect(sy.tasks.list().filter((t) => (t.row as unknown as { purpose: string }).purpose === "audit")).toEqual([]);
  }, 60_000);
});
