import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import { GatewayError } from "../src/core/errors.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { narrowedScope, taskWriteScope } from "../src/harness/task-scope.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const start = () => (sy as unknown as { startWorker(ms: number): void }).startWorker(25);

describe("roadmap team correctness", () => {
  it("recovers persisted ancestor scope and accepts only provable narrowing", () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => { throw new Error("no model needed"); }));
    const root = WorkerTaskSchema.parse({ profile: "supervise", id: "root", goal: "scope", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["scope"], allowedPaths: ["src/**"] } });
    const oldChild = WorkerTaskSchema.parse({ ...root, id: "old-child", parentTaskId: "root", constraints: { acceptanceCriteria: ["scope"] } });
    sy.tasks.submit([root, oldChild]);
    expect(taskWriteScope(oldChild, sy.tasks)).toEqual(["src/**"]);
    expect(taskWriteScope({ ...oldChild, parentTaskId: "old-child", constraints: { acceptanceCriteria: ["scope"], allowedPaths: ["src/nested/**/*.ts"] } }, sy.tasks)).toEqual(["src/nested/**/*.ts"]);
    expect(narrowedScope(["src/*.ts"], ["src/app.ts"])).toEqual(["src/app.ts"]);
    for (const paths of [["**"], ["README.md"], ["src/../README.md"], ["!src/app.ts"]]) {
      expect(() => narrowedScope(["src/**"], paths)).toThrow(/exceeds parent scope/);
    }
    expect(() => narrowedScope(["src/*.ts"], ["src/*"])).toThrow(/exceeds parent scope/);
  });

  it("inherits parent scope and rejects wider nested delegation and direct supervisor edits", async () => {
    let command = "";
    const cfg = baseConfig({ security: { outside_repository: "supervisor" }, supervisor: { implementation: "allowed", allowed_commands: ["node *"] }, team: { max_depth: 3, default_task_requests: 2 }, routing: { escalate_on_failure: false } });
    (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
    env = makeEnv({ config: cfg });
    const script = path.join(env.dir, "write-outside.cjs");
    writeFileSync(script, "require('fs').writeFileSync('README.md','command escaped');");
    command = `node "${script.replace(/\\/g, "/")}"`;
    const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
    const finish = () => call("finish_job", { status: "blocked", summary: "scope inspected", verified: [], not_verified: ["scope test"] });
    const client = new ScriptedClient(req => {
      const n = req.messages.filter(message => message.role === "assistant").length;
      const goal = String(req.messages[1]?.content ?? "");
      const supervisor = String(req.messages[0]?.content).startsWith("# Supervisor charter");
      let toolCalls;
      if (!supervisor) toolCalls = [call("submit_result", goodOutput())];
      else if (goal.includes("scoped parent")) toolCalls = n === 0 ? [call("delegate", { tasks: [{ label: "child", profile: "supervise", goal: "scoped child", acceptance_criteria: ["stay scoped"] }] })] : n === 1 ? [call("await_tasks", { timeout_seconds: 25 })] : n === 2 ? [call("integrate_task", { task_id: "child", accept: true, reason: "try integration despite scope" })] : [finish()];
      else if (goal.includes("scoped child")) toolCalls = n === 0 ? [
        call("write_file", { path: "README.md", content: "escaped direct edit" }),
        call("delegate", { tasks: [{ label: "escape-worker", profile: "implement", goal: "escape worker", acceptance_criteria: ["x"], allowed_paths: ["README.md"], max_requests: 2 }] }),
        call("plan_work", { nodes: [{ label: "escape-subtree", profile: "supervise", goal: "escape deeper", acceptance_criteria: ["x"], allowed_paths: ["**"] }] }),
      ] : n === 1 ? [call("run_command", { command }), call("await_tasks", { timeout_seconds: 10 })] : [finish()];
      else toolCalls = [finish()];
      return reply(null, { ...servedFor(sy!, req), toolCalls });
    });
    sy = open(env, client, { worker: true });
    const [root] = await sy.submitTasks([{ profile: "supervise", goal: "scoped parent", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["stay scoped"], allowedPaths: ["src/**"] } }]);
    await sy.awaitResults([root!.taskId], { timeoutSeconds: 40 });
    const child = sy.tasks.childrenOf(root!.taskId)[0]!;
    expect(child?.spec.constraints.allowedPaths).toEqual(["src/**"]);
    expect(sy.tasks.childrenOf(child.row.id)).toEqual([]);
    const last = client.requests.filter(req => String(req.messages[1]?.content).includes("scoped child")).at(-1)!;
    const outputs = last.messages.filter(message => message.role === "tool").map(message => String(message.content));
    expect(outputs.filter(output => /outside allowedPaths|outside.*scope|exceeds.*scope/.test(output))).toHaveLength(3);
    expect(child.result?.scopeViolation).toContain("core:README.md");
    const parent = client.requests.filter(req => String(req.messages[1]?.content).includes("scoped parent")).at(-1)!;
    expect(parent.messages.filter(message => message.role === "tool").some(message => String(message.content).includes("refused: out-of-scope changes"))).toBe(true);
  }, 50_000);

  it.each(["failure", "cancellation"])("retains a completed batch sibling after a later %s", async mode => {
    env = makeEnv({ config: baseConfig({
      execution: { max_concurrent_tasks: 1, lease_seconds: 30, on_capacity_exhausted: "fail" },
      routing: { max_endpoint_fallbacks: 1, escalate_on_failure: false },
    }) });
    let pending = "";
    const client = new ScriptedClient((req, round) => {
      if (round > 1) {
        if (mode === "cancellation") sy!.cancelTasks([pending]);
        throw new GatewayError(mode === "cancellation" ? "aborted" : "policy_violation", "later batch round stopped", 400, undefined, true);
      }
      return reply(JSON.stringify({ items: [{ id: "i1", result: goodOutput() }] }), servedFor(sy!, req));
    });
    sy = open(env, client);
    const subs = await sy.submitTasks([summarizeTask({ goal: "first" }), summarizeTask({ goal: "second" })]);
    pending = subs[1]!.taskId;
    start();
    const out = await sy.awaitResults(subs.map(task => task.taskId), { timeoutSeconds: 3 });
    const first = out.completed.find(result => result.taskId === subs[0]!.taskId);
    expect(first?.executionStatus).toBe("completed");
    expect(first?.summary).toBe(goodOutput().summary);
    expect(first?.usage.modelRequests).toBe(1);
    expect(first?.routing?.attempts).toHaveLength(1);
    expect(sy.sessions.forTask(subs[0]!.taskId).at(-1)?.status).toBe("completed");
    expect(out.completed.find(result => result.taskId === pending)?.executionStatus).toBe(mode === "cancellation" ? "cancelled" : "failed");
    expect(sy.usage(0).modelRequests).toBe(2);
    expect(out.pending).toEqual([]);
  });

  it("passes explicit inline, pinned file slices and scoped artifacts to a native worker", async () => {
    env = makeEnv({ config: baseConfig({ repositories: { core: { path: "repo" }, reference: { path: "repo", writable: false } } }) });
    env.cfg.coding.runner = "native";
    env.cfg.routing.escalate_on_failure = false;
    const client = new ScriptedClient(req => reply(null, { ...servedFor(sy!, req), toolCalls: [{ id: "submit", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "core:src/app.ts#L2-L2")) } }] }));
    sy = open(env, client);
    const owner = sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "context-owner" }))], { project: "demo" })[0]!.taskId;
    sy.db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(owner);
    const artifact = sy.artifacts.write({ taskId: owner, kind: "context", label: "explicit context", content: "ARTIFACT_CONTEXT_SENTINEL" });
    const [sub] = await sy.submitTasks([{
      profile: "implement", goal: "Read provided context", repositoryAliases: ["core", "reference"], writableRepository: "core", hints: { difficulty: "T2" },
      context: { inlineText: "INLINE_CONTEXT_SENTINEL", fileRefs: ["core:src/app.ts#L2-L2", "reference:README.md#L1-L1"], artifactRefs: [artifact] },
      constraints: { acceptanceCriteria: ["read the context"], allowedPaths: ["src/**"] },
    }]);
    // File context must describe the actual isolated base, not later dirty source edits.
    writeFileSync(path.join(env.repo, "src/app.ts"), "DIRTY_SOURCE_SHOULD_NOT_LEAK\n");
    start();
    const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(result).toBeDefined();
    expect(result.stopReason).toBe("worker_submitted");
    const output = String(client.requests[0]!.messages[1]!.content);
    expect(output).toContain("INLINE_CONTEXT_SENTINEL");
    expect(output).toContain("ARTIFACT_CONTEXT_SENTINEL");
    expect(output).toContain('ref="core:src/app.ts#L2-L2"');
    expect(output).toContain("return a + b");
    expect(output).toContain('ref="reference:README.md#L1-L1"');
    expect(output).toContain("# Fixture");
    expect(output).not.toContain("DIRTY_SOURCE_SHOULD_NOT_LEAK");
    expect(result.usage.modelRequests).toBe(client.requests.length);
  }, 30_000);
});
