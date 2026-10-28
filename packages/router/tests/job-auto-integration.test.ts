import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
import { TaskStore, syntheticResult } from "../src/storage/tasks.js";
import { AWAITING_INTEGRATION, INTEGRATION_WAIT_MS, unintegratedAccepted } from "../src/storage/integration-obligations.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import * as supervisorToolModule from "../src/harness/supervisor-tools.js";
import { deliveryTools } from "../src/harness/delivery-tools.js";
import { integrationBlockers } from "../src/harness/integration-tools.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

/**
 * Gate-2 defect from live pilot 1: a supervisor accepted finished coding tasks but never called
 * integrate_task, so its job branch stayed empty and dependents were built in isolation. Accepted
 * coding results are now integrated by the runtime, dependents start from the branch with their
 * accepted upstreams, validation and a completed finish refuse unintegrated accepted work, and a
 * brief depending on a dead task is refused instead of failing over and over.
 */

let env: Env | undefined;
let sy: MeritRouter | undefined;
let db: Db | undefined;
let tmp: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
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
const userOf = (req: ChatRequest) => String(req.messages.find((m) => m.role === "user")?.content ?? "");
const toolOutputs = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

function teamConfig(extra: Record<string, unknown> = {}) {
  const cfg = baseConfig({ coding: { runner: "native" }, team: { provider_concurrency_enabled: false }, ...extra });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

const node = (label: string, fn: string, extra: Record<string, unknown> = {}) => ({
  label,
  profile: "implement",
  goal: `Add ${fn}(a, b) to src/app.ts`,
  acceptance_criteria: [`${fn} exists`],
  allowed_paths: ["src/**"],
  difficulty: "T2",
  ...extra,
});

describe("automatic integration of accepted coding tasks", () => {
  it("refuses completed finish when its integration drain creates a queued conflict replacement", async () => {
    env = makeEnv({ config: teamConfig() });
    let replacement = "";
    // Exercise the finish boundary with the same child-creation side effect as merge conflict
    // re-delegation; Git conflict mechanics are independent of this ordering regression.
    vi.spyOn(supervisorToolModule, "drainIntegrations").mockImplementation(async (state) => {
      if (replacement) return [];
      const [child] = await state.ctx.services!.submitTasks([{
        profile: "summarize", label: "conflict-redo", goal: "Redo conflicted integration",
        parentTaskId: state.ctx.taskId, repositoryAliases: [], dependsOn: [state.ctx.taskId],
        context: {}, constraints: { acceptanceCriteria: ["replacement integrated"] },
      }]);
      replacement = child!.taskId;
      state.children.set("conflict-redo", replacement);
      return ["conflict: re-delegated as conflict-redo"];
    });
    const client = new ScriptedClient((req) => {
      const served = servedFor(sy!, req);
      const step = turns(req);
      const calls = step === 0
        ? [call("finish_job", { status: "completed", summary: "candidate", verified: [{ claim: "done", evidence: "integration" }], not_verified: [] })]
        : step === 1 ? [call("cancel_tasks", { task_ids: ["conflict-redo"] })]
        : step === 2 ? [call("await_tasks", { timeout_seconds: 10 })]
        : [call("finish_job", { status: "blocked", summary: "replacement needs repair", verified: [], not_verified: ["conflicted work"] })];
      return reply(null, { ...served, toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Check finish integration ordering", repositories: ["core"] });
    const done = await sy.awaitResults([job.taskId], { timeoutSeconds: 90 });
    expect(done.timedOut).toBe(false);
    expect(done.completed[0]!.stopReason).toBe("supervisor_blocked");
    expect(client.requests.filter(isSupervisor).flatMap(toolOutputs).join("\n")).toContain("tasks still running:");
  }, 120_000);

  it("accept_task alone puts A then B on the job branch, and B starts from the branch with A", async () => {
    env = makeEnv({ config: teamConfig() });
    const script = [
      // B needs A's accepted result; neither has checks, so both end not_verified and need the supervisor.
      () => [call("plan_work", { nodes: [node("a", "subtract"), node("b", "multiply", { depends_on: ["a"], requires_accepted_inputs: true })], note: "a then b" })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("accept_task", { task_id: "a", reason: "read the patch: subtract is added as briefed" })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("accept_task", { task_id: "b", reason: "read the patch: multiply is added as briefed" })],
      () => [call("finish_job", { status: "completed", summary: "subtract and multiply delivered", verified: [{ claim: "both on the job branch", evidence: "accept_task integration results" }], not_verified: [] })],
    ];
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!() });
      const fn = /Add (\w+)\(a, b\)/.exec(userOf(req))![1]!;
      if (turns(req) === 0) return reply(null, { ...s, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: `export function ${fn}(a: number, b: number) {\n  return a;\n}\n\nexport function add` })] });
      return reply(null, { ...s, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Add subtract, then multiply on top of it", repositories: ["core"], label: "auto-int" });
    const done = await sy.awaitResults([job.taskId], { timeoutSeconds: 170 });
    expect(done.timedOut, JSON.stringify(sy.listTasks(undefined, 20).map(({ taskId, state, stateReason, goal }) => ({ taskId, state, stateReason, goal })))).toBe(false);
    const sup = client.requests.filter(isSupervisor).at(-1)!;
    const outputs = toolOutputs(sup);
    expect(done.completed[0]!.stopReason, outputs.join("\n---\n")).toBe("supervisor_completed");
    expect(outputs.filter((o) => o.startsWith("error:"))).toEqual([]);
    // The supervisor never called integrate_task.
    expect(client.requests.filter(isSupervisor).flatMap((q) => q.messages.flatMap((m) => (m as { tool_calls?: Array<{ function: { name: string } }> }).tool_calls ?? [])).map((c) => c.function.name)).not.toContain("integrate_task");

    const children = Object.fromEntries(sy.tasks.childrenOf(job.taskId).map((c) => [c.spec.label!, c]));
    const a = children.a!, b = children.b!;
    expect(outputs[2]).toMatch(new RegExp(`${a.row.id} accepted \\(acceptance met\\)[\\s\\S]*integration: integrated 1 commit\\(s\\) from ${a.row.id} onto meritrouter/job-${job.taskId}`));
    expect(outputs[4]).toMatch(new RegExp(`integration: integrated 1 commit\\(s\\) from ${b.row.id}`));

    // One integration per task, never two (the await drain and accept_task share the queue).
    const rows = sy.db.prepare("SELECT task_id, state, after_head FROM merge_queue WHERE job_id = ? ORDER BY created_at").all(job.taskId) as Array<{ task_id: string; state: string; after_head: string }>;
    expect(rows.map((r) => [r.task_id, r.state])).toEqual([[a.row.id, "integrated"], [b.row.id, "integrated"]]);
    expect(unintegratedAccepted(sy.db, job.taskId)).toEqual([]);

    // The job branch has A's commit, then B's, with their Task trailers.
    const branch = `meritrouter/job-${job.taskId}`;
    const base = String(sy.sessions.forTask(job.taskId).at(-1)!.workspace!.repos[0]!.baseCommit);
    const log = git(env.repo, "log", "--reverse", "--format=%B%x00", `${base}..${branch}`).split("\0").map((m) => m.trim()).filter(Boolean);
    const at = (id: string) => log.findIndex((m) => m.includes(`Task: ${id}`));
    expect(at(a.row.id)).toBeGreaterThanOrEqual(0);
    expect(at(b.row.id)).toBeGreaterThan(at(a.row.id));
    const app = git(env.repo, "show", `${branch}:src/app.ts`);
    expect(app).toContain("export function subtract");
    expect(app).toContain("export function multiply");

    // B's workspace was based on the job branch after A's integration (not the empty initial base).
    const bBase = (sy.db.prepare("SELECT base_sha FROM workspaces WHERE task_id = ?").get(b.row.id) as { base_sha: string }).base_sha;
    expect(bBase).toBe(rows[0]!.after_head);
    expect(git(env.repo, "show", `${bBase}:src/app.ts`)).toContain("export function subtract");
    const upstream = sy.tasks.events(b.row.id, 200).find((e) => e.type === "upstream_context")!.data as { baseCommits: Array<{ rule: string }> };
    expect(upstream.baseCommits[0]!.rule).toBe("job_branch");
  }, 200_000);
});

/** A planning-only stub supervisor over a temp store (no repository, no providers). */
function stubState(tasks: TaskStore, store: Db, cfg: ReturnType<typeof parseConfig>, children: Record<string, string>): SupervisorState {
  const services = {
    submitTasks: async (specs: Array<Record<string, unknown>>) => {
      tasks.submit(specs.map((sp) => ({ ...sp, context: {}, constraints: { acceptanceCriteria: ["x"] } })) as WorkerTask[], { project: cfg.brain.project });
      return specs.map((sp) => ({ taskId: String(sp.id), state: "queued", deduplicated: false }));
    },
    getTask: (id: string) => {
      const t = tasks.get(id);
      return t ? { spec: t.spec, state: t.row.state, result: t.result } : null;
    },
  };
  return {
    ctx: { services, taskId: "job", cfg, signal: new AbortController().signal, tasks, spec: tasks.get("job")!.spec, effort: "job-job", brain: null, session: null, now: () => 1_000_000 } as unknown as RunContext,
    db: store,
    actor: { agent: "supervisor:job", role: "supervisor", model: null, job: "job", task: "job", tier: "T3" },
    repos: new Map(),
    briefChecks: new Set(),
    children: new Map(Object.entries(children)),
  };
}

const spec = (id: string, profile: string, extra: Record<string, unknown> = {}) =>
  ({ id, profile, goal: id, label: id, repositoryAliases: [], context: {}, constraints: { acceptanceCriteria: ["x"] }, ...extra }) as unknown as WorkerTask;

function finish(store: Db, id: string, state: string, patch: Record<string, unknown>, at: number): void {
  const result = { ...syntheticResult(id, state === "completed" ? "completed" : "failed", "fixture"), ...patch };
  store.prepare("UPDATE tasks SET state = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?").run(state, JSON.stringify(result), at, at, id);
}

describe("integration obligations in the store", () => {
  it("a dependent keeps waiting for an accepted upstream's integration; validation is refused until it is on the branch", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-auto-int-"));
    db = openDatabase(tmp);
    let clock = 10_000_000;
    const tasks = new TaskStore(db, () => clock);
    const cfg = parseConfig(teamConfig({ repositories: {} }), path.join(tmp, "x.yaml"));
    const project = cfg.brain.project;
    tasks.submit([spec("job", "supervise")], { project });
    tasks.submit([spec("a", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"] })], { project });
    tasks.submit([spec("b", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"], dependsOn: ["a"] })], { project });
    finish(db, "a", "completed", { acceptanceStatus: "met", patchRefs: ["artifact:a-patch"], changedPaths: ["src/app.ts"] }, clock);
    db.prepare("INSERT INTO workspaces (task_id, repo_alias, source_path, worktree_path, base_sha, source_dirty, dirty_paths_json, status, created_at, updated_at) VALUES ('a', 'core', 'x', 'y', ?, 0, '[]', 'collected', ?, ?)").run("0".repeat(40), clock, clock);
    const limits = { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 30_000, defaultTimeoutMs: 60_000 };

    // Accepted and not integrated: the dependent waits, with a reason and an event.
    tasks.claim("w", limits);
    const waiting = tasks.get("b")!;
    expect(waiting.row.state).toBe("waiting_for_dependencies");
    expect(waiting.row.state_reason).toBe(`${AWAITING_INTEGRATION}:a`);
    expect(tasks.events("b").map((e) => e.type)).toContain("dependency_awaiting_integration");

    // Validation and handoff are refused while it is owed; earlier stages are not.
    expect(integrationBlockers(db, "job")).toEqual([expect.stringMatching(/^a \(a, core\): accepted but not integrated; call integrate_task/)]);
    db.prepare("INSERT INTO product_deliveries (task_id, project_id, stage, spec_json, evidence_json, updated_at) VALUES ('job', ?, 'integrate', '{}', '[]', ?)").run(project, clock);
    const advance = deliveryTools([]).find((t) => t.def.function.name === "advance_delivery_stage")!;
    const denv = { ctx: { tasks, taskId: "job", cfg } } as unknown as HarnessEnv;
    await expect(advance.run({ stage: "validate" }, denv)).rejects.toThrow(/integration_required: cannot advance to validate while 1 accepted coding task\(s\) are not on the job branch:\n- a \(a, core\)/);

    // A long wait remains blocked: elapsed time cannot put the upstream on the job branch.
    clock += INTEGRATION_WAIT_MS + 1;
    tasks.claim("w", limits);
    expect(tasks.get("b")!.row.state).toBe("waiting_for_dependencies");
    expect(tasks.events("b").map((e) => e.type)).toContain("dependency_integration_wait_expired");

    // Once integrated through the merge queue, nothing blocks and validation may begin.
    db.prepare(`INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_base, source_head, commits_json, state, after_head, created_at, updated_at)
      VALUES ('m1', 'job', 'a', 'task', 'core', 'meritrouter/job-job', 'k', 'w', ?, ?, '[]', 'integrated', ?, ?, ?)`).run("0".repeat(40), "1".repeat(40), "1".repeat(40), clock, clock);
    expect(integrationBlockers(db, "job")).toEqual([]);
    expect(await advance.run({ stage: "validate" }, denv)).toBe(JSON.stringify({ stage: "validate" }));
    // A later dependent of the integrated upstream starts at once.
    tasks.submit([spec("c", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"], dependsOn: ["a"] })], { project });
    tasks.claim("w", limits);
    expect(tasks.get("c")!.row.state).not.toBe("waiting_for_dependencies");
    expect(tasks.events("c").map((e) => e.type)).not.toContain("dependency_awaiting_integration");
  });
});

describe("failed integration obligations", () => {
  it.each(["conflict", "refused", "failed", "redelegated"])("keeps dependents and completion blocked after %s", (standing) => {
    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-auto-int-failure-"));
    db = openDatabase(tmp);
    const clock = 10_000_000;
    const tasks = new TaskStore(db, () => clock);
    tasks.submit([spec("job", "supervise")]);
    tasks.submit([spec("a", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"] })]);
    tasks.submit([spec("b", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"], dependsOn: ["a"] })]);
    finish(db, "a", "completed", { acceptanceStatus: "met", patchRefs: ["artifact:a"], changedPaths: ["src/app.ts"] }, clock);
    db.prepare("INSERT INTO workspaces (task_id, repo_alias, source_path, worktree_path, base_sha, source_dirty, dirty_paths_json, status, created_at, updated_at) VALUES ('a', 'core', 'x', 'y', ?, 0, '[]', 'collected', ?, ?)").run("0".repeat(40), clock, clock);
    db.prepare(`INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_base, source_head, commits_json, state, redelegated_to, created_at, updated_at)
      VALUES ('m1', 'job', 'a', 'task', 'core', 'meritrouter/job-job', 'k', 'w', ?, ?, '[]', ?, ?, ?, ?)`).run("0".repeat(40), "1".repeat(40), standing, standing === "redelegated" ? "redo" : null, clock, clock);
    if (standing === "redelegated") {
      tasks.submit([spec("redo", "implement", { parentTaskId: "job", writableRepository: "core", repositoryAliases: ["core"] })]);
      finish(db, "redo", "failed", { acceptanceStatus: "unmet" }, clock);
    }
    tasks.claim("w", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 30_000, defaultTimeoutMs: 60_000 });
    expect(tasks.get("b")!.row.state).toBe("waiting_for_dependencies");
    expect(tasks.get("b")!.row.state_reason).toBe(`${AWAITING_INTEGRATION}:a`);
    expect(unintegratedAccepted(db, "job").map(i => i.taskId)).toEqual(["a"]);

    if (standing === "redelegated") {
      // Only an actually integrated replacement discharges the original obligation.
      finish(db, "redo", "completed", { acceptanceStatus: "met" }, clock);
      db.prepare(`INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_base, source_head, commits_json, state, created_at, updated_at)
        VALUES ('m2', 'job', 'redo', 'task', 'core', 'meritrouter/job-job', 'k', 'w', ?, ?, '[]', 'integrated', ?, ?)`).run("0".repeat(40), "1".repeat(40), clock, clock);
      expect(unintegratedAccepted(db, "job")).toEqual([]);
      tasks.claim("w", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 30_000, defaultTimeoutMs: 60_000 });
      // Original dependent specs must not read the obsolete source: redo has its own receipt.
      expect(tasks.get("b")!.row.state).toBe("waiting_for_dependencies");
      tasks.submit([spec("fresh-dependent", "summarize", { parentTaskId: "job", repositoryAliases: ["core"], dependsOn: ["redo"] })]);
      tasks.claim("w", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 30_000, defaultTimeoutMs: 60_000 });
      expect(tasks.get("fresh-dependent")!.row.state).not.toBe("waiting_for_dependencies");
    }
  });
});

describe("delegating against a dead dependency", () => {
  it("is refused with what to do instead; a completed repair stands in for the dead task", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "meritrouter-auto-int-"));
    db = openDatabase(tmp);
    const tasks = new TaskStore(db, () => 1_000_000);
    const cfg = parseConfig(teamConfig({ repositories: {} }), path.join(tmp, "x.yaml"));
    const project = cfg.brain.project;
    tasks.submit([spec("job", "supervise")], { project });
    tasks.submit([spec("tests-id", "summarize", { parentTaskId: "job", label: "tests" })], { project });
    finish(db, "tests-id", "budget_exhausted", { executionStatus: "budget_exhausted", stopReason: "task request budget exhausted" }, 1_000_000);
    const st = stubState(tasks, db, cfg, { tests: "tests-id" });
    const delegate = supervisorTools(st).find((t) => t.def.function.name === "delegate")!;
    const review = { label: "review", profile: "summarize", goal: "Review the tests", acceptance_criteria: ["reviewed"], difficulty: "T1", depends_on: ["tests"] };
    const noBrain = { brain: undefined } as unknown as HarnessEnv;

    await expect(delegate.run({ tasks: [review] }, noBrain)).rejects.toThrow(/refused: review depends on tests \(tests-id\), which ended budget_exhausted \(task request budget exhausted\); a task depending on it would fail at once \(dependency_failed\)[\s\S]*Redo tests first under a new label[\s\S]*request_more_budget/);
    expect(tasks.childrenOf("job").map((c) => c.spec.label)).toEqual(["tests"]);
    // Re-delegating the same refused brief keeps being refused (nothing new dispatched).
    await expect(delegate.run({ tasks: [review] }, noBrain)).rejects.toThrow(/refused: review depends on tests/);

    // A completed repair of the dead task supersedes it: the dependent waits for the repair.
    const commit = "a".repeat(40);
    tasks.submit([spec("redo-id", "summarize", { parentTaskId: "job", label: "tests-redo", context: { repairSource: { taskId: "tests-id", project, alias: "core", base: commit, head: commit, tree: commit, commits: [commit] } } })], { project });
    finish(db, "redo-id", "completed", { executionStatus: "completed", acceptanceStatus: "met" }, 1_000_000);
    st.children.set("tests-redo", "redo-id");
    const out = await delegate.run({ tasks: [review] }, noBrain);
    expect(out).toMatch(/note: review depends on tests, which ended budget_exhausted; it waits for its completed repair tests-redo \(redo-id\) instead/);
    const dispatched = tasks.childrenOf("job").find((c) => c.spec.label === "review")!;
    expect(dispatched.spec.dependsOn).toEqual(["redo-id"]);
  });
});
