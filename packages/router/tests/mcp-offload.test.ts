// Supervisor-offload lane A: the core MCP tool set (client_supervision.tools: core|full),
// delegate/await/inbox/reply/probe/rework/accept/reject/run_check/status/offload_report.
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ChannelMessage, SupervisorChannelService } from "../src/core/channel.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await sy?.close();
  env?.cleanup();
  client = undefined;
  sy = undefined;
  env = undefined;
});

/** The core offload tool set, exactly (supervisor-offload lane A). */
const CORE_TOOLS = ["accept", "await", "delegate", "inbox", "offload_report", "probe", "read_artifact", "reject", "reply", "rework", "run_check", "status"];

const body = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

async function connect(tools: "core" | "full" = "core"): Promise<Client> {
  env = makeEnv({ config: baseConfig({ client_supervision: { tools } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const server = buildMcpServer({ sy, cfg: env.cfg, project: "demo" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "offload-test", version: "1" });
  await client.connect(clientTransport);
  return client;
}

describe("supervisor-offload core MCP tool set", () => {
  it("core mode registers exactly the core set; full mode also includes it", async () => {
    const c = await connect("core");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...CORE_TOOLS].sort());
    // The core set's combined tool-list JSON (names, titles, descriptions, schemas) stays well
    // under the 12KB budget the lane A brief sets, unlike the ~40KB full listing.
    const bytes = Buffer.byteLength(JSON.stringify((await c.listTools()).tools), "utf8");
    expect(bytes).toBeLessThan(12_000);
  });

  it("full mode restores every tool, including the core set", async () => {
    const c = await connect("full");
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const core of CORE_TOOLS) expect(names).toContain(core);
    expect(names).toContain("submit_tasks");
    expect(names).toContain("start_job");
    expect(names).toContain("get_supervision_policy");
  });

  it("delegate lints a vague/unsafe brief without submitting, then submits a valid one with a route preview", async () => {
    env = makeEnv({ config: baseConfig({ client_supervision: { tools: "core" } }) });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const server = buildMcpServer({ sy, cfg: env.cfg, project: "demo" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "offload-test", version: "1" });
    await client.connect(clientTransport);

    const before = (sy.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
    const vague = body(await client.callTool({ name: "delegate", arguments: { brief: { kind: "edit", goal: "fix it", scope: { writable: false }, doneWhen: ["it works"] } } }));
    expect(vague.ok).toBe(false);
    expect(vague.errors.length).toBeGreaterThan(0);
    expect((sy.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n).toBe(before);

    const good = body(
      await client.callTool({
        name: "delegate",
        arguments: { brief: { kind: "summarize", goal: "Summarise the fixture log for the error line", scope: { writable: false }, context: { notes: "line one\nline two\nERROR: boom at step 3" }, doneWhen: ["mentions the error"] } },
      }),
    );
    expect(good.ok).toBe(true);
    expect(good.taskId).toBeTruthy();
    expect(good.routePreview.candidates.length).toBeGreaterThan(0);

    const awaited = body(await client.callTool({ name: "await", arguments: { taskIds: [good.taskId], timeoutSeconds: 10 } }));
    expect(awaited.completed).toEqual([good.taskId]);
    expect(awaited.reports[good.taskId]).toContain("## Outcome");
    expect(awaited.reports[good.taskId]).toContain(good.taskId);
    expect(awaited.reports[good.taskId]).toContain("## Self-check");
  });

  it("accept and reject reuse the same decision path as the full set's accept_result/reject_result", async () => {
    env = makeEnv({ config: baseConfig({ client_supervision: { tools: "core" } }) });
    sy = open(env, new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req))), { worker: true });
    const server = buildMcpServer({ sy, cfg: env.cfg, project: "demo" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "offload-test", version: "1" });
    await client.connect(clientTransport);
    const [sub] = await sy.submitTasks([summarizeTask()]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    const rejected = body(await client.callTool({ name: "reject", arguments: { taskId: sub!.taskId, reason: "spot-checked and it misses the error line" } }));
    expect(rejected.acceptanceStatus).toBe("unmet");
    const [sub2] = await sy.submitTasks([summarizeTask({ idempotencyKey: "accept-me" })]);
    await sy.awaitResults([sub2!.taskId], { timeoutSeconds: 10 });
    const accepted = body(await client.callTool({ name: "accept", arguments: { taskId: sub2!.taskId, reason: "spot-checked, matches the log" } }));
    expect(accepted.acceptanceStatus).toBe("met");
  });

  it("run_check only runs a command the task actually declared, against its recorded worktree", async () => {
    const c = await connect("core");
    const missing = await c.callTool({ name: "run_check", arguments: { taskId: "no-such-task", command: "node --version" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]!.text).toContain("unknown task");

    const [sub] = await sy!.submitTasks([summarizeTask({ profile: "inspect", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["mentions the error"], checks: ["node --version"] }, context: {} })]);
    const undeclared = await c.callTool({ name: "run_check", arguments: { taskId: sub!.taskId, command: "echo hi" } });
    expect(undeclared.isError).toBe(true);
    expect((undeclared.content as Array<{ text: string }>)[0]!.text).toContain("is not one of this task's declared checks");

    const declaredButNoWorkspace = await c.callTool({ name: "run_check", arguments: { taskId: sub!.taskId, command: "node --version" } });
    expect(declaredButNoWorkspace.isError).toBe(true);
    expect((declaredButNoWorkspace.content as Array<{ text: string }>)[0]!.text).toContain("no recorded worktree");
  });

  it("status and offload_report", async () => {
    const c = await connect("core");
    const [sub] = await sy!.submitTasks([summarizeTask()]);
    const status = body(await c.callTool({ name: "status", arguments: { taskIds: [sub!.taskId] } }));
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ taskId: sub!.taskId });
    const report = body(await c.callTool({ name: "offload_report", arguments: { taskIds: [sub!.taskId] } }));
    expect(report.totalTasks).toBe(1);
    expect(report.window.project).toBeTruthy();
  });

  it("inbox, reply, probe and rework delegate to the injected channel service (fake sy.channel)", async () => {
    const c = await connect("core");
    const calls: unknown[][] = [];
    const createdAt = Date.now();
    const message = (over: Partial<ChannelMessage> = {}): ChannelMessage =>
      ({ id: "m1", taskId: "t1", projectId: "demo", direction: "worker_to_supervisor", kind: "question", body: "Which repo?", status: "pending", createdAt, ...over }) as ChannelMessage;
    const probeAnswer = message({ id: "a0", direction: "worker_to_supervisor", kind: "answer", body: "The auth test.", inReplyTo: "p0" });
    const fakeChannel: SupervisorChannelService = {
      postFromWorker: async () => { throw new Error("not exercised by the MCP surface"); },
      awaitReply: async () => { throw new Error("not exercised by the MCP surface"); },
      replyFromSupervisor: async (input) => { calls.push(["reply", input]); return message({ id: "m1", direction: "supervisor_to_worker", kind: "answer", status: "delivered", inReplyTo: "m1", body: input.body }); },
      probe: async (taskId, question) => { calls.push(["probe", taskId, question]); return message({ id: "m2", taskId, direction: "supervisor_to_worker", kind: "probe", body: question }); },
      rework: async (taskId, feedback, criteria) => { calls.push(["rework", taskId, feedback, criteria]); return "t1-rework-1"; },
      pendingForWorker: () => [],
      grantedTools: () => [],
      listPendingForSupervisor: () => [message(), probeAnswer],
      replyFromWorker: async () => { throw new Error("worker side only"); },
      markDelivered: () => { throw new Error("worker side only"); },
      acknowledge: (ids) => { calls.push(["acknowledge", ids]); return []; },
      replyTo: (id) => (id === "m2" ? message({ id: "a2", taskId: "t1", direction: "worker_to_supervisor", kind: "answer", body: "It prints ENOENT.", inReplyTo: "m2", refs: ["session:s1"] }) : null),
      messagesForTask: () => [message({ id: "p0", direction: "supervisor_to_worker", kind: "probe", body: "Which test failed?" })],
    };
    sy!.channel = fakeChannel;

    const inboxed = body(await c.callTool({ name: "inbox", arguments: {} }));
    expect(inboxed.requests).toEqual([message()]);
    // Probe answers come with their question, once, and are then acknowledged.
    expect(inboxed.answers).toEqual([{ ...probeAnswer, question: "Which test failed?" }]);
    expect(calls.shift()).toEqual(["acknowledge", ["a0"]]);

    const replied = body(await c.callTool({ name: "reply", arguments: { messageId: "m1", kind: "answer", body: "The core repo." } }));
    expect(replied.body).toBe("The core repo.");
    expect(calls[0]).toEqual(["reply", { messageId: "m1", kind: "answer", body: "The core repo." }]);

    const probed = body(await c.callTool({ name: "probe", arguments: { taskId: "t1", question: "What does the failing check print?" } }));
    expect(probed).toEqual({ status: "answered", probeId: "m2", answer: "It prints ENOENT.", refs: ["session:s1"] });
    expect(calls[1]).toEqual(["probe", "t1", "What does the failing check print?"]);
    expect(calls[2]).toEqual(["acknowledge", ["a2"]]);

    const reworked = body(await c.callTool({ name: "rework", arguments: { taskId: "t1", feedback: "Criterion c1 unmet: the summary omits the error line.", criteria: ["Mention the ERROR line verbatim"] } }));
    expect(reworked).toEqual({ taskId: "t1-rework-1" });
    expect(calls[3]).toEqual(["rework", "t1", "Criterion c1 unmet: the summary omits the error line.", ["Mention the ERROR line verbatim"]]);
  });
});
