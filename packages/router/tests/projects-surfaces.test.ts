import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Switchyard } from "../src/core/service.js";
import { parseConfig } from "../src/config/load.js";
import { chooseProject, requireProject, type SelectableProject } from "../src/cli/project-select.js";
import { initConfigText } from "../src/cli/projects.js";
import { repoFlags } from "../src/cli/args.js";
import {
  archiveProject,
  createProject,
  globalDashboard,
  globalSettings,
  patchProjectSettings,
  projectOverview,
  projectSettings,
  projectsGrid,
  requestLog,
  sessionsView,
  jobsView,
} from "../src/admin/insights.js";
import { baseConfig, commitAll, makeEnv, open, ScriptedClient, reply, summarizeTask, type Env } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliJs = path.resolve(here, "..", "dist", "cli.js");
const mcpJs = path.resolve(here, "..", "dist", "mcp.js");

let env: Env | undefined;
let sy: Switchyard | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

function gitRepo(dir: string, files: Record<string, string> = { "README.md": "# repo\n" }): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  commitAll(dir, "init");
}

const supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 60, max_output_tokens: 8000, classify: "never", min_tier: "T3" };

/** Two projects, both with an `app` repository; beta overrides its supervisor branch prefix and team size. */
function makeTwoProjects(): Env {
  const base = baseConfig();
  const e = makeEnv({
    config: {
      ...base,
      repositories: {},
      profiles: { ...(base.profiles as Record<string, unknown>), supervise },
      projects: {
        alpha: { name: "Alpha", repositories: { app: { path: "alpha-app" } } },
        beta: { repositories: { app: { path: "beta-app" } }, supervisor: { branch_prefix: "beta/job-" }, team: { max_agents: 3 } },
      },
    },
  });
  gitRepo(path.join(e.dir, "alpha-app"));
  gitRepo(path.join(e.dir, "beta-app"));
  return e;
}

/** A clean environment for child processes: no SWITCHYARD_* variables from the test runner. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("SWITCHYARD_")) e[k] = v;
  return { ...e, ...extra };
}

function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  return spawnSync(process.execPath, [cliJs, ...args, "--config", env!.cfg.configPath], { encoding: "utf8", cwd: opts.cwd ?? env!.dir, env: childEnv(opts.env), timeout: 60_000, ...(opts.input !== undefined ? { input: opts.input } : {}) });
}

describe("project selection", () => {
  const projects: SelectableProject[] = [
    { slug: "alpha", repositoryPaths: { app: { path: "/work/alpha" }, docs: { path: "/work/shared" } } },
    { slug: "beta", repositoryPaths: { app: { path: "/work/beta" }, inner: { path: "/work/alpha/vendor/lib" }, docs: { path: "/work/shared" } } },
    { slug: "old", archived: true, repositoryPaths: { app: { path: "/work/old" } } },
  ];
  const cwd = (p: string) => path.resolve(p);

  it("takes the flag, then the environment, then the only project, then the working directory", () => {
    expect(chooseProject(projects, { flag: "beta", env: "alpha", cwd: cwd("/work/alpha") })).toEqual({ slug: "beta", source: "flag" });
    expect(chooseProject(projects, { env: "alpha", cwd: cwd("/work/beta") })).toEqual({ slug: "alpha", source: "env" });
    // An archived project is never chosen implicitly, but a flag may name it.
    expect(chooseProject(projects, { flag: "old", cwd: cwd("/elsewhere") })).toEqual({ slug: "old", source: "flag" });
    expect(chooseProject([projects[0]!, projects[2]!], { cwd: cwd("/elsewhere") })).toEqual({ slug: "alpha", source: "only" });
    expect(chooseProject(projects, { cwd: cwd("/work/alpha/src/deep") })).toEqual({ slug: "alpha", source: "cwd" });
    // The innermost repository wins: beta's repository nested inside alpha's.
    expect(chooseProject(projects, { cwd: cwd("/work/alpha/vendor/lib/src") })).toEqual({ slug: "beta", source: "cwd" });
    expect(chooseProject(projects, { cwd: cwd("/work/old") })).toBeNull();
  });

  it("fails with the list of projects when it cannot choose, and on an unknown project", () => {
    expect(() => requireProject(projects, { cwd: cwd("/elsewhere") })).toThrow(/several projects and the working directory is not inside any project's repository; pass --project <slug> or set SWITCHYARD_PROJECT\. Projects: alpha, beta, old \(archived\)/);
    // The same folder configured in two projects is ambiguous.
    expect(() => requireProject(projects, { cwd: cwd("/work/shared/x") })).toThrow(/inside repositories of several projects \(alpha, beta\)/);
    expect(() => chooseProject(projects, { flag: "nope", cwd: cwd("/work/alpha") })).toThrow(/unknown project nope \(from --project\); projects: alpha, beta, old \(archived\)/);
    expect(() => chooseProject(projects, { env: "nope", cwd: cwd("/work/alpha") })).toThrow(/from SWITCHYARD_PROJECT/);
  });

  it("parses --repo flags and writes init configs in the projects shape", () => {
    expect(repoFlags(["app=../my-app", "../libs/core/"])).toEqual({ app: { path: "../my-app" }, core: { path: "../libs/core/" } });
    expect(() => repoFlags(["=x"])).toThrow(/--repo takes/);
    expect(() => repoFlags(["a=x", "a=y"])).toThrow(/given twice/);
    const examples = path.resolve(here, "../examples");
    for (const preset of ["claude-code", "standalone-free"]) {
      const text = initConfigText(readFileSync(path.join(examples, "presets", `${preset}.yaml`), "utf8"), { slug: "shop", name: "Shop", repositories: { web: { path: "../web" } } });
      const raw = YAML.parse(text) as { repositories?: unknown; brain: { project: string }; projects: Record<string, { name: string; repositories: Record<string, { path: string }> }> };
      expect(Object.keys(raw.projects)).toEqual(["shop"]);
      expect(raw.projects.shop).toMatchObject({ name: "Shop", repositories: { web: { path: "../web" } } });
      expect(raw.brain.project).toBe("shop");
      expect(raw.repositories).toBeUndefined();
      const cfg = parseConfig(raw, path.join(tmpdir(), "x", "switchyard.config.yaml"));
      expect(cfg.projectResolution.primary).toBe("shop");
    }
    // A preset still in the single-project shape is converted.
    const legacy = initConfigText(YAML.stringify(baseConfig()), { slug: "demo2" });
    const raw = YAML.parse(legacy) as Record<string, unknown>;
    expect(raw.repositories).toBeUndefined();
    expect(raw.projects).toEqual({ demo2: { repositories: { core: { path: "repo" } } } });
    expect(() => initConfigText("version: 1\n", { slug: "Bad Slug" })).toThrow(/--project/);
  });
});

describe("CLI with projects", () => {
  it("resolves the project per command: flag, working directory, the only project, or an error listing them", () => {
    env = makeTwoProjects();
    const task = JSON.stringify(summarizeTask());
    // Outside every repository with two projects: a write fails and lists the projects.
    const ambiguous = cli(["submit", "-"], { input: task });
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toMatch(/several projects .*pass --project <slug> or set SWITCHYARD_PROJECT\. Projects: alpha, beta/);
    const unknown = cli(["status", "--project", "nope"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/unknown project nope/);

    const inBeta = cli(["submit", "-", "--project", "beta", "--json"], { input: task });
    expect(inBeta.status, inBeta.stderr).toBe(0);
    const betaId = (JSON.parse(inBeta.stdout) as Array<{ taskId: string }>)[0]!.taskId;
    // From inside alpha's repository the project is inferred.
    const inAlpha = cli(["submit", "-", "--json"], { input: task, cwd: path.join(env.dir, "alpha-app") });
    expect(inAlpha.status, inAlpha.stderr).toBe(0);
    const alphaId = (JSON.parse(inAlpha.stdout) as Array<{ taskId: string }>)[0]!.taskId;
    // SWITCHYARD_PROJECT works too.
    const viaEnv = cli(["submit", "-", "--json"], { input: task, env: { SWITCHYARD_PROJECT: "beta" } });
    expect(viaEnv.status, viaEnv.stderr).toBe(0);

    const all = JSON.parse(cli(["status", "--json"]).stdout) as Array<{ taskId: string; project: string }>;
    expect(all.map((t) => t.project).sort()).toEqual(["alpha", "beta", "beta"]);
    const beta = JSON.parse(cli(["status", "--json", "--project", "beta"]).stdout) as Array<{ taskId: string; project: string }>;
    expect(beta.map((t) => t.project)).toEqual(["beta", "beta"]);
    const fromAlphaDir = JSON.parse(cli(["status", "--json"], { cwd: path.join(env.dir, "alpha-app") }).stdout) as Array<{ taskId: string }>;
    expect(fromAlphaDir.map((t) => t.taskId)).toEqual([alphaId]);
    // An id-based command with a named project refuses another project's task.
    const cancel = cli(["cancel", betaId, "--project", "alpha"]);
    expect(cancel.status).toBe(1);
    expect(cancel.stderr).toMatch(/belongs to project beta, not alpha/);

    // blame resolves the alias in the chosen project.
    const blame = cli(["blame", "app", "README.md", "--json", "--project", "beta"]);
    expect(blame.status, blame.stderr).toBe(0);

    // doctor reports per project: repositories and brain folders.
    const doctor = cli(["doctor", "--json"]);
    const checks = JSON.parse(doctor.stdout) as Array<{ check: string; level: string }>;
    expect(checks.map((c) => c.check)).toEqual(expect.arrayContaining(["project alpha", "alpha repo app", "alpha brain", "project beta", "beta repo app", "beta brain"]));
    const one = JSON.parse(cli(["doctor", "--json", "--project", "beta"]).stdout) as Array<{ check: string }>;
    expect(one.some((c) => c.check.startsWith("alpha"))).toBe(false);
  }, 120_000);

  it("projects create writes a valid projects.<slug>; archive hides it; a single-project config is converted", () => {
    env = makeEnv();
    // The single-project shape: no --project needed anywhere.
    const first = cli(["submit", "-", "--json"], { input: JSON.stringify(summarizeTask()) });
    expect(first.status, first.stderr).toBe(0);
    gitRepo(path.join(env.dir, "web"));

    const bad = cli(["projects", "create", "shop", "--repo", "web=missing-folder"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/does not exist or is not a folder/);
    const dup = cli(["projects", "create", "demo"]);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/project demo already exists/);

    const made = cli(["projects", "create", "shop", "--name", "Web shop", "--repo", "web=web"]);
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout).toMatch(/converted: its repositories moved under projects\.demo/);
    const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8")) as Record<string, unknown>;
    expect(raw.repositories).toBeUndefined();
    expect(raw.projects).toEqual({ demo: { repositories: { core: { path: "repo" } } }, shop: { name: "Web shop", repositories: { web: { path: "web" } } } });
    const cfg = parseConfig(raw, env.cfg.configPath);
    expect(cfg.projectResolution.projects.map((p) => p.slug)).toEqual(["demo", "shop"]);
    expect(existsSync(path.join(env.dir, "brain", "projects", "shop", "working"))).toBe(true);
    expect(existsSync(`${env.cfg.configPath}.bak`)).toBe(true);

    const list = JSON.parse(cli(["projects", "list", "--json"]).stdout) as Array<{ slug: string; queuedTasks: number; repositories: Array<{ alias: string; exists: boolean }> }>;
    expect(list.map((p) => [p.slug, p.queuedTasks])).toEqual([["demo", 1], ["shop", 0]]);
    expect(list[1]!.repositories).toEqual([expect.objectContaining({ alias: "web", exists: true })]);

    // The old task stays in its project; archiving a project with queued work is refused.
    const busy = cli(["projects", "archive", "demo"]);
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(/1 queued task/);
    expect(cli(["projects", "archive", "shop"]).status).toBe(0);
    expect((JSON.parse(cli(["projects", "--json"]).stdout) as Array<{ slug: string }>).map((p) => p.slug)).toEqual(["demo"]);
    expect((JSON.parse(cli(["projects", "list", "--all", "--json"]).stdout) as Array<{ slug: string; archived: boolean }>).map((p) => [p.slug, p.archived])).toEqual([["demo", false], ["shop", true]]);
    // With shop archived, demo is the only live project: commands need no --project.
    const again = cli(["submit", "-", "--json"], { input: JSON.stringify(summarizeTask({ goal: "Again" })) });
    expect(again.status, again.stderr).toBe(0);
    expect(cli(["projects", "unarchive", "shop"]).status).toBe(0);
  }, 120_000);

  it("init writes a global config plus a first project", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "switchyard-init-"));
    try {
      const r = spawnSync(process.execPath, [cliJs, "init", dir, "--project", "shop", "--repo", "web=../web"], { encoding: "utf8", env: childEnv(), timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const raw = YAML.parse(readFileSync(path.join(dir, "switchyard.config.yaml"), "utf8")) as { brain: { project: string }; projects: Record<string, unknown>; repositories?: unknown };
      expect(raw.projects).toEqual({ shop: { name: "My project", repositories: { web: { path: "../web" } } } });
      expect(raw.brain.project).toBe("shop");
      expect(raw.repositories).toBeUndefined();
      expect(() => parseConfig(raw, path.join(dir, "switchyard.config.yaml"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP with projects", () => {
  const connect = async (args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpJs, "--config", env!.cfg.configPath, ...args], cwd: opts.cwd ?? env!.dir, env: childEnv(opts.env) }));
    return client;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client!.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text) as unknown;
  };
  const submitOne = async (goal: string) => ((await call("submit_tasks", { tasks: [summarizeTask({ goal })] })) as { submitted: Array<{ taskId: string }> }).submitted[0]!.taskId;

  it("serves the project from --project, SWITCHYARD_PROJECT, or the working directory; --no-worker runs no worker", async () => {
    env = makeTwoProjects();
    await connect(["--project", "beta", "--no-worker"]);
    const id = await submitOne("In beta");
    const status = (await call("get_task_status", { taskIds: [id] })) as Array<{ project: string; state: string }>;
    expect(status[0]).toMatchObject({ project: "beta", state: "queued" });
    // A tool may name another project; reads default to this server's project.
    const alphaId = ((await call("submit_tasks", { tasks: [summarizeTask({ goal: "In alpha" })], project: "alpha" })) as { submitted: Array<{ taskId: string }> }).submitted[0]!.taskId;
    expect(((await call("get_task_status", {})) as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual([id]);
    expect(((await call("get_task_status", { taskIds: [alphaId] })) as Array<{ state: string }>)[0]!.state).toBe("unknown");
    // The brain tools work in the project's brain.
    await call("brain_start_working_doc", { effort: "e1", title: "Beta work", scope: "test", currentState: "beta state" });
    expect(((await call("brain_read", { path: "projects/beta/working/e1.md", section: "Current State" })) as { content: string }).content).toBe("beta state");
    // No worker: the task is still queued a moment later (a worker would have failed it: no reachable provider).
    await new Promise((r) => setTimeout(r, 1500));
    expect(((await call("get_task_status", { taskIds: [id] })) as Array<{ state: string }>)[0]!.state).toBe("queued");
    await client!.close();

    await connect(["--no-worker"], { env: { SWITCHYARD_PROJECT: "alpha" } });
    expect(((await call("get_task_status", {})) as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual([alphaId]);
    await client!.close();

    await connect(["--no-worker"], { cwd: path.join(env.dir, "beta-app") });
    const fromCwd = await submitOne("From the beta folder");
    expect(((await call("get_task_status", { taskIds: [fromCwd] })) as Array<{ project: string }>)[0]!.project).toBe("beta");
    await client!.close();
    client = undefined;

    // Nothing to choose from: the server refuses to start and lists the projects.
    const r = spawnSync(process.execPath, [mcpJs, "--config", env.cfg.configPath, "--no-worker"], { encoding: "utf8", cwd: env.dir, env: childEnv(), input: "", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/switchyard mcp: .*several projects.*Projects: alpha, beta/);
  }, 120_000);
});

describe("admin API across projects", () => {
  /** A finished physical request charged to `taskId` (or to no task), with optional paid spend. */
  function request(s: Switchyard, id: string, taskId: string | null, paid?: { reserved: number; actual: number | null }) {
    const now = Date.now();
    s.db.prepare("INSERT INTO executions (id, kind, profile, status, created_at) VALUES (?, 'task', 'summarize', 'finished', ?)").run(`x_${id}`, now);
    s.db
      .prepare("INSERT INTO model_requests (id, execution_id, purpose, gateway_model, status, reserved_at, finished_at, est_input_tokens, reserved_output_tokens, input_tokens, output_tokens) VALUES (?, ?, 'task', 'm', 'succeeded', ?, ?, 10, 10, 100, 50)")
      .run(id, `x_${id}`, now, now);
    if (taskId) s.db.prepare("INSERT INTO request_charges (request_id, task_id, input_tokens, output_tokens) VALUES (?, ?, 100, 50)").run(id, taskId);
    if (paid) s.db.prepare("INSERT INTO paid_spend (request_id, key_ref, provider, endpoint_id, reserved_usd, actual_usd, created_at) VALUES (?, 'vault:1', 'p', 'p/m', ?, ?, ?)").run(id, paid.reserved, paid.actual, now);
  }

  it("splits the global dashboard and each project's overview, requests, jobs, and settings", async () => {
    env = makeTwoProjects();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const [a1, a2] = await sy.submitTasks([summarizeTask({ goal: "a1" }), summarizeTask({ goal: "a2" })], { project: "alpha" });
    const [b1] = await sy.submitTasks([summarizeTask({ goal: "b1" })], { project: "beta" });
    const job = await sy.startJob({ goal: "Build it", repositories: ["app"], project: "alpha" });
    sy.db.prepare("INSERT INTO job_questions (task_id, question, asked_at) VALUES (?, 'Which colour?', ?)").run(job.taskId, Date.now());
    request(sy, "r1", a1!.taskId, { reserved: 0.4, actual: 0.5 });
    request(sy, "r2", a2!.taskId);
    request(sy, "r3", b1!.taskId, { reserved: 0.25, actual: null });
    request(sy, "r4", null);

    const grid = projectsGrid(sy);
    expect(grid.map((p) => [p.slug, p.name, p.queuedTasks, p.queuedJobs, p.runningTasks, p.attention])).toEqual([
      ["alpha", "Alpha", 3, 1, 0, 1],
      ["beta", "beta", 1, 0, 0, 0],
    ]);
    expect(grid[0]!.attentionItems[0]).toMatch(/1 question/);
    expect(grid[0]!.repositories).toEqual([expect.objectContaining({ alias: "app", exists: true, path: path.join(env.dir, "alpha-app") })]);
    expect(grid[0]!.lastActivityAt).toBeGreaterThan(0);

    const g = await globalDashboard(sy);
    expect(g.projects.map((p) => [p.slug, p.usage24h.requests, p.usage24h.paidSpendUsd, p.tasksByState.queued ?? 0])).toEqual([
      ["alpha", 2, 0.5, 3],
      ["beta", 1, 0.25, 1],
    ]);
    expect(g.unattributed.usage24h.requests).toBe(1);
    expect(g.totals).toMatchObject({ queuedTasks: 4, queuedJobs: 1, runningJobs: 0 });
    expect(g.totals.usage24h).toMatchObject({ requests: 4, paidSpendUsd: 0.75, tasksSubmitted: 4 });
    expect(g.jobs.map((j) => [j.taskId, j.project, j.pendingQuestions])).toEqual([[job.taskId, "alpha", 1]]);
    expect(g.attention).toContainEqual({ project: "alpha", text: expect.stringMatching(/question/) });
    expect(g.install.tasksByState.queued).toBe(4);

    const b = projectOverview(sy, "beta");
    expect(b.project).toMatchObject({ slug: "beta", archived: false, legacy: false });
    expect(b.usage24h.modelRequests).toBe(1);
    expect(b.usage24h.logicalTasks.submitted).toBe(1);
    expect(b.paidSpendUsd.last24h).toBe(0.25);
    expect(b.jobs).toEqual([]);
    expect(b.attention).toEqual([]);
    const a = projectOverview(sy, "alpha");
    expect(a.usage7d.modelRequests).toBe(2);
    expect(a.activity).toMatchObject({ queuedTasks: 3, queuedJobs: 1 });
    expect(() => projectOverview(sy!, "nope")).toThrow(/unknown project nope/);

    // Requests: all, or one project's.
    expect(requestLog(sy).map((r) => r.id).sort()).toEqual(["r1", "r2", "r3", "r4"]);
    expect(requestLog(sy, { project: "alpha" }).map((r) => [r.id, r.project]).sort()).toEqual([["r1", "alpha"], ["r2", "alpha"]]);
    expect(jobsView(sy, 50, "beta")).toEqual([]);
    expect(jobsView(sy, 50, "alpha").map((j) => j.project)).toEqual(["alpha"]);
    expect(sessionsView(sy, { project: "beta" })).toEqual([]);

    // Settings: global sections vs a project's, edited under projects.<slug>.
    const gs = globalSettings(sy);
    expect(gs.multiProject).toBe(true);
    expect(Object.keys(gs.sections)).not.toContain("projects");
    expect(Object.keys(gs.sections)).not.toContain("repositories");
    expect(gs.sections).toHaveProperty("execution");
    const ps = projectSettings(sy, "beta");
    expect(ps.configKeyPath).toEqual(["projects", "beta"]);
    expect(ps.effective.supervisor.branch_prefix).toBe("beta/job-");
    expect(ps.effective.team.max_agents).toBe(3);
    expect(projectSettings(sy, "alpha").effective.supervisor.branch_prefix).toBe("switchyard/job-");
    expect(patchProjectSettings(sy, "beta", [{ path: ["execution", "max_concurrent_tasks"], value: 9 }])).toMatchObject({ ok: false, errors: [expect.stringMatching(/not a project setting/)] });
    expect(patchProjectSettings(sy, "beta", [{ path: ["team", "provider_concurrency_enabled"], value: true }])).toMatchObject({ ok: false });
    expect(patchProjectSettings(sy, "beta", [{ path: ["team", "max_agents"], value: 5 }])).toEqual({ ok: true });
    expect(sy.projects.get("beta")!.team.max_agents).toBe(5);
    expect(sy.projects.get("alpha")!.team.max_agents).not.toBe(5);
    expect((YAML.parse(readFileSync(env.cfg.configPath, "utf8")) as { projects: { beta: { team: unknown } } }).projects.beta.team).toEqual({ max_agents: 5 });

    // Create and archive from the panel.
    gitRepo(path.join(env.dir, "gamma-app"));
    expect(await createProject(sy, { slug: "Gamma", repositories: {} })).toMatchObject({ ok: false });
    const made = await createProject(sy, { slug: "gamma", name: "Gamma", repositories: { app: { path: "gamma-app" } } });
    expect(made).toMatchObject({ ok: true, convertedLegacy: null, project: { slug: "gamma", name: "Gamma" } });
    expect(sy.projects.slugs()).toEqual(["alpha", "beta", "gamma"]);
    expect(() => archiveProject(sy!, "alpha")).toThrow(/queued task/);
    expect(archiveProject(sy, "gamma").archived).toBe(true);
    expect(projectsGrid(sy).map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(projectsGrid(sy, { includeArchived: true }).map((p) => p.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect((await globalDashboard(sy)).projects.map((p) => p.slug)).toEqual(["alpha", "beta"]);
  }, 60_000);
});
