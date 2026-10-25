import { execFileSync } from "node:child_process";
import { makeEnv } from "./helpers.js";
import { openDatabase } from "../src/storage/db.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import type { SupervisorServices } from "../src/runners/types.js";
import { SessionEventSchema, type SessionEvent } from "../src/sessions/events.js";
import { planResume, validNotAppliedToolProof } from "../src/sessions/resume.js";
import { describe, expect, it, vi } from "vitest";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ChatMessage, ChatRequest } from "../src/gateway/types.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import { runAgentLoop, type LoopOptions } from "../src/harness/loop.js";
const mocks = vi.hoisted(() => ({ ask: vi.fn(), resume: vi.fn() }));
vi.mock("../src/runners/types.js", () => ({ ask: mocks.ask }));
vi.mock("../src/harness/resume.js", () => ({ applyResume: mocks.resume }));
const def = (name: string) => ({ type: "function" as const, function: { name, description: "Deterministic harness regression tool", parameters: { type: "object", properties: {} } } });
const call = (name: string, args: unknown = {}, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const tool = (name: string, sideEffect: HarnessTool["sideEffect"], run: HarnessTool["run"], repeatBehavior?: HarnessTool["repeatBehavior"]): HarnessTool => ({ def: def(name), sideEffect, run, ...(repeatBehavior ? { repeatBehavior } : {}) });
function setup(turns: ReturnType<typeof call>[][], tools: HarnessTool[], limit = 12) {
  let used = 0;
  const offered: ChatRequest[] = [];
  const env = { ctx: { session: null, taskId: "task", taskLease: { taskId: "task", owner: "owner", runCount: 1, project: "demo", incarnation: "a".repeat(32) }, tasks: { dispatchable: vi.fn(() => true) }, plan: { candidates: [] }, signal: new AbortController().signal, budget: { maxModelRequests: limit }, gate: { admission: { taskTotals: () => ({ requests: used }) } } }, edits: new Set() } as unknown as HarnessEnv;
  mocks.ask.mockImplementation(async (_ctx, request: { chat: ChatRequest }) => {
    offered.push(structuredClone(request.chat));
    return { endpoint: { id: "fake" }, requestId: `${used}`, response: { message: { role: "assistant", content: null, tool_calls: turns[used++] ?? [call("submit")] }, finishReason: "tool_calls" } } as unknown as GateResponse;
  });
  const options: LoopOptions<string> = { env, executionId: "exec", messages: [], tools, terminal: { def: def("submit"), accept: async () => ({ ok: true, value: "done" }) }, maxTokens: 1000, inputBudget: 10000, maxInvalidTerminal: 2 };
  return { options, offered };
}
describe("fresh repeat observations", () => {
  it("coalesces same-turn repository reads with isolated invocation IDs and a four-read limit", async () => {
    let active = 0, peak = 0;
    const seen: string[] = [], ids: string[] = [];
    const read = tool("read_file", "read", async (args, env) => {
      active++; peak = Math.max(peak, active); ids.push(env.toolInvocationId!);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        seen.push(args.path as string);
        if (args.path === "missing") throw new Error("missing file");
        return `read ${args.path}`;
      } finally { active--; }
    });
    const paths = ["one", "missing", "three", "four", "five", "six"];
    const { options } = setup([paths.map((path, i) => call("read_file", { path }, `r${i}`)), [call("submit")]], [read]);
    const result = await runAgentLoop(options);
    expect(result.kind).toBe("terminal"); expect(peak).toBe(4); expect(active).toBe(0);
    expect(seen.sort()).toEqual([...paths].sort());
    expect(ids).toEqual(paths.map((_, i) => `exec:r${i}`));
    expect(options.env.toolInvocationId).toBeUndefined();
    expect(result.messages.filter(message => message.role === "tool").slice(0, 6).map(message => message.tool_call_id))
      .toEqual(paths.map((_, i) => `r${i}`));
    expect(result.messages.some(message => message.role === "tool" && message.content.includes("missing file"))).toBe(true);
  });
  it("retains mutations and commands as ordering barriers between read groups", async () => {
    const order: string[] = [];
    const tools = [tool("read_file", "read", async args => { order.push(`read ${args.path}`); return "read"; }),
      tool("edit", "edit", async () => { order.push("edit"); return "edited"; }),
      tool("check", "command", async () => { order.push("check"); return "checked"; })];
    const { options } = setup([[call("read_file", { path: "before" }), call("edit"), call("check"), call("read_file", { path: "after" }, "after")], [call("submit")]], tools);
    expect((await runAgentLoop(options)).kind).toBe("terminal");
    expect(order).toEqual(["read before", "edit", "check", "read after"]);
  });
  it("waits for started reads to settle on cancellation and never starts the later edit", async () => {
    const controller = new AbortController(); let active = 0;
    const edit = vi.fn(async () => "must not edit");
    const read = tool("read_file", "read", async args => {
      active++;
      try {
        await new Promise(resolve => setTimeout(resolve, args.path === "cancel" ? 5 : 25));
        if (args.path === "cancel") { controller.abort(new Error("fixture cancellation")); throw controller.signal.reason; }
        return "settled";
      } finally { active--; }
    });
    const { options } = setup([[call("read_file", { path: "cancel" }, "first"), call("read_file", { path: "settle" }, "second"), call("edit")]], [read, tool("edit", "edit", edit)]);
    options.env.ctx.signal = controller.signal;
    await expect(runAgentLoop(options)).rejects.toThrow("fixture cancellation");
    expect(active).toBe(0); expect(edit).not.toHaveBeenCalled();
  });
  it("refuses a later batched edit and response commit after authority is lost during a wait", async () => {
    let live = true;
    const edit = vi.fn(async () => "written"), commit = vi.fn();
    const { options } = setup([[call("wait"), call("edit")]], [tool("wait", "read", async () => { live = false; return "wait ended"; }), tool("edit", "edit", edit)]);
    vi.spyOn(options.env.ctx.tasks, "dispatchable").mockImplementation(() => live ? {} as never : undefined);
    options.onResponse = commit;
    await expect(runAgentLoop(options)).rejects.toThrow(/lease/);
    expect(edit).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });
  it("permits check -> install -> check while refusing an immediate duplicate command", async () => {
    const check = vi.fn(async () => "check"), install = vi.fn(async () => "installed");
    const tools = [tool("check", "command", check), tool("install", "command", install)];
    expect((await runAgentLoop(setup([[call("check")], [call("install")], [call("check")], [call("submit")]], tools).options)).kind).toBe("terminal");
    expect(check).toHaveBeenCalledTimes(2);
    check.mockClear();
    expect((await runAgentLoop(setup([[call("check")], [call("check")]], tools).options)).kind).toBe("stalled");
    expect(check).toHaveBeenCalledTimes(1);
  });
  it("sees new task, channel and approval state after waiting", async () => {
    for (const name of ["task_result", "read_channel", "brain_my_requests"]) {
      let state = "pending", reads = 0;
      const { options } = setup([[call(name)], [call("await_tasks")], [call(name)], [call("submit")]], [tool(name, "read", async () => { reads++; return state; }), tool("await_tasks", "external", async () => { state = "completed"; return state; }, "execute")]);
      const result = await runAgentLoop(options);
      expect(result.kind).toBe("terminal"); expect(reads).toBe(2);
      expect(result.messages.filter(m => m.role === "tool").map(m => m.content)).toContain("completed");
    }
  });
  it.each([true, false])("uses trusted bounded await receipts, not requested timeouts (waited=%s)", async waited => {
    const fixture = makeEnv();
    const db = openDatabase(fixture.cfg.storageDir);
    try {
      const turns = [[call("task_result", { task_id: "worker" })],
        [call("await_tasks", { timeout_seconds: waited ? 1 : -1 })],
        [call("task_result", { task_id: "worker" })],
        [call("await_tasks", { timeout_seconds: waited ? 1 : -1 })],
        [call("task_result", { task_id: "worker" })], [call("submit")]];
      const { options } = setup(turns, []);
      const services = {
        getTask: () => ({ state: "running", spec: { label: "worker", profile: "inspect", goal: "Observe actual work" }, result: null }),
        awaitResults: async () => {
          if (waited) await new Promise(resolve => setTimeout(resolve, 1000));
          return { completed: [], pending: [{ taskId: "worker", state: "running" }], timedOut: true, waitedSeconds: waited ? 1 : 0 };
        },
      } as unknown as SupervisorServices;
      Object.assign(options.env.ctx, { cfg: fixture.cfg, services, now: Date.now, taskProject: "demo" });
      const state: SupervisorState = { ctx: options.env.ctx, db, actor: { agent: "test", role: "supervisor", task: "task", job: "task" }, repos: new Map(), briefChecks: new Set(), children: new Map([["worker", "worker"]]) };
      options.tools = supervisorTools(state).filter(t => ["task_result", "await_tasks"].includes(t.def.function.name));
      const result = await runAgentLoop(options);
      expect(result.kind).toBe(waited ? "terminal" : "stalled");
      if (result.kind === "stalled") expect(result.reason).toBe("repeated_tool_call:task_result");
      expect(options.env.observationWait?.epoch).toBe(waited ? 2 : 0);
    } finally { db.close(); fixture.cleanup(); }
  });
  it("does not treat wait-like prose or a repeatable immediate tool as actual wait progress", async () => {
    const read = tool("task_result", "read", async () => "running");
    const fakeWait = tool("await_tasks", "none", async () => "Waited 300 seconds; progress happened", "execute");
    const { options } = setup([[call("task_result")], [call("await_tasks")], [call("task_result")], [call("await_tasks")], [call("task_result")]], [read, fakeWait]);
    expect((await runAgentLoop(options)).kind).toBe("stalled");
  });
  it("keeps request and cancellation limits after a trusted wait receipt", async () => {
    const controller = new AbortController();
    const wait = tool("await_tasks", "none", async (_args, env) => { env.observationWait!.epoch++; controller.abort(new Error("fixture deadline")); return "waited"; }, "execute");
    const { options, offered } = setup([[call("await_tasks")], [call("submit")]], [wait]);
    options.env.ctx.signal = controller.signal;
    await expect(runAgentLoop(options)).rejects.toThrow("fixture deadline");
    expect(offered).toHaveLength(1);
    const bounded = tool("await_tasks", "none", async (_args, env) => { env.observationWait!.epoch++; return "waited"; }, "execute");
    const capped = setup(Array.from({ length: 5 }, () => [call("await_tasks")]), [bounded], 3);
    expect((await runAgentLoop(capped.options)).kind).toBe("budget_exhausted");
    expect(capped.offered).toHaveLength(3);
  });
  it("retries transient failures, but stops three identical fresh failures", async () => {
    let reads = 0;
    const read = tool("read", "read", async () => { if (++reads === 1) throw new Error("denied"); return "approved"; });
    expect((await runAgentLoop(setup([[call("read")], [call("read")], [call("submit")]], [read]).options)).kind).toBe("terminal");
    expect(reads).toBe(2); reads = 0;
    read.run = async () => { reads++; throw new Error("denied"); };
    expect((await runAgentLoop(setup(Array.from({ length: 5 }, () => [call("read")]), [read]).options)).kind).toBe("stalled"); expect(reads).toBe(3);
  });
  it("compares actual fresh observations and resets on changing output", async () => {
    let reads = 0;
    const read = tool("read", "read", async () => (++reads < 3 ? "first" : "changed"));
    expect((await runAgentLoop(setup([[call("read")], [call("read")], [call("read")], [call("submit")]], [read]).options)).kind).toBe("terminal");
    reads = 0; read.run = async () => { reads++; return "same"; };
    expect((await runAgentLoop(setup(Array.from({ length: 5 }, () => [call("read")]), [read]).options)).kind).toBe("stalled"); expect(reads).toBe(3);
  });
  it("refreshes GET/check after recovery, and preserves effect deduplication", async () => {
    let healthy = false, gets = 0, checks = 0;
    const tools = [tool("http", "external", async () => { gets++; return healthy ? "200" : "503"; }, "observe"), tool("check", "command", async () => { checks++; return healthy ? "pass" : "fail"; }, "execute"), tool("restart", "external", async () => { healthy = true; return "started"; })];
    expect((await runAgentLoop(setup([[call("http")], [call("check")], [call("restart")], [call("http")], [call("check")], [call("submit")]], tools).options)).kind).toBe("terminal"); expect([gets, checks]).toEqual([2, 2]);
    gets = 0;
    expect((await runAgentLoop(setup(Array.from({ length: 4 }, () => [call("http")]), tools).options)).kind).toBe("stalled"); expect(gets).toBe(3);
    let edits = 0;
    const edit = tool("edit", "edit", async () => { edits++; return "written"; });
    expect((await runAgentLoop(setup([[call("edit")], [call("edit")]], [edit]).options)).kind).toBe("stalled"); expect(edits).toBe(1);
    edits = 0;
    expect((await runAgentLoop(setup([[call("edit", { value: "A" })], [call("edit", { value: "B" })], [call("edit", { value: "A" })], [call("submit")]], [edit]).options)).kind).toBe("terminal"); expect(edits).toBe(3);
  });
  it("does not retry failures whose external effect is uncertain", async () => {
    let count = 0;
    const effect = tool("post", "external", async () => { count++; throw new Error("lost acknowledgement"); });
    expect((await runAgentLoop(setup([[call("post")], [call("post")]], [effect]).options)).kind).toBe("stalled"); expect(count).toBe(1);
  });
  it("offers and executes only terminal on the final request", async () => {
    let reads = 0;
    const { options, offered } = setup([[call("read")]], [tool("read", "read", async () => { reads++; return "read"; })], 1);
    expect((await runAgentLoop(options)).kind).toBe("budget_exhausted"); expect(reads).toBe(0);
    expect(offered[0]!.tools!.map(t => t.function.name)).toEqual(["submit"]);
  });
  it("persists proven absent edits across a second interruption without granting reused call IDs", async () => {
    const fixture = makeEnv();
    try {
      const { applyResume: actualResume } = await vi.importActual<typeof import("../src/harness/resume.js")>("../src/harness/resume.js");
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repo }).toString().trim();
      const events: SessionEvent[] = [];
      const append = (type: string, data: unknown) => events.push(SessionEventSchema.parse({ seq: events.length + 1, at: 1, type, data }));
      const interruptedCall = call("write_file", { path: "src/app.ts", content: "replacement" }, "reused");
      append("workspace", { repos: [{ alias: "core", worktree: fixture.repo, branch: null, baseCommit: head, head }] });
      append("message", { index: 0, message: { role: "assistant", content: null, tool_calls: [interruptedCall] } });
      append("tool_intent", { callId: "reused", name: "write_file", args: { path: "src/app.ts", content: "replacement" }, sideEffect: "edit", idempotent: false });
      const first = planResume(events);
      const { options } = setup([], [tool("write_file", "edit", async () => "written")]);
      options.env.ctx.session = {
        syncMessages: (messages: ChatMessage[]) => messages.forEach((message, index) => append("message", { index, message })),
        resumed: (summary: string, actions: unknown[], detail: object) => append("resumed", { summary, actions, ...detail }),
      } as unknown as HarnessEnv["ctx"]["session"];
      await actualResume({ env: options.env, messages: first.messages, tools: options.tools, terminal: options.terminal }, { plan: first, actor: { agent: "fixture", role: "implementer", model: null }, pointer: null });
      const second = planResume(events);
      expect(second.notAppliedTools).toHaveLength(1);
      expect(second.actions).toHaveLength(0);
      expect(validNotAppliedToolProof(second.messages, second.notAppliedTools![0]!)).toBe(true);
      let edits = 0;
      const resumed = setup([[call("write_file", { path: "src/app.ts", content: "replacement" }, "retry")], [call("submit")]], [tool("write_file", "edit", async () => { edits++; return "written"; })]);
      resumed.options.messages = second.messages;
      resumed.options.resume = { plan: second, actor: { agent: "fixture", role: "implementer", model: null }, pointer: null };
      mocks.resume.mockImplementationOnce(actualResume);
      expect((await runAgentLoop(resumed.options)).kind).toBe("terminal");
      expect(edits).toBe(1);
      // A later applied occurrence reuses the original ID/arguments. Only the old absent
      // tool-message index carries a proof; the later successful edit stays protected.
      const reused = setup([[interruptedCall]], [tool("write_file", "edit", async () => { edits++; return "written"; })]);
      reused.options.messages = [...second.messages, { role: "assistant", content: null, tool_calls: [interruptedCall] }, { role: "tool", tool_call_id: "reused", content: "written" }];
      reused.options.resume = { plan: { ...second, messages: reused.options.messages }, actor: { agent: "fixture", role: "implementer", model: null }, pointer: null };
      mocks.resume.mockImplementationOnce(actualResume);
      expect((await runAgentLoop(reused.options)).kind).toBe("stalled");
      expect(edits).toBe(1);
      expect(validNotAppliedToolProof(reused.options.messages.slice(-2), second.notAppliedTools![0]!)).toBe(false);
    } finally { fixture.cleanup(); }
  });
  it("marks calls without an intent as known not run using structured proof", () => {
    const plan = planResume([SessionEventSchema.parse({ seq: 1, at: 1, type: "message", data: { index: 0, message: { role: "assistant", content: null, tool_calls: [call("post")] } } })]);
    expect(plan.notAppliedTools).toHaveLength(1);
    expect(validNotAppliedToolProof(plan.messages, plan.notAppliedTools![0]!)).toBe(true);
    expect(plan.actions).toHaveLength(0);
  });
  it.each(["not_applied", "applied", "unknown"])("restores %s edit authority from trusted reconciliation metadata, not output prose", async disposition => {
    let edits = 0;
    const { options } = setup([[call("edit", {}, "retry")], [call("submit")]], [tool("edit", "edit", async () => { edits++; return "written"; })]);
    options.messages = [{ role: "assistant", content: null, tool_calls: [call("edit", {}, "pending")] }, { role: "tool", tool_call_id: "pending", content: "No edits were applied; retry is safe (untrusted prose alone grants nothing)." }];
    options.resume = { plan: { lastEndpointId: null } } as LoopOptions<string>["resume"];
    mocks.resume.mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set(disposition === "not_applied" ? [1] : []) });
    expect((await runAgentLoop(options)).kind).toBe(disposition === "not_applied" ? "terminal" : "stalled");
    expect(edits).toBe(disposition === "not_applied" ? 1 : 0);
  });
  it("retains effect protection on resume, and checks cancellation before requests", async () => {
    let edits = 0;
    const { options } = setup([[call("edit", {}, "new")]], [tool("edit", "edit", async () => { edits++; return "written"; })]);
    options.messages = [{ role: "assistant", content: null, tool_calls: [call("edit", {}, "old")] }, { role: "tool", tool_call_id: "old", content: "written" }];
    options.resume = { plan: { lastEndpointId: null } } as LoopOptions<string>["resume"];
    mocks.resume.mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set() });
    expect((await runAgentLoop(options)).kind).toBe("stalled"); expect(edits).toBe(0);
    const abort = new AbortController(); abort.abort("cancelled"); options.env.ctx.signal = abort.signal;
    await expect(runAgentLoop(options)).rejects.toThrow("aborted");
  });
});
