import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { evalsDir, gradeReadOnly, loadSuite } from "../src/qualification/runner.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { minimalEnv, runProcess } from "../src/runners/coding/process.js";
import { qualificationBoard } from "../src/admin/insights.js";
import { emptyUsage } from "../src/core/task.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

async function waitForRun(runId: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sy!.qualifier.gradePending();
    const run = qualificationBoard(sy!).runs.find((r) => r.id === runId)!;
    if (run.status === "finished") return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("qualification run did not finish");
}

describe("qualification", () => {
  it("the shipped suite is valid", () => {
    const suite = loadSuite();
    expect(suite.evals.filter((e) => e.family !== "review").map((e) => e.id)).toEqual(["fix-range", "add-duration", "rename-option", "locate-validator", "diagnose-crash"]);
    // Reviewer evaluations: the four kinds, spread over T1-T3 (all four at T3 for review_strict).
    const review = suite.evals.filter((e) => e.family === "review");
    expect(new Set(review.map((e) => e.review!.kind))).toEqual(new Set(["correct", "defect", "unverifiable", "style"]));
    expect(new Set(review.filter((e) => e.tier === "T3").map((e) => e.review!.kind)).size).toBe(4);
    expect(new Set(review.map((e) => e.tier))).toEqual(new Set(["T1", "T2", "T3"]));
  });

  it("every coding eval's hidden tests fail on the untouched fixture", async () => {
    for (const e of loadSuite().evals.filter((x) => x.family === "coding")) {
      const dir = mkdtempSync(path.join(tmpdir(), "sy-eval-"));
      cpSync(path.join(evalsDir(), e.fixture), dir, { recursive: true });
      cpSync(path.join(evalsDir(), e.hidden!.dir), path.join(dir, "hidden"), { recursive: true });
      const r = await runProcess(e.hidden!.command, [], { cwd: dir, env: minimalEnv({}), timeoutMs: 60_000, shell: true });
      rmSync(dir, { recursive: true, force: true });
      expect(r.exitCode, `${e.id} hidden tests should fail before any fix`).not.toBe(0);
      expect(r.stdout, e.id).toMatch(/# pass \d+/);
    }
  }, 120_000);

  it("runs pinned to one model, grades coding with hidden tests and read-only with citations", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" }, qualification: { required: true, min_trials: 1, pass_threshold: 0.5 } }) });
    const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    const client = new ScriptedClient((req) => {
      const source = JSON.stringify(req.messages);
      const range = source.match(/q-[a-z0-9]+-fix-range-1/)?.[0];
      const locate = source.match(/q-[a-z0-9]+-locate-validator-1/)?.[0];
      const first = !req.messages.some(message => message.role === "tool");
      if (range) return reply(null, { ...servedFor(sy!, req), toolCalls: [first
        ? call("replace_in_file", { path: "src/range.js", old_text: "i <= end", new_text: "i < end" })
        : call("submit_result", goodOutput(3, `${range}:src/range.js#L1-L6`))] });
      if (first) return reply(null, { ...servedFor(sy!, req), toolCalls: [call("read_file", { alias: locate, path: "src/validation/address.js" })] });
      return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", {
        summary: "checkAddress in src/validation/address.js decides it",
        findings: [{ description: "checkAddress validates emails", evidenceRefs: [`${locate}:src/validation/address.js#L5-L9`] }],
        criteria: [0, 1].map(index => ({ index, status: "met", evidenceRefs: [`${locate}:src/validation/address.js#L5-L9`] })),
      })] });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["fix-range", "locate-validator"], trials: 1 });
    expect(run.tasks).toBe(2);
    const finished = await waitForRun(run.runId);
    expect(finished.graded).toBe(2);
    const board = qualificationBoard(sy);
    const coding = board.results.find((r) => r.evalId === "fix-range")!;
    expect(coding.outcome, JSON.stringify(coding.detail)).toBe("pass");
    const t1coding = board.rows.find((r) => r.family === "coding" && r.tier === "T1" && r.endpointId === "openrouter/vendor/big-a:free")!;
    expect(t1coding.stat).toMatchObject({ passes: 1, trials: 1, qualified: true });
  }, 120_000);

  it("a coding run that changes nothing fails grading", async () => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
    const client = new ScriptedClient(req => {
      const alias = JSON.stringify(req.messages).match(/q-[a-z0-9]+-fix-range-1/)?.[0];
      const first = !req.messages.some(message => message.role === "tool");
      return reply(null, { ...servedFor(sy!, req), toolCalls: [{ id: first ? "read" : "submit", type: "function", function: {
        name: first ? "read_file" : "submit_result", arguments: JSON.stringify(first ? { alias, path: "src/range.js" } : goodOutput(3, `${alias}:src/range.js#L1-L6`)),
      } }] });
    });
    sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["fix-range"], trials: 1 });
    await waitForRun(run.runId);
    expect(qualificationBoard(sy).results[0]!).toMatchObject({ outcome: "fail", detail: { detail: expect.stringContaining("no patch") } });
    expect(client.requests.filter(request => request.tools?.some(tool => tool.function.name === "read_file"))).toHaveLength(2);
    const result = sy.tasks.get(qualificationBoard(sy).results[0]!.taskId!)!.result!;
    expect(result.stopReason).toBe("worker_submitted");
    expect(result.patchRefs).toHaveLength(0);
  }, 120_000);

  it("refuses to start beyond the daily qualification allocation", async () => {
    env = makeEnv({ config: baseConfig({ qualification: { max_requests_per_day: 5 } }) });
    sy = open(env, new ScriptedClient(() => reply("{}")));
    await expect(sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["fix-range"], trials: 1 })).rejects.toThrow(/allocation/);
  });

  it("read-only grading needs the right citation and wording", () => {
    const e = loadSuite().evals.find((x) => x.id === "diagnose-crash")!;
    const base = { taskId: "t", executionStatus: "completed" as const, acceptanceStatus: "not_verified" as const, stopReason: "", artifactRefs: [], patchRefs: [], baseCommits: {}, checks: [], unresolvedCriteria: [], usage: emptyUsage(), servedEndpoints: [], classification: null, routing: null };
    expect(gradeReadOnly(e, { ...base, summary: "discount applied twice", findings: [{ description: "finalize applies it again", evidenceRefs: ["q-x:src/cart.js#L13-L15"] }] }).outcome).toBe("pass");
    expect(gradeReadOnly(e, { ...base, summary: "rounding error", findings: [{ description: "pricing", evidenceRefs: ["q-x:src/pricing.js#L1-L3"] }] }).outcome).toBe("fail");
  });
});
