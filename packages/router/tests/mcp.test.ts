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
    expect(tools).toEqual([
      "accept_result", "answer_question", "await_results", "blame", "brain_access_requests", "brain_append_ledger", "brain_decide_request", "brain_list", "brain_promote_lesson",
      "brain_read", "brain_search", "brain_set_current_state", "brain_start_working_doc", "brain_write", "cancel_tasks", "collect_results", "get_job_metrics", "get_job_tree", "get_plan", "get_session", "get_task_status",
      "job_status", "list_questions", "list_sessions", "panel", "preview_route", "read_artifact", "read_channel", "reject_result", "resume_session", "resume_task", "start_job", "submit_tasks", "usage_summary",
    ]);

    // The test config turns panel.auto_start off: the panel tool reports that and starts nothing.
    const panel = await client.callTool({ name: "panel", arguments: {} });
    expect(JSON.parse((panel.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ state: expect.stringMatching(/^(disabled|running)$/) });
    const info = client.getInstructions();
    expect(info).toMatch(/web panel \(http:\/\/127\.0\.0\.1:\d+\)/);

    const bad = await client.callTool({ name: "submit_tasks", arguments: { tasks: [{ profile: "summarize" }] } });
    expect(bad.isError).toBe(true);
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
});
