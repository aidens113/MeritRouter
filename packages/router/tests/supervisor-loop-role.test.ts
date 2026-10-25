import { describe, expect, it, vi } from "vitest";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ChatMessage, ChatRequest } from "../src/gateway/types.js";
import { runAgentLoop, type LoopOptions } from "../src/harness/loop.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../src/runners/types.js", () => ({ ask: mocks.ask }));

const def = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } });

async function runWithoutEdits(mode: "supervisor" | "coding") {
  let used = 0;
  const offered: ChatRequest[] = [];
  const env = {
    ctx: {
      profile: { mode }, taskId: "task", session: null,
      taskLease: { taskId: "task", owner: "owner", runCount: 1, project: "demo", incarnation: "a".repeat(32) },
      tasks: { dispatchable: () => true }, plan: { candidates: [] }, signal: new AbortController().signal,
      budget: { maxModelRequests: 6 }, gate: { admission: { taskTotals: () => ({ requests: used }) } },
    }, edits: new Set(),
  } as unknown as HarnessEnv;
  const write = vi.fn(async () => "written");
  const tools: HarnessTool[] = [
    { def: def("write_file"), sideEffect: "edit", run: write },
    { def: def("read_file"), sideEffect: "read", run: async args => `read ${args.path}` },
  ];
  mocks.ask.mockImplementation(async (_ctx, request: { chat: ChatRequest }) => {
    offered.push(structuredClone(request.chat));
    const turn = used++;
    const name = turn < 3 ? "read_file" : "submit";
    return {
      endpoint: { id: "fake" }, requestId: String(turn),
      response: { message: { role: "assistant", content: null, tool_calls: [{ id: String(turn), type: "function", function: { name, arguments: JSON.stringify({ path: `file-${turn}` }) } }] }, finishReason: "tool_calls" },
    } as unknown as GateResponse;
  });
  const options: LoopOptions<string> = {
    env, executionId: "exec", messages: [], tools,
    terminal: { def: def("submit"), accept: async () => ({ ok: true, value: "done" }) },
    maxTokens: 1000, inputBudget: 10000, maxInvalidTerminal: 2,
  };
  const result = await runAgentLoop(options);
  expect(result.kind).toBe("terminal");
  expect(write).not.toHaveBeenCalled();
  return offered[3]!.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
}

describe("role-aware agent loop stall guidance", () => {
  it("directs supervisors to plan, delegate, review and verify without implementing app code", async () => {
    const guidance = await runWithoutEdits("supervisor");
    expect(guidance).toContain("persisted delivery specification and task plan");
    expect(guidance).toContain("dispatch bounded worker briefs");
    expect(guidance).toContain("review their results");
    expect(guidance).toContain("verify the integrated product");
    expect(guidance).toContain("delegate-only supervisors must delegate application changes");
    expect(guidance).toContain("human approval");
    expect(guidance).not.toContain("Write your implementation now with write_file");
    expect(guidance).not.toContain("define the smallest version");
  });

  it("preserves implementation guidance for coding workers", async () => {
    const guidance = await runWithoutEdits("coding");
    expect(guidance).toContain("Write your implementation now with write_file");
    expect(guidance).toContain("define the smallest version");
    expect(guidance).not.toContain("delegate-only supervisors");
  });
});

function policyLoop(turns: string[][], tools: HarnessTool[], policy: LoopOptions<string>["toolPolicy"]) {
  let used = 0;
  const offered: ChatRequest[] = [];
  const env = {
    ctx: {
      taskId: "task", session: null,
      taskLease: { taskId: "task", owner: "owner", runCount: 1, project: "demo", incarnation: "a".repeat(32) },
      tasks: { dispatchable: () => true }, plan: { candidates: [] }, signal: new AbortController().signal,
      budget: { maxModelRequests: 10 }, gate: { admission: { taskTotals: () => ({ requests: used }) } },
    }, edits: new Set(),
  } as unknown as HarnessEnv;
  mocks.ask.mockImplementation(async (_ctx, request: { chat: ChatRequest }) => {
    offered.push(structuredClone(request.chat));
    const turn = used++;
    return {
      endpoint: { id: "fake" }, requestId: String(turn),
      response: { message: { role: "assistant", content: null, tool_calls: (turns[turn] ?? ["submit"]).map((name, index) => ({ id: `${turn}-${index}`, type: "function", function: { name, arguments: "{}" } })) }, finishReason: "tool_calls" },
    } as unknown as GateResponse;
  });
  const options: LoopOptions<string> = {
    env, executionId: "exec", messages: [], tools, toolPolicy: policy,
    terminal: { def: def("submit"), accept: async () => ({ ok: true, value: "done" }) },
    maxTokens: 1000, inputBudget: 10000, maxInvalidTerminal: 2,
  };
  return { options, offered };
}

describe("dynamic loop tool policy", () => {
  it("filters requests, rejects invented restricted calls and deduplicates notices", async () => {
    const command = vi.fn(async () => "ran command");
    const { options, offered } = policyLoop([["command"], ["observe"], ["submit"]], [
      { def: def("command"), sideEffect: "command", run: command },
      { def: def("observe"), sideEffect: "read", run: async () => "observed" },
    ], () => ({ allowedToolNames: ["observe"], notice: "Record a plan first." }));
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(command).not.toHaveBeenCalled();
    expect(offered.every(request => request.tools!.map(tool => tool.function.name).join(",") === "observe,submit")).toBe(true);
    expect(options.messages.filter(message => message.role === "user" && message.content === "Record a plan first.")).toHaveLength(1);
    expect(options.messages.some(message => message.role === "tool" && message.content.includes("restricted by current workflow policy"))).toBe(true);
  });

  it("rechecks policy between calls in one response and refreshes the next request", async () => {
    let advanced = false;
    const command = vi.fn(async () => "must not run");
    const { options, offered } = policyLoop([["advance", "command"], ["submit"]], [
      { def: def("advance"), sideEffect: "edit", run: async () => { advanced = true; return "advanced"; } },
      { def: def("command"), sideEffect: "command", run: command },
    ], () => ({ allowedToolNames: advanced ? [] : ["advance", "command"], notice: advanced ? "Review next." : "Plan next." }));
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(command).not.toHaveBeenCalled();
    expect(offered[0]!.tools!.map(tool => tool.function.name)).toEqual(["advance", "command", "submit"]);
    expect(offered[1]!.tools!.map(tool => tool.function.name)).toEqual(["submit"]);
    expect(options.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Plan next.", "Review next."]);
  });

  it("applies the current policy to unfinished resume intents without rerunning completed effects", async () => {
    const command = vi.fn(async () => "must not run");
    const { options } = policyLoop([["submit"]], [{ def: def("command"), sideEffect: "command", run: command }], () => ({ allowedToolNames: [] }));
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old", content: "completed before interruption" },
      { role: "assistant", content: null, tool_calls: [{ id: "pending", type: "function", function: { name: "command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "pending", content: "interrupted; recovering" },
    ];
    options.messages = messages;
    options.resume = {
      actor: { agent: "fixture", role: "supervisor", model: null }, pointer: null,
      plan: {
        messages, actions: [{ kind: "rerun_tool", callId: "pending", name: "command", args: {}, messageIndex: 3, intentSeq: 1, sideEffect: "command" }],
        summary: "resumed", resolvedIntentSeqs: [1], droppedRequestSeqs: [], workspace: null, reason: null, lastEndpointId: null, warnings: [],
      },
    };
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(command).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ content: "completed before interruption" });
    expect(messages[3]).toMatchObject({ content: "error: tool restricted by current workflow policy: command" });
  });
});
