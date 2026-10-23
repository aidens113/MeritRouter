import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import type { WorkerResult, WorkerTask } from "../src/core/task.js";
import { maxAgentsPerJob } from "../src/config/schema.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore, syntheticResult, type ClaimLimits } from "../src/storage/tasks.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { FileLeaseStore, globsOverlap } from "../src/storage/file-leases.js";
import { PlanStore, assertPlanGraph, criticalPath, type PlanNodeInput } from "../src/storage/plans.js";
import { INTEGRATED_EVENT, UPSTREAM_CONTEXT_EVENT, withUpstreamContext } from "../src/context/upstream.js";
import { loadSources, renderSources } from "../src/context/sources.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A plan node with the defaults plan_work fills in. */
function node(label: string, dependsOn: string[] = [], over: Partial<PlanNodeInput> = {}): PlanNodeInput & { dependsOn: string[]; weight: number } {
  return { label, profile: "inspect", goal: `do ${label}`, acceptanceCriteria: ["x"], requiresAcceptedInputs: false, weight: 1, ...over, dependsOn: over.dependsOn ?? dependsOn };
}

describe("plan graph", () => {
  it("computes the critical path of a diamond by tier weight", () => {
    // a (T1) -> b (T3) -> d (T1); a -> c (T2) -> d
    const nodes = [node("a", [], { weight: 1 }), node("b", ["a"], { weight: 4 }), node("c", ["a"], { weight: 2 }), node("d", ["b", "c"], { weight: 1 })];
    expect(criticalPath(nodes)).toEqual({ labels: ["a", "b", "d"], cost: 6 });
    // Make the other branch heavier: the path follows it.
    const heavier = nodes.map((n) => (n.label === "c" ? { ...n, weight: 8 } : n));
    expect(criticalPath(heavier)).toEqual({ labels: ["a", "c", "d"], cost: 10 });
    // Dependencies outside the plan (tasks dispatched earlier) count as done.
    expect(criticalPath([node("x", ["earlier"], { weight: 2 })])).toEqual({ labels: ["x"], cost: 2 });
    expect(criticalPath([])).toEqual({ labels: [], cost: 0 });
  });

  it("rejects cycles, unknown dependencies, and duplicate labels", () => {
    expect(() => assertPlanGraph([node("a", ["b"]), node("b", ["a"])], new Set())).toThrow(/cycle: a -> b -> a/);
    expect(() => assertPlanGraph([node("a", ["ghost"])], new Set())).toThrow(/depends on ghost/);
    expect(() => assertPlanGraph([node("a", ["earlier"])], new Set(["earlier"]))).not.toThrow();
    expect(() => assertPlanGraph([node("a"), node("a")], new Set())).toThrow(/more than once/);
    expect(globsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
    expect(globsOverlap(["src/**"], ["src/b/x.ts"])).toBe(true);
  });

  it("team.max_agents defaults to 8 and accepts supervisor.max_workers_per_job as an alias", () => {
    env = makeEnv();
    expect(maxAgentsPerJob(env.cfg)).toBe(8);
    expect(maxAgentsPerJob({ team: {}, supervisor: { max_workers_per_job: 3 } })).toBe(3);
    expect(maxAgentsPerJob({ team: { max_agents: 5 }, supervisor: { max_workers_per_job: 3 } })).toBe(5);
  });
});

// ---------- the task store: file leases, per-job cap, accepted inputs ----------

function store(): { tasks: TaskStore; clock: { now: number } } {
  tmp = mkdtempSync(path.join(tmpdir(), "switchyard-team-"));
  db = openDatabase(tmp);
  const clock = { now: 1_000_000 };
  return { tasks: new TaskStore(db, () => clock.now), clock };
}

const LIMITS: ClaimLimits = { maxConcurrent: 20, maxWritersPerRepo: 10, leaseMs: 60_000, defaultTimeoutMs: 600_000, maxAgentsPerJob: 10 };

function coding(id: string, allowedPaths: string[] | undefined, extra: Partial<WorkerTask> = {}): WorkerTask {
  return {
    id,
    profile: "implement",
    goal: `edit ${id}`,
    repositoryAliases: ["core"],
    writableRepository: "core",
    context: {},
    constraints: { acceptanceCriteria: ["x"], ...(allowedPaths ? { allowedPaths } : {}) },
    parentTaskId: "job",
    ...extra,
  } as WorkerTask;
}

function inspect(id: string, extra: Partial<WorkerTask> = {}): WorkerTask {
  return { id, profile: "inspect", goal: `look at ${id}`, repositoryAliases: ["core"], context: {}, constraints: { acceptanceCriteria: ["x"] }, ...extra } as WorkerTask;
}

const done = (id: string, acceptanceStatus: WorkerResult["acceptanceStatus"]): WorkerResult => ({ ...syntheticResult(id, "completed", "done"), acceptanceStatus, summary: `summary of ${id}` });
const claimedIds = (tasks: TaskStore, limits: ClaimLimits = LIMITS) => tasks.claim("w", limits).map((t) => t.row.id).sort();

describe("team-wide file leases", () => {
  it("overlapping write globs never run at the same time; disjoint ones do", () => {
    const { tasks } = store();
    tasks.submit([coding("a", ["src/**"]), coding("b", ["src/app.ts"]), coding("c", ["docs/**"]), coding("d", undefined)]);
    // a takes src/**; b overlaps it; c is disjoint; d (no allowed paths = whole repo) overlaps both.
    expect(claimedIds(tasks)).toEqual(["a", "c"]);
    expect(tasks.get("b")!.row.state_reason).toBe("waiting_for_file_lease:a");
    expect(tasks.events("b").filter((e) => e.type === "waiting_for_file_lease")).toHaveLength(1);
    // Repeated claim passes do not repeat the event.
    expect(claimedIds(tasks)).toEqual([]);
    expect(tasks.events("b").filter((e) => e.type === "waiting_for_file_lease")).toHaveLength(1);
    const leases = new FileLeaseStore(db!, () => 1_000_000);
    expect(leases.live("core").map((l) => [l.taskId, l.globs])).toEqual([["a", ["src/**"]], ["c", ["docs/**"]]]);

    tasks.finish("a", "w", done("a", "met"), "completed");
    expect(leases.forTask("a")[0]).toMatchObject({ live: false, releaseReason: "finished" });
    // b gets src/app.ts now; d still overlaps c (and b).
    expect(claimedIds(tasks)).toEqual(["b"]);
    tasks.finish("b", "w", done("b", "met"), "completed");
    tasks.finish("c", "w", done("c", "met"), "completed");
    expect(claimedIds(tasks)).toEqual(["d"]);
    expect(leases.forJob("job").map((l) => l.taskId)).toEqual(["a", "c", "b", "d"]);
  });

  it("leases expire with the task lease, and a resumed task acquires its lease again at claim", () => {
    const { tasks, clock } = store();
    tasks.submit([coding("a", ["src/**"]), coding("b", ["src/**"])]);
    expect(claimedIds(tasks)).toEqual(["a"]);
    // The worker running a dies: once its task lease expires, its file lease is no longer held.
    clock.now += LIMITS.leaseMs + 1;
    expect(new FileLeaseStore(db!, () => clock.now).live()).toEqual([]);
    expect(tasks.recoverExpiredLeases()).toEqual(["a"]);
    expect(new FileLeaseStore(db!, () => clock.now).forTask("a")[0]).toMatchObject({ releaseReason: "expired" });
    // Recovery queues a to resume; a (older) is claimed first and re-acquires src/** before b.
    tasks.resume("a");
    expect(claimedIds(tasks)).toEqual(["a"]);
    expect(tasks.events("a").filter((e) => e.type === "file_lease_acquired")).toHaveLength(2);
    expect(tasks.get("b")!.row.state_reason).toBe("waiting_for_file_lease:a");
    // A graceful interruption releases it too.
    expect(tasks.interrupt("a", "w", "worker shut down")).toBe(true);
    expect(claimedIds(tasks)).toEqual(["b"]);
  });

  it("caps running tasks per job at team.max_agents", () => {
    const { tasks } = store();
    tasks.submit([1, 2, 3, 4, 5].map((i) => inspect(`n${i}`, { parentTaskId: "job" })));
    tasks.submit([inspect("other", { parentTaskId: "job2" }), inspect("loose")]);
    expect(claimedIds(tasks, { ...LIMITS, maxAgentsPerJob: 3 })).toEqual(["loose", "n1", "n2", "n3", "other"]);
    expect(claimedIds(tasks, { ...LIMITS, maxAgentsPerJob: 3 })).toEqual([]);
    tasks.finish("n1", "w", done("n1", "met"), "completed");
    expect(claimedIds(tasks, { ...LIMITS, maxAgentsPerJob: 3 })).toEqual(["n4"]);
  });
});

describe("dependency gate with accepted inputs", () => {
  function job(tasks: TaskStore): void {
    tasks.submit([{ id: "job", profile: "supervise", goal: "the job", repositoryAliases: [], context: {}, constraints: { acceptanceCriteria: ["x"] } } as WorkerTask]);
  }

  it("a node requiring accepted inputs waits on not_verified and needs_supervisor, starts once accepted, and fails on unmet", () => {
    const { tasks } = store();
    job(tasks);
    new PlanStore(db!).record("job", [node("up"), node("up2"), node("strict", ["up", "up2"], { requiresAcceptedInputs: true }), node("loose", ["up"])]);
    tasks.submit([
      inspect("up", { parentTaskId: "job", label: "up" }),
      inspect("up2", { parentTaskId: "job", label: "up2" }),
      inspect("strict", { parentTaskId: "job", label: "strict", dependsOn: ["up", "up2"] }),
      inspect("loose", { parentTaskId: "job", label: "loose", dependsOn: ["up"] }),
    ]);
    const lim = { ...LIMITS, supervisorProfiles: ["supervise"], maxSupervisors: 0 };
    expect(claimedIds(tasks, lim)).toEqual(["up", "up2"]);
    tasks.finish("up", "w", done("up", "not_verified"), "completed");
    tasks.finish("up2", "w", done("up2", "needs_supervisor"), "completed");
    // loose starts (with a warning); strict waits for both to be accepted.
    expect(claimedIds(tasks, lim)).toEqual(["loose"]);
    expect(tasks.events("loose").map((e) => e.type)).toContain("dependency_unverified");
    expect(tasks.get("strict")!.row).toMatchObject({ state: "waiting_for_dependencies", state_reason: "awaiting_acceptance:up,up2" });
    expect(tasks.events("strict").find((e) => e.type === "dependency_awaiting_acceptance")?.data).toEqual({
      dependencies: [{ dependency: "up", acceptanceStatus: "not_verified" }, { dependency: "up2", acceptanceStatus: "needs_supervisor" }],
    });
    const accept = (id: string) => tasks.updateResult(id, (t) => ({ result: { ...t.result!, acceptanceStatus: "met" }, event: { type: "result_accepted" }, value: null }));
    accept("up");
    expect(claimedIds(tasks, lim)).toEqual([]);
    expect(tasks.get("strict")!.row.state_reason).toBe("awaiting_acceptance:up2");
    accept("up2");
    expect(claimedIds(tasks, lim)).toEqual(["strict"]);
    expect(tasks.events("strict").find((e) => e.type === "dependencies_satisfied")?.data).toEqual({ acceptedInputs: true });
  });

  it("an unmet upstream fails a dependent as before, and high importance defaults to accepted inputs", () => {
    const { tasks } = store();
    job(tasks);
    tasks.submit([inspect("u"), inspect("dep", { dependsOn: ["u"] }), inspect("vip", { dependsOn: ["u"], importance: "high", importanceReason: "ships" })]);
    claimedIds(tasks);
    tasks.finish("u", "w", done("u", "not_verified"), "completed");
    expect(claimedIds(tasks)).toEqual(["dep"]);
    expect(tasks.get("vip")!.row.state_reason).toBe("awaiting_acceptance:u");
    tasks.updateResult("u", (t) => ({ result: { ...t.result!, acceptanceStatus: "unmet" }, event: { type: "result_rejected" }, value: null }));
    claimedIds(tasks);
    expect(tasks.get("vip")!.row).toMatchObject({ state: "failed", state_reason: "dependency_failed:u:completed:acceptance_unmet" });
  });
});

// ---------- upstream results and the base commit rule ----------

describe("upstream results", () => {
  it("freezes upstream results into a labelled context block and the evidence universe, and picks the coding base commit", async () => {
    env = makeEnv();
    db = openDatabase(env.cfg.storageDir);
    const tasks = new TaskStore(db);
    const artifacts = new ArtifactStore(db, env.cfg.storageDir);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd }).toString().trim();
    tasks.submit([{ id: "job", profile: "supervise", goal: "the job", repositoryAliases: ["core"], context: {}, constraints: { acceptanceCriteria: ["x"] } } as WorkerTask], { project: "demo" });
    tasks.submit([coding("up", ["src/**"], { label: "up" }), coding("down", ["src/**"], { label: "down", dependsOn: ["up"] }), inspect("reader", { dependsOn: ["up"] })], { project: "demo" });
    tasks.claim("w", LIMITS);

    // The upstream worked in its own worktree and committed.
    const worktree = path.join(env.dir, "wt-up");
    const base = git(env.repo, "rev-parse", "HEAD");
    git(env.repo, "worktree", "add", "-b", "up-branch", worktree, base);
    writeFileSync(path.join(worktree, "src", "app.ts"), "export const up = 1;\n");
    git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "up");
    const upHead = git(worktree, "rev-parse", "HEAD");
    db.prepare("INSERT INTO workspaces (task_id, repo_alias, source_path, worktree_path, base_sha, source_dirty, dirty_paths_json, status, created_at, updated_at) VALUES ('up', 'core', ?, ?, ?, 0, '[]', 'ready', 0, 0)").run(env.repo, worktree, base);
    const patch = artifacts.write({ taskId: "up", kind: "patch", label: "up patch", content: "diff --git a/src/app.ts b/src/app.ts\n+export const up = 1;\n", extension: ".patch" });
    const log = artifacts.write({ taskId: "up", kind: "check_log", label: "check", content: "ok\n" });
    tasks.finish("up", "w", { ...done("up", "met"), summary: "UP-SUMMARY: added up", findings: [{ description: "up finding", evidenceRefs: [patch] }], artifactRefs: [log], patchRefs: [patch], baseCommits: { core: base } }, "completed");

    // Not integrated yet: the coding dependent is based on the upstream's head.
    const down = await withUpstreamContext({ cfg: env.cfg, tasks, artifacts }, tasks.get("down")!);
    expect(down.spec.context.baseCommits).toEqual({ core: upHead });
    const recorded = tasks.events("down").find((e) => e.type === UPSTREAM_CONTEXT_EVENT)!.data as { artifactRef: string; baseCommits: Array<{ rule: string }> };
    expect(recorded.baseCommits[0]).toMatchObject({ rule: "upstream_head", upstreams: ["up"] });
    expect(down.spec.context.artifactRefs).toEqual([recorded.artifactRef]);

    // The run sees a labelled block; the upstream's artifacts are citable but not inlined.
    const sources = await loadSources(env.cfg, down.spec, artifacts);
    expect(sources.map((s) => [s.baseRef, !!s.upstream, !!s.referenceOnly])).toEqual([
      [recorded.artifactRef, true, false],
      [log, false, true],
      [patch, false, true],
    ]);
    const text = renderSources(sources);
    expect(text).toContain(`<upstream-results ref="${recorded.artifactRef}">`);
    expect(text).toMatch(/Upstream results: what the tasks this task depends on produced/);
    expect(text).toContain("UP-SUMMARY: added up");
    expect(text).toContain("acceptance: met");
    expect(text).toContain("Not integrated onto the job branch yet");
    expect(text).not.toContain("+export const up = 1;");

    // Later runs reuse the frozen context, even after the upstream changes.
    const again = await withUpstreamContext({ cfg: env.cfg, tasks, artifacts }, tasks.get("down")!);
    expect(again.spec.context).toEqual(down.spec.context);

    // A non-coding dependent gets the block but keeps its base commits.
    const reader = await withUpstreamContext({ cfg: env.cfg, tasks, artifacts }, tasks.get("reader")!);
    expect(reader.spec.context.baseCommits).toBeUndefined();
    expect(reader.spec.context.artifactRefs).toHaveLength(1);

    // Once integrated onto the job branch, a new dependent starts from the job branch head.
    const branch = `${env.cfg.supervisor.branch_prefix}job`;
    git(env.repo, "branch", branch, upHead);
    tasks.event("up", INTEGRATED_EVENT, { repository: "core", branch, head: upHead });
    tasks.submit([coding("later", ["src/**"], { label: "later", dependsOn: ["up"] })], { project: "demo" });
    const later = await withUpstreamContext({ cfg: env.cfg, tasks, artifacts }, tasks.get("later")!);
    expect(tasks.events("later").find((e) => e.type === UPSTREAM_CONTEXT_EVENT)!.data).toMatchObject({ baseCommits: [{ alias: "core", commit: upHead, rule: "job_branch" }] });
    expect(renderSources(await loadSources(env.cfg, later.spec, artifacts))).toContain(`Integrated onto ${branch} (core)`);
    git(env.repo, "worktree", "remove", "--force", worktree);
  });
});

// ---------- a supervisor plan, end to end ----------

function teamConfig(maxAgents: number) {
  const cfg = baseConfig({ coding: { runner: "native" }, team: { max_agents: maxAgents, provider_concurrency_start: 8 }, execution: { max_concurrent_tasks: 8, lease_seconds: 30 } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  return cfg;
}

const brief = (label: string, extra: Record<string, unknown> = {}) => ({ label, profile: "inspect", goal: `Inspect part ${label}`, acceptance_criteria: ["described"], file_refs: ["core:README.md"], difficulty: "T1", ...extra });

describe("plan_work", () => {
  it("runs independent nodes concurrently up to team.max_agents, hands upstream results to dependents, and keeps dispatched nodes on re-plan", async () => {
    env = makeEnv({ config: teamConfig(3) });
    let inflight = 0;
    let maxInflight = 0;
    const started: string[] = [];
    const seenByE: string[] = [];
    const script = [
      () => [call("plan_work", { nodes: [brief("a"), brief("b"), brief("c"), brief("d"), brief("e", { depends_on: ["a", "b"], difficulty: "T2" })], note: "first cut" })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("plan_work", { nodes: [brief("a", { goal: "Inspect part a differently" }), brief("f", { depends_on: ["e"] })], note: "add f" })],
      () => [call("await_tasks", { timeout_seconds: 120 })],
      () => [call("finish_job", { status: "completed", summary: "all parts inspected", verified: [{ claim: "every node finished", evidence: "await_tasks" }], not_verified: [] })],
    ];
    const client = new ScriptedClient(async (req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!() });
      const user = String(req.messages.find((m) => m.role === "user")!.content);
      const label = /Inspect part (\w)/.exec(user)![1]!;
      started.push(label);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(400);
      inflight--;
      const upstream = /<upstream-results ref="(artifact:[^"]+)">/.exec(user)?.[1];
      if (label === "e") seenByE.push(user);
      const ref = upstream ?? "core:README.md";
      return reply(null, { ...s, toolCalls: [call("submit_result", { summary: `RESULT-${label}`, findings: [{ description: `finding of ${label}`, evidenceRefs: [ref] }], criteria: [{ index: 0, status: "met", evidenceRefs: [ref] }] })] });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Inspect every part", repositories: ["core"], label: "team-job" });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 150 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");

    const sup = client.requests.filter(isSupervisor).at(-1)!;
    const outputs = sup.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(outputs.filter((o) => o.startsWith("error:"))).toEqual([]);
    expect(outputs[0]).toMatch(/^plan v1 recorded: 5 node\(s\); 5 dispatched now, 0 already dispatched/);
    // e (T2 = 2) after a or b (T1 = 1) is the longest chain.
    expect(outputs[0]).toMatch(/critical path: a -> e \(estimated cost 3\); at most 3 task\(s\) of this job run at once/);

    // Four independent nodes, cap three: three ran at once, never more.
    expect(maxInflight).toBe(3);
    // The dependent ran after its upstreams and was given their results.
    expect(started.indexOf("e")).toBeGreaterThan(Math.max(started.indexOf("a"), started.indexOf("b")));
    expect(seenByE[0]).toContain("Upstream results");
    expect(seenByE[0]).toContain("RESULT-a");
    expect(seenByE[0]).toContain("RESULT-b");
    const children = sy.tasks.childrenOf(job.taskId);
    const byLabel = Object.fromEntries(children.map((c) => [c.spec.label!, c]));
    expect(byLabel.e!.result!.executionStatus).toBe("completed");
    expect(byLabel.e!.result!.findings[0]!.evidenceRefs[0]).toMatch(/^artifact:/);

    // Re-plan: a keeps its task (not re-dispatched), f is new, b..e are carried over.
    expect(outputs[2]).toMatch(/^plan v2 recorded: 6 node\(s\); 1 dispatched now, 1 already dispatched \(kept\), 4 carried over \(b, c, d, e\)/);
    expect(children.map((c) => c.spec.label).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(started.filter((l) => l === "a")).toHaveLength(1);
    const plans = new PlanStore(sy.db).list(job.taskId);
    expect(plans.map((p) => [p.version, p.note, p.nodes.length])).toEqual([[1, "first cut", 5], [2, "add f", 6]]);
    expect(plans[1]!.nodes.find((n) => n.label === "a")!.goal).toBe("Inspect part a");
    expect(byLabel.f!.spec.dependsOn).toEqual([byLabel.e!.row.id]);
  }, 180_000);

  it("a node requiring accepted inputs waits for the supervisor's acceptance, and await_tasks returns instead of idling", async () => {
    env = makeEnv({ config: teamConfig(4) });
    const started: string[] = [];
    const script = [
      () => [call("plan_work", { nodes: [brief("u"), brief("v", { depends_on: ["u"], requires_accepted_inputs: true })] })],
      () => [call("await_tasks", { timeout_seconds: 600 })],
      () => [call("accept_task", { task_id: "u", reason: "read the README myself; the description matches" })],
      () => [call("await_tasks", { timeout_seconds: 600 })],
      () => [call("finish_job", { status: "completed", summary: "done", verified: [{ claim: "u accepted, v ran on it", evidence: "await_tasks" }], not_verified: [] })],
    ];
    const client = new ScriptedClient((req) => {
      const s = servedFor(sy!, req);
      if (isSupervisor(req)) return reply(null, { ...s, toolCalls: script[turns(req)]!() });
      const user = String(req.messages.find((m) => m.role === "user")!.content);
      started.push(/Inspect part (\w)/.exec(user)![1]!);
      const ref = /<upstream-results ref="(artifact:[^"]+)">/.exec(user)?.[1] ?? "core:README.md";
      return reply(null, { ...s, toolCalls: [call("submit_result", { summary: "seen", findings: [], criteria: [{ index: 0, status: "met", evidenceRefs: [ref] }] })] });
    });
    sy = open(env, client, { worker: true });
    const startedAt = Date.now();
    const job = await sy.startJob({ goal: "Inspect u, then v on accepted input", repositories: ["core"], label: "accept-job" });
    const r = (await sy.awaitResults([job.taskId], { timeoutSeconds: 120 })).completed[0]!;
    expect(r.stopReason).toBe("supervisor_completed");
    // The 600 s waits did not run out: the first returned as soon as only the acceptance was missing.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    const outputs = client.requests.filter(isSupervisor).at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(outputs.filter((o) => o.startsWith("error:"))).toEqual([]);
    expect(outputs[1]).toMatch(/still waiting_for_dependencies \(awaiting_acceptance:\S+; accept_task or reject_task the upstream result\)/);
    expect(outputs[2]).toMatch(/accepted \(acceptance met\)/);
    expect(started).toEqual(["u", "v"]);
    const v = sy.tasks.childrenOf(job.taskId).find((c) => c.spec.label === "v")!;
    expect(sy.tasks.events(v.row.id).map((e) => e.type)).toEqual(expect.arrayContaining(["dependency_awaiting_acceptance", "dependencies_satisfied"]));
    expect(v.row.state).toBe("completed");
  }, 180_000);
});
