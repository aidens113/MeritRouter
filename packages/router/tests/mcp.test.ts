import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeEnv, summarizeTask, type Env } from "./helpers.js";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp.js");
let env: Env | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  env?.cleanup();
});

describe("MCP server", () => {
  it("exposes the task tools and persists submissions before acknowledging", async () => {
    env = makeEnv();
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, "--config", env.cfg.configPath], env: { PATH: process.env.PATH ?? "" } }));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["await_results", "cancel_tasks", "collect_results", "get_task_status", "preview_route", "read_artifact", "resume_task", "submit_tasks", "usage_summary"]);

    const bad = await client.callTool({ name: "submit_tasks", arguments: { tasks: [{ profile: "summarize" }] } });
    expect(bad.isError).toBe(true);

    const ok = await client.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "mcp-1" })] } });
    const submitted = JSON.parse((ok.content as Array<{ text: string }>)[0]!.text).submitted;
    expect(submitted[0].taskId).toMatch(/^t_/);
    const again = await client.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "mcp-1" })] } });
    expect(JSON.parse((again.content as Array<{ text: string }>)[0]!.text).submitted[0]).toMatchObject({ taskId: submitted[0].taskId, deduplicated: true });

    // No gateway key in this environment: the task fails with a typed auth reason, not a hang.
    const res = await client.callTool({ name: "await_results", arguments: { taskIds: [submitted[0].taskId], timeoutSeconds: 15 } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(body.completed[0].stopReason).toMatch(/gateway_auth|no_eligible_endpoint/);
  }, 60_000);
});
