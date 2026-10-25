import { afterEach, describe, expect, it, vi } from "vitest";
import { baseConfig, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { assertPlannedBriefs, assertSupervisorTool, supervisorToolPolicy, SUPERVISOR_DISCOVERY_REQUESTS } from "../src/harness/supervisor-lifecycle.js";
import { PlanStore } from "../src/storage/plans.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { productDigest } from "../src/verification/product-spec.js";
import { jobPlan } from "../src/admin/job-plans.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); env?.cleanup(); sy = undefined; env = undefined; });
const goal = "Deliver a usable isolated fixture";
const specification = { schemaVersion: 1, id: "fixture", revision: 1, source: { ref: "fixture", digest: productDigest(goal) }, originalInstruction: goal, ownerId: "initiator", users: ["operator"], platforms: ["browser"], workflows: ["open fixture"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [], criteria: [{ id: "usable", priority: "required", behavior: "Fixture opens", applicability: { status: "applicable" }, requiredEvidence: ["journey"] }] };
const brief = { label: "inspect", profile: "inspect", goal: "Inspect the fixture", acceptance_criteria: ["Report fixture contents"], repositories: ["core"], difficulty: "T1" };
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

async function fixture(version: 2 | undefined = 2) {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" } } } });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const [task] = await sy.submitTasks([{ profile: "supervise", deliveryVersion: version, goal, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Fixture opens"] } }]);
  const services = { submitTasks: sy.submitTasks.bind(sy), getTask: (id: string) => { const task = sy!.tasks.get(id); return task ? { spec: task.spec, state: task.row.state, result: task.result } : null; } };
  const ctx = { taskId: task!.taskId, spec: sy.tasks.get(task!.taskId)!.spec, tasks: sy.tasks, cfg: sy.cfg, gate: sy.gate, services, now: Date.now, signal: new AbortController().signal, budget: { maxModelRequests: 40 }, artifacts: sy.artifacts } as unknown as RunContext;
  const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:fixture", role: "supervisor", task: ctx.taskId, job: ctx.taskId }, repos: new Map([["core", { alias: "core", worktree: env.repo, branch: "fixture", baseSha: "a".repeat(40) }]]), briefChecks: new Set(), children: new Map() };
  const harness = { ctx, role: "supervisor", readers: new Map(), edits: new Set() } as unknown as HarnessEnv;
  const tools = supervisorTools(state);
  const store = new ProductDeliveries(sy.db);
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.def.function.name === name)!;
    assertSupervisorTool(ctx, tool, args);
    return tool.run(args, harness);
  };
  const prepare = () => { store.saveSpec(ctx.taskId, "demo", specification); store.transition(ctx.taskId, "demo", "prepare"); store.transition(ctx.taskId, "demo", "plan"); };
  return { ctx, state, run, prepare, store };
}

describe("supervisor lifecycle enforcement", () => {
  it("publishes draft nodes through the actual plan view without staffing, workers, or approvals", async () => {
    const { ctx, run, prepare, store } = await fixture();
    prepare();
    expect(() => store.transition(ctx.taskId, "demo", "implement")).toThrow(/plan_work/);
    const before = sy!.gate.admission.taskTotals(ctx.taskId).requests;
    await expect(run("plan_work", { nodes: [brief], dispatch: false })).resolves.toContain("0 dispatched now (draft");
    expect(sy!.gate.admission.taskTotals(ctx.taskId).requests).toBe(before);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
    expect(jobPlan(sy!, ctx.taskId)?.nodes).toEqual([expect.objectContaining({ label: "inspect", taskId: null, state: "not_dispatched" })]);
    expect(() => store.transition(ctx.taskId, "demo", "implement")).not.toThrow();
    await expect(run("plan_work", { nodes: [brief] })).resolves.toContain("1 dispatched now");
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
  });

  it("validates draft scopes and graphs before persistence or dispatch", async () => {
    const { ctx, run } = await fixture();
    for (const nodes of [[{ ...brief, repositories: ["foreign"] }], [{ ...brief, max_requests: -1 }], [{ ...brief, profile: "implement", allowed_paths: [] }], [{ ...brief, depends_on: ["missing"] }], [brief, brief]]) {
      await expect(run("plan_work", { nodes, dispatch: false })).rejects.toThrow();
      expect(new PlanStore(sy!.db).latest(ctx.taskId)).toBeNull();
      expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    }
  });

  it("rejects direct and nested host commands and inspect-with-check before a real plan", async () => {
    const { ctx } = await fixture();
    const tool = (name: string, sideEffect: HarnessTool["sideEffect"] = "read") => ({ def: { type: "function", function: { name, parameters: {} } }, sideEffect } as HarnessTool);
    expect(() => assertSupervisorTool(ctx, tool("run_check", "command"), { command: "node --version" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("batch", "command"), { items: [{ operation: "run_recipe", args: { id: "check:1" } }] })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("delegate", "delegate"), { tasks: [{ ...brief, checks: ["node --version"] }] })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("delegate", "delegate"), { tasks: [brief] })).not.toThrow();
    expect(() => assertSupervisorTool(ctx, tool("batch", "command"), { items: [{ operation: "list_paths", args: {} }] })).not.toThrow();
    for (const name of ["lab_check", "lab_restart", "lab_promote"]) expect(() => assertSupervisorTool(ctx, tool(name, "external"), {})).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("integrate_task", "edit"), { task_id: "old-child" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("lab_http", "external"), { method: "POST" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("lab_http", "external"), { method: "GET" })).not.toThrow();
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
  });

  it("preserves encoded arrays while rejecting malformed strings and encoded command bypasses before effects", async () => {
    const { ctx, run, prepare } = await fixture();
    await expect(run("delegate", { tasks: JSON.stringify([{ ...brief, checks: ["node --version"] }]) })).rejects.toThrow(/delivery_plan_required/);
    const invalid = ["[", '[{}] trailing note', '{"label":"not-an-array"}', '[null]', '[1]'];
    for (const value of invalid) {
      await expect(run("plan_work", { nodes: value, dispatch: false })).rejects.toThrow(/nodes must be (a JSON array|an array) of objects/);
      await expect(run("delegate", { tasks: value })).rejects.toThrow(/tasks must be (a JSON array|an array) of objects/);
      expect(new PlanStore(sy!.db).latest(ctx.taskId)).toBeNull();
      expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    }
    prepare();
    await expect(run("plan_work", { nodes: JSON.stringify([brief]), dispatch: false })).resolves.toContain("0 dispatched now (draft");
    await expect(run("delegate", { tasks: JSON.stringify([brief]) })).resolves.toContain("inspect ->");
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
  });

  it("matches actual execution and review briefs to recorded plan nodes", async () => {
    const { ctx, run } = await fixture();
    const implementation = { ...brief, label: "implement", profile: "implement", allowed_paths: ["src/**"] };
    await run("plan_work", { dispatch: false, nodes: [implementation, brief] });
    expect(() => assertPlannedBriefs(ctx, [implementation, brief], "core")).not.toThrow();
    for (const patch of [{ goal: "Another task" }, { allowed_paths: ["**"] }, { checks: ["npm install"] }, { lab_checks: ["runtime"] }, { depends_on: ["inspect"] }, { acceptance_criteria: ["Weaker"] }, { writable_repository: "foreign" }]) {
      expect(() => assertPlannedBriefs(ctx, [{ ...implementation, ...patch }], "core")).toThrow(/plan_conflict/);
    }
    expect(() => assertPlannedBriefs(ctx, [{ ...brief, label: "unplanned-review" }], "core")).toThrow(/plan_required/);
  });

  it("bounds discovery using task-wide requests across reopened runner instances", async () => {
    const { ctx, prepare, run } = await fixture();
    vi.spyOn(ctx.gate.admission, "taskTotals").mockReturnValue({ requests: SUPERVISOR_DISCOVERY_REQUESTS } as ReturnType<typeof ctx.gate.admission.taskTotals>);
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).not.toContain("read_files");
    expect(supervisorToolPolicy({ ...ctx })?.allowedToolNames).toContain("set_delivery_spec");
    prepare();
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).toContain("plan_work");
    await run("plan_work", { nodes: [brief], dispatch: false });
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).not.toContain("read_files");
    await run("plan_work", { nodes: [brief] });
    expect(supervisorToolPolicy(ctx)).toBeNull();
  });

  it("preserves non-v2 legacy direct dispatch and tool behavior", async () => {
    const { ctx, run, prepare, store } = await fixture(undefined);
    // Explicitly remove the version; fixture's default parameter otherwise selects v2.
    delete ctx.spec.deliveryVersion;
    sy!.db.prepare("UPDATE tasks SET spec_json=json_remove(spec_json,'$.deliveryVersion') WHERE id=?").run(ctx.taskId);
    expect(supervisorToolPolicy(ctx)).toBeNull();
    expect(() => assertPlannedBriefs(ctx, [{ ...brief, profile: "implement" }], "core")).not.toThrow();
    prepare();
    expect(() => store.transition(ctx.taskId, "demo", "implement")).not.toThrow();
    await expect(run("plan_work", { nodes: [brief] })).resolves.toContain("1 dispatched now");
  });
});

it.each([[false, false], [false, true], [true, false]])("runs the real supervisor with no pre-plan host effects (blocked %s, encoded arrays %s)", async (immediateBlocked, encoded) => {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, client_supervision: {}, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" } } } });
  let turn = 0;
  const script = [
    [call("run_check", { command: "node --version" }), call("batch", { items: [{ id: "files", operation: "list_paths", args: {} }] }, "read-batch"), call("batch", { items: [{ id: "host", operation: "run_recipe", args: { id: "check:1" } }] }, "host-batch"), call("delegate", { tasks: [{ ...brief, checks: ["node --version"] }] })],
    [call("set_delivery_spec", { spec: specification }), call("advance_delivery_stage", { stage: "prepare" }, "prepare"), call("advance_delivery_stage", { stage: "plan" }, "plan")],
    [call("plan_work", { nodes: encoded ? JSON.stringify([brief]) : [brief], dispatch: false })],
    encoded ? [call("delegate", { tasks: JSON.stringify([brief]) })] : [call("plan_work", { nodes: [brief] })],
    [call("await_tasks", { timeout_seconds: 30 })],
    [call("finish_job", { status: "blocked", summary: "Planning/dispatch fixture complete; product not implemented", verified: [{ claim: "Planned inspection ran", evidence: "await_tasks observed child result" }], not_verified: ["Usable product"], follow_up: "Implement product" })],
  ];
  if (immediateBlocked) script.splice(1, script.length - 1, [call("finish_job", { status: "blocked", summary: "Explicit prerequisite blocker", verified: [], not_verified: ["Product"], follow_up: "Resolve prerequisite" })]);
  const client = new ScriptedClient(req => {
    if (String(req.messages[0]?.content).startsWith("# Supervisor charter")) return reply(null, { ...servedFor(sy!, req), toolCalls: script[turn++]! });
    const workerTurn = req.messages.filter(message => message.role === "assistant").length;
    return reply(null, { ...servedFor(sy!, req), toolCalls: workerTurn === 0 ? [call("read_file", { path: "README.md" })] : [call("submit_result", { summary: "Fixture inspected", findings: [], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:README.md#L1"] }] })] });
  });
  sy = open(env, client, { worker: true });
  const job = await sy.startJob({ goal, repositories: ["core"], checks: ["node --version"] });
  const result = (await sy.awaitResults([job.taskId], { timeoutSeconds: 70 })).completed[0];
  expect(result, JSON.stringify(client.requests.at(-1)?.messages)).toMatchObject({ stopReason: "supervisor_blocked" });
  expect(turn).toBe(immediateBlocked ? 2 : 6);
  expect(new PlanStore(sy.db).list(job.taskId)).toHaveLength(immediateBlocked ? 0 : encoded ? 1 : 2);
  expect(sy.tasks.childrenOf(job.taskId)).toHaveLength(immediateBlocked ? 0 : 1);
  if (!immediateBlocked) expect(sy.tasks.childrenOf(job.taskId)[0]!.row.state).toBe("completed");
  const toolMessages = client.requests.filter(req => String(req.messages[0]?.content).startsWith("# Supervisor charter")).at(-1)!.messages.filter(message => message.role === "tool");
  expect(toolMessages.find(message => message.tool_call_id === "read-batch")?.content).toContain('"status":"succeeded"');
  expect(toolMessages.find(message => message.tool_call_id === "host-batch")?.content).toContain("delivery_plan_required");
  expect(sy.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
}, 90_000);
