import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeContinuationSchema, assistantMessage, estimateTokens, type ChatMessage, type ChatRequest, type NativeContinuation } from "../src/gateway/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { SessionStore } from "../src/sessions/store.js";
import { planResume } from "../src/sessions/resume.js";
import { SessionEventSchema } from "../src/sessions/events.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { runAgentLoop } from "../src/harness/loop.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { runCompletion } from "../src/runners/completion.js";
import type { RunContext } from "../src/runners/types.js";
import { makeEnv, reply, type Env } from "./helpers.js";

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../src/runners/types.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/runners/types.js")>(), ask: mocks.ask }));
let env: Env | undefined, db: Db | undefined;
afterEach(() => { mocks.ask.mockReset(); if (db?.open) db.close(); db = undefined; env?.cleanup(); env = undefined; });
const call = (name: string, id: string, args = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const tool = (name: string) => ({ type: "function" as const, function: { name, description: "Fixture data tool", parameters: { type: "object", properties: {} } } });
const BASE: ChatMessage[] = [{ role: "system", content: "fixture charter" }, { role: "user", content: "fixture goal" }];
function native(turn: number, content: string, clientCall?: ReturnType<typeof call>): NativeContinuation {
  return NativeContinuationSchema.parse({ provider: "anthropic", routeProvider: "native-fixture", baseUrl: "https://anthropic.example.test", model: "fixture-model", prefixDigest: String(turn).repeat(64), content: [
    { type: "thinking", thinking: `private thinking ${turn}`, signature: `unchanged-opaque-signature-${turn}+/=` },
    { type: "redacted_thinking", data: `opaque-redacted-${turn}+/=` },
    { type: "text", text: content },
    { type: "server_tool_use", id: `server-${turn}`, name: "web_search", input: { query: "fixture" } },
    { type: "web_search_tool_result", tool_use_id: `server-${turn}`, content: [{ type: "web_search_result", url: "https://example.test", encrypted_content: "opaque-server-result", nested: { preserved: [1, null, true] } }] },
    ...(clientCall ? [{ type: "tool_use", id: clientCall.id, name: clientCall.function.name, input: JSON.parse(clientCall.function.arguments) }] : []),
  ] });
}
function response(turn: number, content: string, clientCall?: ReturnType<typeof call>): GateResponse {
  return { requestId: `request-${turn}`, endpoint: { id: "fixture" } as ModelEndpoint, attempts: [], estimatedInputTokens: 100,
    response: { ...reply(content, clientCall ? { toolCalls: [clientCall] } : {}), message: { content, ...(clientCall ? { tool_calls: [clientCall] } : {}), nativeContinuation: native(turn, content, clientCall) } } };
}
function store() {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  return new SessionStore(db, env.cfg.storageDir);
}
function loopEnvironment(limit = 3, session: ReturnType<SessionStore["create"]> | null = null) {
  let used = 0;
  const offered: ChatRequest[] = [], read = vi.fn(async () => "fixture observation");
  const context = { session, taskId: "fixture-task", taskLease: { taskId: "fixture-task", owner: "fixture-owner", runCount: 1, project: "fixture", incarnation: "a".repeat(32) }, tasks: { dispatchable: () => true }, plan: { candidates: [] }, signal: new AbortController().signal,
    budget: { maxModelRequests: limit }, gate: { admission: { taskTotals: () => ({ requests: used }) } } };
  const options = { env: { ctx: context, edits: new Set() } as unknown as HarnessEnv, executionId: "fixture-execution", messages: structuredClone(BASE),
    tools: [{ def: tool("read_file"), sideEffect: "read" as const, run: read }], terminal: { def: tool("submit"), accept: async () => ({ ok: true as const, value: "done" }) }, maxTokens: 1000, inputBudget: 20000, maxInvalidTerminal: 2 };
  const script = (replies: GateResponse[]) => mocks.ask.mockImplementation(async (_ctx, request: { chat: ChatRequest }) => {
    offered.push(structuredClone(request.chat)); return replies[used++]!;
  });
  return { options, offered, read, script };
}

describe("opaque native assistant continuation", () => {
  it("carries the entire ordered first and second tool responses into the following turns without exposing thinking as answer text", async () => {
    const first = response(1, "first visible answer", call("read_file", "read-1", { path: "one" }));
    const second = response(2, "second visible answer", call("read_file", "read-2", { path: "two" }));
    const last = response(3, "finished", call("submit", "done"));
    const fixture = loopEnvironment(); fixture.script([first, second, last]);
    expect((await runAgentLoop(fixture.options)).kind).toBe("terminal");
    const replayed = fixture.offered[2]!.messages.filter(message => message.role === "assistant");
    expect(replayed.map(message => message.nativeContinuation)).toEqual([first.response.message.nativeContinuation, second.response.message.nativeContinuation]);
    expect(JSON.stringify(replayed[0]!.nativeContinuation!.content)).toBe(JSON.stringify(first.response.message.nativeContinuation!.content));
    expect(replayed.map(message => message.content)).toEqual(["first visible answer", "second visible answer"]);
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it("persists the complete state through a real store restart and notices signature-only transcript changes", () => {
    let sessions = store();
    const recorder = sessions.create({ role: "inspector", agentLabel: "fixture" });
    const state = response(1, "visible", call("read_file", "read-1"));
    const messages = [...BASE, assistantMessage(state.response.message), { role: "tool" as const, tool_call_id: "read-1", content: "observed" }];
    recorder.syncMessages(messages); recorder.end("interrupted", "fixture restart");
    db!.close(); db = openDatabase(env!.cfg.storageDir); sessions = new SessionStore(db, env!.cfg.storageDir);
    expect(sessions.transcript(recorder.id)).toEqual(messages);
    const reopened = sessions.reopen(recorder.id), before = reopened.lastSeq;
    const changed = structuredClone(messages);
    const assistant = changed[2] as Extract<ChatMessage, { role: "assistant" }>;
    assistant.nativeContinuation!.content[0]!.signature = "signature-changed-with-same-visible-text-and-call-id";
    reopened.syncMessages(changed);
    expect(reopened.lastSeq).toBeGreaterThan(before);
    expect(sessions.transcript(recorder.id)).toEqual(changed);
    expect(sessions.events(recorder.id)!.corrupt).toEqual([]);
  });

  it("restores native state from a durable response when a crash precedes the assistant transcript append", () => {
    let sessions = store();
    const recorder = sessions.create({ role: "inspector", agentLabel: "fixture" });
    recorder.syncMessages(BASE);
    recorder.modelRequest({ executionId: "fixture-execution", purpose: "fixture", chat: { messages: BASE, max_tokens: 1000 } });
    const received = response(1, "visible", call("read_file", "read-1")); recorder.modelResponse(received);
    recorder.end("interrupted", "fixture response-before-message crash");
    db!.close(); db = openDatabase(env!.cfg.storageDir); sessions = new SessionStore(db, env!.cfg.storageDir);
    const plan = planResume(sessions.events(recorder.id)!.events);
    expect(plan.messages.find(message => message.role === "assistant")).toEqual(assistantMessage(received.response.message));
    expect(plan.messages.find(message => message.role === "tool")?.content).toContain("interrupted");
  });

  it("counts native-only thinking input conservatively once instead of omitting it or counting normalized content twice", () => {
    const received = response(1, "visible", call("read_file", "read-1"));
    const message = assistantMessage(received.response.message);
    const raw = JSON.stringify(message.nativeContinuation!.content);
    expect(estimateTokens([message])).toBe(estimateTokens([{ role: "assistant", content: raw }]));
    expect(estimateTokens([message])).toBeGreaterThan(estimateTokens([{ role: "assistant", content: "visible", tool_calls: message.tool_calls }]));
  });

  it("stores native signatures larger than the tool-output cap intact and explicitly rejects oversized state without clipping it", () => {
    const sessions = store(), recorder = sessions.create({ role: "inspector", agentLabel: "fixture" });
    const state = native(1, "visible"); state.content[0]!.signature = "s".repeat(40000);
    recorder.syncMessages([assistantMessage({ content: "visible", nativeContinuation: state })]);
    expect((sessions.transcript(recorder.id)![0] as Extract<ChatMessage, { role: "assistant" }>).nativeContinuation!.content[0]!.signature).toBe("s".repeat(40000));
    const oversized = structuredClone(state); oversized.content[0]!.signature = "x".repeat(2 * 1024 * 1024);
    const before = recorder.lastSeq;
    expect(() => recorder.syncMessages([{ role: "assistant", content: "visible", nativeContinuation: oversized }])).toThrow(/2 MiB/);
    expect(recorder.lastSeq).toBe(before);
    expect(sessions.events(recorder.id)!.corrupt).toEqual([]);
    expect(NativeContinuationSchema.safeParse({ ...state, content: Array.from({ length: 513 }, () => ({ type: "text", text: "x" })) }).success).toBe(false);
  });

  it("does not treat plain text or opaque native tool-looking blocks as a terminal tool success", async () => {
    const fixture = loopEnvironment(1);
    const received = response(1, "I am finished");
    received.response.message.nativeContinuation!.content.push({ type: "tool_use", id: "not-an-authorized-normalized-call", name: "submit", input: {} });
    fixture.script([received]);
    expect((await runAgentLoop(fixture.options)).kind).toBe("budget_exhausted");
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.offered[0]!.tool_choice).toBe("required");
    expect(fixture.offered[0]!.tools!.map(definition => definition.function.name)).toEqual(["submit"]);
  });

  it("keeps old event logs compatible when no native continuation exists", () => {
    expect(SessionEventSchema.parse({ seq: 1, at: 1, type: "message", data: { index: 0, message: { role: "assistant", content: "old visible response" } } }).type).toBe("message");
  });

  it("preserves native assistant state through the completion runner's actual JSON repair turn", async () => {
    store();
    const spec = WorkerTaskSchema.parse({ profile: "summarize", goal: "Summarize fixture", context: { inlineText: "fixture" }, constraints: { acceptanceCriteria: ["fixture criterion"] } });
    const responses = [response(1, "not valid JSON"), response(2, JSON.stringify({ summary: "fixture", findings: [], criteria: [{ index: 0, status: "unknown", evidenceRefs: [] }] }))];
    const offered: ChatRequest[] = []; let at = 0;
    mocks.ask.mockImplementation(async (_ctx, request: { chat: ChatRequest }) => { offered.push(structuredClone(request.chat)); return responses[at++]!; });
    const ctx = { cfg: env!.cfg, spec, profile: env!.cfg.profiles.summarize!, taskId: "completion-fixture", artifacts: new ArtifactStore(db!, env!.cfg.storageDir),
      budget: { maxModelRequests: 2, maxInputTokens: 20000, maxOutputTokens: 1000, maxPaidUsd: 0 }, plan: { candidates: [] }, brain: null, access: null,
      gate: { admission: { createExecution: () => "completion-execution", finishExecution: vi.fn() } }, now: Date.now } as unknown as RunContext;
    expect((await runCompletion(ctx)).state).toBe("completed");
    expect(offered[1]!.messages.find(message => message.role === "assistant")).toEqual(assistantMessage(responses[0]!.response.message));
  });
});
