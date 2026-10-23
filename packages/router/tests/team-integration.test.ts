import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import type { WorkerTask } from "../src/core/task.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { parseConfig } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { ChannelStore, CHANNEL_MAX_TEXT_CHARS } from "../src/storage/channel.js";
import { PlanNodeSchema, PlanStore, redundancyFor } from "../src/storage/plans.js";
import { SessionStore } from "../src/sessions/store.js";
import { carvesOf } from "../src/admission/admission.js";
import { channelTools } from "../src/harness/channel-tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { INTEGRATED_EVENT, integrationOf } from "../src/context/upstream.js";
import { INTEGRATION_RECORDED_EVENT, taskConfirmation } from "../src/verification/calibration.js";
import { sessionProgress, watchdogVerdict } from "../src/core/watchdog.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

/**
 * T2 integration: `plan_work` with sub-supervisor nodes and redundancy, the team channel only
 * inside a job with configured limits, calibration's own integration event, undo of a whole
 * sub-job, and the watchdog allowance of `integrate_task`.
 */

let env: Env | undefined;
let sy: MeritRouter | undefined;
let db: Db | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter((m) => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const goalOf = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.function.name);
const toolOutputs = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const check = `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

function teamConfig(extra: Record<string, unknown> = {}) {
  const cfg = baseConfig({ coding: { runner: "native" }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

function worker(req: ChatRequest) {
  const s = servedFor(sy!, req);
  if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n\nexport function add" })] });
  return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
}

const PARENT_GOAL = "Deliver subtract() through a planned sub-team";
const CHILD_GOAL = "Implement subtract() with your own planned worker";

describe("plan_work with sub-supervisors", () => {
  it("a supervise node goes through the delegate path (carve, branch fork, depth limit); undo by task on the sub-job reverts its workers' commits", async () => {
    // This fixture scripts nested team behavior, independently of provider AIMD slots.
    env = makeEnv({ config: teamConfig({ team: { provider_concurrency_enabled: false } }) });
    const parentScript = [
      () => [call("plan_work", { nodes: [{ label: "sub", profile: "supervise", goal: CHILD_GOAL, acceptance_criteria: ["subtract exists"], checks: [check] }], note: "one sub-team" })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("integrate_task", { task_id: "sub" })],
      () => [call("finish_job", { status: "completed", summary: "subtract delivered by the sub-team", verified: [{ claim: "subtract on the job branch", evidence: "job checks after integration" }], not_verified: [] })],
    ];
    const childScript = [
      // At depth 2 (team.max_depth 2) a plan's supervise node is refused like a delegated one.
      () => [call("plan_work", { nodes: [{ label: "deeper", profile: "supervise", goal: "nested further", acceptance_criteria: ["x"] }] })],
      () => [call("plan_work", { nodes: [{ label: "w1", profile: "implement", goal: "Add subtract(a, b) to src/app.ts", acceptance_criteria: ["subtract exists"], allowed_paths: ["src/**"], checks: [check], difficulty: "T2" }] })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("integrate_task", { task_id: "w1" })],
      () => [call("finish_job", { status: "completed", summary: "subtract added", verified: [{ claim: "subtract exists", evidence: "check" }], not_verified: [] })],
    ];
    const client = new ScriptedClient(async (req) => {
      if (!isSupervisor(req)) return worker(req);
      const script = goalOf(req).includes(CHILD_GOAL) ? childScript : parentScript;
      const calls = script[turns(req)]!();
      // await_tasks deliberately returns for pending operator actions. Do not advance
      // this fixed script into integration until the fixture operator finishes them.
      if (calls.some(tool => tool.function.name === "integrate_task")) {
        const jobId = /Job id: (\S+)/.exec(String(req.messages[0]!.content))![1]!;
        const label = JSON.parse(calls[0]!.function.arguments).task_id;
        const child = sy!.tasks.childrenOf(jobId).find(task => task.spec.label === label)!;
        const finished = await sy!.awaitResults([child.row.id], { timeoutSeconds: 120 });
        expect(finished.timedOut, JSON.stringify(finished.pending)).toBe(false);
      }
      return reply(null, { ...servedFor(sy!, req), toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: PARENT_GOAL, repositories: ["core"], checks: [check], label: "parent" });
    const awaited = await sy.awaitResults([job.taskId], { timeoutSeconds: 170 });
    expect(awaited.timedOut, JSON.stringify({ pending: awaited.pending, states: sy.listTasks(undefined, 50).map(({ taskId, state, stateReason, goal }) => ({ taskId, state, stateReason, goal })), actions: sy.db.prepare("SELECT task_id, json_extract(value_json,'$.status') AS status FROM worker_action_requests").all(), last: client.requests.slice(-8).map(request => ({ goal: String(request.messages[1]?.content).slice(0, 100), tools: request.messages.filter(message => message.role === "tool").slice(-3) })) }, null, 2)).toBe(false);
    const r = awaited.completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");

    const [child] = sy.tasks.childrenOf(job.taskId);
    expect(child!.spec).toMatchObject({ profile: "supervise", label: "sub", parentTaskId: job.taskId });
    expect(child!.result).toMatchObject({ stopReason: "supervisor_completed", acceptanceStatus: "met" });
    const [w1] = sy.tasks.childrenOf(child!.row.id);
    expect(w1!.spec).toMatchObject({ profile: "implement", label: "w1", parentTaskId: child!.row.id });

    // The plan records the supervise node; dispatching it carved the budget like delegate.
    expect(new PlanStore(sy.db).latest(job.taskId)!.nodes).toEqual([expect.objectContaining({ label: "sub", profile: "supervise", redundancy: 1 })]);
    expect(child!.spec.budget?.maxModelRequests).toBe(14);
    expect(carvesOf(sy.db, job.taskId)).toEqual([expect.objectContaining({ childTaskId: child!.row.id, requests: 14, parentRemaining: 29, depth: 2 })]);
    const parentReqs = client.requests.filter((q) => isSupervisor(q) && !goalOf(q).includes(CHILD_GOAL));
    const childReqs = client.requests.filter((q) => isSupervisor(q) && goalOf(q).includes(CHILD_GOAL));
    expect(toolOutputs(parentReqs.at(-1)!)[0]).toMatch(/plan v1 recorded: 1 node\(s\); 1 dispatched now[\s\S]*sub -> t_\w+ \(queued\); sub-supervisor with 14 requests on branch meritrouter\/job-t_/);

    // The sub-job's branch forks from the parent's.
    const parentBranch = `meritrouter/job-${job.taskId}`;
    const childBranch = `meritrouter/job-${child!.row.id}`;
    const parentWs = sy.sessions.forTask(job.taskId).at(-1)!.workspace!.repos[0]!;
    const parentBase = parentWs.baseCommit!;
    expect(child!.spec.context.baseCommits).toEqual({ core: parentBase });
    expect(gitOut(env.repo, "merge-base", childBranch, parentBranch).trim()).toBe(parentBase);

    // Depth: the sub-job's plan with a supervise node was refused and its version withdrawn.
    const childOut = toolOutputs(childReqs.at(-1)!);
    expect(childOut[0]).toMatch(/^error: deeper: sub-supervisors are limited to team.max_depth 2; this job is at depth 2/);
    expect(new PlanStore(sy.db).list(child!.row.id).map((p) => p.nodes.map((n) => n.label))).toEqual([["w1"]]);

    // The team channel: offered to the worker (its task is in a job).
    const w1Req = client.requests.find((q) => !isSupervisor(q))!;
    expect(toolNames(w1Req)).toEqual(expect.arrayContaining(["post_channel", "read_channel"]));

    // Integration events: dependents read `integrated`, calibration has its own event type.
    const events = sy.tasks.events(child!.row.id, 200);
    expect(events.find((e) => e.type === INTEGRATED_EVENT)!.data).toEqual({ repository: "core", branch: parentBranch, head: expect.any(String) });
    expect(events.find((e) => e.type === INTEGRATION_RECORDED_EVENT)!.data).toMatchObject({ jobId: job.taskId, repo: "core", commits: expect.any(Number) });
    expect(integrationOf(sy.tasks, child!.row.id)).toMatchObject({ repository: "core", branch: parentBranch });
    expect(integrationOf(sy.tasks, w1!.row.id)).toMatchObject({ repository: "core", branch: childBranch });

    // Undo by task on the sub-job: its commits carry w1's Task trailer, so the sub-job's tasks are resolved.
    const appBefore = readFileSync(path.join(parentWs.worktree, "src/app.ts"), "utf8");
    expect(appBefore).toContain("subtract");
    const st: SupervisorState = {
      ctx: { services: {}, taskId: job.taskId, cfg: sy.cfg, signal: new AbortController().signal, tasks: sy.tasks, artifacts: sy.artifacts } as unknown as RunContext,
      db: sy.db,
      actor: { agent: "supervisor:parent", role: "supervisor", model: null, job: job.taskId, task: job.taskId, tier: "T3" },
      repos: new Map([["core", { alias: "core", worktree: parentWs.worktree, branch: parentBranch, baseSha: parentBase }]]),
      briefChecks: new Set(),
      children: new Map([["sub", child!.row.id]]),
    };
    const undo = supervisorTools(st).find((t) => t.def.function.name === "undo")!;
    expect(await undo.run({ kind: "task", target: "sub", reason: "the sub-team's change is not wanted" }, {} as HarnessEnv)).toMatch(/^reverted 1 commit\(s\)/);
    expect(readFileSync(path.join(parentWs.worktree, "src/app.ts"), "utf8")).not.toContain("subtract");
    const undoLog = gitOut(parentWs.worktree, "log", "-1", "--format=%B");
    expect(undoLog).toMatch(/Reason: the sub-team's change is not wanted/);
    // Calibration: both the worker and the sub-job record the undo, and the sub-job is an escaped defect.
    expect(sy.tasks.events(w1!.row.id, 200).some((e) => e.type === "undone")).toBe(true);
    expect(sy.tasks.events(child!.row.id, 200).some((e) => e.type === "undone")).toBe(true);
    expect(taskConfirmation({ db: sy.db, tasks: sy.tasks, artifacts: sy.artifacts }, child!.row.id)).toMatchObject({ status: "escaped_defect" });
  }, 240_000);

  it("plan_work records and passes redundancy; a supervise node may not be redundant", async () => {
    // Plan node validation.
    const node = { label: "sub", profile: "supervise", goal: "g", acceptanceCriteria: ["x"], requiresAcceptedInputs: false, weight: 4 };
    expect(PlanNodeSchema.parse(node).profile).toBe("supervise");
    expect(() => PlanNodeSchema.parse({ ...node, redundancy: 2 })).toThrow(/redundancy is not for sub-supervisors/);

    // plan_work over a stubbed delegate service: the node's redundancy is recorded and read back at run time.
    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-team-int-"));
    db = openDatabase(tmp);
    const tasks = new TaskStore(db, () => 1_000_000);
    tasks.submit([{ id: "job", profile: "supervise", goal: "job", repositoryAliases: ["core"], context: {}, constraints: { acceptanceCriteria: ["x"] }, label: "job" } as WorkerTask]);
    const cfg = parseConfig(teamConfig(), path.join(tmp, "x.yaml"));
    const submitted: Array<Record<string, unknown>> = [];
    const services = {
      submitTasks: async (specs: Array<Record<string, unknown>>) => {
        submitted.push(...specs);
        tasks.submit(specs.map((sp) => ({ ...sp, context: {}, constraints: { acceptanceCriteria: ["x"] } })) as WorkerTask[]);
        return specs.map((sp) => ({ taskId: String(sp.id), state: "queued", deduplicated: false }));
      },
      getTask: (id: string) => {
        const t = tasks.get(id);
        return t ? { spec: t.spec, state: t.row.state, result: t.result } : null;
      },
    };
    const st: SupervisorState = {
      ctx: { services, taskId: "job", cfg, signal: new AbortController().signal, tasks, spec: tasks.get("job")!.spec, effort: "job-job", brain: null, session: null, now: () => 1_000_000 } as unknown as RunContext,
      db,
      actor: { agent: "supervisor:job", role: "supervisor", model: null, job: "job", task: "job", tier: "T3" },
      repos: new Map(),
      briefChecks: new Set(),
      children: new Map(),
    };
    const plan = supervisorTools(st).find((t) => t.def.function.name === "plan_work")!;
    const props = (plan.def.function.parameters as { properties: { nodes: { items: { properties: Record<string, { enum?: unknown[] }> } } } }).properties.nodes.items.properties;
    expect(props.redundancy!.enum).toEqual([1, 2]);
    expect(props.profile!.enum).toContain("supervise");
    const out = await plan.run(
      {
        nodes: [
          { label: "twice", profile: "summarize", goal: "Summarise the log", acceptance_criteria: ["mentions the error"], difficulty: "T1", redundancy: 2 },
          { label: "once", profile: "summarize", goal: "Summarise again", acceptance_criteria: ["x"], difficulty: "T1" },
        ],
      },
      { brain: undefined } as unknown as HarnessEnv,
    );
    expect(out).toMatch(/plan v1 recorded: 2 node\(s\); 2 dispatched now/);
    expect(new PlanStore(db).latest("job")!.nodes.map((n) => [n.label, n.redundancy])).toEqual([["twice", 2], ["once", 1]]);
    expect(redundancyFor(db, { parentTaskId: "job", label: "twice" })).toBe(2);
    expect(redundancyFor(db, { parentTaskId: "job", label: "once" })).toBe(1);
    expect(submitted.map((sp) => sp.label)).toEqual(["twice", "once"]);
  });
});

describe("team channel integration", () => {
  it("a task outside any job is not offered the channel tools", async () => {
    env = makeEnv();
    const client = new ScriptedClient((req) => reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] }));
    sy = open(env, client, { worker: true });
    const [t] = await sy.submitTasks([{ profile: "inspect", label: "find-add", goal: "Where is add() defined?", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } }]);
    await sy.awaitResults([t!.taskId], { timeoutSeconds: 60 });
    const names = toolNames(client.requests[0]!);
    expect(names).toEqual(expect.arrayContaining(["brain_search", "read_file"]));
    expect(names).not.toContain("post_channel");
    expect(names).not.toContain("read_channel");
  }, 60_000);

  it("post limits come from team.channel_max_*", async () => {
    expect(parseConfig(baseConfig(), path.join(tmpdir(), "x.yaml")).team).toMatchObject({ channel_max_posts_per_task: 10, channel_max_posts_per_supervisor: 40, channel_max_post_chars: CHANNEL_MAX_TEXT_CHARS });
    expect(() => parseConfig(baseConfig({ team: { channel_max_post_chars: CHANNEL_MAX_TEXT_CHARS + 1 } }), path.join(tmpdir(), "x.yaml"))).toThrow();
    const cfg = parseConfig(baseConfig({ team: { channel_max_posts_per_task: 2, channel_max_posts_per_supervisor: 3, channel_max_post_chars: 100 } }), path.join(tmpdir(), "x.yaml"));

    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-team-int-"));
    db = openDatabase(tmp);
    const tasks = new TaskStore(db, () => 1_000_000);
    const spec = (id: string, profile: string, parentTaskId?: string) => ({ id, profile, goal: id, repositoryAliases: ["core"], context: {}, constraints: { acceptanceCriteria: ["x"] }, label: id, ...(parentTaskId ? { parentTaskId } : {}) }) as WorkerTask;
    tasks.submit([spec("job", "supervise")]);
    tasks.submit([spec("a", "inspect", "job")]);
    const envFor = (taskId: string, role: string) => ({ role, ctx: { taskId, jobId: "job", tasks, cfg, now: () => 3_000_000, session: null, brain: null, spec: tasks.get(taskId)!.spec, tier: "T1" } }) as unknown as HarnessEnv;
    const [post] = channelTools();
    await expect(post!.run({ kind: "finding", text: "x".repeat(101) }, envFor("a", "inspector"))).rejects.toThrow(/longer than 100 characters \(team.channel_max_post_chars\)/);
    await post!.run({ kind: "finding", text: "one" }, envFor("a", "inspector"));
    await post!.run({ kind: "finding", text: "two" }, envFor("a", "inspector"));
    await expect(post!.run({ kind: "finding", text: "three" }, envFor("a", "inspector"))).rejects.toThrow(/post limit reached: 2 of 2/);
    for (const text of ["s1", "s2", "s3"]) await post!.run({ kind: "interface_contract", text }, envFor("job", "supervisor"));
    await expect(post!.run({ kind: "interface_contract", text: "s4" }, envFor("job", "supervisor"))).rejects.toThrow(/post limit reached: 3 of 3/);
    expect(new ChannelStore(db).list("job").length).toBe(5);
  });
});

describe("watchdog and integrate_task", () => {
  it("allows integrate_task one check timeout per job check (fake clock)", () => {
    let clock = 5_000_000;
    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-team-int-"));
    db = openDatabase(tmp);
    const sessions = new SessionStore(db, tmp, () => clock);
    const cfg = parseConfig(baseConfig({ execution: { watchdog_minutes: 10, check_timeout_seconds: 900 } }), path.join(tmp, "x.yaml"));
    const min = 60_000;
    const rec = sessions.create({ role: "supervisor", agentLabel: "supervisor:job" });
    clock += 1_000;
    rec.toolIntent({ callId: "c1", name: "integrate_task", args: { task_id: "w1" }, sideEffect: "edit" });
    const progress = sessionProgress(db, rec.id)!;
    expect(progress).toEqual({ at: clock, type: "tool_intent", name: "integrate_task" });
    const at = (idle: number, checks: number) => watchdogVerdict(cfg, progress, clock + idle, { checks });
    // Three job checks of 15 minutes each run inside the call: 45 minutes plus the margin.
    expect(at(40 * min, 3)).toMatchObject({ kind: "ok", allowanceMs: 46 * min, waitingOn: "tool integrate_task" });
    expect(at(46 * min, 3)).toMatchObject({ kind: "ok" });
    expect(at(46 * min + 1, 3)).toMatchObject({ kind: "stuck", idleMs: 46 * min + 1 });
    // No job checks: one check timeout, as for any running tool.
    expect(at(16 * min + 1, 0)).toMatchObject({ kind: "stuck", allowanceMs: 16 * min });
    // A job over two repositories runs its checks once per repository inside the call.
    expect(watchdogVerdict(cfg, progress, clock + 80 * min, { checks: 3, repositories: 2 })).toMatchObject({ kind: "ok", allowanceMs: 91 * min });
    // Other tools keep a single check timeout whatever the task's checks.
    const other = sessions.create({ role: "implementer", agentLabel: "implementer:w1" });
    other.toolIntent({ callId: "c2", name: "run_command", args: { command: "npm test" }, sideEffect: "command" });
    expect(watchdogVerdict(cfg, sessionProgress(db, other.id)!, clock + 40 * min, { checks: 3 })).toMatchObject({ kind: "stuck", allowanceMs: 16 * min });
    rec.end("completed", "test");
    other.end("completed", "test");
  });
});
