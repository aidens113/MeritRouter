import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Switchyard } from "../src/core/service.js";
import { BudgetRequests } from "../src/admission/budget-requests.js";
import { WORKER_CHECK_EVENT } from "../src/harness/tools.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T, ok: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 30_000;
  for (;;) { const value = read(); if (ok(value)) return value; if (Date.now() > end) throw new Error(`fixture timed out: ${JSON.stringify(value)}`); await pause(25); }
}
const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const sdk = (file: string) => pathToFileURL(fileURLToPath(new URL(`../node_modules/@modelcontextprotocol/sdk/dist/esm/client/${file}.js`, import.meta.url))).href;

function fixture(mode: "approve" | "deny" | "token" | "lease", supervisor = false) {
  const config = baseConfig({
    coding: { runner: "command", command: "placeholder", max_check_runs_per_task: 1 },
    team: { budget_approver: supervisor ? "supervisor" : "human", budget_request_wait_seconds: 20 },
    routing: { escalate_on_failure: false },
  });
  if (supervisor) (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config });
  const output = path.join(env.dir, "fixture-output.json");
  const ready = path.join(env.dir, "fixture-ready.json");
  const proceed = path.join(env.dir, "fixture-proceed");
  const script = path.join(env.dir, "external-tools-agent.mjs");
  writeFileSync(script, `
import { Client } from ${JSON.stringify(sdk("index"))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(sdk("streamableHttp"))};
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const url = process.env.SWITCHYARD_TASK_TOOLS_URL;
const token = process.env.SWITCHYARD_TASK_TOOLS_TOKEN;
const client = new Client({name:'fixture-external-agent',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(url), {requestInit:{headers:{Authorization:'Bearer '+token}}}));
const tools = (await client.listTools()).tools.map(tool=>tool.name);
const wrongToken = (await fetch(url,{method:'POST',headers:{Authorization:'Bearer invalid-token','content-type':'application/json'},body:'{}'})).status;
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const result = {url, tools, wrongToken, config, secretInPrompt:readFileSync(process.env.SWITCHYARD_PROMPT_FILE,'utf8').includes(token)};
writeFileSync(${JSON.stringify(ready)}, JSON.stringify(result));
if (${JSON.stringify(mode)} === 'lease') {
  while (!existsSync(${JSON.stringify(proceed)})) await new Promise(resolve=>setTimeout(resolve,25));
  result.lostLease = await client.callTool({name:'run_check',arguments:{command:${JSON.stringify(check)}}});
} else {
  appendFileSync('src/app.ts','\\nexport const subtract = (a,b) => a-b;\\n');
  result.foreignTask = await client.callTool({name:'run_check',arguments:{command:${JSON.stringify(check)},taskId:'foreign-task'}});
  result.undeclared = await client.callTool({name:'run_check',arguments:{command:'echo arbitrary command'}});
  result.check = await client.callTool({name:'run_check',arguments:{command:${JSON.stringify(check)}}});
  result.excessCheck = await client.callTool({name:'run_check',arguments:{command:${JSON.stringify(check)}}});
  async function chat(content) {
    const response = await fetch(process.env.SWITCHYARD_BASE_URL+'/chat/completions', {method:'POST',headers:{Authorization:'Bearer '+process.env.SWITCHYARD_JOB_TOKEN,'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}],max_tokens:100})});
    return {status:response.status,body:await response.text()};
  }
  result.first = await chat('first');
  const asking = client.callTool({name:'request_more_budget',arguments:{requests:2,reason:'checks passed; two implementation confirmations remain'}});
  let queued;
  if (${JSON.stringify(mode)} === 'approve') { await new Promise(resolve=>setTimeout(resolve,150)); queued = chat('queued during budget wait'); }
  result.budget = await asking;
  writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
  if (${JSON.stringify(mode)} === 'approve') { result.second = await queued; result.third = await chat('third'); }
  if (${JSON.stringify(mode)} === 'token') await chat('x'.repeat(20_000));
}
writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
await client.close();
`);
  env.cfg.coding.command = `"${process.execPath}" "${script}"`;
  const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const client = new ScriptedClient(req => {
    if (supervisor && String(req.messages[0]?.content).startsWith("# Supervisor charter")) {
      const turn = req.messages.filter(message => message.role === "assistant").length;
      const request = new BudgetRequests(sy!.db).list({ status: "pending" })[0];
      const tools = turn === 0 ? [call("delegate", { tasks: [{ label: "external", profile: "implement", goal: "Add subtract with the task tools", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], max_requests: 1, difficulty: "T2" }] })]
        : turn === 1 || turn === 3 ? [call("await_tasks", { timeout_seconds: 20 })]
        : turn === 2 ? [call("decide_budget_request", { id: request?.id, approve: true, grant: 2, reason: "two remaining confirmations" })]
        : [call("finish_job", { status: "blocked", summary: "external worker tested", verified: [], not_verified: ["no integration requested"] })];
      return reply(null, { ...servedFor(sy!, req), toolCalls: tools });
    }
    return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
  });
  sy = open(env, client, { worker: true });
  return { output, ready, proceed, client };
}

const task = () => ({ profile: "implement", goal: "Add subtract and verify it", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, budget: { maxModelRequests: 1, maxInputTokens: 1000, maxPaidUsd: 0 }, constraints: { acceptanceCriteria: [{ id: "subtract", text: "subtract exists", verify: "check", checks: [check] }], allowedPaths: ["src/**"], checks: [check] } });

describe("external task tools", () => {
  it.each(["approve", "deny"] as const)("runs real command-agent checks and human budget %s through task-scoped MCP", async mode => {
    const f = fixture(mode);
    const [sub] = await sy!.submitTasks([task()]);
    const store = new BudgetRequests(sy!.db);
    const request = await until(() => store.list({ taskId: sub!.taskId, status: "pending" })[0], Boolean);
    await pause(250);
    expect(f.client.requests).toHaveLength(1); // A concurrently queued model call also waits for the decision.
    store.decide(request!.id, { approve: mode === "approve", grant: 2, by: "human:fixture", reason: mode === "approve" ? "bounded remaining work" : "finish with existing evidence", cfg: sy!.cfg });
    const result = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 25 })).completed[0]!;
    expect(result?.executionStatus).toBe("completed");
    expect(result.usage.modelRequests).toBe(mode === "approve" ? 3 : 1);
    const observed = JSON.parse(readFileSync(f.output, "utf8"));
    expect(observed.tools.sort()).toEqual(["request_more_budget", "run_check"]);
    expect(observed.wrongToken).toBe(401);
    expect(observed.foreignTask.isError).toBe(true);
    expect(observed.undeclared.isError).toBe(true);
    expect(observed.check.isError).not.toBe(true);
    expect(observed.excessCheck.isError).toBe(true);
    expect(observed.secretInPrompt).toBe(false);
    expect(observed.config.mcp.switchyard_task).toMatchObject({ type: "remote", url: observed.url, enabled: true, oauth: false, headers: { Authorization: "Bearer {env:SWITCHYARD_TASK_TOOLS_TOKEN}" } });
    expect(observed.config.enabled_providers).toEqual(["switchyard"]);
    expect(observed.budget.content[0].text).toContain(mode === "approve" ? "Your limit is now 3" : "denied by human:fixture");
    expect(sy!.tasks.events(sub!.taskId, 200).filter(event => event.type === WORKER_CHECK_EVENT)).toHaveLength(1);
    const session = sy!.sessions.forTask(sub!.taskId).at(-1)!;
    const journal = sy!.sessions.events(session.id)!.events;
    expect(journal.some(event => event.type === "tool_intent" && event.data.name === "request_more_budget")).toBe(true);
    expect(journal.some(event => event.type === "tool_outcome" && event.data.name === "run_check")).toBe(true);
    await expect(fetch(observed.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 60_000);

  it("continues an external worker past its old cap after its actual supervisor approves", async () => {
    const f = fixture("approve", true);
    const job = await sy!.startJob({ goal: "Verify external task budget approval", repositories: ["core"] });
    await sy!.awaitResults([job.taskId], { timeoutSeconds: 30 });
    const child = sy!.tasks.childrenOf(job.taskId)[0]!;
    expect(child.result?.executionStatus).toBe("completed");
    expect(child.result?.usage.modelRequests).toBe(3);
    expect(new BudgetRequests(sy!.db).list({ taskId: child.row.id })[0]).toMatchObject({ approver: "supervisor", status: "approved", granted: 2 });
    const observed = JSON.parse(readFileSync(f.output, "utf8"));
    expect(observed.budget.content[0].text).toContain("approved by supervisor:");
    await expect(fetch(observed.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 60_000);

  it("retains token caps after a request approval", async () => {
    const f = fixture("token");
    const [sub] = await sy!.submitTasks([task()]);
    const store = new BudgetRequests(sy!.db);
    const request = await until(() => store.list({ taskId: sub!.taskId, status: "pending" })[0], Boolean);
    store.decide(request!.id, { approve: true, grant: 2, by: "human:fixture", reason: "two more requests, same token cap", cfg: sy!.cfg });
    const result = (await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 25 })).completed[0]!;
    expect(result?.executionStatus).toBe("budget_exhausted");
    expect(result.stopReason).toContain("task_token_budget_exhausted");
    expect(f.client.requests).toHaveLength(1);
    const observed = JSON.parse(readFileSync(f.ready, "utf8"));
    await expect(fetch(observed.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 60_000);

  it("refuses a stale execution lease without running a declared check", async () => {
    const f = fixture("lease");
    const [sub] = await sy!.submitTasks([task()]);
    await until(() => existsSync(f.ready), Boolean);
    sy!.db.prepare("UPDATE tasks SET lease_owner = 'foreign-worker' WHERE id = ?").run(sub!.taskId);
    writeFileSync(f.proceed, "continue");
    await until(() => existsSync(f.output), Boolean);
    const observed = JSON.parse(readFileSync(f.output, "utf8"));
    expect(observed.lostLease.isError).toBe(true);
    expect(sy!.tasks.events(sub!.taskId, 200).some(event => event.type === WORKER_CHECK_EVENT)).toBe(false);
    await sy!.close(); sy = undefined;
    await expect(fetch(observed.url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 45_000);
});
