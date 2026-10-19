import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;

function setup(mode: string, extra: Record<string, unknown> = {}) {
  env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: `node "${agent}" ${mode}` }, ...extra }) });
  process.env.OPENAI_API_KEY = "should-not-leak";
  const client = new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));
  sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
  return client;
}

const implementTask = (o: Record<string, unknown> = {}) => ({
  profile: "implement",
  goal: "Add a subtract function to src/app.ts",
  repositoryAliases: ["core"],
  writableRepository: "core",
  hints: { difficulty: "T2" },
  constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: [check] },
  ...o,
});

describe("coding worker", () => {
  it("edits in an isolated worktree, returns a patch with its base SHA, and runs checks", async () => {
    const client = setup("good");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env!.repo }).toString().trim();
    const [sub] = await sy!.submitTasks([implementTask()]);
    const r = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.executionStatus).toBe("completed");
    expect(r.acceptanceStatus).toBe("met");
    expect(r.checks).toEqual([expect.objectContaining({ exitCode: 0 })]);
    expect(r.baseCommits).toEqual({ core: head });
    expect(r.patchRefs).toHaveLength(1);
    const patch = sy!.artifacts.read(r.patchRefs[0]!)!.content.toString();
    expect(patch).toContain("+export function subtract");
    // Parent checkout untouched.
    expect(readFileSync(path.join(env!.repo, "src/app.ts"), "utf8")).not.toContain("subtract");
    // Both agent calls (including the "title" call) went through admission.
    expect(r.usage.modelRequests).toBe(2);
    expect(client.requests).toHaveLength(2);
    expect(r.routing?.tier).toBe("T2");
  }, 90_000);

  it("detects out-of-scope edits and never reports them as met", async () => {
    setup("scope");
    const [sub] = await sy!.submitTasks([implementTask()]);
    const r = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("unmet");
    expect(r.findings.map((f) => f.description).join("\n")).toMatch(/Out-of-scope changes.*README\.md/);
  }, 90_000);

  it("flags modified tests so success is not accepted on the worker's word", async () => {
    setup("tests");
    const [sub] = await sy!.submitTasks([implementTask()]);
    const r = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("not_verified");
    expect(r.findings.map((f) => f.description).join("\n")).toMatch(/Tests or evaluator files were modified/);
  }, 90_000);

  it("stops the agent at the request budget; extra calls are never admitted", async () => {
    const client = setup("loop");
    const [sub] = await sy!.submitTasks([implementTask({ budget: { maxModelRequests: 3 }, constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] } })]);
    const r = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(client.requests).toHaveLength(3);
    expect(r.usage.modelRequests).toBe(3);
    // Escalation would add a T3 run; the task budget caps the total regardless.
    expect(["budget_exhausted", "completed"]).toContain(r.executionStatus);
    expect(r.patchRefs).toHaveLength(1);
  }, 90_000);

  it("emulates streaming for agents that request it", async () => {
    setup("stream");
    const [sub] = await sy!.submitTasks([implementTask()]);
    const r = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
    expect(r.acceptanceStatus).toBe("met");
  }, 90_000);
});
