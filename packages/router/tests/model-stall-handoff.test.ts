import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as requests from "../src/runners/types.js";
import * as resume from "../src/harness/resume.js";
import type { RunContext } from "../src/runners/types.js";
import type { MeritRouter } from "../src/core/service.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { ChatToolCall } from "../src/gateway/types.js";
import { AdmissionDenied } from "../src/core/errors.js";
import { runAgentLoop, type LoopOptions } from "../src/harness/loop.js";
import { StallHandoff } from "../src/harness/stall-handoff.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, commitAll, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let fixture: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; fixture?.cleanup(); fixture = undefined; });
const def = (name: string) => ({ type: "function" as const, function: { name, description: "Fixture", parameters: { type: "object", properties: {} } } });
const call = (name: string, id: string, args = {}): ChatToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const tool = (name: string, sideEffect: HarnessTool["sideEffect"], run: HarnessTool["run"]): HarnessTool => ({ def: def(name), sideEffect, run });

async function loopFixture(count = 2, cap = 20) {
  fixture = makeEnv({ endpoints: Array.from({ length: count }, (_, index) => endpoint({ gatewayModelId: `model-${index}`, totalParametersB: 500 - index })) });
  sy = open(fixture, new ScriptedClient(() => reply("unused")), { worker: false });
  const [submitted] = await sy.submitTasks([{ profile: "inspect", goal: "Continue a bounded stalled task", repositoryAliases: ["core"], budget: { maxModelRequests: cap }, constraints: { acceptanceCriteria: ["inspect"] } }]);
  const id = submitted!.taskId;
  sy.tasks.claim("fixture", { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60_000, defaultTimeoutMs: 3_600_000 });
  const row = sy.tasks.get(id)!.row;
  const controller = new AbortController();
  let used = 0;
  const endpoints = sy.catalog.endpoints();
  const ctx = { taskId: id, tasks: sy.tasks, cfg: fixture.cfg, session: null, profile: fixture.cfg.profiles.inspect,
    taskLease: { taskId: id, owner: "fixture", runCount: row.run_count, project: row.project_id, incarnation: row.lease_incarnation },
    plan: { candidates: endpoints, tier: "T3", profile: "inspect", paidPolicy: "never" },
    budget: { maxModelRequests: cap }, signal: controller.signal, gate: { admission: { taskTotals: () => ({ requests: used }) } },
  } as unknown as RunContext;
  const offered: Array<{ endpoint: string; avoid: readonly string[]; names: string[] }> = [];
  const script = vi.fn<(endpoint: string, n: number) => ChatToolCall[]>();
  vi.spyOn(requests, "ask").mockImplementation(async (_ctx, req) => {
    const ep = endpoints.find(endpoint => !(req.avoidEndpointIds ?? []).includes(endpoint.id));
    if (!ep) throw new AdmissionDenied("no_eligible_endpoint", "all fixture endpoints excluded");
    offered.push({ endpoint: ep.id, avoid: req.avoidEndpointIds ?? [], names: req.chat.tools?.map(tool => tool.function.name) ?? [] });
    used++;
    return { endpoint: ep, requestId: `request-${used}`, response: { message: { content: null, tool_calls: script(ep.id, used) }, finishReason: "tool_calls" } } as unknown as GateResponse;
  });
  const options: LoopOptions<string> = { env: { ctx, edits: new Set() } as HarnessEnv, executionId: "execution", messages: [], tools: [],
    terminal: { def: def("submit"), accept: async () => ({ ok: true, value: "done" }) }, maxTokens: 1000, inputBudget: 10_000, maxInvalidTerminal: 2 };
  return { options, ctx, endpoints, controller, offered, script, used: () => used };
}

it("hands a real native task to another free endpoint without losing work or physical request accounting", async () => {
  fixture = makeEnv({ config: baseConfig({ coding: { runner: "native" } }), endpoints: [endpoint({ gatewayModelId: "stall", totalParametersB: 550 }), endpoint({ gatewayModelId: "recover", totalParametersB: 200 })] });
  let stale = 0;
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (req.model === "stall") return reply(null, { ...served, toolCalls: [call("read_file", `read-${++stale}`, { path: "src/app.ts" })] });
    const written = req.messages.some(message => message.role === "tool" && message.content.includes("wrote src/recovered.ts"));
    return reply(null, { ...served, toolCalls: written ? [call("submit_result", "submit", goodOutput(1, "core:src/recovered.ts#L1-L1"))] : [call("write_file", "write", { path: "src/recovered.ts", content: "export const recovered = true;\n" })] });
  });
  sy = open(fixture, client, { worker: true, coding: createCodingRunner(fixture.cfg) });
  const [sub] = await sy.submitTasks([{ profile: "implement", label: "handoff", goal: "Write recovered.ts after fresh observations", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T3" }, budget: { maxModelRequests: 12 }, constraints: { allowedPaths: ["src/**"], acceptanceCriteria: ["recovered exists"] } }]);
  const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
  expect(result.executionStatus).toBe("completed");
  expect(result.usage.modelRequests).toBe(5);
  expect(client.requests.map(request => request.model)).toEqual(["stall", "stall", "stall", "recover", "recover"]);
  const workspace = sy.sessions.forTask(sub!.taskId).at(-1)!.workspace!.repos[0]!.worktree;
  expect(readFileSync(path.join(workspace, "src/recovered.ts"), "utf8")).toContain("recovered = true");
  expect(sy.tasks.events(sub!.taskId, 200).filter(event => event.type === "agent_endpoint_stalled")).toHaveLength(1);
}, 90_000);

it("bounds unchanged observation recovery by distinct endpoints rather than resetting the task", async () => {
  const f = await loopFixture();
  f.script.mockImplementation((_endpoint, n) => [call("read", `read-${n}`)]);
  f.options.tools = [tool("read", "read", async () => "unchanged")];
  expect(await runAgentLoop(f.options)).toMatchObject({ kind: "stalled", reason: "model_handoff_exhausted:repeated_tool_call:read" });
  expect(f.used()).toBe(6);
  expect(f.offered.map(request => request.endpoint)).toEqual([...Array(3).fill(f.endpoints[0]!.id), ...Array(3).fill(f.endpoints[1]!.id)]);
});

it.each([false, true])("keeps completed and uncertain effects deduplicated across handoffs (uncertain=%s)", async uncertain => {
  const f = await loopFixture(3);
  let effects = 0;
  f.options.tools = [tool("effect", "external", async () => { effects++; if (uncertain) throw new Error("acknowledgement lost"); return "effect completed"; })];
  f.script.mockImplementation((ep, n) => ep === f.endpoints[2]!.id ? [call("submit", `submit-${n}`)] : [call("effect", `effect-${n}`)]);
  expect((await runAgentLoop(f.options)).kind).toBe("terminal");
  expect(effects).toBe(1);
  expect(f.used()).toBe(4);
  expect(f.options.messages.filter(message => message.role === "tool" && message.content.includes("No action was repeated"))).toHaveLength(2);
});

it("keeps the original ceiling and terminal-only final request after a handoff", async () => {
  const f = await loopFixture(2, 4);
  let edits = 0;
  f.options.tools = [tool("read", "read", async () => "same"), tool("edit", "edit", async () => { edits++; return "edited"; })];
  f.script.mockImplementation((ep, n) => [call(ep === f.endpoints[0]!.id ? "read" : "edit", `call-${n}`)]);
  expect((await runAgentLoop(f.options)).kind).toBe("budget_exhausted");
  expect(f.used()).toBe(4); expect(edits).toBe(0);
  expect(f.offered.at(-1)!.names).toEqual(["submit"]);
});

it.each(["cancelled", "deadline"])("does not hand off after %s authority expires", async reason => {
  const f = await loopFixture();
  let reads = 0;
  f.options.tools = [tool("read", "read", async () => { if (++reads === 3) f.controller.abort(new Error(reason)); return "same"; })];
  f.script.mockImplementation((_ep, n) => [call("read", `call-${n}`)]);
  await expect(runAgentLoop(f.options)).rejects.toThrow(reason);
  expect(f.used()).toBe(3); expect(new StallHandoff(f.ctx).excluded.size).toBe(0);
});

it("does not turn a free-model stall into a paid route even when another plan candidate is priced", async () => {
  const f = await loopFixture();
  f.endpoints[1]!.pricing = { ...f.endpoints[1]!.pricing, inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
  f.options.tools = [tool("read", "read", async () => "same")];
  f.script.mockImplementation((_ep, n) => [call("read", `call-${n}`)]);
  expect((await runAgentLoop(f.options))).toMatchObject({ kind: "stalled", reason: "model_handoff_exhausted:repeated_tool_call:read" });
  expect(f.used()).toBe(3); expect(f.offered.every(request => request.endpoint === f.endpoints[0]!.id)).toBe(true);
});

it("restores typed exclusions despite unrelated events beyond ordinary timeline pagination", async () => {
  const f = await loopFixture();
  new StallHandoff(f.ctx).record(f.endpoints[0]!.id, "repeated_tool_call:read", "old-execution", "old-request");
  for (let n = 0; n < 600; n++) sy!.tasks.event(f.ctx.taskId, "unrelated", { n });
  f.script.mockImplementation((_ep, n) => [call("submit", `submit-${n}`)]);
  expect((await runAgentLoop(f.options)).kind).toBe("terminal");
  expect(f.offered[0]!.endpoint).toBe(f.endpoints[1]!.id);
  expect(f.offered[0]!.avoid).toContain(f.endpoints[0]!.id);
});

it("keeps the legacy finite stall when there is only one candidate", async () => {
  const f = await loopFixture(1);
  f.options.tools = [tool("read", "read", async () => "same")];
  f.script.mockImplementation((_ep, n) => [call("read", `call-${n}`)]);
  expect(await runAgentLoop(f.options)).toMatchObject({ kind: "stalled", reason: "repeated_tool_call:read" });
  expect(f.used()).toBe(3);
});

it.each(["no_eligible_endpoint", "context_does_not_fit"] as const)("stops without a new charge when Gate rejects the alternative: %s", async reason => {
  const f = await loopFixture();
  let reads = 0;
  f.options.tools = [tool("read", "read", async () => {
    if (++reads === 3) vi.mocked(requests.ask).mockRejectedValueOnce(new AdmissionDenied(reason, "no eligible fitting alternate"));
    return "same";
  })];
  f.script.mockImplementation((_ep, n) => [call("read", `call-${n}`)]);
  expect(await runAgentLoop(f.options)).toMatchObject({ kind: "stalled", reason: "model_handoff_exhausted:repeated_tool_call:read" });
  expect(f.used()).toBe(3);
});

it("restores endpoint exclusions AND completed effects after interruption during a handoff", async () => {
  const f = await loopFixture(3);
  let effects = 0;
  f.options.tools = [tool("effect", "external", async () => { effects++; return "completed"; })];
  f.script.mockImplementation((_ep, n) => [call("effect", `effect-${n}`)]);
  const original = f.ctx.tasks.event.bind(f.ctx.tasks);
  const event = vi.spyOn(f.ctx.tasks, "event").mockImplementation((task, type, data) => {
    original(task, type, data);
    if (type === "agent_endpoint_stalled") f.controller.abort(new Error("fixture restart"));
  });
  await expect(runAgentLoop(f.options)).rejects.toThrow("fixture restart");
  event.mockRestore();
  for (let n = 0; n < 600; n++) sy!.tasks.event(f.ctx.taskId, "later_noise", { n });
  f.ctx.signal = new AbortController().signal;
  vi.spyOn(resume, "applyResume").mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set() });
  f.options.resume = { plan: { lastEndpointId: f.endpoints[0]!.id }, actor: { agent: "fixture", role: "implementer" }, pointer: null } as unknown as NonNullable<LoopOptions<string>["resume"]>;
  f.script.mockImplementation((ep, n) => ep === f.endpoints[2]!.id ? [call("submit", `submit-${n}`)] : [call("effect", `effect-${n}`)]);
  expect((await runAgentLoop(f.options)).kind).toBe("terminal");
  expect(effects).toBe(1);
  expect(f.offered.slice(2).every(request => request.endpoint !== f.endpoints[0]!.id)).toBe(true);
  expect(f.used()).toBe(4);
});

it("fails closed on a malformed stored recovery receipt", async () => {
  const f = await loopFixture();
  sy!.tasks.event(f.ctx.taskId, "agent_endpoint_stalled", { endpointId: f.endpoints[0]!.id });
  await expect(runAgentLoop(f.options)).rejects.toThrow();
  expect(f.used()).toBe(0);
});

it.each(["abort", "lease"])("refuses a handoff receipt when %s authority ends during response commit", async condition => {
  const f = await loopFixture();
  let edits = 0;
  f.options.tools = [tool("edit", "edit", async (_args, env) => { edits++; env.edits.add("src/a.ts"); return "written"; })];
  f.script.mockImplementation((_ep, n) => [call("edit", `first-${n}`), call("edit", `repeat-${n}`)]);
  f.options.onResponse = async () => {
    await Promise.resolve();
    if (condition === "abort") f.controller.abort(new Error("authority ended during commit"));
    else vi.spyOn(f.ctx.tasks, "dispatchable").mockReturnValue(undefined);
  };
  await expect(runAgentLoop(f.options)).rejects.toThrow(condition === "abort" ? /authority ended during commit/ : /lease/);
  expect(f.used()).toBe(1); expect(edits).toBe(1);
  expect(sy!.tasks.events(f.ctx.taskId, 200).filter(event => event.type === "agent_endpoint_stalled")).toHaveLength(0);
});

it("refuses resumed handoff before pending-effect replay when real host compaction removed effect proof", async () => {
  const f = await loopFixture();
  for (const ep of f.endpoints) ep.contextLimitTokens = 2048;
  f.options.inputBudget = 500;
  let effects = 0;
  f.options.tools = [tool("effect", "external", async () => { effects++; return "effect completed " + "x".repeat(10_000); }), tool("read", "read", async args => args.step === "grow" ? "y".repeat(10_000) : "same")];
  f.script.mockImplementation((_ep, n) => n === 1 ? [call("effect", `call-${n}`)] : [call("read", `call-${n}`, { step: n === 2 ? "grow" : "stall" })]);
  const original = f.ctx.tasks.event.bind(f.ctx.tasks);
  const event = vi.spyOn(f.ctx.tasks, "event").mockImplementation((task, type, data) => {
    original(task, type, data);
    if (type === "agent_endpoint_stalled") f.controller.abort(new Error("fixture interruption"));
  });
  await expect(runAgentLoop(f.options)).rejects.toThrow("fixture interruption");
  event.mockRestore();
  const before = f.used();
  expect(before).toBe(5); expect(effects).toBe(1);
  expect(new StallHandoff(f.ctx).lostEffectHistory).toBe(true);
  const replay = vi.spyOn(resume, "applyResume").mockImplementation(async () => { effects++; return { kind: "continue", notAppliedToolIndexes: new Set() }; });
  f.ctx.signal = new AbortController().signal;
  f.options.resume = { plan: { lastEndpointId: f.endpoints[0]!.id }, actor: { agent: "fixture", role: "implementer" }, pointer: null } as unknown as NonNullable<LoopOptions<string>["resume"]>;
  await expect(runAgentLoop(f.options)).rejects.toMatchObject({ code: "model_handoff_unprovable_effect_history" });
  expect(replay).not.toHaveBeenCalled(); expect(f.used()).toBe(before); expect(effects).toBe(1);
});

it("does not reject a resumed handoff for read-only compaction with no protected effects", async () => {
  const f = await loopFixture();
  for (const ep of f.endpoints) ep.contextLimitTokens = 2048;
  f.options.inputBudget = 500;
  f.options.tools = [tool("read", "read", async () => "x".repeat(10_000))];
  f.script.mockImplementation((_ep, n) => [call("read", `call-${n}`)]);
  const original = f.ctx.tasks.event.bind(f.ctx.tasks);
  const event = vi.spyOn(f.ctx.tasks, "event").mockImplementation((task, type, data) => {
    original(task, type, data);
    if (type === "agent_endpoint_stalled") f.controller.abort(new Error("fixture interruption"));
  });
  await expect(runAgentLoop(f.options)).rejects.toThrow("fixture interruption");
  event.mockRestore();
  expect(new StallHandoff(f.ctx).lostEffectHistory).toBe(false);
  const replay = vi.spyOn(resume, "applyResume").mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set() });
  f.ctx.signal = new AbortController().signal;
  f.options.resume = { plan: { lastEndpointId: f.endpoints[0]!.id }, actor: { agent: "fixture", role: "inspector" }, pointer: null } as unknown as NonNullable<LoopOptions<string>["resume"]>;
  f.script.mockImplementation((_ep, n) => [call("submit", `submit-${n}`)]);
  expect((await runAgentLoop(f.options)).kind).toBe("terminal");
  expect(replay).toHaveBeenCalledOnce(); expect(f.used()).toBe(4);
});

it("rejects malformed authoritative compaction receipts before resume can replay anything", async () => {
  const f = await loopFixture();
  new StallHandoff(f.ctx).record(f.endpoints[0]!.id, "repeated_tool_call:read", "old-execution", "old-request");
  sy!.tasks.event(f.ctx.taskId, "agent_effect_history_compacted", { schemaVersion: 1 });
  const replay = vi.spyOn(resume, "applyResume").mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set() });
  f.options.resume = { plan: { lastEndpointId: f.endpoints[0]!.id }, actor: { agent: "fixture", role: "inspector" }, pointer: null } as unknown as NonNullable<LoopOptions<string>["resume"]>;
  await expect(runAgentLoop(f.options)).rejects.toThrow();
  expect(replay).not.toHaveBeenCalled(); expect(f.used()).toBe(0);
});

it("the actual native resumed runner cannot finalize checks or replay a pending command after lost effect history", async () => {
  fixture = makeEnv({ config: baseConfig({ coding: { runner: "native" } }), endpoints: [endpoint({ gatewayModelId: "first" }), endpoint({ gatewayModelId: "second", totalParametersB: 200 })] });
  const client = new ScriptedClient(() => { throw new Error("no model request authorized"); });
  sy = open(fixture, client, { worker: false });
  const command = 'node -e "require(\'fs\').writeFileSync(\'check-ran\',\'bad\')"';
  const [sub] = await sy.submitTasks([{ profile: "implement", goal: "Resume checked source safely", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, budget: { maxModelRequests: 12 }, constraints: { allowedPaths: ["src/**"], checks: [command], acceptanceCriteria: ["safe"] } }]);
  const id = sub!.taskId;
  sy.tasks.claim("fixture", { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60_000, defaultTimeoutMs: 3_600_000 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture!.repo, encoding: "utf8" }).trim();
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(fixture.repo, "src/kept.ts"), "export const kept = true;\n");
  commitAll(fixture.repo, "Retained changed source");
  const head = git("rev-parse", "HEAD");
  const session = sy.sessions.create({ taskId: id, jobId: null, role: "implementer", agentLabel: "fixture", profile: "implement", tier: "T2" });
  session.setWorkspace({ repos: [{ alias: "core", worktree: fixture.repo, baseCommit: base, head, branch: null }] });
  session.syncMessages([{ role: "user", content: "Resume retained source" }, { role: "assistant", content: null, tool_calls: [call("run_check", "pending-check", { command })] }]);
  session.toolIntent({ callId: "pending-check", name: "run_check", args: { command }, sideEffect: "command", idempotent: true });
  sy.tasks.event(id, "agent_endpoint_stalled", { schemaVersion: 1, endpointId: sy.catalog.endpoints()[0]!.id, reason: "repeated_tool_call:read", executionId: "earlier-execution", requestId: "earlier-request" });
  sy.tasks.event(id, "agent_effect_history_compacted", { schemaVersion: 1, executionId: "earlier-execution" });
  session.end("interrupted", "fixture interruption");
  expect(sy.sessions.planResume(session.id)!.actions).toContainEqual(expect.objectContaining({ kind: "rerun_tool", name: "run_check" }));
  sy.tasks.interrupt(id, "fixture", "fixture interruption");
  sy.resumeSession(session.id, "demo");
  await sy.close();
  sy = open(fixture, client, { worker: true, coding: createCodingRunner(fixture.cfg) });
  const result = (await sy.awaitResults([id], { timeoutSeconds: 30 })).completed[0]!;
  expect(result.executionStatus).toBe("failed");
  expect(result.stopReason).toContain("model_handoff_unprovable_effect_history");
  expect(client.requests).toHaveLength(0);
  expect(sy.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests WHERE task_id=?").get(id)).toEqual({ n: 0 });
  expect(existsSync(path.join(fixture.repo, "check-ran"))).toBe(false);
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(path.join(fixture.repo, "src/kept.ts"), "utf8")).toBe("export const kept = true;\n");
}, 45_000);

it("validates persisted lost-effect safety state before replay even when the current routing plan is empty", async () => {
  const f = await loopFixture();
  const handoff = new StallHandoff(f.ctx);
  handoff.record(f.endpoints[0]!.id, "repeated_tool_call:read", "previous", "previous-request");
  handoff.recordLostEffectHistory("previous");
  f.ctx.plan.candidates = [];
  const replay = vi.spyOn(resume, "applyResume").mockResolvedValue({ kind: "continue", notAppliedToolIndexes: new Set() });
  f.options.resume = { plan: { lastEndpointId: f.endpoints[0]!.id }, actor: { agent: "fixture", role: "inspector" }, pointer: null } as unknown as NonNullable<LoopOptions<string>["resume"]>;
  await expect(runAgentLoop(f.options)).rejects.toMatchObject({ code: "model_handoff_unprovable_effect_history" });
  expect(replay).not.toHaveBeenCalled(); expect(f.used()).toBe(0);
});
