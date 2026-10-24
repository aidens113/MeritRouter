import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MeritRouter } from "../src/core/service.js";
import { decideTaskAcceptance, taskDetail } from "../src/admin/insights.js";
import { MeritRouterError } from "../src/core/errors.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

// The CLI and MCP surfaces run from dist/ (build first: pnpm --filter meritrouter build).
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const cliJs = path.join(dist, "cli.js");
const mcpJs = path.join(dist, "mcp.js");

let env: Env | undefined;
let sy: MeritRouter | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

/** Strict verification with a human acceptor: summarize gets room for the strict review reserve. */
function strictHumanEnv(strictAcceptor:"human"|"supervisor"="human"): Env {
  const profiles = { ...(baseConfig().profiles as Record<string, Record<string, unknown>>) };
  profiles.summarize = { ...profiles.summarize, max_model_requests: 8 };
  return makeEnv({ config: baseConfig({ profiles, verification: { strict_acceptor: strictAcceptor } }) });
}

const critical = (extra: Record<string, unknown> = {}) => summarizeTask({ importance: "critical", importanceReason: "billing data", ...extra });

/**
 * Run tasks to completion in-process, one at a time (so they are never batched into one request),
 * then close, so another process can open the store.
 */
async function finished(e: Env, tasks: Array<Record<string, unknown>>): Promise<string[]> {
  sy = open(e, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
  const ids: string[] = [];
  for (const task of tasks) {
    const [sub] = await sy.submitTasks([task]);
    const out = await sy.awaitResults([sub!.taskId], { timeoutSeconds: 20 });
    expect(out.timedOut).toBe(false);
    expect(out.completed[0]!.acceptanceStatus).toBe("needs_supervisor");
    ids.push(sub!.taskId);
  }
  await sy.close();
  sy = undefined;
  return ids;
}

/** The environment without secrets, so the CLI never sees a real gateway or provider key. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|FREELLMAPI|MERITROUTER/i.test(k)));
}

function cli(e: Env, ...args: string[]) {
  const r = spawnSync(process.execPath, [cliJs, ...args, "--config", e.cfg.configPath], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("insights task detail", () => {
  it("exposes the contract, verification record, importance, and a pending decision; a human decision is recorded", async () => {
    env = strictHumanEnv();
    const [id] = await finished(env, [critical()]);
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const d = taskDetail(sy, id!)!;
    expect(d.criteria).toEqual([{ id: "c1", text: "mentions the error", verify: "evidence", checks: [] }]);
    expect(d.contract!.contract).toMatchObject({ importance: { level: "critical", reason: "billing data", source: "task" }, verification: { level: "strict", strictAcceptor: "human" } });
    expect(d.contract!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.contractError).toBeNull();
    expect(d.verification).toMatchObject({ level: "strict", contractSha256: d.contract!.sha256 });
    expect(d.importance).toEqual({ level: "critical", requested: "critical", reason: "billing data", source: "task", compiled: true });
    expect(d.acceptance).toEqual({ awaitingDecision: true, supervisorAcceptance: true, strictAcceptor: "human", decisions: [] });
    // The contract has a finite initial allocation but no task-wide ceiling by default.
    const total = d.contract!.contract.budget.total;
    expect(total).toBeGreaterThan(sy.cfg.tiers.T1.max_model_requests); // differs from the T1 run cap
    expect(d.contract!.contract.budget.unallocated).toBeNull();
    expect(d.status).toMatchObject({ maxModelRequests: null });
    expect(sy.listTasks().find((t) => t.taskId === id)!.maxModelRequests).toBeNull();

    // A supervisor (or an agent over MCP) cannot accept a strict result when the acceptor is human.
    let refused: unknown;
    try {
      decideTaskAcceptance(sy, id!, "accept", { kind: "supervisor", id: "mcp:test" }, "looks right");
    } catch (e) {
      refused = e;
    }
    expect((refused as MeritRouterError).code).toBe("human_acceptance_required");

    const out = decideTaskAcceptance(sy, id!, "accept", { kind: "human", id: "panel" }, "compared the summary with the log");
    expect(out).toMatchObject({ acceptanceStatus: "met", decision: { decision: "accepted", by: { kind: "human", id: "panel" }, reason: "compared the summary with the log" } });
    const after = taskDetail(sy, id!)!;
    expect(after.acceptance.awaitingDecision).toBe(false);
    expect(after.acceptance.decisions).toEqual([expect.objectContaining({ decision: "accepted", by: { kind: "human", id: "panel" } })]);
    expect(after.events.map((e) => e.type)).toContain("result_accepted");

    let err: unknown;
    try {
      decideTaskAcceptance(sy, "t_missing", "accept", { kind: "human", id: "panel" }, "x");
    } catch (e) {
      err = e;
    }
    expect((err as MeritRouterError).code).toBe("not_found");
  });

  it("shows the requested importance before the contract is compiled", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const [sub] = await sy.submitTasks([summarizeTask({ importance: "low" })]);
    const d = taskDetail(sy, sub!.taskId)!;
    expect(d.contract).toBeNull();
    expect(d.verification).toBeNull();
    expect(d.importance).toEqual({ level: "low", requested: "low", reason: null, source: "task", compiled: false });
    expect(d.acceptance).toMatchObject({ awaitingDecision: false, strictAcceptor: "supervisor", decisions: [] });
    // Without a contract, "allowed" stays the profile/tier/task cap (summarize: 4).
    expect(d.status).toMatchObject({ maxModelRequests: 4 });
  });
});

describe("CLI acceptance and importance", () => {
  it("noninteractive CLI cannot claim human acceptance authority",async()=>{
    env=strictHumanEnv();
    const [id]=await finished(env,[critical()]);
    expect(cli(env,"accept",id!,"--reason","model reviewed").stderr).toMatch(/only a human/);
    expect(cli(env,"accept",id!,"--human","--reason","model claims human").stderr).toMatch(/requires an interactive terminal/);
  },60000);
  it("supervisor accept and reject record the OS user; reject needs a reason", async () => {
    env = strictHumanEnv("supervisor");
    const [a, b] = await finished(env, [critical({ id: "a" }), critical({ id: "b" })]);

    const noReason = cli(env, "reject", b!);
    expect(noReason.code).toBe(1);
    expect(noReason.stderr).toMatch(/needs a reason/);
    expect(cli(env, "accept").stderr).toContain("usage: meritrouter accept <task id>");

    const accepted = cli(env, "accept", a!, "--reason", "checked against the log");
    expect(accepted.stderr).toBe("");
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toMatch(new RegExp(`^${a}: accepted by supervisor:cli:\\S+; acceptance met`));
    // The CLI status preserves the uncapped task ceiling instead of substituting its current allocation.
    expect(JSON.parse(cli(env, "status", a!, "--json").stdout)[0]).toMatchObject({ taskId: a, maxModelRequests: null });
    expect(cli(env, "status", a!).stdout).toMatch(/\d+\/uncapped/);

    const rejected = cli(env, "reject", b!, "--reason", "misses the step number", "--json");
    expect(rejected.code).toBe(0);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ taskId: b, acceptanceStatus: "unmet", decision: { decision: "rejected", by: { kind: "supervisor", id: expect.stringMatching(/^supervisor:cli:./) }, reason: "misses the step number" } });

    // An unmet result cannot be accepted afterwards.
    const again = cli(env, "accept", b!, "--reason", "changed my mind");
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/cannot be accepted/);
    expect(cli(env, "accept", "t_missing", "--reason", "x").stderr).toMatch(/unknown task t_missing/);
  }, 60_000);

  it("submit --importance fills in tasks that set none and validates the level", async () => {
    env = strictHumanEnv(); // summarize gets 8 requests: room for deep's review reserve
    const file = path.join(env.dir, "tasks.json");
    writeFileSync(file, JSON.stringify([summarizeTask({ id: "plain" }), summarizeTask({ id: "own", importance: "low" })]));
    const ok = cli(env, "submit", file, "--importance", "high", "--importance-reason", "customer facing", "--json");
    expect(ok.stderr).toBe("");
    expect(ok.code).toBe(0);
    const ids = (JSON.parse(ok.stdout) as Array<{ taskId: string }>).map((s) => s.taskId);
    expect(ids).toHaveLength(2);

    expect(cli(env, "submit", file, "--importance", "urgent").stderr).toMatch(/--importance takes low, normal, high, critical/);
    expect(cli(env, "submit", file, "--importance-reason", "why").stderr).toMatch(/--importance-reason needs --importance/);
    // high needs a reason: the task schema refuses it.
    expect(cli(env, "submit", file, "--importance", "critical").code).toBe(1);

    sy = open(env, new ScriptedClient(() => reply("{}")));
    const specs = sy.listTasks(undefined, 10).map((t) => sy!.tasks.get(t.taskId)!.spec);
    expect(specs.find((s) => s.id === "plain")).toMatchObject({ importance: "high", importanceReason: "customer facing" });
    expect(specs.find((s) => s.id === "own")!.importance).toBe("low");
  }, 60_000);
});

describe("MCP acceptance tools", () => {
  const connect = async (e: Env) => {
    client = new Client({ name: "test-client", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpJs, "--config", e.cfg.configPath], env: { PATH: process.env.PATH ?? "" } }));
  };
  const body = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

  it("the MCP client is an agent: it cannot accept a strict result when the acceptor is human, but can reject", async () => {
    env = strictHumanEnv();
    const [a, b] = await finished(env, [critical({ id: "a" }), critical({ id: "b" })]);
    await connect(env);

    const noReason = await client!.callTool({ name: "accept_result", arguments: { taskId: a } });
    expect(noReason.isError).toBe(true);
    expect(text(noReason)).toMatch(/needs a reason/);
    const refused = await client!.callTool({ name: "accept_result", arguments: { taskId: a, reason: "matches the log" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/only a human can accept/);
    expect((await client!.callTool({ name: "reject_result", arguments: { taskId: b } })).isError).toBe(true);

    const rejected = body(await client!.callTool({ name: "reject_result", arguments: { taskId: b, reason: "wrong step" } }));
    expect(rejected).toMatchObject({ taskId: b, acceptanceStatus: "unmet", decision: { decision: "rejected", by: { kind: "supervisor", id: "mcp:test-client" }, reason: "wrong step" } });
    const collected = body(await client!.callTool({ name: "collect_results", arguments: { taskIds: [a, b] } })) as { completed: Array<{ taskId: string; acceptanceStatus: string }> };
    expect(collected.completed.map((r) => [r.taskId, r.acceptanceStatus])).toEqual([
      [a, "needs_supervisor"],
      [b, "unmet"],
    ]);
  }, 60_000);

  it("with the supervisor as strict acceptor, accept_result records the MCP client as the supervisor", async () => {
    const profiles = { ...(baseConfig().profiles as Record<string, Record<string, unknown>>) };
    profiles.summarize = { ...profiles.summarize, max_model_requests: 8 };
    env = makeEnv({ config: baseConfig({ profiles }) });
    const [a] = await finished(env, [critical({ id: "a" })]);
    await connect(env);
    const accepted = body(await client!.callTool({ name: "accept_result", arguments: { taskId: a, reason: "matches the log" } }));
    expect(accepted).toMatchObject({ taskId: a, acceptanceStatus: "met", decision: { decision: "accepted", by: { kind: "supervisor", id: "mcp:test-client" }, reason: "matches the log" } });
  }, 60_000);
});
