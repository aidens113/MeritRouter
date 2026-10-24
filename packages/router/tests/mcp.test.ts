import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeEnv, summarizeTask, type Env } from "./helpers.js";

/** The panel tool forces a start: point it at a folder with no panel app so a test never launches one. */
const NO_PANEL = path.join(tmpdir(), "meritrouter-no-panel-app");

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const server = path.join(dist, "mcp.js");
let env: Env | undefined;

/** JSON Schema keywords every MCP client reads, OpenAI's included (see src/mcp/schemas.ts). */
const PORTABLE = new Set(["type", "properties", "required", "items", "enum", "description", "additionalProperties", "anyOf", "minimum", "maximum", "exclusiveMinimum", "minItems", "maxItems", "minLength", "maxLength", "default"]);

/** Why a tool's input schema would not suit an OpenAI client; empty when it suits. */
function schemaProblems(tool: string, schema: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (schema.type !== "object" || typeof schema.properties !== "object") problems.push(`${tool}: the input schema is not an object with properties`);
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return problems.push(`${at}: not a schema`);
    const n = node as Record<string, unknown>;
    for (const k of Object.keys(n)) if (!PORTABLE.has(k) && !(at === tool && k === "$schema")) problems.push(`${at}: keyword ${k}`);
    if (n.type === undefined && !Array.isArray(n.anyOf)) problems.push(`${at}: no type (Codex would read a string)`);
    if (n.type === "array" && !n.items) problems.push(`${at}: array without items`);
    if (n.additionalProperties !== undefined && typeof n.additionalProperties !== "boolean") problems.push(`${at}: additionalProperties is a schema, not true or false`);
    for (const [k, v] of Object.entries((n.properties as Record<string, unknown>) ?? {})) walk(v, `${at}.${k}`);
    if (n.items) walk(n.items, `${at}[]`);
    for (const [i, v] of ((n.anyOf as unknown[]) ?? []).entries()) walk(v, `${at}|${i}`);
  };
  walk(schema, tool);
  return problems;
}
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  env?.cleanup();
});

describe("MCP server", () => {
  it("exposes the task tools and persists submissions before acknowledging", async () => {
    env = makeEnv();
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, "--config", env.cfg.configPath], env: { PATH: process.env.PATH ?? "", MERITROUTER_PANEL_DIR: NO_PANEL } }));
    const listed = (await client.listTools()).tools;
    // Every input schema suits OpenAI clients (Codex, ChatGPT): portable keywords only, typed
    // nodes, and open objects that say additionalProperties: true. Empty inputs are objects.
    expect(listed.flatMap((t) => schemaProblems(t.name, t.inputSchema as Record<string, unknown>))).toEqual([]);
    expect(listed.find((t) => t.name === "panel")!.inputSchema).toMatchObject({ type: "object", properties: {} });
    const tools = listed.map((t) => t.name).sort();
    expect(tools).toEqual([
      "accept_result", "answer_question", "await_results", "blame", "brain_access_requests", "brain_append_ledger", "brain_decide_request", "brain_list", "brain_promote_lesson",
      "brain_read", "brain_search", "brain_set_current_state", "brain_start_working_doc", "brain_write", "budget_requests", "cancel_tasks", "collect_results", "decide_budget_request", "decide_delivery", "delivery_status", "get_job_metrics", "get_job_tree", "get_plan", "get_session", "get_supervision_policy", "get_task_status",
      "job_status", "lab_control", "lab_logs", "lab_operation", "lab_status", "list_questions", "list_sessions", "panel", "preview_route", "project_delivery_report", "read_artifact", "read_channel", "record_delivery_observation", "reject_result", "resume_session", "resume_task", "set_supervision_policy", "start_job", "submit_tasks", "usage_summary", "write_project_memory", "write_user_preference",
    ]);

    // Any tool call revives a panel the user turned off: the marker goes (auto_start off here, and no
    // panel app, so nothing starts).
    const marker = path.join(env!.cfg.storageDir, "panel.stopped");
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), by: "test" }));
    await client.callTool({ name: "usage_summary", arguments: {} });
    for (let i = 0; i < 50 && existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(marker)).toBe(false);

    // The test config turns panel.auto_start off: the panel tool reports that and starts nothing.
    const panel = await client.callTool({ name: "panel", arguments: {} });
    expect(JSON.parse((panel.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/no panel app at/) });
    const info = client.getInstructions();
    expect(info).toMatch(/web panel \(http:\/\/127\.0\.0\.1:\d+\)/);

    const bad = await client.callTool({ name: "submit_tasks", arguments: { tasks: [{ profile: "summarize" }] } });
    expect(bad.isError).toBe(true);
    // The described task shape keeps unknown keys, so the service's strict validation still sees them.
    const unknownKey = await client.callTool({ name: "submit_tasks", arguments: { tasks: [{ ...summarizeTask({ idempotencyKey: "mcp-x" }), bogusField: 1 }] } });
    expect(unknownKey.isError).toBe(true);
    expect((unknownKey.content as Array<{ text: string }>)[0]!.text).toMatch(/bogusField/);
    const noPlan = await client.callTool({ name: "get_plan", arguments: { jobId: "no-such-job" } });
    expect(noPlan.isError).toBe(true);
    expect((noPlan.content as Array<{ text: string }>)[0]!.text).toBe("unknown job no-such-job");
    for (const name of ["get_job_tree", "read_channel"]) {
      const missing = await client.callTool({ name, arguments: { jobId: "no-such-job" } });
      expect(missing.isError).toBe(true);
      expect((missing.content as Array<{ text: string }>)[0]!.text).toBe("unknown job no-such-job");
    }
    const noMetrics = await client.callTool({ name: "get_job_metrics", arguments: { jobId: "no-such-job" } });
    expect(noMetrics.isError).toBe(true);
    expect((noMetrics.content as Array<{ text: string }>)[0]!.text).toBe("unknown job or task no-such-job");
    // Portable descriptive shapes must retain unknown keys for strict runtime validation.
    const badLabControl = await client.callTool({ name: "lab_control", arguments: { name: "fixture", operation: { kind: "start", unexpected: true } } });
    expect(badLabControl.isError).toBe(true);
    expect((badLabControl.content as Array<{ text: string }>)[0]!.text).toMatch(/unexpected/);
    const missingCheck = await client.callTool({ name: "lab_control", arguments: { name: "fixture", operation: { kind: "check" } } });
    expect(missingCheck.isError).toBe(true);
    expect((missingCheck.content as Array<{ text: string }>)[0]!.text).toMatch(/name/);
    expect((await client.callTool({ name: "read_channel", arguments: { jobId: "x", kinds: ["rumour"] } })).isError).toBe(true);

    const ok = await client.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "mcp-1" })] } });
    const submitted = JSON.parse((ok.content as Array<{ text: string }>)[0]!.text).submitted;
    expect(submitted[0].taskId).toMatch(/^t_/);
    // Metrics of any task: one agent's (single) view; the agents' intervals only on request.
    const metrics = JSON.parse(((await client.callTool({ name: "get_job_metrics", arguments: { jobId: submitted[0].taskId } })).content as Array<{ text: string }>)[0]!.text) as { jobId: string; kind: string; agents?: unknown };
    expect(metrics).toMatchObject({ jobId: submitted[0].taskId, kind: "single" });
    expect(metrics.agents).toBeUndefined();
    const withAgents = JSON.parse(((await client.callTool({ name: "get_job_metrics", arguments: { jobId: submitted[0].taskId, agents: true } })).content as Array<{ text: string }>)[0]!.text) as { agents: Array<{ taskId: string }> };
    expect(withAgents.agents.map((a) => a.taskId)).toEqual([submitted[0].taskId]);
    const again = await client.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "mcp-1" })] } });
    expect(JSON.parse((again.content as Array<{ text: string }>)[0]!.text).submitted[0]).toMatchObject({ taskId: submitted[0].taskId, deduplicated: true });

    // Claude Code uses the shared brain as a supervisor: it can start a working document and read it back.
    const doc = await client.callTool({ name: "brain_start_working_doc", arguments: { effort: "mcp-effort", title: "From Claude", scope: "test", currentState: "hello" } });
    expect(doc.isError).toBeFalsy();
    const read = await client.callTool({ name: "brain_read", arguments: { path: "projects/demo/working/mcp-effort.md", section: "Current State" } });
    expect(JSON.parse((read.content as Array<{ text: string }>)[0]!.text).content).toBe("hello");

    // No gateway key in this environment: the task fails with a typed auth reason, not a hang.
    const res = await client.callTool({ name: "await_results", arguments: { taskIds: [submitted[0].taskId], timeoutSeconds: 15 } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(body.completed[0].stopReason).toMatch(/gateway_auth|no_eligible_endpoint/);
  }, 60_000);

  it("runs as `meritrouter mcp` on stdio, so an installed package needs no dist path", async () => {
    env = makeEnv();
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(dist, "cli.js"), "mcp", "--config", env.cfg.configPath, "--no-worker"], env: { PATH: process.env.PATH ?? "", MERITROUTER_PANEL_DIR: NO_PANEL } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("submit_tasks");
    expect(names).toHaveLength(48);
    const noJob = await client.callTool({ name: "job_status", arguments: { jobId: "no-such-job" } });
    expect((noJob.content as Array<{ text: string }>)[0]!.text).toBe("unknown job no-such-job");
  }, 60_000);
});
