import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Switchyard } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { WORKER_CHECK_EVENT } from "../src/harness/tools.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { startTaskTools, taskToolsBrief, type TaskToolsBridge } from "../src/runners/coding/task-tools.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
let bridge: TaskToolsBridge | undefined;
let client: Client | undefined;
afterEach(async () => { await client?.close(); client = undefined; await bridge?.close(); bridge = undefined; await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const check = "node --version";
const task = () => ({ profile: "implement", goal: "Verify task tools", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, budget: { maxModelRequests: 1, maxInputTokens: 1000, maxPaidUsd: 0 }, constraints: { acceptanceCriteria: ["runtime check is available"], allowedPaths: ["src/**"], checks: [check] } });
const text = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;
async function until<T>(read: () => T, ok: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) { const value = read(); if (ok(value)) return value; if (Date.now() > end) throw new Error("fixture timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function directBridge() {
  env = makeEnv({ config: baseConfig({ coding: { runner: "native", max_check_runs_per_task: 1 }, security: { outside_repository: "human_only" } }) });
  const provider = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
  sy = open(env, provider);
  const [submitted] = await sy.submitTasks([task()]);
  const stored = sy.tasks.claim("bridge-test", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 30000 })[0]!;
  expect(stored.row.id).toBe(submitted!.taskId);
  const ctx = { cfg: env.cfg, tasks: sy.tasks, taskId: stored.row.id, leaseOwner: "bridge-test", taskLease: capturedLease(stored), spec: stored.spec, now: Date.now, signal: new AbortController().signal, session: null, artifacts: sy.artifacts } as unknown as RunContext;
  bridge = await startTaskTools(ctx, env.repo, env.dir);
  client = new Client({ name: "direct-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
  return { ctx, provider };
}

describe("external worker refusal", () => {
  it.each(["human", "supervisor", "auto"] as const)("cannot gain process or model access through the %s budget approver", async budget_approver => {
    env = makeEnv({ config: baseConfig({ coding: { runner: "command", command: "placeholder" }, team: { budget_approver }, routing: { escalate_on_failure: false } }) });
    const marker = path.join(env.dir, "external-tools-started");
    const script = path.join(env.dir, "forbidden-agent.cjs");
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
    env.cfg.coding.command = `"${process.execPath}" "${script}"`;
    const provider = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
    sy = open(env, provider, { worker: true });
    const [submitted] = await sy.submitTasks([task()]);
    const result = (await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 15 })).completed[0]!;
    expect(result).toMatchObject({ executionStatus: "failed", stopReason: "worker_sandbox_unavailable", checks: [], patchRefs: [] });
    expect(result.usage.modelRequests).toBe(0);
    expect(provider.requests).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(path.join(env.repo, "src/app.ts"), "utf8")).not.toContain("subtract");
    expect(new BudgetRequests(sy.db).list({ taskId: submitted!.taskId })).toHaveLength(0);
    expect(new WorkerActionRequests(sy.db).list({ project: sy.tasks.projectOf(submitted!.taskId)!, taskId: submitted!.taskId })).toHaveLength(0);
    expect(sy.tasks.events(submitted!.taskId, 100).some(event => event.type === WORKER_CHECK_EVENT)).toBe(false);
  }, 20000);
});

describe("direct task-scoped bridge", () => {
  it("authenticates and validates bounded capabilities without launching an external worker", async () => {
    const { provider } = await directBridge();
    expect((await client!.listTools()).tools.map(tool => tool.name).sort()).toEqual(["request_more_budget", "run_check"]);
    expect(taskToolsBrief(bridge!)).not.toContain(bridge!.token);
    const unauthorized = await fetch(bridge!.url, { method: "POST", headers: { Authorization: "Bearer invalid-token", "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect((await client!.callTool({ name: "run_check", arguments: { command: check, taskId: "foreign-task" } })).isError).toBe(true);
    const undeclared = await client!.callTool({ name: "run_check", arguments: { command: "echo arbitrary" } });
    expect(undeclared.isError).toBe(true);
    expect(text(undeclared)).toContain("not a declared check");
    expect(provider.requests).toHaveLength(0);
    const url = bridge!.url;
    await client!.close(); client = undefined;
    await bridge!.close(); bridge = undefined;
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it("files exact checks for operator handling and cannot run a denied check", async () => {
    const { ctx } = await directBridge();
    const pending = client!.callTool({ name: "run_check", arguments: { command: check } });
    const actions = new WorkerActionRequests(sy!.db);
    const request = await until(() => actions.list({ project: ctx.taskLease!.project, taskId: ctx.taskId, status: "pending" })[0], Boolean);
    expect(request!.action.command).toBe(check);
    expect(request!.exitCode).toBeNull();
    await actions.decide({ project: request!.project, id: request!.id, decision: "deny", reason: "fixture operator refuses host execution", actor: { kind: "operator" }, config: env!.cfg });
    const result = JSON.parse(text(await pending));
    expect(result.status).toBe("denied");
    expect(result.output).toBeNull();
    expect(sy!.tasks.events(ctx.taskId, 100).some(event => event.type === WORKER_CHECK_EVENT)).toBe(false);
  });

  it("rejects a stale bridge lease before filing a command", async () => {
    const { ctx } = await directBridge();
    sy!.db.prepare("UPDATE tasks SET lease_owner='foreign-worker' WHERE id=?").run(ctx.taskId);
    expect((await client!.callTool({ name: "run_check", arguments: { command: check } })).isError).toBe(true);
    expect(new WorkerActionRequests(sy!.db).list({ project: ctx.taskLease!.project, taskId: ctx.taskId })).toHaveLength(0);
  });
});
