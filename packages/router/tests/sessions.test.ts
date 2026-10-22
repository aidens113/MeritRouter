import { capturedLease } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import type { ChatMessage } from "../src/gateway/types.js";
import type { GateRequest, GateResponse } from "../src/gateway/gate.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { GatewayError } from "../src/core/errors.js";
import { ask, type RunContext } from "../src/runners/types.js";
import { SessionEventSchema, TOOL_OUTPUT_CAP_BYTES, type SessionEvent } from "../src/sessions/events.js";
import { sessionDetail, sessionsView } from "../src/admin/insights.js";
import { makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function start(): Switchyard {
  env = makeEnv();
  sy = open(env, new ScriptedClient(() => reply("unused")));
  return sy;
}

function gateResponse(content: string | null = "hello"): GateResponse {
  return {
    requestId: "req_1",
    response: reply(content),
    endpoint: { id: "openrouter/vendor/big-a:free" } as ModelEndpoint,
    attempts: [{ endpointId: "openrouter/vendor/big-a:free", outcome: "ok" }],
    estimatedInputTokens: 42,
  };
}

const chat = (messages: ChatMessage[]) => ({ executionId: "exec_1", purpose: "runner", chat: { messages, max_tokens: 500, tools: [{ type: "function" as const, function: { name: "read_file", description: "read", parameters: {} } }] } });

const types = (events: SessionEvent[]) => events.map((e) => e.type);

describe("session store", () => {
  it("creates, appends, indexes, lists, and ends a session", () => {
    const s = start();
    const rec = s.sessions.create({ taskId: "t_1", jobId: "j_1", role: "analyst", agentLabel: "analyst-1", profile: "analyze", tier: "T2" });
    expect(rec.id).toMatch(/^s_/);
    const messages: ChatMessage[] = [
      { role: "system", content: "charter" },
      { role: "user", content: "goal" },
    ];
    rec.syncMessages(messages);
    rec.modelRequest(chat(messages));
    rec.modelResponse(gateResponse());
    const intent = rec.toolIntent({ callId: "c1", name: "read_file", args: { path: "a.ts" }, sideEffect: "read" });
    rec.toolOutcome(intent, { ok: true, output: "file text" });
    rec.note("checkpoint", { step: 1 });
    rec.setWorkspace({ repos: [{ alias: "core", worktree: "/w/core", branch: "b", baseCommit: "abc", head: "def" }] });
    rec.end("completed", "submitted");

    const got = s.sessions.get(rec.id)!;
    expect(got).toMatchObject({ taskId: "t_1", jobId: "j_1", role: "analyst", agentLabel: "analyst-1", profile: "analyze", tier: "T2", status: "completed", stopReason: "submitted", modelRequests: 1, toolCalls: 1, lastSeq: 10 });
    expect(got.endedAt).not.toBeNull();
    expect(got.workspace?.repos[0]?.head).toBe("def");
    expect(got.logPath).toBe(path.join(env!.cfg.storageDir, "sessions", `${rec.id}.jsonl`));

    const page = s.sessions.events(rec.id)!;
    expect(page.corrupt).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(types(page.events)).toEqual(["started", "message", "message", "model_request", "model_response", "tool_intent", "tool_outcome", "note", "workspace", "ended"]);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const outcome = page.events.find((e) => e.type === "tool_outcome")!;
    expect(outcome.data).toMatchObject({ intentSeq: intent, callId: "c1", name: "read_file", ok: true, output: "file text", truncated: false });
    const req = page.events.find((e) => e.type === "model_request")!;
    expect(req.data).toMatchObject({ messageCount: 2, maxTokens: 500, tools: ["read_file"] });

    // Index rows: one per event, without payloads; counters match.
    const rows = s.db.prepare("SELECT seq, type, name, ok FROM session_events WHERE session_id = ? ORDER BY seq").all(rec.id) as Array<{ seq: number; type: string; name: string | null; ok: number | null }>;
    expect(rows.map((r) => r.type)).toEqual(types(page.events));
    expect(rows.find((r) => r.type === "tool_outcome")).toMatchObject({ name: "read_file", ok: 1 });
    expect(rows.find((r) => r.type === "model_response")).toMatchObject({ name: "openrouter/vendor/big-a:free", ok: 1 });

    // Ended: further appends throw; ending again is a no-op.
    expect(() => rec.note("late")).toThrow(/has ended/);
    expect(rec.end("failed", "again")).toBe(10);
    expect(s.sessions.get(rec.id)!.status).toBe("completed");
  });

  it("lists by status, task, job, and parent; forTask is oldest first", () => {
    const s = start();
    const a = s.sessions.create({ taskId: "t_1", jobId: "j_1", role: "supervisor", agentLabel: "sup" });
    const b = s.sessions.create({ taskId: "t_2", jobId: "j_1", parentSessionId: a.id, role: "implementer", agentLabel: "impl" });
    const c = s.sessions.create({ taskId: "t_2", jobId: "j_1", parentSessionId: a.id, previousSessionId: b.id, role: "implementer", agentLabel: "impl", tier: "T3" });
    b.end("failed", "escalated");
    expect(s.sessions.list({ status: "running" }).map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
    expect(s.sessions.list({ status: ["failed", "completed"] }).map((r) => r.id)).toEqual([b.id]);
    expect(s.sessions.list({ jobId: "j_1" })).toHaveLength(3);
    expect(s.sessions.list({ jobId: "j_1", limit: 1 })).toHaveLength(1);
    expect(s.sessions.list({ parentSessionId: a.id }).map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
    expect(s.sessions.forTask("t_2").map((r) => r.id)).toEqual([b.id, c.id]);
    expect(s.sessions.get(c.id)!.previousSessionId).toBe(b.id);
    expect(s.sessions.list({ taskId: "nope" })).toEqual([]);
    expect(s.sessions.get("s_missing")).toBeNull();
    expect(s.sessions.events("s_missing")).toBeNull();
  });

  it("rejects invalid create input with zod", () => {
    const s = start();
    expect(() => s.sessions.create({ role: "wizard" as never, agentLabel: "x" })).toThrow();
    expect(() => s.sessions.create({ role: "analyst", agentLabel: "" })).toThrow();
    expect(s.sessions.list()).toEqual([]);
  });

  it("logs each transcript message once, and again only from where it was rewritten", () => {
    const s = start();
    const rec = s.sessions.create({ role: "inspector", agentLabel: "i" });
    const m: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal" },
    ];
    rec.syncMessages(m);
    m.push({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] });
    m.push({ role: "tool", tool_call_id: "c1", content: "long output" });
    rec.syncMessages(m);
    // Compaction rewrites tool output in place: not a new message.
    (m[3] as { content: string }).content = "[elided to fit context; call the tool again if needed]";
    rec.syncMessages(m);
    let msgs = s.sessions.events(rec.id)!.events.filter((e) => e.type === "message");
    expect(msgs.map((e) => (e.data as { index: number }).index)).toEqual([0, 1, 2, 3]);
    expect((msgs[3]!.data as { message: { content: string } }).message.content).toBe("long output");

    // A rewritten transcript (different message at index 1) is logged from index 1 on.
    const rewritten: ChatMessage[] = [m[0]!, { role: "user", content: "summary of earlier work" }, { role: "user", content: "continue" }];
    rec.syncMessages(rewritten);
    msgs = s.sessions.events(rec.id)!.events.filter((e) => e.type === "message");
    expect(msgs.map((e) => (e.data as { index: number }).index)).toEqual([0, 1, 2, 3, 1, 2]);
  });

  it("caps tool output and rejects an outcome without an intent", () => {
    const s = start();
    const rec = s.sessions.create({ role: "implementer", agentLabel: "impl" });
    const seq = rec.toolIntent({ callId: "c1", name: "run_check", args: "raw", sideEffect: "command", idempotent: true });
    rec.toolOutcome(seq, { ok: false, output: "x".repeat(TOOL_OUTPUT_CAP_BYTES + 500) });
    expect(() => rec.toolOutcome(seq, { ok: true, output: "dup" })).toThrow(/no tool intent/);
    expect(() => rec.toolOutcome(999, { ok: true, output: "" })).toThrow(/no tool intent/);
    const ev = s.sessions.events(rec.id)!.events;
    const intent = ev.find((e) => e.type === "tool_intent")!;
    expect(intent.data).toMatchObject({ sideEffect: "command", idempotent: true, args: "raw" });
    const out = ev.find((e) => e.type === "tool_outcome")!.data as { output: string; truncated: boolean; ok: boolean };
    expect(out.truncated).toBe(true);
    expect(out.ok).toBe(false);
    expect(Buffer.byteLength(out.output)).toBe(TOOL_OUTPUT_CAP_BYTES);
    expect(s.sessions.get(rec.id)!.toolCalls).toBe(1);
  });

  it("pages events with afterSeq and limit", () => {
    const s = start();
    const rec = s.sessions.create({ role: "summarizer", agentLabel: "sum" });
    for (let i = 0; i < 5; i++) rec.note(`n${i}`);
    const first = s.sessions.events(rec.id, { limit: 2 })!;
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const next = s.sessions.events(rec.id, { afterSeq: 2, limit: 10 })!;
    expect(next.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(next.hasMore).toBe(false);
    expect(next.lastSeq).toBe(6);
  });

  it("writes a JSONL log that is readable after the store closes", async () => {
    const s = start();
    const rec = s.sessions.create({ taskId: "t_1", role: "reviewer", agentLabel: "rev" });
    rec.note("before close");
    const id = rec.id;
    const logPath = s.sessions.get(id)!.logPath;
    await s.close();
    sy = undefined;

    // Raw file: one valid event per line, newline-terminated.
    const raw = readFileSync(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(SessionEventSchema.safeParse(JSON.parse(l)).success).toBe(true);

    // A fresh service sees the same session and events.
    sy = open(env!, new ScriptedClient(() => reply("unused")));
    expect(sy.sessions.get(id)).toMatchObject({ status: "running", lastSeq: 2, taskId: "t_1" });
    expect(types(sy.sessions.events(id)!.events)).toEqual(["started", "note"]);
  });

  it("skips and reports corrupt lines instead of throwing", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "a" });
    rec.note("good");
    const logPath = s.sessions.get(rec.id)!.logPath;
    appendFileSync(logPath, "not json\n");
    appendFileSync(logPath, `${JSON.stringify({ seq: 3, at: 1, type: "tool_outcome", data: { ok: "yes" } })}\n`);
    appendFileSync(logPath, `${JSON.stringify({ seq: 4, at: 1, type: "note", data: { text: "valid after corruption" } })}\n`);
    appendFileSync(logPath, `{"seq":5,"at":1,"type":"no`); // torn final line
    const page = s.sessions.events(rec.id)!;
    expect(types(page.events)).toEqual(["started", "note", "note"]);
    expect(page.corrupt.map((c) => c.line)).toEqual([3, 4, 6]);
    expect(page.corrupt[0]!.error).toMatch(/invalid JSON/);
    expect(page.corrupt[1]!.error).toMatch(/data/);
    expect(page.corrupt[2]!.excerpt).toContain('"seq":5');
  });

  it("reports a missing log as corrupt line 0", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "a" });
    const logPath = s.sessions.get(rec.id)!.logPath;
    expect(existsSync(logPath)).toBe(true);
    s.db.prepare("UPDATE sessions SET log_path = 'sessions/elsewhere.jsonl' WHERE id = ?").run(rec.id);
    const page = s.sessions.events(rec.id)!;
    expect(page.events).toEqual([]);
    expect(page.corrupt[0]!.line).toBe(0);
  });
});

describe("ask() with a session", () => {
  function ctxWith(s: Switchyard, request: () => Promise<GateResponse>): RunContext {
    s.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "t_1" }))]);
    s.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
    const taskLease = capturedLease(s.tasks.get("t_1")!);
    return {
      taskId: "t_1",
      leaseOwner: "owner",
      taskLease,
      tasks: s.tasks,
      taskProject: taskLease.project,
      claimedRunCount: taskLease.runCount,
      budget: {},
      plan: {},
      signal: new AbortController().signal,
      attempts: [],
      gate: { request: (input: GateRequest) => {
        expect(input.participants).toEqual([expect.objectContaining({ taskId: "t_1", leaseOwner: "owner", lease: taskLease })]);
        return request();
      } },
      session: s.sessions.create({ taskId: "t_1", role: "summarizer", agentLabel: "sum" }),
    } as unknown as RunContext;
  }

  it("records the transcript, the request, and the response", async () => {
    const s = start();
    const ctx = ctxWith(s, async () => gateResponse("answer"));
    const messages: ChatMessage[] = [{ role: "user", content: "summarise" }];
    const res = await ask(ctx, chat(messages));
    expect(res.requestId).toBe("req_1");
    expect(ctx.attempts).toHaveLength(1);
    const ev = s.sessions.events(ctx.session!.id)!.events;
    expect(types(ev)).toEqual(["started", "message", "model_request", "model_response"]);
    expect(ev[3]!.data).toMatchObject({ requestId: "req_1", endpointId: "openrouter/vendor/big-a:free", content: "answer", estimatedInputTokens: 42 });
    expect(s.sessions.get(ctx.session!.id)!.modelRequests).toBe(1);
  });

  it("records a gateway error with its attempts and rethrows", async () => {
    const s = start();
    const ctx = ctxWith(s, async () => {
      throw Object.assign(new GatewayError("rate_limited", "slow down", 429), { attempts: [{ endpointId: "e1", outcome: "rate_limited" }] });
    });
    await expect(ask(ctx, chat([{ role: "user", content: "x" }]))).rejects.toThrow(/slow down/);
    expect(ctx.attempts).toEqual([{ endpointId: "e1", outcome: "rate_limited" }]);
    const ev = s.sessions.events(ctx.session!.id)!.events;
    const err = ev.find((e) => e.type === "model_error")!;
    expect(err.data).toMatchObject({ executionId: "exec_1", message: "slow down", code: "gateway:rate_limited", status: 429, attempts: [{ endpointId: "e1" }] });
    const row = s.db.prepare("SELECT name, ok FROM session_events WHERE session_id = ? AND type = 'model_error'").get(ctx.session!.id);
    expect(row).toEqual({ name: "gateway:rate_limited", ok: 0 });
  });

  it("refuses missing captured authority before journaling or calling the Gate", async () => {
    const s = start();
    let calls = 0;
    const ctx = ctxWith(s, async () => { calls++; return gateResponse(); });
    ctx.taskLease = undefined;
    await expect(ask(ctx, chat([{ role: "user", content: "private fixture" }]))).rejects.toThrow("requires a captured task lease");
    expect(calls).toBe(0);
    expect(types(s.sessions.events(ctx.session!.id)!.events)).toEqual(["started"]);
  });

  it("records nothing when the context has no session", async () => {
    const s = start();
    const ctx = { ...ctxWith(s, async () => gateResponse()), session: null } as RunContext;
    await ask(ctx, chat([{ role: "user", content: "x" }]));
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type != 'started'").get()).toEqual({ n: 0 });
  });
});

describe("session insights", () => {
  it("lists sessions with task labels and shows a timeline with children and task sessions", async () => {
    const s = start();
    const [sub] = await s.submitTasks([{ profile: "summarize", label: "sum-log", goal: "Summarise", context: { inlineText: "x" }, constraints: { acceptanceCriteria: ["ok"] } }]);
    await s.cancelTasks([sub!.taskId]);
    const parent = s.sessions.create({ role: "supervisor", agentLabel: "sup" });
    const a = s.sessions.create({ taskId: sub!.taskId, parentSessionId: parent.id, role: "summarizer", agentLabel: "sum" });
    a.end("failed", "budget_exhausted");
    const b = s.sessions.create({ taskId: sub!.taskId, parentSessionId: parent.id, previousSessionId: a.id, role: "summarizer", agentLabel: "sum", tier: "T2" });
    b.note("hello");

    const view = sessionsView(s, { taskId: sub!.taskId });
    expect(view.map((v) => v.id)).toEqual([b.id, a.id]);
    expect(view[0]!.taskLabel).toBe("sum-log");
    expect(view[1]!.durationMs).toBeGreaterThanOrEqual(0);

    const detail = sessionDetail(s, parent.id)!;
    expect(detail.session.id).toBe(parent.id);
    // A taskless legacy parent has no authoritative project; do not infer child scope.
    expect(detail.children).toEqual([]);
    expect(detail.taskSessions).toEqual([]);

    const bd = sessionDetail(s, b.id, { afterSeq: 1 })!;
    expect(types(bd.events)).toEqual(["note"]);
    expect(bd.taskSessions.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(bd.corrupt).toEqual([]);
    expect(sessionDetail(s, "s_missing")).toBeNull();
  });
});
