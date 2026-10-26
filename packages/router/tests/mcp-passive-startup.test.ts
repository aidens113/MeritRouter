import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpOptions, parseMcpArgv } from "../src/mcp/serve.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, goodOutput, summarizeTask, type Env } from "./helpers.js";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
let env: Env | undefined, sy: MeritRouter | undefined, client: Client | undefined, provider: Server | undefined;
let calls = 0;
afterEach(async () => {
  await client?.close(); client = undefined;
  await sy?.close(); sy = undefined;
  if (provider) await new Promise<void>((resolve, reject) => provider!.close(error => error ? reject(error) : resolve()));
  provider = undefined;
  env?.cleanup(); env = undefined;
});
const content = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

it("requires explicit worker selection and refuses conflicting flags through shared CLI parsing", () => {
  expect(mcpOptions({}).worker).toBe(false);
  expect(parseMcpArgv([]).worker).toBe(false);
  expect(parseMcpArgv(["--no-worker"]).worker).toBe(false);
  expect(parseMcpArgv(["--worker"]).worker).toBe(true);
  expect(mcpOptions({ worker: true }).worker).toBe(true);
  expect(() => parseMcpArgv(["--worker", "--no-worker"])).toThrow(/choose --worker or --no-worker/);
  expect(() => mcpOptions({ worker: true, "no-worker": true })).toThrow(/choose --worker or --no-worker/);
});

async function setup() {
  calls = 0;
  provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `fixture-${calls}`, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(goodOutput()) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
  await new Promise<void>(resolve => provider!.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  const cfg = baseConfig();
  (cfg.providers as Record<string, Record<string, unknown>>).openrouter!.base_url = `http://127.0.0.1:${address.port}/v1`;
  (cfg.profiles as Record<string, Record<string, unknown>>).summarize!.batching = { enabled: false };
  env = makeEnv({ config: cfg });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  return sy;
}
async function connect(entry: "standalone" | "cli", flags: string[]) {
  client = new Client({ name: "passive-regression", version: "1" });
  const command = entry === "standalone" ? [path.join(dist, "mcp.js")] : [path.join(dist, "cli.js"), "mcp"];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...command, "--config", env!.cfg.configPath, ...flags], env: { PATH: process.env.PATH ?? "", MERITROUTER_PANEL_DIR: path.join(tmpdir(), "meritrouter-no-panel-app") } }));
}

it.each([
  ["standalone", []], ["standalone", ["--no-worker"]],
  ["cli", []], ["cli", ["--no-worker"]],
] as const)("%s MCP %j discovery, submission and resume do not claim queued work", async (entry, flags) => {
  const router = await setup();
  const [queued, interrupted] = await router.submitTasks([summarizeTask({ idempotencyKey: "queued" }), summarizeTask({ idempotencyKey: "interrupted" })]);
  router.db.prepare("UPDATE tasks SET state='interrupted',state_reason='fixture shutdown' WHERE id=?").run(interrupted!.taskId);
  await connect(entry, [...flags]);
  expect((await client!.listTools()).tools.some(tool => tool.name === "submit_tasks")).toBe(true);
  const submission = await client!.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "submitted" })] } });
  expect(submission.isError).toBeFalsy();
  const added = JSON.parse(content(submission)).submitted[0].taskId as string;
  const resumed = await client!.callTool({ name: "resume_task", arguments: { taskId: interrupted!.taskId } });
  expect(resumed.isError).toBeFalsy();
  // Cross an actual worker polling interval; a mistakenly active scheduler would claim/spend.
  await new Promise(resolve => setTimeout(resolve, 1250));
  const status = await client!.callTool({ name: "get_task_status", arguments: { taskIds: [queued!.taskId, interrupted!.taskId, added] } });
  expect(JSON.parse(content(status))).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: queued!.taskId, state: "queued", modelRequestsUsed: 0 }), expect.objectContaining({ taskId: interrupted!.taskId, state: "queued", modelRequestsUsed: 0 }), expect.objectContaining({ taskId: added, state: "queued", modelRequestsUsed: 0 })]));
  expect(router.db.prepare("SELECT run_count FROM tasks").all()).toEqual([{ run_count: 0 }, { run_count: 0 }, { run_count: 0 }]);
  expect(router.db.prepare("SELECT id FROM model_requests").all()).toEqual([]);
  expect(router.db.prepare("SELECT key FROM meta WHERE key LIKE 'worker:%'").all()).toEqual([]);
  expect(router.tasks.events(queued!.taskId).some(event => event.type === "claimed")).toBe(false);
  expect(calls).toBe(0);
}, 30_000);

it.each(["standalone", "cli"] as const)("%s explicit --worker executes through the loopback fake provider", async entry => {
  const router = await setup();
  const [task] = await router.submitTasks([summarizeTask()]);
  await connect(entry, ["--worker"]);
  const outcome = await router.awaitResults([task!.taskId], { timeoutSeconds: 15 });
  expect(outcome.completed[0]?.executionStatus).toBe("completed");
  expect(calls).toBe(1);
  expect(router.db.prepare("SELECT status FROM model_requests").all()).toEqual([{ status: "succeeded" }]);
  expect(router.admission.taskTotals(task!.taskId).requests).toBe(1);
}, 30_000);

it("preserves explicitly requested programmatic worker:true", async () => {
  env = makeEnv();
  const cfg = mcpOptions({ worker: true });
  const fake = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
  sy = open(env, fake, { worker: cfg.worker });
  const [task] = await sy.submitTasks([summarizeTask()]);
  expect((await sy.awaitResults([task!.taskId], { timeoutSeconds: 10 })).completed[0]?.executionStatus).toBe("completed");
  expect(fake.requests).toHaveLength(1);
});
