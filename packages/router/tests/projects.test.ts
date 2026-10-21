import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { Switchyard } from "../src/core/service.js";
import { parseConfig } from "../src/config/load.js";
import { DB_FILE } from "../src/storage/db.js";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { FileLeaseStore } from "../src/storage/file-leases.js";
import { MergeQueue } from "../src/workspaces/merge-queue.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { repoKey, splitRepoKey, type ProjectContext } from "../src/projects/context.js";
import { baseResult, type RunContext, type RunOutcome } from "../src/runners/types.js";
import { baseConfig, commitAll, FakeProvider, makeEnv, open, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}

function gitRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

/** Two projects, both with an `app` repository (different folders); beta also has `lib`. */
function twoProjectsConfig(extra: Record<string, unknown> = {}) {
  return {
    ...baseConfig(),
    repositories: {},
    routing: { escalate_on_failure: false },
    team: { provider_concurrency_enabled: false },
    projects: {
      alpha: { repositories: { app: { path: "alpha-app" } }, verification: { default_importance: "high" } },
      beta: { name: "Beta", repositories: { app: { path: "beta-app" }, lib: { path: "beta-lib" } }, supervisor: { branch_prefix: "beta/job-" }, team: { max_agents: 3 } },
    },
    ...extra,
  };
}

function makeTwoProjects(): Env {
  const e = makeEnv({ config: twoProjectsConfig() });
  gitRepo(path.join(e.dir, "alpha-app"), { "src/app.ts": "export const who = 'alpha';\n" });
  gitRepo(path.join(e.dir, "beta-app"), { "src/app.ts": "export const who = 'beta';\n" });
  gitRepo(path.join(e.dir, "beta-lib"), { "README.md": "# lib\n" });
  return e;
}

const implement = (label: string) => ({
  profile: "implement",
  label,
  goal: `Edit the app (${label})`,
  repositoryAliases: ["app"],
  writableRepository: "app",
  constraints: { acceptanceCriteria: ["edits src/app.ts"], allowedPaths: ["src/**"] },
  hints: { difficulty: "T2" },
});

/** A coding runner that records what it sees, then holds the task until it is cancelled. */
function holdingRunner() {
  const seen: Array<{ taskId: string; project: string; repos: Record<string, string>; brainProject: string | null }> = [];
  return {
    seen,
    run: async (ctx: RunContext): Promise<RunOutcome> => {
      const cfg = ctx.cfg as ProjectContext;
      seen.push({ taskId: ctx.taskId, project: cfg.project.slug, repos: Object.fromEntries(Object.entries(cfg.repositoryPaths).map(([a, r]) => [a, r.path])), brainProject: ctx.brain?.project ?? null });
      await new Promise<void>((resolve) => (ctx.signal.aborted ? resolve() : ctx.signal.addEventListener("abort", () => resolve())));
      return { state: "cancelled", result: baseResult({ executionStatus: "cancelled", stopReason: "cancelled" }) };
    },
  };
}

describe("project configuration", () => {
  it("reads a single-project config as one project that is the global config (legacy upgrade, in memory)", () => {
    const cfg = parseConfig(baseConfig(), path.join(tmpdir(), "sy.yaml"));
    expect(cfg.projectResolution.primary).toBe("demo");
    expect(cfg.projectResolution.projects.map((p) => [p.slug, p.legacy, Object.keys(p.repositories)])).toEqual([["demo", true, ["core"]]]);
    const reg = new ProjectRegistry(cfg);
    const ctx = reg.forWrite();
    expect(ctx.project).toEqual({ slug: "demo", name: "demo", legacy: true });
    // Nothing is overlaid: the context reads (and writes) the global config itself.
    expect(ctx.repositoryPaths).toBe(cfg.repositoryPaths);
    expect(ctx.verification).toBe(cfg.verification);
    expect(ctx.brain.project).toBe("demo");
    expect(JSON.parse(JSON.stringify(ctx))).toMatchObject({ project: { slug: "demo" }, repositories: { core: { path: "repo" } } });
    expect(reg.primary).toBe(ctx);
  });

  it("overlays each project's repositories, brain scope, and overrides on the global config", () => {
    const cfgPath = path.join(tmpdir(), "sy.yaml");
    const cfg = parseConfig(twoProjectsConfig(), cfgPath);
    expect(cfg.projectResolution.primary).toBe("alpha");
    const reg = new ProjectRegistry(cfg);
    const alpha = reg.require("alpha");
    const beta = reg.require("beta");
    expect(Object.keys(alpha.repositoryPaths)).toEqual(["app"]);
    expect(Object.keys(beta.repositoryPaths)).toEqual(["app", "lib"]);
    expect(alpha.repositoryPaths.app!.path).toBe(path.resolve(path.dirname(cfgPath), "alpha-app"));
    expect(beta.repositoryPaths.app!.path).toBe(path.resolve(path.dirname(cfgPath), "beta-app"));
    expect([alpha.brain.project, beta.brain.project]).toEqual(["alpha", "beta"]);
    expect(beta.project.name).toBe("Beta");
    // Overrides: deep-merged verification, replaced supervisor and team keys; the rest is global.
    expect(alpha.verification.default_importance).toBe("high");
    expect(alpha.verification.levels).toEqual(cfg.verification.levels);
    expect(cfg.verification.default_importance).toBe("normal");
    expect([alpha.supervisor.branch_prefix, beta.supervisor.branch_prefix, cfg.supervisor.branch_prefix]).toEqual(["switchyard/job-", "beta/job-", "switchyard/job-"]);
    expect([alpha.team.max_agents, beta.team.max_agents]).toEqual([undefined, 3]);
    expect(beta.team.provider_concurrency_enabled).toBe(false);
    expect(alpha.profiles).toBe(cfg.profiles);
    // A write must name a project when there are several.
    expect(() => reg.forWrite()).toThrow(/2 projects \(alpha, beta\); name the project/);
    expect(() => reg.require("gamma")).toThrow(/unknown project gamma/);
  });

  it("rejects top-level repositories beside projects, global settings under a project, and invalid overrides", () => {
    const at = path.join(tmpdir(), "sy.yaml");
    expect(() => parseConfig({ ...twoProjectsConfig(), repositories: { core: { path: "repo" } } }, at)).toThrow(/repositories: top-level repositories cannot be combined with projects/);
    expect(() => parseConfig(twoProjectsConfig({ projects: { a: { team: { provider_concurrency_max: 4 } } } }), at)).toThrow(/projects\.a\.team\.provider_concurrency_max: not a project setting/);
    expect(() => parseConfig(twoProjectsConfig({ projects: { a: { execution: {} } } }), at)).toThrow(/projects\.a/);
    expect(() => parseConfig(twoProjectsConfig({ projects: { a: { team: { max_depth: 9 } } } }), at)).toThrow(/projects\.a\.team\.max_depth/);
    expect(() => parseConfig(twoProjectsConfig({ projects: { "Bad/Slug": {} } }), at)).toThrow(/projects/);
  });

  it("keys repositories <project>/<alias>", () => {
    expect(repoKey("alpha", "app")).toBe("alpha/app");
    expect(repoKey("", "app")).toBe("app");
    expect(splitRepoKey("alpha/app")).toEqual({ project: "alpha", alias: "app" });
    expect(splitRepoKey("app")).toEqual({ project: null, alias: "app" });
  });
});

describe("projects in one worker", () => {
  it("runs two projects' tasks on the same `app` alias at once, each seeing only its own repositories", async () => {
    env = makeTwoProjects();
    const runner = holdingRunner();
    sy = open(env, new FakeProvider(), { worker: true, coding: runner });
    const [a] = await sy.submitTasks([implement("a")], { project: "alpha" });
    const [b] = await sy.submitTasks([implement("b")], { project: "beta" });

    // With one writer per repository and overlapping paths, a shared key would hold one back.
    await until(() => runner.seen.length === 2);
    expect(sy.tasks.get(a!.taskId)!.row.state).toBe("running");
    expect(sy.tasks.get(b!.taskId)!.row.state).toBe("running");
    expect([sy.tasks.get(a!.taskId)!.row.writable_repo, sy.tasks.get(b!.taskId)!.row.writable_repo]).toEqual(["alpha/app", "beta/app"]);
    expect(new FileLeaseStore(sy.db).live().map((l) => l.repository).sort()).toEqual(["alpha/app", "beta/app"]);
    for (const id of [a!.taskId, b!.taskId]) expect(sy.tasks.events(id, 100).map((e) => e.type)).not.toContain("waiting_for_file_lease");

    // Each runner saw its own project: repositories, brain scope.
    const seenA = runner.seen.find((s) => s.taskId === a!.taskId)!;
    const seenB = runner.seen.find((s) => s.taskId === b!.taskId)!;
    expect(seenA).toMatchObject({ project: "alpha", brainProject: "alpha", repos: { app: path.join(env.dir, "alpha-app") } });
    expect(Object.keys(seenA.repos)).toEqual(["app"]);
    expect(seenB).toMatchObject({ project: "beta", brainProject: "beta", repos: { app: path.join(env.dir, "beta-app"), lib: path.join(env.dir, "beta-lib") } });

    // Merge locks are per project repository too: the same alias and branch queue separately.
    const q = new MergeQueue(sy.db, sy.tasks, "test");
    const item = (jobId: string) => q.enqueue({ jobId, taskId: jobId, kind: "task", repo: "app", branch: "switchyard/job-x", integrationWorktree: env!.dir, sourceWorktree: null, sourceBase: "a".repeat(40), sourceHead: "b".repeat(40), commits: [], acceptance: null });
    const qa = item(a!.taskId);
    const qb = item(b!.taskId);
    expect([qa.lockKey, qb.lockKey]).toEqual(["alpha/app:switchyard/job-x", "beta/app:switchyard/job-x"]);
    const ahead = (taskId: string) => (sy!.tasks.events(taskId, 200).find((e) => e.type === "merge_queued")!.data as { ahead: number }).ahead;
    expect([ahead(a!.taskId), ahead(b!.taskId)]).toEqual([0, 0]);

    sy.cancelTasks([a!.taskId, b!.taskId]);
    await until(() => [a!.taskId, b!.taskId].every((id) => sy!.tasks.get(id)!.row.state === "cancelled"));
  });

  it("validates a task against its own project's repositories and refuses cross-project links", async () => {
    env = makeTwoProjects();
    sy = open(env, new FakeProvider());
    // `lib` is beta's; alpha has no such repository.
    await expect(sy.submitTasks([{ ...implement("x"), repositoryAliases: ["app", "lib"] }], { project: "alpha" })).rejects.toThrow(/unknown repository alias lib/);
    const [b] = await sy.submitTasks([{ ...implement("x"), repositoryAliases: ["app", "lib"] }], { project: "beta" });
    // Writes need a project when there are several; delegated tasks inherit their job's.
    await expect(sy.submitTasks([implement("y")])).rejects.toThrow(/name the project/);
    const [child] = await sy.submitTasks([{ ...implement("child"), parentTaskId: b!.taskId }]);
    expect(sy.tasks.projectOf(child!.taskId)).toBe("beta");
    await expect(sy.submitTasks([{ ...implement("z"), dependsOn: [b!.taskId] }], { project: "alpha" })).rejects.toThrow(/project beta, not alpha/);
    // Idempotency keys are unique per install: reuse from another project is refused, not deduplicated.
    await sy.submitTasks([summarizeTask({ idempotencyKey: "k1" })], { project: "alpha" });
    await expect(sy.submitTasks([summarizeTask({ idempotencyKey: "k1" })], { project: "beta" })).rejects.toThrow(/already used in project alpha/);
  });

  it("filters service reads by project and refuses id-based writes into another project", async () => {
    env = makeTwoProjects();
    sy = open(env, new FakeProvider());
    const [a] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
    const [b1] = await sy.submitTasks([summarizeTask({ goal: "Summarise b1" })], { project: "beta" });
    const [b2] = await sy.submitTasks([summarizeTask({ goal: "Summarise b2" })], { project: "beta" });
    expect(sy.listTasks(undefined, 50, "alpha").map((t) => t.taskId)).toEqual([a!.taskId]);
    expect(sy.listTasks(undefined, 50, "beta").map((t) => t.taskId).sort()).toEqual([b1!.taskId, b2!.taskId].sort());
    expect(sy.listTasks(undefined, 50).map((t) => t.project).sort()).toEqual(["alpha", "beta", "beta"]);
    expect(sy.getStatus([b1!.taskId], "alpha")).toEqual([{ taskId: b1!.taskId, state: "unknown" }]);
    expect(sy.getStatus([b1!.taskId], "beta")[0]).toMatchObject({ taskId: b1!.taskId, project: "beta" });
    expect(sy.usage(0, undefined, "alpha").logicalTasks.submitted).toBe(1);
    expect(sy.usage(0, undefined, "beta").logicalTasks.submitted).toBe(2);
    expect(sy.usage(0).logicalTasks.submitted).toBe(3);

    sy.db.prepare("INSERT INTO job_questions (task_id, question, asked_at) VALUES (?, 'which?', 1)").run(b1!.taskId);
    expect(sy.questions({ project: "alpha" })).toEqual([]);
    expect(sy.questions({ project: "beta" }).map((q) => [q.taskId, q.project])).toEqual([[b1!.taskId, "beta"]]);
    const qid = sy.questions({ project: "beta" })[0]!.id;
    expect(() => sy!.answerQuestion(qid, "this", "user", "alpha")).toThrow(/belongs to project beta, not alpha/);

    expect(() => sy!.cancelTasks([b1!.taskId], "alpha")).toThrow(/belongs to project beta, not alpha/);
    expect(sy.cancelTasks([b1!.taskId], "beta")).toEqual([{ taskId: b1!.taskId, state: "cancelled" }]);
    // Events of a task carry its project; the projects table records both projects.
    expect(sy.db.prepare("SELECT DISTINCT project_id FROM events WHERE task_id = ?").all(b1!.taskId)).toEqual([{ project_id: "beta" }]);
    expect(sy.projects.rows().map((r) => [r.id, r.name, r.lastActiveAt !== null])).toEqual([["alpha", "alpha", true], ["beta", "Beta", true]]);
  });
});

describe("store upgrade to projects", () => {
  it("gives every existing row the one legacy project and namespaces repository keys", async () => {
    env = makeEnv();
    const at = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE projects"));
    expect(at).toBeGreaterThan(0);
    mkdirSync(env.cfg.storageDir, { recursive: true });
    const old = new Database(path.join(env.cfg.storageDir, DB_FILE));
    for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
    old.pragma(`user_version = ${at}`);
    const spec = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify(WorkerTaskSchema.parse({ id, profile: "implement", goal: `old ${id}`, repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["x"], allowedPaths: ["src/**"] }, ...extra }));
    const task = old.prepare("INSERT INTO tasks (id, spec_hash, profile, spec_json, state, created_at, updated_at, finished_at, writable_repo) VALUES (?, ?, ?, ?, 'completed', 1, 1, 1, ?)");
    task.run("job1", "h1", "implement", spec("job1"), "core");
    task.run("t1", "h2", "implement", spec("t1", { parentTaskId: "job1" }), "core");
    task.run("t2", "h3", "summarize", JSON.stringify(WorkerTaskSchema.parse({ id: "t2", ...summarizeTask() })), null);
    old.prepare("INSERT INTO events (task_id, ts, type) VALUES ('t1', 1, 'submitted'), (NULL, 1, 'config_reloaded')").run();
    old.prepare("INSERT INTO sessions (id, task_id, role, agent_label, status, log_path, created_at, updated_at) VALUES ('s1', 't1', 'implementer', 'x', 'completed', 'x.jsonl', 1, 1), ('s2', NULL, 'supervisor', 'cc', 'completed', 'y.jsonl', 1, 1)").run();
    old.prepare("INSERT INTO job_state (task_id, messages_json, updated_at) VALUES ('job1', '[]', 1)").run();
    old.prepare("INSERT INTO file_leases (job_id, task_id, repository, globs_json, mode, acquired_at, released_at) VALUES ('job1', 't1', 'core', '[\"src/**\"]', 'write', 1, 2)").run();
    old.prepare("INSERT INTO merge_queue (id, job_id, task_id, kind, repo_alias, branch, lock_key, integration_worktree, source_base, source_head, commits_json, state, created_at, updated_at) VALUES ('mq1', 'job1', 't1', 'task', 'core', 'switchyard/job-job1', 'core:switchyard/job-job1', 'w', 'a', 'b', '[]', 'integrated', 1, 1)").run();
    old.prepare("INSERT INTO brain_grants (task_id, pattern, mode, granted_by, created_at) VALUES ('t1', 'projects/demo/**', 'read', 'supervisor', 1)").run();
    old.prepare("INSERT INTO brain_access_requests (task_id, job_id, role, pattern, mode, reason, status, created_at) VALUES (NULL, 'job1', 'implementer', 'p', 'read', 'r', 'pending', 1)").run();
    old.prepare("INSERT INTO job_plans (job_id, version, plan_json, created_at) VALUES ('job1', 1, '{}', 1)").run();
    old.prepare("INSERT INTO executions (id, kind, profile, status, created_at) VALUES ('e1', 'task', 'implement', 'done', 1)").run();
    const req = old.prepare("INSERT INTO model_requests (id, execution_id, purpose, gateway_model, status, reserved_at, est_input_tokens, reserved_output_tokens) VALUES (?, 'e1', 'execution', 'm', 'succeeded', 1, 1, 1)");
    req.run("r1");
    req.run("r2");
    old.prepare("INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens) VALUES ('r1', 't1', 1, 1)").run();
    old.close();

    sy = open(env, new FakeProvider());
    const one = (sql: string) => sy!.db.prepare(sql).all();
    expect(one("SELECT id, project_id, writable_repo FROM tasks ORDER BY id")).toEqual([
      { id: "job1", project_id: "demo", writable_repo: "demo/core" },
      { id: "t1", project_id: "demo", writable_repo: "demo/core" },
      { id: "t2", project_id: "demo", writable_repo: null },
    ]);
    expect(one("SELECT task_id, project_id FROM events ORDER BY id")).toEqual([
      { task_id: "t1", project_id: "demo" },
      { task_id: null, project_id: null },
    ]);
    expect(one("SELECT id, project_id FROM sessions ORDER BY id")).toEqual([{ id: "s1", project_id: "demo" }, { id: "s2", project_id: "demo" }]);
    expect(one("SELECT project_id FROM job_state")).toEqual([{ project_id: "demo" }]);
    expect(one("SELECT repository FROM file_leases")).toEqual([{ repository: "demo/core" }]);
    expect(one("SELECT repo_alias, lock_key FROM merge_queue")).toEqual([{ repo_alias: "core", lock_key: "demo/core:switchyard/job-job1" }]);
    expect(one("SELECT project_id FROM brain_grants")).toEqual([{ project_id: "demo" }]);
    expect(one("SELECT project_id FROM brain_access_requests")).toEqual([{ project_id: "demo" }]);
    expect(one("SELECT project_id FROM job_plans")).toEqual([{ project_id: "demo" }]);
    expect(one("SELECT id, project_id FROM model_requests ORDER BY id")).toEqual([{ id: "r1", project_id: "demo" }, { id: "r2", project_id: "" }]);
    expect(one("SELECT id, name FROM projects")).toEqual([{ id: "demo", name: "demo" }]);
    // Plan versions are still immutable once stamped.
    expect(() => sy!.db.prepare("UPDATE job_plans SET plan_json = '[]'").run()).toThrow(/immutable/);
    expect(() => sy!.db.prepare("UPDATE job_plans SET project_id = 'other'").run()).toThrow(/immutable/);
    // The upgraded install keeps working as one project: reads see the old rows, writes need no project.
    expect(sy.listTasks(undefined, 50, "demo").map((t) => t.taskId).sort()).toEqual(["job1", "t1", "t2"]);
    const [fresh] = await sy.submitTasks([summarizeTask()]);
    expect(sy.tasks.projectOf(fresh!.taskId)).toBe("demo");
    expect(sy.db.prepare("SELECT project_id FROM sessions WHERE id = 's1'").get()).toEqual({ project_id: "demo" });
    expect(new FileLeaseStore(sy.db).forTask("t1")[0]!.repository).toBe("demo/core");
  });

  it("a second start changes nothing, and rows written later inherit their task's project", async () => {
    env = makeTwoProjects();
    sy = open(env, new FakeProvider());
    const [b] = await sy.submitTasks([summarizeTask()], { project: "beta" });
    sy.db.prepare("INSERT INTO sessions (id, task_id, role, agent_label, status, log_path, created_at, updated_at) VALUES ('sx', ?, 'summarizer', 'x', 'completed', 'x.jsonl', 1, 1)").run(b!.taskId);
    expect(sy.db.prepare("SELECT project_id FROM sessions WHERE id = 'sx'").get()).toEqual({ project_id: "beta" });
    await sy.close();
    sy = open(env, new FakeProvider());
    expect(sy.tasks.projectOf(b!.taskId)).toBe("beta");
    expect(sy.db.prepare("SELECT project_id FROM sessions WHERE id = 'sx'").get()).toEqual({ project_id: "beta" });
  });
});
