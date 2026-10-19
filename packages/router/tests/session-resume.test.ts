import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync } from "node:fs";
import type { Switchyard } from "../src/core/service.js";
import type { ChatMessage, ChatToolCall } from "../src/gateway/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { SessionEventSchema, type ResumeAction, type SessionEvent, type ToolSideEffect } from "../src/sessions/events.js";
import type { SessionRecorder } from "../src/sessions/recorder.js";
import { editRecoveryMessage, planResume, RESUME_TEXT } from "../src/sessions/resume.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

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

const call = (id: string, name: string, args: Record<string, unknown> = {}): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function gateResponse(content: string | null, toolCalls?: ChatToolCall[]): GateResponse {
  return {
    requestId: "req_1",
    response: reply(content, toolCalls ? { toolCalls } : {}),
    endpoint: { id: "openrouter/vendor/big-a:free" } as ModelEndpoint,
    attempts: [{ endpointId: "openrouter/vendor/big-a:free", outcome: "ok" }],
    estimatedInputTokens: 42,
  };
}

const BASE: ChatMessage[] = [
  { role: "system", content: "charter" },
  { role: "user", content: "goal" },
];

/** Log a request for `messages` and its response, as `ask()` does. */
function turn(rec: SessionRecorder, messages: ChatMessage[], content: string | null, toolCalls?: ChatToolCall[]) {
  rec.syncMessages(messages);
  rec.modelRequest({ executionId: "exec_1", purpose: "runner", chat: { messages, max_tokens: 500 } });
  rec.modelResponse(gateResponse(content, toolCalls));
}

function intent(rec: SessionRecorder, c: ChatToolCall, sideEffect: ToolSideEffect, idempotent?: boolean): number {
  return rec.toolIntent({ callId: c.id, name: c.function.name, args: JSON.parse(c.function.arguments), sideEffect, ...(idempotent !== undefined ? { idempotent } : {}) });
}

const WORKSPACE = { repos: [{ alias: "core", worktree: "/w/core", branch: "job/x", baseCommit: "aaa", head: "bbb" }] };

function eventsOf(s: Switchyard, id: string): SessionEvent[] {
  return s.sessions.events(id, { limit: 10_000 })!.events;
}

const toolMsg = (m: ChatMessage | undefined) => (m && m.role === "tool" ? m : null);

describe("session reopen", () => {
  it("continues seq and counters, restores the transcript and open intents, and claims the session once", () => {
    const s = start();
    const rec = s.sessions.create({ taskId: "t_1", role: "analyst", agentLabel: "analyst-1" });
    const c1 = call("c1", "read_file", { path: "a.ts" });
    turn(rec, BASE, null, [c1]);
    const i1 = intent(rec, c1, "read");
    rec.end("interrupted", "shutdown");
    const before = s.sessions.get(rec.id)!;
    expect(before).toMatchObject({ status: "interrupted", stopReason: "shutdown", modelRequests: 1, toolCalls: 1 });

    const again = s.sessions.reopen(rec.id);
    const after = s.sessions.get(rec.id)!;
    expect(after).toMatchObject({ status: "running", stopReason: null, endedAt: null, modelRequests: 1, toolCalls: 1 });
    // The reopen note continues the sequence.
    expect(again.lastSeq).toBe(before.lastSeq + 1);
    expect(after.lastSeq).toBe(before.lastSeq + 1);
    const note = eventsOf(s, rec.id).at(-1)!;
    expect(note).toMatchObject({ type: "note", data: { text: "reopened", data: { previousStatus: "interrupted", previousStopReason: "shutdown" } } });

    // Logged messages are known: re-syncing logs nothing; a new message is logged once.
    const seq0 = again.lastSeq;
    again.syncMessages(BASE);
    expect(again.lastSeq).toBe(seq0);
    again.syncMessages([...BASE, { role: "assistant", content: null, tool_calls: [c1] }, { role: "tool", tool_call_id: "c1", content: "text" }]);
    expect(again.lastSeq).toBe(seq0 + 2);

    // The open intent can still be closed; counters keep counting.
    again.toolOutcome(i1, { ok: true, output: "text" });
    again.modelRequest({ executionId: "exec_2", purpose: "runner", chat: { messages: BASE, max_tokens: 500 } });
    expect(s.sessions.get(rec.id)).toMatchObject({ modelRequests: 2, toolCalls: 1, lastSeq: seq0 + 4 });
    expect(s.sessions.pendingIntents(rec.id)).toEqual([]);

    // Index rows match the log one for one.
    const rows = s.db.prepare("SELECT seq, type FROM session_events WHERE session_id = ? ORDER BY seq").all(rec.id) as Array<{ seq: number; type: string }>;
    expect(rows).toEqual(eventsOf(s, rec.id).map((e) => ({ seq: e.seq, type: e.type })));

    // Running (already claimed) and completed sessions cannot be reopened by default.
    expect(() => s.sessions.reopen(rec.id)).toThrow(/is running/);
    again.end("completed", "done");
    expect(() => s.sessions.reopen(rec.id)).toThrow(/is completed/);
    expect(s.sessions.reopen(rec.id, { from: ["completed"] }).lastSeq).toBeGreaterThan(seq0);
    expect(() => s.sessions.reopen("s_missing")).toThrow(/unknown session/);
  });

  it("terminates a torn final line and backfills index rows the crash missed", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "analyst-1" });
    rec.syncMessages(BASE);
    rec.end("interrupted", "shutdown");
    const indexed = s.sessions.get(rec.id)!.lastSeq;
    // A durable line the index never saw, then a torn line.
    const lost = { seq: indexed + 1, at: Date.now(), type: "note", data: { text: "after the index" } };
    appendFileSync(rec.logPath, `${JSON.stringify(lost)}\n{"seq":${indexed + 2},"at":1,"ty`);

    const again = s.sessions.reopen(rec.id);
    expect(again.lastSeq).toBe(indexed + 2); // the backfilled line, then the reopen note
    const page = s.sessions.events(rec.id)!;
    expect(page.corrupt).toHaveLength(1);
    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: indexed + 2 }, (_, i) => i + 1));
    expect(page.events.at(-1)).toMatchObject({ type: "note", data: { text: "reopened" } });
    const rows = s.db.prepare("SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq").all(rec.id) as Array<{ seq: number }>;
    expect(rows.map((r) => r.seq)).toEqual(page.events.map((e) => e.seq));
    // Every line but the torn one still validates.
    const lines = readFileSync(rec.logPath, "utf8").split("\n").filter(Boolean);
    expect(lines.filter((l) => !SessionEventSchema.safeParse((() => { try { return JSON.parse(l); } catch { return null; } })()).success)).toHaveLength(1);
  });
});

describe("markDeadRunning", () => {
  it("ends running sessions whose lease is gone as interrupted/process_died, in the log too", () => {
    const s = start();
    const live = s.sessions.create({ taskId: "t_live", role: "analyst", agentLabel: "a-1" });
    const dead = s.sessions.create({ taskId: "t_dead", role: "analyst", agentLabel: "a-2" });
    const done = s.sessions.create({ taskId: "t_done", role: "analyst", agentLabel: "a-3" });
    done.end("completed", "ok");
    const seen: string[] = [];
    const marked = s.sessions.markDeadRunning((r) => {
      seen.push(r.taskId!);
      return r.taskId === "t_live";
    });
    expect(seen.sort()).toEqual(["t_dead", "t_live"]);
    expect(marked.map((r) => r.id)).toEqual([dead.id]);
    expect(marked[0]).toMatchObject({ status: "interrupted", stopReason: "process_died" });
    expect(s.sessions.get(live.id)!.status).toBe("running");
    expect(eventsOf(s, dead.id).at(-1)).toMatchObject({ type: "ended", data: { status: "interrupted", stopReason: "process_died" } });
    // Idempotent: nothing left to mark.
    expect(s.sessions.markDeadRunning(() => false).map((r) => r.id)).toEqual([live.id]);
  });
});

describe("transcript", () => {
  it("replays message events; a later event for an index replaces it and drops what followed", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "analyst-1" });
    rec.syncMessages([...BASE, { role: "user", content: "one" }, { role: "user", content: "two" }]);
    rec.syncMessages([...BASE, { role: "user", content: "rewritten" }]);
    expect(s.sessions.transcript(rec.id)).toEqual([...BASE, { role: "user", content: "rewritten" }]);
    expect(s.sessions.transcript("s_missing")).toBeNull();
    expect(s.sessions.pendingIntents("s_missing")).toBeNull();
    expect(s.sessions.planResume("s_missing")).toBeNull();
  });
});

describe("planResume", () => {
  /** One turn whose tool calls cover every side-effect class, interrupted mid-tools. */
  function interruptedTurn(s: Switchyard, opts: { workspace?: boolean } = {}) {
    const rec = s.sessions.create({ taskId: "t_1", role: "implementer", agentLabel: "implementer-1" });
    if (opts.workspace !== false) rec.setWorkspace(WORKSPACE);
    const calls = {
      done: call("c_done", "read_file", { path: "done.ts" }),
      read: call("c_read", "search", { q: "x" }),
      none: call("c_none", "await_tasks"),
      edit: call("c_edit", "write_file", { path: "a.ts" }),
      deleg: call("c_deleg", "delegate", { label: "w1" }),
      cmdIdem: call("c_cmd_idem", "run_check", { name: "lint" }),
      cmd: call("c_cmd", "run_command", { cmd: "npm publish" }),
      brain: call("c_brain", "brain_write", { path: "x.md" }),
      ext: call("c_ext", "ask_user", { question: "which?" }),
      orphan: call("c_orphan", "read_file", { path: "never.ts" }),
    };
    turn(rec, BASE, "working", Object.values(calls));
    const seqs: Record<string, number> = {};
    seqs.done = intent(rec, calls.done, "read");
    rec.toolOutcome(seqs.done, { ok: true, output: "done text" });
    seqs.read = intent(rec, calls.read, "read");
    seqs.none = intent(rec, calls.none, "none");
    seqs.edit = intent(rec, calls.edit, "edit");
    seqs.deleg = intent(rec, calls.deleg, "delegate");
    seqs.cmdIdem = intent(rec, calls.cmdIdem, "command", true);
    seqs.cmd = intent(rec, calls.cmd, "command");
    seqs.brain = intent(rec, calls.brain, "brain");
    seqs.ext = intent(rec, calls.ext, "external");
    rec.end("interrupted", "process_died");
    return { rec, calls, seqs };
  }

  it("covers each side-effect class, an orphaned call, and a recorded but unlogged outcome", () => {
    const s = start();
    const { rec, calls, seqs } = interruptedTurn(s);
    const plan = s.sessions.planResume(rec.id)!;

    // Transcript: the logged request, the unlogged assistant turn, a tool message per call in order.
    expect(plan.messages.slice(0, 2)).toEqual(BASE);
    expect(plan.messages[2]).toEqual({ role: "assistant", content: "working", tool_calls: Object.values(calls) });
    const tools = plan.messages.slice(3).map(toolMsg);
    expect(tools.map((t) => t?.tool_call_id)).toEqual(Object.values(calls).map((c) => c.id));
    const content = (id: string) => tools.find((t) => t?.tool_call_id === id)!.content;
    expect(content("c_done")).toBe("done text");
    expect(content("c_read")).toBe(RESUME_TEXT.retry);
    expect(content("c_none")).toBe(RESUME_TEXT.retry);
    expect(content("c_edit")).toBe(RESUME_TEXT.recovering);
    expect(content("c_deleg")).toBe(RESUME_TEXT.recovering);
    expect(content("c_cmd_idem")).toBe(RESUME_TEXT.recovering);
    expect(content("c_cmd")).toBe(RESUME_TEXT.commandUnknown);
    expect(content("c_brain")).toBe(RESUME_TEXT.brainUnknown);
    expect(content("c_ext")).toBe(RESUME_TEXT.recovering);
    expect(content("c_orphan")).toBe(RESUME_TEXT.notRun);

    // Actions, each pointing at the tool message it fills.
    const idx = (id: string) => plan.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === id);
    expect(plan.actions).toEqual<ResumeAction[]>([
      { kind: "rerun_tool", sideEffect: "delegate", intentSeq: seqs.deleg!, callId: "c_deleg", name: "delegate", args: { label: "w1" }, messageIndex: idx("c_deleg") },
      { kind: "rerun_tool", sideEffect: "command", intentSeq: seqs.cmdIdem!, callId: "c_cmd_idem", name: "run_check", args: { name: "lint" }, messageIndex: idx("c_cmd_idem") },
      { kind: "report_external", intentSeq: seqs.ext!, callId: "c_ext", name: "ask_user", args: { question: "which?" }, messageIndex: idx("c_ext") },
      {
        kind: "reconcile_edits",
        policy: "commit",
        repos: WORKSPACE.repos,
        calls: [{ intentSeq: seqs.edit!, callId: "c_edit", name: "write_file", args: { path: "a.ts" }, messageIndex: idx("c_edit") }],
        completedCallIds: [],
      },
    ]);
    // Every pending intent is settled; the completed one and the orphan have no intent to settle.
    expect(plan.resolvedIntentSeqs).toEqual([seqs.read, seqs.none, seqs.edit, seqs.deleg, seqs.cmdIdem, seqs.cmd, seqs.brain, seqs.ext]);
    expect(plan.droppedRequestSeqs).toEqual([]);
    expect(plan.reason).toBe("process_died");
    expect(plan.workspace).toEqual(WORKSPACE);
    expect(plan.warnings).toEqual([]);
    expect(plan.summary).toMatch(/^This session was interrupted \(process_died\)/);
    for (const name of ["search", "await_tasks", "write_file", "delegate", "run_check", "run_command", "brain_write", "ask_user"]) expect(plan.summary).toContain(name);
    expect(plan.summary).toContain("c_orphan");
    expect(plan.summary).not.toContain("c_done");

    // The pure function agrees with the store wrapper; reset policy is passed through.
    expect(planResume(eventsOf(s, rec.id), { recoverEdits: "reset" }).actions.at(-1)).toMatchObject({ kind: "reconcile_edits", policy: "reset" });
    expect(s.sessions.pendingIntents(rec.id)!.map((p) => p.seq)).toEqual(plan.resolvedIntentSeqs);
  });

  it("reports an interrupted edit as unknown when no workspace is recorded", () => {
    const s = start();
    const { rec } = interruptedTurn(s, { workspace: false });
    const plan = s.sessions.planResume(rec.id)!;
    expect(plan.actions.some((a) => a.kind === "reconcile_edits")).toBe(false);
    expect(plan.messages.map(toolMsg).find((t) => t?.tool_call_id === "c_edit")!.content).toBe(RESUME_TEXT.editUnknown);
    expect(plan.warnings).toContain("interrupted edits but no workspace recorded; nothing to reconcile");
  });

  it("reconciles edits that completed after the last recorded head but were never logged as messages", () => {
    const s = start();
    const rec = s.sessions.create({ role: "implementer", agentLabel: "implementer-1" });
    rec.setWorkspace(WORKSPACE);
    const c = call("c_w", "write_file", { path: "a.ts" });
    turn(rec, BASE, null, [c]);
    rec.toolOutcome(intent(rec, c, "edit"), { ok: true, output: "wrote a.ts" });
    rec.end("interrupted", "process_died");
    const plan = s.sessions.planResume(rec.id)!;
    expect(plan.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c_w", content: "wrote a.ts" });
    expect(plan.actions).toEqual([{ kind: "reconcile_edits", policy: "commit", repos: WORKSPACE.repos, calls: [], completedCallIds: ["c_w"] }]);
    expect(plan.resolvedIntentSeqs).toEqual([]);
  });

  it("drops a model request that got no response and leaves the logged transcript as is", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "analyst-1" });
    const c = call("c1", "read_file", { path: "a.ts" });
    turn(rec, BASE, null, [c]);
    rec.toolOutcome(intent(rec, c, "read"), { ok: true, output: "text" });
    const full: ChatMessage[] = [...BASE, { role: "assistant", content: null, tool_calls: [c] }, { role: "tool", tool_call_id: "c1", content: "text" }];
    rec.syncMessages(full);
    const lost = rec.modelRequest({ executionId: "exec_2", purpose: "runner", chat: { messages: full, max_tokens: 500 } });
    rec.end("interrupted", "process_died");

    const plan = s.sessions.planResume(rec.id)!;
    expect(plan.messages).toEqual(full);
    expect(plan.actions).toEqual([]);
    expect(plan.resolvedIntentSeqs).toEqual([]);
    expect(plan.droppedRequestSeqs).toEqual([lost]);
    expect(plan.summary).toContain("no response; it was dropped");
  });

  it("says nothing was in flight for a clean interruption (a capacity deferral)", () => {
    const s = start();
    const rec = s.sessions.create({ role: "analyst", agentLabel: "analyst-1" });
    rec.syncMessages(BASE);
    rec.end("interrupted", "deferred_for_capacity: busy");
    const plan = s.sessions.planResume(rec.id)!;
    expect(plan.messages).toEqual(BASE);
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toBe("This session was interrupted (deferred_for_capacity: busy) and has been resumed from its log. Nothing was in flight. Continue from here.");
  });

  it("keeps a pending intent with no transcript slot as an action without a message index", () => {
    const s = start();
    const rec = s.sessions.create({ role: "implementer", agentLabel: "implementer-1" });
    rec.syncMessages(BASE);
    const seq = rec.toolIntent({ callId: "gw_1", name: "delegate", args: { label: "w" }, sideEffect: "delegate" });
    rec.end("interrupted", "process_died");
    const plan = s.sessions.planResume(rec.id)!;
    expect(plan.messages).toEqual(BASE);
    expect(plan.actions).toEqual([{ kind: "rerun_tool", sideEffect: "delegate", intentSeq: seq, callId: "gw_1", name: "delegate", args: { label: "w" }, messageIndex: null }]);
  });
});

describe("resume round trip", () => {
  it("records resumed, settles intents, and re-plans the same way after a crash during recovery", () => {
    const s = start();
    const rec = s.sessions.create({ taskId: "t_1", role: "supervisor", agentLabel: "supervisor-1" });
    const read = call("c_read", "task_result", { id: "t_9" });
    const deleg = call("c_deleg", "delegate", { label: "w1" });
    turn(rec, BASE, null, [read, deleg]);
    const readSeq = intent(rec, read, "read");
    const delegSeq = intent(rec, deleg, "delegate");
    rec.end("interrupted", "process_died");

    // Recovery: reopen, re-run the delegation (journaled under the same call id), then crash before `resumed`.
    const r1 = s.sessions.reopen(rec.id);
    const plan1 = s.sessions.planResume(rec.id)!;
    expect(plan1.actions.map((a) => a.kind)).toEqual(["rerun_tool"]);
    const rerun = r1.toolIntent({ callId: "c_deleg", name: "delegate", args: { label: "w1" }, sideEffect: "delegate" });
    r1.toolOutcome(rerun, { ok: true, output: "deduplicated: t_w1" });
    expect(s.sessions.pendingIntents(rec.id)!.map((p) => p.seq)).toEqual([readSeq]); // the re-run superseded the delegate intent
    s.sessions.markDeadRunning(() => false);

    // Second recovery: the delegation's result is the re-run's output; only the read is left.
    const r2 = s.sessions.reopen(rec.id);
    const plan2 = s.sessions.planResume(rec.id)!;
    expect(plan2.actions).toEqual([]);
    expect(plan2.messages.slice(3)).toEqual([
      { role: "tool", tool_call_id: "c_read", content: RESUME_TEXT.retry },
      { role: "tool", tool_call_id: "c_deleg", content: "deduplicated: t_w1" },
    ]);
    expect(plan2.resolvedIntentSeqs).toEqual([readSeq]);

    const resumedSeq = r2.resumed(plan2.summary, plan2.actions, plan2);
    const ev = eventsOf(s, rec.id).find((e) => e.seq === resumedSeq)!;
    expect(ev).toMatchObject({ type: "resumed", data: { summary: plan2.summary, actions: [], resolvedIntentSeqs: [readSeq], droppedRequestSeqs: [] } });
    expect(s.db.prepare("SELECT type FROM session_events WHERE session_id = ? AND seq = ?").get(rec.id, resumedSeq)).toEqual({ type: "resumed" });
    expect(s.sessions.pendingIntents(rec.id)).toEqual([]);
    expect(() => r2.toolOutcome(readSeq, { ok: true, output: "late" })).toThrow(/no tool intent/);
    expect(delegSeq).toBeLessThan(rerun);

    // The caller continues: append the notice and sync; the plan's messages are now logged.
    const continued: ChatMessage[] = [...plan2.messages, { role: "user", content: plan2.summary }];
    r2.syncMessages(continued);
    expect(s.sessions.transcript(rec.id)).toEqual(continued);
    // A crash now has nothing in flight.
    r2.end("interrupted", "process_died");
    const plan3 = s.sessions.planResume(rec.id)!;
    expect(plan3.messages).toEqual(continued);
    expect(plan3.actions).toEqual([]);
    expect(plan3.resolvedIntentSeqs).toEqual([]);
  });

  it("records action results in the resumed event", () => {
    const s = start();
    const rec = s.sessions.create({ role: "implementer", agentLabel: "implementer-1" });
    rec.setWorkspace(WORKSPACE);
    const c = call("c_edit", "write_file", { path: "a.ts" });
    turn(rec, BASE, null, [c]);
    intent(rec, c, "edit");
    rec.end("interrupted", "process_died");
    const again = s.sessions.reopen(rec.id);
    const plan = s.sessions.planResume(rec.id)!;
    const action = plan.actions[0]!;
    expect(action.kind).toBe("reconcile_edits");
    const text = editRecoveryMessage("commit", ["a.ts"]);
    if (action.kind === "reconcile_edits") for (const ref of action.calls) plan.messages[ref.messageIndex!] = { role: "tool", tool_call_id: ref.callId, content: text };
    again.resumed(plan.summary, plan.actions.map((a) => ({ ...a, result: text })), plan);
    const ev = eventsOf(s, rec.id).at(-1)!;
    expect(ev.type).toBe("resumed");
    if (ev.type === "resumed") expect(ev.data.actions[0]).toMatchObject({ kind: "reconcile_edits", result: text });
    expect(plan.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c_edit", content: text });
    expect(editRecoveryMessage("reset", ["a.ts", "b.ts"])).toContain("a.ts, b.ts");
    expect(editRecoveryMessage("commit", [])).toContain("no uncommitted changes");
  });
});
