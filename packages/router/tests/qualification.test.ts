import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { evalsDir, gradeReadOnly, loadSuite } from "../src/qualification/runner.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { minimalEnv, runProcess } from "../src/runners/coding/process.js";
import { qualificationBoard } from "../src/admin/insights.js";
import { emptyUsage } from "../src/core/task.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
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
    expect(suite.evals.map((e) => e.id)).toEqual(["fix-range", "add-duration", "rename-option", "locate-validator", "diagnose-crash"]);
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
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: `node "${agent}" fixrange` }, qualification: { required: true, min_trials: 1, pass_threshold: 0.5 } }) });
    const client = new ScriptedClient((req) => {
      if (req.tools?.length) {
        return reply(null, {
          ...servedFor(sy!, req),
          toolCalls: [{ id: "1", type: "function", function: { name: "submit_result", arguments: JSON.stringify({ summary: "checkAddress in src/validation/address.js decides it", findings: [{ description: "checkAddress validates emails", evidenceRefs: [`${req.messages[1] && JSON.stringify(req.messages[1]).match(/q-[a-z0-9-]+/)?.[0]}:src/validation/address.js#L5-L9`] }], criteria: [0, 1].map((index) => ({ index, status: "met", evidenceRefs: ["inline"] })) }) } }],
        });
      }
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
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
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: `node "${agent}" noop` } }) });
    sy = open(env, new ScriptedClient((req) => reply("{}", servedFor(sy!, req))), { worker: true, coding: createCodingRunner(env.cfg) });
    const run = await sy.qualifier.start("openrouter/vendor/big-a:free", { evalIds: ["fix-range"], trials: 1 });
    await waitForRun(run.runId);
    expect(qualificationBoard(sy).results[0]!.outcome).toBe("fail");
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
