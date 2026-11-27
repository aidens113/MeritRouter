import { describe, expect, it, vi } from "vitest";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { runAgentLoop, type LoopOptions } from "../src/harness/loop.js";
import { workerToolPolicy, type HarnessEnv, type HarnessTool } from "../src/harness/tools.js";
import { submitResultTool } from "../src/harness/worker.js";
import { ALWAYS_ON_WORKER_TOOLS, briefToTaskArgument } from "../src/core/brief.js";
import type { WorkerTask } from "../src/core/task.js";
import type { SupervisorChannelService } from "../src/core/channel.js";

const mocks = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("../src/runners/types.js", () => ({ ask: mocks.ask }));

const def = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } });

/** A RunContext stub with just what workerToolPolicy and runAgentLoop read. */
function stubCtx(tools: WorkerTask["tools"], channel?: SupervisorChannelService) {
  return { taskId: "task", spec: { tools }, channel } as unknown as import("../src/runners/types.js").RunContext;
}

describe("workerToolPolicy (core/brief.ts resolved tool grant -> dynamic loop policy)", () => {
  it("is undefined for a legacy task with no brief-resolved tool grant", () => {
    expect(workerToolPolicy(stubCtx(undefined))).toBeUndefined();
  });

  it("offers only the grant's tools plus the always-on tools when no channel grant exists", () => {
    const policy = workerToolPolicy(stubCtx({ allow: ["read_file", "search"] }))!;
    const allowed = policy().allowedToolNames;
    expect(allowed).toEqual(expect.arrayContaining(["read_file", "search", ...ALWAYS_ON_WORKER_TOOLS]));
    expect(allowed).not.toContain("write_file");
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it("adds a tool granted over the supervisor channel, recomputed on every call", () => {
    let granted: string[] = [];
    const channel = { grantedTools: () => granted } as unknown as SupervisorChannelService;
    const policy = workerToolPolicy(stubCtx({ allow: ["read_file"] }, channel))!;
    expect(policy().allowedToolNames).not.toContain("web_search");
    granted = ["web_search"];
    expect(policy().allowedToolNames).toContain("web_search");
  });
});

describe("briefToTaskArgument sets WorkerTaskInput.tools from resolveBriefTools", () => {
  it("names the profile and resolves its tools for a kind-default grant", () => {
    const task = briefToTaskArgument({
      kind: "scout",
      goal: "Find where the retry loop is implemented",
      scope: { writable: false },
      doneWhen: ["the file and line are named"],
    });
    expect(task.tools?.profile).toBe("scout");
    expect(task.tools?.allow).toEqual(expect.arrayContaining(["list_files", "read_file", "search", ...ALWAYS_ON_WORKER_TOOLS]));
    expect(task.tools?.allow).not.toContain("write_file");
  });

  it("has no profile name for an explicit tool list", () => {
    const task = briefToTaskArgument({
      kind: "scout",
      goal: "Find where the retry loop is implemented",
      scope: { writable: false },
      tools: ["read_file", "search"],
      doneWhen: ["the file and line are named"],
    });
    expect(task.tools?.profile).toBeUndefined();
    expect(task.tools?.allow).toEqual(expect.arrayContaining(["read_file", "search", ...ALWAYS_ON_WORKER_TOOLS]));
  });
});

/** Minimal runAgentLoop harness (mirrors tests/supervisor-loop-role.test.ts's dynamic-policy fixture). */
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

describe("worker tool restriction end to end through runAgentLoop", () => {
  it("keeps an in-budget read result when the ungranted tool schemas are large", async () => {
    const contents = "export const sample = 'a fixture value';\n".repeat(300);
    const ctx = stubCtx({ allow: ["read_file"] });
    const ungranted = def("web_search");
    ungranted.function.description = "large ungranted schema ".repeat(1500);
    const { options, offered } = policyLoop(
      [["read_file"], ["submit"]],
      [
        { def: def("read_file"), sideEffect: "read", run: async () => contents },
        { def: ungranted, sideEffect: "read", run: async () => "outside scope" },
      ],
      workerToolPolicy(ctx),
    );
    options.inputBudget = 2000;
    options.fallbackContextTokens = 8192;

    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(offered[1]!.messages.find(message => message.role === "tool")?.content).toBe(contents);
    expect(offered[1]!.tools!.map(tool => tool.function.name)).toEqual(["read_file", "submit"]);
  });

  it("offers only the brief's profile tools plus always-on, and a channel grant adds a tool starting the next turn", async () => {
    const webSearch = vi.fn(async () => "web result");
    let granted: string[] = [];
    // The read_file call stands in for the supervisor's grant reply landing after this turn's
    // tool calls run (SupervisorChannelStore.answer): workerToolPolicy recomputes allowedToolNames
    // fresh on its next call, at the top of the loop's next turn, before that turn's request.
    const readFile = vi.fn(async () => { granted = ["web_search"]; return "file contents"; });
    const ctx = stubCtx({ allow: ["read_file"] }, { grantedTools: () => granted } as unknown as SupervisorChannelService);
    const { options, offered } = policyLoop(
      [["read_file"], ["web_search"], ["submit"]],
      [
        { def: def("read_file"), sideEffect: "read", run: readFile },
        { def: def("web_search"), sideEffect: "read", run: webSearch },
      ],
      workerToolPolicy(ctx),
    );
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(offered[0]!.tools!.map(t => t.function.name)).not.toContain("web_search");
    expect(offered[1]!.tools!.map(t => t.function.name)).toContain("web_search");
  });

  it("refuses a call to a tool outside the current grant and tells the worker to request_tools", async () => {
    const writeFileRun = vi.fn(async () => "wrote");
    const ctx = stubCtx({ allow: ["read_file"] });
    const { options } = policyLoop(
      [["write_file"]],
      [
        { def: def("read_file"), sideEffect: "read", run: async () => "read" },
        { def: def("write_file"), sideEffect: "edit", run: writeFileRun },
      ],
      workerToolPolicy(ctx),
    );
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(writeFileRun).not.toHaveBeenCalled();
    expect(options.messages.some(m => m.role === "tool" && String(m.content).includes("restricted by current workflow policy"))).toBe(true);
    expect(options.messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("request_tools"))).toBe(true);
  });

  it("leaves a legacy task (no spec.tools) unrestricted: no toolPolicy is produced, so the model may call any offered tool", async () => {
    const ctx = stubCtx(undefined);
    expect(workerToolPolicy(ctx)).toBeUndefined();
    const writeFileRun = vi.fn(async () => "wrote");
    const { options } = policyLoop(
      [["write_file"]],
      [{ def: def("write_file"), sideEffect: "edit", run: writeFileRun }],
      workerToolPolicy(ctx),
    );
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(writeFileRun).toHaveBeenCalledTimes(1);
  });
});

describe("submit_result requires selfCheck only for a brief-originated (spec.tools) task", () => {
  const env = { universe: { refs: new Map() } } as unknown as HarnessEnv;
  const output = (extra: Record<string, unknown> = {}) => ({
    summary: "done",
    findings: [],
    criteria: [{ index: 0, status: "unknown", evidenceRefs: [] }],
    ...extra,
  });
  const selfCheck = { notTested: ["nothing critical"], assumptions: [], riskiestChange: "none", checkNext: [] };

  it("rejects a brief-originated task's submit_result with no selfCheck, with a clear message", async () => {
    const spec = { constraints: { acceptanceCriteria: ["x"] }, tools: { allow: ["read_file"] } } as unknown as WorkerTask;
    const terminal = submitResultTool(spec, env.universe);
    const result = await terminal.accept(output(), env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(" ")).toContain("selfCheck is required");
  });

  it("accepts the same brief-originated task once selfCheck is supplied", async () => {
    const spec = { constraints: { acceptanceCriteria: ["x"] }, tools: { allow: ["read_file"] } } as unknown as WorkerTask;
    const terminal = submitResultTool(spec, env.universe);
    const result = await terminal.accept(output({ selfCheck }), env);
    expect(result.ok).toBe(true);
  });

  it("leaves a legacy task (no spec.tools) accepting submit_result without selfCheck", async () => {
    const spec = { constraints: { acceptanceCriteria: ["x"] } } as unknown as WorkerTask;
    const terminal = submitResultTool(spec, env.universe);
    const result = await terminal.accept(output(), env);
    expect(result.ok).toBe(true);
  });
});
