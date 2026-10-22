import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type { Switchyard } from "../src/core/service.js";
import { archiveProject, deleteProject, previewProjectDeletion } from "../src/admin/insights.js";
import { backfillProjects } from "../src/projects/backfill.js";
import { purgeProjectRows } from "../src/projects/deletion.js";
import { ensurePanel, panelBuildStale, panelStopFile, turnPanelOff } from "../src/operations/panel.js";
import { baseConfig, commitAll, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, summarizeTask, type Env } from "./helpers.js";

// Deleting a project: refused while it has running or queued tasks, for the last live project, and
// on a confirmation that is not its slug; otherwise its rows, logs, artifacts, SwitchYard
// worktrees, settings, and brain folder go, while requests, charges, paid spend, branches, and the
// repository folders stay. Also the panel's power button (turnPanelOff) and the stale-build check.

let env: Env | undefined;
let sy: Switchyard | undefined;
const extra: string[] = [];
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, "init", "-q", "-b", "main");
  commitAll(dir, "init");
}

function makeProjects(projects: Record<string, unknown>, primary = "alpha"): Env {
  const base = baseConfig();
  const e = makeEnv({ config: { ...base, repositories: {}, brain: { path: "brain", project: primary }, projects } });
  for (const slug of Object.keys(projects)) gitRepo(path.join(e.dir, `${slug}-app`));
  return e;
}

const repoOf = (slug: string) => ({ repositories: { app: { path: `${slug}-app` } } });
const client = () => new ScriptedClient((req) => reply(JSON.stringify(goodOutput()), servedFor(sy!, req)));

async function runIn(project: string, goal: string): Promise<string> {
  const [sub] = await sy!.submitTasks([summarizeTask({ goal })], { project });
  const out = await sy!.awaitResults([sub!.taskId], { timeoutSeconds: 15 });
  expect(out.completed[0]?.executionStatus).toBe("completed");
  return sub!.taskId;
}

const count = (sql: string, ...args: unknown[]) => sy!.db.prepare(sql).pluck().get(...args) as number;

describe("deleting a project", () => {
  it("keeps task Lab recovery records until cleanup is proven, then purges dependent rows", async () => {
    env = makeProjects({ alpha: repoOf("alpha"), beta: repoOf("beta") });
    sy = open(env, client(), { worker: true });
    const task = await runIn("beta", "Completed task with retained runtime evidence");
    await sy.close(); sy = open(env, client());
    const now = Date.now();
    sy.db.prepare("INSERT INTO task_workspace_attempts(id,task_id,project_id,run_count,lease_owner,execution_id,source_worktree,writable_alias,repositories_json,state,created_at,updated_at) VALUES('twa_test',?,'beta',1,'old-owner','e-lab','managed-source','app','[]','submitted',?,?)").run(task, now, now);
    sy.db.prepare("INSERT INTO labs(id,project_id,name,state,root,recipe_json,repositories_json,ports_json,env_json,goal,created_at,updated_at,last_activity,kind) VALUES('lab-test','beta','task-test','destroyed','managed-root','{}','[]','{}','{}','',?,?,?,'task_attempt')").run(now, now, now);
    sy.db.prepare("INSERT INTO lab_task_attempts(attempt_id,lab_id,desired_state,phase,checks_json,recipe_json,recipe_digest,deadline_at,created_at,updated_at) VALUES('twa_test','lab-test','stopped','cleanup_blocked','[]','{}','digest',?,?,?)").run(now, now, now);
    sy.db.prepare("INSERT INTO task_lab_operations(id,attempt_id,kind,state,created_at,updated_at) VALUES('op-test','twa_test','cleanup','completed',?,?)").run(now, now);
    sy.db.prepare("INSERT INTO lab_attempt_processes(id,lab_id,attempt_id,kind,logical_name,token,directory,state,created_at,updated_at) VALUES('tap_test','lab-test','twa_test','check','test','token','proof','running',?,?)").run(now, now);
    expect(() => purgeProjectRows(sy!.db, "beta", ["running", "queued"])).toThrow(/cleanup/);
    expect(sy.tasks.get(task)).not.toBeNull();
    sy.db.prepare("UPDATE lab_task_attempts SET phase='pruned'").run();
    expect(() => purgeProjectRows(sy!.db, "beta", ["running", "queued"])).toThrow(/cleanup/);
    sy.db.prepare("UPDATE lab_attempt_processes SET state='stopped'").run();
    expect(purgeProjectRows(sy.db, "beta", ["running", "queued"]).tasks).toBe(1);
    expect(count("SELECT count(*) FROM task_workspace_attempts")).toBe(0);
    expect(count("SELECT count(*) FROM lab_attempt_processes")).toBe(0);
    expect(count("SELECT count(*) FROM labs")).toBe(0);
    expect(sy.projects.rows().some(row => row.id === "alpha")).toBe(true);
    expect(sy.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("previews, refuses a wrong confirmation and active tasks, then removes the project and keeps accounting", async () => {
    env = makeProjects({ alpha: repoOf("alpha"), beta: repoOf("beta") });
    sy = open(env, client(), { worker: true });
    const storage = env.cfg.storageDir;
    const alphaTask = await runIn("alpha", "In alpha");
    const betaTask = await runIn("beta", "In beta");
    // Reopen without the worker, so a task set back to queued below stays queued.
    await sy.close();
    sy = open(env, client());

    // Extra state a job leaves: a channel post, paid spend on its request, worktrees, brain notes.
    const now = Date.now();
    sy.db.prepare("INSERT INTO job_channel (job_id, author_role, author_label, kind, refs_json, text, created_at) VALUES (?, 'supervisor', 's', 'finding', '[]', 'a post', ?)").run(betaTask, now);
    sy.db.prepare("INSERT INTO job_channel (job_id, author_role, author_label, kind, refs_json, text, created_at) VALUES (?, 'supervisor', 's', 'finding', '[]', 'a post', ?)").run(alphaTask, now);
    const betaRequest = sy.db.prepare("SELECT request_id FROM request_charges WHERE task_id = ?").pluck().get(betaTask) as string;
    expect(betaRequest).toBeTruthy();
    sy.db.prepare("INSERT INTO paid_spend (request_id, key_ref, provider, endpoint_id, reserved_usd, actual_usd, created_at) VALUES (?, 'vault:1', 'openrouter', 'e', 0.01, 0.01, ?)").run(betaRequest, now);
    const wtRoot = path.join(storage, "worktrees");
    mkdirSync(wtRoot, { recursive: true });
    const betaApp = path.join(env.dir, "beta-app");
    const alphaApp = path.join(env.dir, "alpha-app");
    const betaCoding = path.join(wtRoot, `${betaTask}-r1-abc`);
    const betaJob = path.join(wtRoot, `job-${betaTask}-app`);
    const alphaCoding = path.join(wtRoot, `${alphaTask}-r1-abc`);
    git(betaApp, "worktree", "add", "-q", "--detach", betaCoding, "HEAD");
    git(betaApp, "worktree", "add", "-q", "-b", `switchyard/job-${betaTask}`, betaJob, "HEAD");
    git(alphaApp, "worktree", "add", "-q", "--detach", alphaCoding, "HEAD");
    const brain = sy.brainFor("beta");
    await brain.ensure();
    await sy.brainFor("alpha").ensure();
    writeFileSync(path.join(brain.root, "projects", "beta", "working", "notes.md"), "# Notes\n\nwritten outside SwitchYard\n");
    const sessionLogs = (sy.db.prepare("SELECT log_path FROM sessions WHERE project_id = 'beta'").pluck().all() as string[]).map((f) => path.resolve(storage, f));
    expect(sessionLogs.length).toBeGreaterThan(0);
    expect(sessionLogs.every((f) => existsSync(f))).toBe(true);

    const preview = await previewProjectDeletion(sy, "beta");
    expect(preview.blockers).toEqual([]);
    expect(preview.counts).toMatchObject({ tasks: 1, sessions: sessionLogs.length, worktrees: 2 });
    expect(preview.counts.brainEntries).toBeGreaterThanOrEqual(1);
    expect(preview.kept).toMatchObject({ requests: 1, paidRequests: 1 });
    expect(preview.removes.join(" ")).toMatch(/1 task \(0 of them jobs\)/);
    expect(preview.keeps.join(" ")).toMatch(/Its repository folder and every branch in it, untouched/);

    await expect(deleteProject(sy, "beta", { confirm: "bet" })).rejects.toThrow(/type the project's slug to confirm: expected "beta"/);
    sy.db.prepare("UPDATE tasks SET state = 'queued' WHERE id = ?").run(betaTask);
    expect((await previewProjectDeletion(sy, "beta")).blockers.join(" ")).toMatch(/0 running and 1 queued/);
    await expect(deleteProject(sy, "beta", { confirm: "beta" })).rejects.toThrow(/cannot be deleted: it has 0 running and 1 queued/);
    sy.db.prepare("UPDATE tasks SET state = 'completed' WHERE id = ?").run(betaTask);
    // Nothing was removed by the refusals.
    expect(sy.projects.slugs()).toEqual(["alpha", "beta"]);
    expect(count("SELECT COUNT(*) FROM tasks WHERE project_id = 'beta'")).toBe(1);

    const r = await deleteProject(sy, "beta", { confirm: "beta" });
    expect(r.problems).toEqual([]);
    expect(r.removed).toMatchObject({ tasks: 1, sessions: sessionLogs.length, worktrees: 2 });
    expect(r.newPrimary).toBeNull();
    expect(r.brainCommit).toMatch(/^[0-9a-f]{40}$/);

    // Settings: gone from the config (previous file backed up) and from this process.
    const cfgText = readFileSync(env.cfg.configPath, "utf8");
    expect((YAML.parse(cfgText) as { projects: Record<string, unknown> }).projects).not.toHaveProperty("beta");
    expect(readFileSync(`${env.cfg.configPath}.bak`, "utf8")).toMatch(/beta/);
    expect(sy.projects.slugs()).toEqual(["alpha"]);

    // Rows: the project's are gone; alpha's stay; requests, charges, and spend stay, unlinked.
    for (const table of ["tasks", "sessions", "job_state", "job_plans", "brain_grants", "brain_access_requests"]) expect(count(`SELECT COUNT(*) FROM ${table} WHERE project_id = 'beta'`)).toBe(0);
    expect(count("SELECT COUNT(*) FROM projects WHERE id = 'beta'")).toBe(0);
    expect(count("SELECT COUNT(*) FROM events WHERE task_id = ?", betaTask)).toBe(0);
    expect(count("SELECT COUNT(*) FROM artifacts WHERE task_id = ?", betaTask)).toBe(0);
    expect(count("SELECT COUNT(*) FROM job_channel WHERE job_id = ?", betaTask)).toBe(0);
    expect(count("SELECT COUNT(*) FROM tasks WHERE id = ?", alphaTask)).toBe(1);
    expect(count("SELECT COUNT(*) FROM sessions WHERE project_id = 'alpha'")).toBeGreaterThan(0);
    expect(sy.db.prepare("SELECT project_id FROM model_requests WHERE id = ?").pluck().get(betaRequest)).toBe("");
    // The request stays (accounting); its charge to the deleted task goes, and every foreign key holds.
    expect(count("SELECT COUNT(*) FROM request_charges WHERE request_id = ?", betaRequest)).toBe(0);
    expect(sy.db.pragma("foreign_key_check")).toEqual([]);
    expect(count("SELECT COUNT(*) FROM paid_spend WHERE request_id = ?", betaRequest)).toBe(1);
    // The channel stays append-only for everyone else.
    expect(count("SELECT COUNT(*) FROM job_channel WHERE job_id = ?", alphaTask)).toBe(1);
    expect(() => sy!.db.prepare("DELETE FROM job_channel").run()).toThrow(/append-only/);
    expect(sy.db.pragma("foreign_keys", { simple: true })).toBe(1);

    // Files: session logs and the task's artifacts are gone.
    expect(sessionLogs.some((f) => existsSync(f))).toBe(false);
    expect(existsSync(path.join(storage, "artifacts", betaTask))).toBe(false);

    // Worktrees: SwitchYard's are removed, the branch and the repository folder stay; alpha's stays.
    expect(existsSync(betaCoding)).toBe(false);
    expect(existsSync(betaJob)).toBe(false);
    expect(git(betaApp, "worktree", "list", "--porcelain")).not.toMatch(new RegExp(betaTask));
    expect(git(betaApp, "branch", "--list", `switchyard/job-${betaTask}`).trim()).not.toBe("");
    expect(readFileSync(path.join(betaApp, "README.md"), "utf8")).toBe("# repo\n");
    expect(existsSync(alphaCoding)).toBe(true);

    // Brain: the folder is gone in one commit with the reason; the outside edit stays in history.
    expect(existsSync(path.join(brain.root, "projects", "beta"))).toBe(false);
    expect(existsSync(path.join(brain.root, "projects", "alpha"))).toBe(true);
    const log = git(brain.root, "log", "-1", "--format=%s%n%b", "--", "projects/beta");
    expect(log).toMatch(/Remove project beta/);
    expect(log).toMatch(/Remove-Reason: project beta was deleted/);
    expect(git(brain.root, "log", "--format=%s", "--", "projects/beta/working/notes.md")).toMatch(/Record edits made outside SwitchYard/);
    expect(readFileSync(path.join(brain.root, "README.md"), "utf8")).not.toMatch(/projects\/beta/);
    expect(count("SELECT COUNT(*) FROM brain_files WHERE path LIKE 'projects/beta/%'")).toBe(0);

    // A restart's backfill leaves the unlinked requests global (their charges name deleted tasks).
    backfillProjects(sy.db, "alpha");
    expect(sy.db.prepare("SELECT project_id FROM model_requests WHERE id = ?").pluck().get(betaRequest)).toBe("");

    // The last live project cannot be deleted.
    const last = await previewProjectDeletion(sy, "alpha");
    expect(last.blockers.join(" ")).toMatch(/only project/);
    await expect(deleteProject(sy, "alpha", { confirm: "alpha" })).rejects.toThrow(/only project/);
    await expect(deleteProject(sy, "beta", { confirm: "beta" })).rejects.toThrow(/unknown project beta/);
  }, 90_000);

  it("refuses the last live project when the others are archived, deletes an archived one, and moves the primary", async () => {
    env = makeProjects({ alpha: repoOf("alpha"), beta: repoOf("beta"), gamma: repoOf("gamma") });
    sy = open(env, client());
    archiveProject(sy, "beta");
    archiveProject(sy, "gamma");
    expect((await previewProjectDeletion(sy, "alpha")).blockers.join(" ")).toMatch(/last project that is not archived/);
    await expect(deleteProject(sy, "alpha", { confirm: "alpha" })).rejects.toThrow(/last project that is not archived/);

    // An archived project can go: alpha stays live.
    const gone = await deleteProject(sy, "gamma", { confirm: "gamma" });
    expect(gone.problems).toEqual([]);
    expect(sy.projects.slugs()).toEqual(["alpha", "beta"]);

    // Deleting the primary project moves brain.project to a live project.
    sy.db.prepare("UPDATE projects SET archived_at = NULL WHERE id = 'beta'").run();
    const r = await deleteProject(sy, "alpha", { confirm: "alpha" });
    expect(r.newPrimary).toBe("beta");
    expect((YAML.parse(readFileSync(env.cfg.configPath, "utf8")) as { brain: { project: string } }).brain.project).toBe("beta");
    expect(sy.projects.primary.project.slug).toBe("beta");
    expect(r.problems).toEqual([]);
    expect(existsSync(path.join(env.dir, "alpha-app", "README.md"))).toBe(true);
  }, 60_000);

  it("refuses the single-project config", async () => {
    env = makeEnv();
    sy = open(env, client());
    const p = await previewProjectDeletion(sy, "demo");
    expect(p.legacy).toBe(true);
    expect(p.blockers.join(" ")).toMatch(/single-project config/);
    await expect(deleteProject(sy, "demo", { confirm: "demo" })).rejects.toThrow(/single-project config/);
  });
});

describe("panel power and build freshness", () => {
  it("turnPanelOff records the stop and exits after responding; background starts then leave it off", async () => {
    env = makeEnv({ config: baseConfig({ panel: { port: 1, auto_start: true } }) });
    let exited = 0;
    const out = turnPanelOff(env.cfg, { delayMs: 20, exit: () => exited++ });
    expect(out.marker).toBe(panelStopFile(env.cfg));
    expect(existsSync(panelStopFile(env.cfg))).toBe(true);
    expect(exited).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(exited).toBe(1);
    expect((await ensurePanel(env.cfg, { waitMs: 0 })).state).toBe("stopped");
  });

  it("reports a panel build older than the router build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "switchyard-stale-"));
    extra.push(dir);
    const panel = path.join(dir, "panel");
    const router = path.join(dir, "dist");
    mkdirSync(path.join(panel, ".next"), { recursive: true });
    mkdirSync(path.join(router, "admin"), { recursive: true });
    writeFileSync(path.join(panel, ".next", "BUILD_ID"), "x");
    writeFileSync(path.join(router, "admin", "insights.js"), "x");
    const t = Date.now() / 1000;
    utimesSync(path.join(panel, ".next", "BUILD_ID"), t - 60, t - 60);
    utimesSync(path.join(router, "admin", "insights.js"), t, t);
    expect(panelBuildStale(panel, router)).toMatch(/older than the router build .* rebuild it/);
    utimesSync(path.join(panel, ".next", "BUILD_ID"), t + 60, t + 60);
    expect(panelBuildStale(panel, router)).toBeNull();
    expect(panelBuildStale(path.join(dir, "unbuilt"), router)).toBeNull();
  });
});
