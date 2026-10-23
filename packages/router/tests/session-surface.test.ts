import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ChatMessage, ChatResponse } from "../src/gateway/types.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { GatewayError } from "../src/core/errors.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { jobDetail, jobsView, sessionsView } from "../src/admin/insights.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

// Both surfaces run from dist/ (build first: pnpm --filter switchyard-router build).
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const cliJs = path.join(dist, "cli.js");
const mcpJs = path.join(dist, "mcp.js");

let env: Env | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  env?.cleanup();
  env = undefined;
});

const EP = "openrouter/vendor/big-a:free";
const gateResponse = (content: string | null, toolCalls?: ChatResponse["message"]["tool_calls"]): GateResponse => ({
  requestId: "req_1",
  response: reply(content, toolCalls ? { toolCalls } : {}),
  endpoint: { id: EP } as ModelEndpoint,
  attempts: [{ endpointId: EP, outcome: "ok" }],
  estimatedInputTokens: 42,
});

/**
 * Two sessions recorded directly through the store with authoritative task/execution membership:
 * a completed analyst session with a tool call, and a failed delegated child with a model error.
 */
async function seed(e: Env): Promise<{ root: string; child: string; rootEvents: number }> {
  const sy = open(e, new ScriptedClient(() => reply("unused")));
  try {
    sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "t_root", label: undefined })), WorkerTaskSchema.parse(summarizeTask({ id: "t_child", label: undefined }))]);
    sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "j_1", label: undefined }))]);
    sy.db.prepare("UPDATE tasks SET state='completed' WHERE id IN ('t_root','t_child','j_1')").run();
    authorizeExecution(sy, "exec_1", "t_root", true);
    authorizeExecution(sy, "exec_2", "t_child");
    const root = sy.sessions.create({ taskId: "t_root", jobId: "j_1", role: "analyst", agentLabel: "analyst-1", profile: "analyze", tier: "T2" });
    const messages: ChatMessage[] = [
      { role: "system", content: "charter text" },
      { role: "user", content: "Find the\nbug in app.ts" },
    ];
    root.syncMessages(messages);
    root.modelRequest({ executionId: "exec_1", purpose: "runner", chat: { messages, max_tokens: 500, tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: {} } }] } });
    root.modelResponse(gateResponse(null, [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } }]));
    const intent = root.toolIntent({ callId: "c1", name: "read_file", args: { path: "src/app.ts" }, sideEffect: "read" });
    root.toolOutcome(intent, { ok: true, output: "export function add(a, b) {\n  return a + b;\n}" });
    root.note("checkpoint reached");
    root.end("completed", "submitted");

    const child = sy.sessions.create({ taskId: "t_child", jobId: "j_1", parentSessionId: root.id, role: "implementer", agentLabel: "implementer-1", profile: "implement", tier: "T3" });
    child.syncMessages([{ role: "user", content: "fix it" }]);
    child.modelRequest({ executionId: "exec_2", purpose: "runner", chat: { messages: [{ role: "user", content: "fix it" }], max_tokens: 800 } });
    child.modelError({ executionId: "exec_2", error: new GatewayError("rate_limited", "slow down", 429), attempts: [{ endpointId: EP, outcome: "rate_limited" }] });
    child.end("failed", "gateway_rate_limited");
    return { root: root.id, child: child.id, rootEvents: root.lastSeq };
  } finally {
    await sy.close();
  }
}

/** Timeline disclosure requires the same durable authority recorded by real runners. */
function authorizeExecution(sy: ReturnType<typeof open>, execution: string, taskId: string, response = false): void {
  sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES (?,'task','summarize','completed',1)").run(execution);
  sy.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES (?,?,?)").run(execution, taskId, taskId);
  if (response) {
    sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES ('req_1',?,'runner',?,'succeeded',1,42,500,'demo')").run(execution, EP);
    sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES ('req_1',?,42,50)").run(taskId);
  }
}

/** The environment without secrets, so the CLI never sees a real gateway or provider key. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|FREELLMAPI|SWITCHYARD/i.test(k)));
}

function cli(e: Env, ...args: string[]) {
  const r = spawnSync(process.execPath, [cliJs, ...args, "--config", e.cfg.configPath], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("session CLI", () => {
  it("lists sessions with filters and prints JSON", async () => {
    env = makeEnv();
    const { root, child } = await seed(env);

    const all = cli(env, "sessions");
    expect(all.code, all.stderr).toBe(0);
    const lines = all.stdout.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^session\s+status\s+role\s+agent\s+task\s+job\s+requests\s+tools\s+events\s+started\s+duration\s+reason/);
    // Newest first.
    expect(lines[2]).toContain(child);
    expect(lines[2]).toMatch(/failed\s+implementer\s+implementer-1\s+t_child\s+j_1\s+1\s+0\s+5\s/);
    expect(lines[3]).toContain(root);
    expect(lines[3]).toMatch(/completed\s+analyst\s+analyst-1\s+t_root/);

    const failed = cli(env, "sessions", "--status", "failed", "--json");
    expect(failed.code, failed.stderr).toBe(0);
    const failedRows = JSON.parse(failed.stdout) as Array<{ id: string; status: string; parentSessionId: string }>;
    expect(failedRows.map((s) => s.id)).toEqual([child]);
    expect(failedRows[0]).toMatchObject({ status: "failed", parentSessionId: root });

    const several = JSON.parse(cli(env, "sessions", "--status", "completed,failed", "--json").stdout) as unknown[];
    expect(several).toHaveLength(2);
    expect((JSON.parse(cli(env, "sessions", "--task", "t_root", "--json").stdout) as Array<{ id: string }>).map((s) => s.id)).toEqual([root]);
    expect(JSON.parse(cli(env, "sessions", "--job", "j_1", "--limit", "1", "--json").stdout)).toHaveLength(1);
    expect(cli(env, "sessions", "--job", "j_none").stdout.trim()).toBe("(none)");

    const bad = cli(env, "sessions", "--status", "sleeping");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/--status takes running, completed, failed, interrupted, cancelled/);
    expect(cli(env, "sessions", "--limit", "0").stderr).toMatch(/--limit must be an integer >= 1/);
  }, 60_000);

  it("prints a session timeline with paging", async () => {
    env = makeEnv();
    const { root, child, rootEvents } = await seed(env);

    const t = cli(env, "session", root);
    expect(t.code, t.stderr).toBe(0);
    const out = t.stdout;
    expect(out.split(/\r?\n/)[0]).toBe(`${root} analyst-1 (analyst) completed: submitted`);
    expect(out).toContain("task t_root  job j_1  profile analyze  tier T2");
    expect(out).toMatch(/model requests 1 {2}tool calls 1 {2}events 9/);
    expect(out).toMatch(/seq\s+time\s+type\s+name\/ok\s+summary/);
    const row = (seq: number) => out.split(/\r?\n/).find((l) => new RegExp(`^\\s*${seq}  \\d\\d:\\d\\d:\\d\\d\\.\\d{3}  `).test(l)) ?? "";
    expect(row(1)).toMatch(/started\s+analyst\s+agent analyst-1, profile analyze, tier T2, task t_root/);
    // Multi-line content collapses to one line.
    expect(row(3)).toMatch(/message\s+user\s+#1 Find the bug in app\.ts$/);
    expect(row(4)).toMatch(/model_request\s+runner\s+2 msgs, max 500 tok, tools read_file/);
    expect(row(5)).toMatch(/model_response\s+openrouter\/vendor\/big-a:free ok\s+stop, in 100 \(cache unknown\) \/ out 50 tok: -> read_file/);
    expect(row(6)).toMatch(/tool_intent\s+read_file\s+\[read\] \{"path":"src\/app\.ts"\}/);
    expect(row(7)).toMatch(/tool_outcome\s+read_file ok\s+intent #6: export function add\(a, b\) \{ return a \+ b; \}/);
    expect(row(8)).toMatch(/note\s+checkpoint reached/);
    expect(row(9)).toMatch(/ended\s+completed\s+submitted/);
    expect(out).not.toContain("more events");
    expect(out).toContain("delegated sessions:");
    expect(out).toContain(`  ${child} implementer (implementer) failed`);

    // The failed child shows the model error with its code and status.
    const c = cli(env, "session", child).stdout;
    expect(c).toMatch(/model_error\s+gateway:rate_limited FAIL\s+HTTP 429: slow down/);
    expect(c).toContain(`parent ${root}`);

    // Paging: --after/--limit, with a hint for the next page.
    const page = cli(env, "session", root, "--after", "3", "--limit", "2");
    expect(page.code, page.stderr).toBe(0);
    expect(page.stdout).toMatch(/^\s*4 {2}.*model_request/m);
    expect(page.stdout).toMatch(/^\s*5 {2}.*model_response/m);
    expect(page.stdout).not.toMatch(/^\s*6 {2}/m);
    expect(page.stdout).toContain(`more events: switchyard session ${root} --after 5`);
    expect(cli(env, "session", root, "--after", String(rootEvents)).stdout).toContain(`(no events after seq ${rootEvents})`);

    // --json prints the raw page.
    const raw = JSON.parse(cli(env, "session", root, "--after", "3", "--limit", "2", "--json").stdout) as { events: Array<{ seq: number; type: string }>; hasMore: boolean; lastSeq: number; corrupt: unknown[]; session: { id: string }; children: Array<{ id: string }> };
    expect(raw.events.map((e) => [e.seq, e.type])).toEqual([[4, "model_request"], [5, "model_response"]]);
    expect(raw).toMatchObject({ hasMore: true, lastSeq: rootEvents, corrupt: [], session: { id: root } });
    expect(raw.children.map((s) => s.id)).toEqual([child]);

    const missing = cli(env, "session", "s_missing");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("unknown session s_missing");
    expect(cli(env, "session").stderr).toContain("usage: switchyard session <id>");
    expect(cli(env, "session", root, "--after", "x").stderr).toMatch(/--after must be an integer >= 0/);
  }, 60_000);
});

describe("session MCP tools", () => {
  it("lists sessions and pages through a timeline", async () => {
    env = makeEnv();
    const { root, child, rootEvents } = await seed(env);
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpJs, "--config", env.cfg.configPath], env: { PATH: process.env.PATH ?? "" } }));
    const body = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

    const all = body(await client.callTool({ name: "list_sessions", arguments: {} })) as Array<{ id: string }>;
    expect(all.map((s) => s.id)).toEqual([child, root]);
    expect((body(await client.callTool({ name: "list_sessions", arguments: { status: "completed" } })) as Array<{ id: string }>).map((s) => s.id)).toEqual([root]);
    expect(body(await client.callTool({ name: "list_sessions", arguments: { status: ["completed", "failed"], jobId: "j_1" } }))).toHaveLength(2);
    expect((body(await client.callTool({ name: "list_sessions", arguments: { parentSessionId: root } })) as Array<{ id: string }>).map((s) => s.id)).toEqual([child]);
    expect((await client.callTool({ name: "list_sessions", arguments: { status: "sleeping" } })).isError).toBe(true);

    const first = body(await client.callTool({ name: "get_session", arguments: { sessionId: root, limit: 4 } }));
    expect(first.session).toMatchObject({ id: root, status: "completed", modelRequests: 1, toolCalls: 1 });
    expect(first.events.map((e: { type: string }) => e.type)).toEqual(["started", "message", "message", "model_request"]);
    expect(first.hasMore).toBe(true);
    const rest = body(await client.callTool({ name: "get_session", arguments: { sessionId: root, afterSeq: 4 } }));
    expect(rest.events.map((e: { seq: number }) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(rest).toMatchObject({ hasMore: false, lastSeq: rootEvents, corrupt: [] });
    expect(rest.events.find((e: { type: string }) => e.type === "tool_outcome").data).toMatchObject({ name: "read_file", ok: true });
    expect(rest.children.map((s: { id: string }) => s.id)).toEqual([child]);

    const err = body(await client.callTool({ name: "get_session", arguments: { sessionId: child } }));
    expect(err.events.find((e: { type: string }) => e.type === "model_error").data).toMatchObject({ code: "gateway:rate_limited", status: 429 });

    const missing = await client.callTool({ name: "get_session", arguments: { sessionId: "s_missing" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]!.text).toContain("unknown session s_missing");
  }, 60_000);
});

/**
 * Submit a task straight into the store and mark it interrupted, as after a crash. Its run count
 * is at the auto-resume cap (3), so a starting worker (the MCP server) leaves it to the operator.
 */
function interruptedTask(sy: ReturnType<typeof open>, label: string): string {
  const [t] = sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ label }))]);
  sy.db.prepare("UPDATE tasks SET state = 'interrupted', state_reason = 'worker lease expired', run_count = 3 WHERE id = ?").run(t!.taskId);
  return t!.taskId;
}

/**
 * Interrupted work for the resume surfaces:
 * - `resumed`: a session that crashed with a read in flight, was resumed once (a `resumed` event),
 *   then interrupted again; its task is interrupted, so it can be resumed;
 * - `stale`: an older interrupted session of the same task (superseded by `resumed`);
 * - `other`: the latest session of a second interrupted task, resumed by task id;
 * - `done`: a completed session of a completed task.
 */
async function seedInterrupted(e: Env): Promise<{ resumed: string; stale: string; other: string; done: string; taskId: string; otherTask: string }> {
  const sy = open(e, new ScriptedClient(() => reply("unused")));
  try {
    const taskId = interruptedTask(sy, "resume-me");
    authorizeExecution(sy, "exec_r", taskId, true);
    const stale = sy.sessions.create({ taskId, role: "summarizer", agentLabel: "summarizer:old", profile: "summarize", tier: "T1" });
    stale.end("interrupted", "shutdown");
    const rec = sy.sessions.create({ taskId, role: "inspector", agentLabel: "inspector:resume-me", profile: "summarize", tier: "T1" });
    const messages: ChatMessage[] = [
      { role: "system", content: "charter" },
      { role: "user", content: "Read src/app.ts" },
    ];
    const read = { id: "c1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } };
    rec.syncMessages(messages);
    rec.modelRequest({ executionId: "exec_r", purpose: "tool_loop", chat: { messages, max_tokens: 500 } });
    rec.modelResponse(gateResponse(null, [read]));
    rec.syncMessages([...messages, { role: "assistant", content: null, tool_calls: [read] }]);
    rec.toolIntent({ callId: "c1", name: "read_file", args: { path: "src/app.ts" }, sideEffect: "read" });
    rec.end("interrupted", "process_died");
    // A worker resumed it once, then stopped again before the next request.
    const again = sy.sessions.reopen(rec.id);
    const plan = sy.sessions.planResume(rec.id)!;
    again.resumed(plan.summary, plan.actions, plan);
    again.syncMessages([...plan.messages, { role: "user", content: plan.summary }]);
    again.end("interrupted", "shutdown");

    const otherTask = interruptedTask(sy, "by-task-id");
    const other = sy.sessions.create({ taskId: otherTask, role: "summarizer", agentLabel: "summarizer:by-task-id", profile: "summarize", tier: "T1" });
    other.end("interrupted", "shutdown");

    const [doneTask] = sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ label: "finished" }))]);
    sy.db.prepare("UPDATE tasks SET state = 'completed' WHERE id = ?").run(doneTask!.taskId);
    const done = sy.sessions.create({ taskId: doneTask!.taskId, role: "summarizer", agentLabel: "summarizer:finished", profile: "summarize", tier: "T1" });
    done.end("completed", "submitted");
    return { resumed: rec.id, stale: stale.id, other: other.id, done: done.id, taskId, otherTask };
  } finally {
    await sy.close();
  }
}

describe("session resume surfaces", () => {
  it("marks resumable sessions and resumes by session id or task id from the CLI", async () => {
    env = makeEnv();
    const ids = await seedInterrupted(env);

    const rows = JSON.parse(cli(env, "sessions", "--json").stdout) as Array<{ id: string; resumable: boolean }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.resumable]))).toEqual({ [ids.resumed]: true, [ids.stale]: false, [ids.other]: true, [ids.done]: false });

    // The resumed event reads as one timeline row: what was settled, then the notice the model got.
    const t = cli(env, "session", ids.resumed);
    expect(t.code, t.stderr).toBe(0);
    const resumedRow = t.stdout.split(/\r?\n/).find((l) => /\sresumed\s/.test(l)) ?? "";
    expect(resumedRow).toMatch(/resumed\s+0 action\(s\)\s+1 interrupted call\(s\) settled; \S/);

    const r = cli(env, "resume", ids.resumed);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ sessionId: ids.resumed, taskId: ids.taskId, state: "queued" });
    // A second resume is refused: the task is already queued.
    const twice = cli(env, "resume", ids.resumed);
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain(`task ${ids.taskId} is queued, not interrupted`);

    const byTask = cli(env, "resume", ids.otherTask);
    expect(byTask.code, byTask.stderr).toBe(0);
    expect(JSON.parse(byTask.stdout)).toEqual({ taskId: ids.otherTask, state: "queued" });

    const done = cli(env, "resume", ids.done);
    expect(done.code).toBe(1);
    expect(done.stderr).toContain(`session ${ids.done} is completed; only interrupted sessions can be resumed`);
    expect(cli(env, "resume", "s_missing").stderr).toContain("unknown session s_missing");
    expect(cli(env, "resume", "t_missing").stderr).toContain("unknown task t_missing");
    expect(cli(env, "resume").stderr).toContain("usage: switchyard resume <session-id|task-id>");

    // The directive names the session, so the worker continues that session.
    const sy = open(env, new ScriptedClient(() => reply("unused")));
    try {
      const ev = sy.tasks.events(ids.taskId, 50).filter((x) => x.type === "resumed");
      expect(ev.at(-1)!.data).toEqual({ sessionId: ids.resumed });
    } finally {
      await sy.close();
    }
  }, 60_000);

  it("resumes a session over MCP", async () => {
    env = makeEnv();
    const ids = await seedInterrupted(env);
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpJs, "--config", env.cfg.configPath], env: { PATH: process.env.PATH ?? "" } }));
    const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

    const ok = await client.callTool({ name: "resume_session", arguments: { sessionId: ids.resumed } });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(JSON.parse(text(ok))).toEqual({ sessionId: ids.resumed, taskId: ids.taskId, state: "queued" });

    const done = await client.callTool({ name: "resume_session", arguments: { sessionId: ids.done } });
    expect(done.isError).toBe(true);
    expect(text(done)).toContain("only interrupted sessions can be resumed");
    const missing = await client.callTool({ name: "resume_session", arguments: { sessionId: "s_missing" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("unknown session s_missing");
  }, 60_000);
});

describe("job detail from sessions", () => {
  it("reads the transcript and branches from the latest supervisor session, with job_state as a fallback", async () => {
    const cfg = baseConfig();
    (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
    env = makeEnv({ config: cfg });
    const sy = open(env, new ScriptedClient(() => reply("unused")));
    try {
      const job = (await sy.startJob({ goal: "Add subtract()", repositories: ["core"], label: "sub" })).taskId;
      expect(jobDetail(sy, job)).toMatchObject({ sessionId: null, branches: [], transcript: [] });

      const first = sy.sessions.create({ taskId: job, jobId: job, role: "supervisor", agentLabel: "supervisor:sub", profile: "supervise", tier: "T3" });
      const delegate = { id: "d1", type: "function" as const, function: { name: "delegate", arguments: '{"tasks":[]}' } };
      first.syncMessages([
        { role: "system", content: "# Supervisor charter" },
        { role: "user", content: "Goal: Add subtract()" },
        { role: "assistant", content: "Delegating.", tool_calls: [delegate] },
        { role: "tool", tool_call_id: "d1", content: "nothing delegated" },
      ]);
      first.setWorkspace({ repos: [{ alias: "core", worktree: "/wt/job", branch: `switchyard/job-${job}`, baseCommit: "a".repeat(40), head: "b".repeat(40) }] });
      first.end("interrupted", "process_died");

      const d = jobDetail(sy, job)!;
      expect(d.sessionId).toBe(first.id);
      expect(d.branches).toEqual([{ alias: "core", branch: `switchyard/job-${job}`, baseSha: "a".repeat(40), worktree: "/wt/job" }]);
      expect(d.transcript).toEqual([
        { role: "user", content: "Goal: Add subtract()" },
        { role: "assistant", content: "Delegating.", tools: ['delegate({"tasks":[]})'] },
        { role: "tool", content: "nothing delegated" },
      ]);

      // A fresh supervisor session (an escalation) has its own transcript; the branches stay those last recorded.
      sy.db.prepare("UPDATE tasks SET state = 'interrupted' WHERE id = ?").run(job);
      const second = sy.sessions.create({ taskId: job, jobId: job, previousSessionId: first.id, role: "supervisor", agentLabel: "supervisor:sub", profile: "supervise", tier: "T3" });
      second.syncMessages([
        { role: "system", content: "# Supervisor charter" },
        { role: "user", content: "Goal again" },
      ]);
      second.end("interrupted", "shutdown");
      const d2 = jobDetail(sy, job)!;
      expect(d2.sessionId).toBe(second.id);
      expect(d2.transcript).toEqual([{ role: "user", content: "Goal again" }]);
      expect(d2.branches.map((b) => b.worktree)).toEqual(["/wt/job"]);
      expect(Object.fromEntries(sessionsView(sy, { jobId: job }).map((s) => [s.id, s.resumable]))).toEqual({ [first.id]: false, [second.id]: true });

      // A job from before sessions: job_state is still read.
      const legacy = (await sy.startJob({ goal: "Old job", repositories: ["core"], label: "old" })).taskId;
      sy.db
        .prepare("INSERT INTO job_state (task_id, messages_json, detail_json, updated_at) VALUES (?, ?, ?, ?)")
        .run(legacy, JSON.stringify([{ role: "system", content: "charter" }, { role: "user", content: "Old goal" }]), JSON.stringify({ repos: [{ alias: "core", branch: "switchyard/job-old", baseSha: "c".repeat(40), worktree: "/wt/old" }] }), Date.now());
      expect(jobDetail(sy, legacy)).toMatchObject({ sessionId: null, transcript: [{ role: "user", content: "Old goal" }], branches: [{ branch: "switchyard/job-old", worktree: "/wt/old" }] });

      // The list view carries the branches and session but not the transcript.
      const list = jobsView(sy);
      expect(list.find((j) => j.taskId === job)).toMatchObject({ sessionId: second.id, branches: [{ worktree: "/wt/job" }] });
      expect(list.every((j) => !("transcript" in j))).toBe(true);
    } finally {
      await sy.close();
    }
  }, 60_000);
});
