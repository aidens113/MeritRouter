import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { WORKER_CHECK_EVENT } from "../src/harness/tools.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { startTaskTools, taskToolsBrief, type TaskToolsBridge } from "../src/runners/coding/task-tools.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
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

async function directBridge(declared = check) {
  env = makeEnv({ config: baseConfig({ coding: { runner: "native", max_check_runs_per_task: 1 }, security: { outside_repository: "human_only" } }) });
  const provider = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
  sy = open(env, provider);
  const request = task();
  request.constraints.checks = [declared];
  const [submitted] = await sy.submitTasks([request]);
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
  it("accepts operation-specific offset ranges in a real MCP batch", async () => {
    const { ctx } = await directBridge();
    const ref = sy!.artifacts.write({ taskId: ctx.taskId, kind: "tool_output", label: "large fixture", content: "x".repeat(1_000_005) + "tail", extension: ".txt" });
    const page = JSON.parse(text(await client!.callTool({ name: "batch", arguments: { items: [
      { id: "page", operation: "read_output_page", args: { ref, offset: 1_000_005, length: 4 } },
    ] } })));
    expect(page.status).toBe("succeeded");
    expect(page.data[0].result.data.text).toBe("tail");
    // The portable superset must not weaken the original listing operation's limit.
    const invalid = JSON.parse(text(await client!.callTool({ name: "batch", arguments: { items: [
      { id: "paths", operation: "list_paths", args: { offset: 1_000_005 } },
    ] } })));
    expect(invalid.status).toBe("failed");
  });
  it("advertises usable nested read and batch schemas over actual MCP", async () => {
    await directBridge();
    const listed = await client!.listTools();
    const read = listed.tools.find(tool => tool.name === "read_files")!.inputSchema as any;
    expect(read.properties.files.items.type).toBe("object");
    expect(read.properties.files.items.required).toContain("path");
    const batch = listed.tools.find(tool => tool.name === "batch")!.inputSchema as any;
    expect(batch.properties.items.items.properties.operation.enum).toContain("read_files");
    expect(batch.properties.items.items.properties.args.properties.files.items.properties.path.type).toBe("string");
    const result = JSON.parse(text(await client!.callTool({ name: "batch", arguments: { items: [
      { id: "files", operation: "read_files", args: { files: [{ path: "src/app.ts" }, { path: "missing" }] } },
      { id: "paths", operation: "list_paths", args: {} },
    ] } })));
    expect(result.status).toBe("succeeded");
    expect(result.data[0].result.data.map((file: any) => file.status)).toEqual(["succeeded", "failed"]);
    expect(result.data[1].result.status).toBe("succeeded");
    const legacy = JSON.parse(text(await client!.callTool({ name: "read_files", arguments: { files: ["src/app.ts"] } })));
    expect(legacy.data[0].status).toBe("succeeded");
    expect(taskToolsBrief(bridge!)).toContain("Do not spend one model turn per known file or check");
  });
  it("waits for a running approved recipe to stop before settling timeout", async () => {
    const { ctx } = await directBridge("node slow-check.cjs");
    const marker=path.join(env!.repo,"late-write");
    const started=path.join(env!.dir,"recipe-started");
    // Keep the startup marker outside the pinned repository so observing real
    // execution does not itself revoke the command's source authority.
    writeFileSync(path.join(env!.repo,"slow-check.cjs"),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},String(Date.now()));setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),8000);`);
    const invokedAt=Date.now();
    const pending=client!.callTool({name:"run_recipe",arguments:{id:"check:1",timeout_ms:5000}});
    const actions=new WorkerActionRequests(sy!.db);
    const request=await until(()=>actions.list({project:ctx.taskLease!.project,taskId:ctx.taskId,status:"pending"})[0],Boolean);
    const executing=actions.decide({project:ctx.taskLease!.project,id:request!.id,decision:"approve",reason:"fixture operator authorized captured command",actor:{kind:"operator"},config:env!.cfg});
    await until(()=>existsSync(started),Boolean);
    const startedAt=Number(readFileSync(started,"utf8"));
    expect(startedAt).toBeGreaterThanOrEqual(invokedAt);
    expect(startedAt).toBeLessThan(invokedAt+5000);
    const result=await pending,finished=await executing;
    expect(result.isError).toBe(true);expect(finished.status).toBe("uncertain");expect(finished.quiescedAt).toBeTypeOf("number");
    expect(finished.quiescedAt!).toBeGreaterThanOrEqual(startedAt);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,startedAt+8200-Date.now())));expect(existsSync(marker)).toBe(false);
  },20000);
  it("cancels an expired recipe approval so it cannot execute later", async () => {
    const { ctx } = await directBridge();
    const result = await client!.callTool({name:"run_recipe",arguments:{id:"check:1",timeout_ms:700}});
    expect(result.isError).toBe(true);
    const actions = new WorkerActionRequests(sy!.db);
    const request = actions.list({project:ctx.taskLease!.project,taskId:ctx.taskId})[0];
    expect(request?.status).toBe("cancelled");
    expect(request?.quiescedAt).toBeTypeOf("number");
    const late = await actions.decide({project:ctx.taskLease!.project,id:request!.id,decision:"approve",reason:"too late",actor:{kind:"operator"},config:env!.cfg});
    expect(late.status).toBe("cancelled");
    expect(sy!.tasks.events(ctx.taskId,100).some(event=>event.type===WORKER_CHECK_EVENT)).toBe(false);
  });
  it("authenticates and validates bounded capabilities without launching an external worker", async () => {
    const { provider } = await directBridge();
    const names = (await client!.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual(["batch", "cancel_operation", "git_diff", "git_status", "list_paths", "operation_status", "read_files", "read_output_page", "request_more_budget", "run_check", "run_checks", "run_recipe", "search_text", "workspace_info"]);
    expect(names).not.toContain("apply_edits");
    const deniedBatch = await client!.callTool({ name: "batch", arguments: { items: [{ id: "escape", operation: "apply_edits", args: { edits: [{ action: "create", path: "src/forbidden", content: "never" }] } }] } });
    expect(deniedBatch.isError).toBe(true);
    expect(existsSync(path.join(env!.repo, "src/forbidden"))).toBe(false);
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
