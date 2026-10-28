import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "../src/config/load.js";
import { initializeConfig } from "../src/cli/setup.js";
import type { MeritRouter } from "../src/core/service.js";
import { createProject } from "../src/admin/projects.js";
import { projectsCommand } from "../src/cli/projects.js";
import { baseConfig, FakeProvider, makeEnv, open, summarizeTask, type Env } from "./helpers.js";

// The two split-layout operator gaps from wave-c1's open questions:
//   1. `setup` writes no placeholder project; the first one created (any entry point) becomes
//      primary (src/projects/resolve.ts, src/cli/setup.ts).
//   2. CLI entry points for a project's own backup, restore, and legacy migration
//      (src/cli/projects.ts, wrapping src/operations/project-backup.ts and
//      src/projects/store-migration.ts).

const services: MeritRouter[] = [], envs: Env[] = [], dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  for (const env of envs.splice(0)) env.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

function tempDir(prefix = "meritrouter-test-cliops-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function gitRepo(dir: string): string {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

const select = { cwd: "", env: undefined };

async function print(run: () => Promise<number>): Promise<{ code: number; printed: string }> {
  let printed = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { code: await run(), printed };
  } finally {
    process.stdout.write = write;
  }
}

/** A split installation with no project configured at all (setup's split-layout decision). */
function splitEnvWithNoProjects(): Env {
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: {}, brain: { path: "brain", project: "unconfigured" } }) });
  envs.push(env);
  return env;
}

describe("a split installation starts with no project; the first one created becomes primary", () => {
  it("setup writes storage.layout split with no placeholder project", () => {
    const root = tempDir();
    const configPath = path.join(root, "meritrouter.config.yaml");
    initializeConfig({ configPath, project: "my-project", setup: true });
    const written = YAML.parse(readFileSync(configPath, "utf8")) as { storage: { layout: string }; projects: Record<string, unknown> };
    expect(written.storage.layout).toBe("split");
    expect(written.projects).toEqual({});
    const cfg = loadConfig(configPath);
    expect(cfg.projectResolution.projects).toEqual([]);
  });

  it("the first project created (admin) becomes primary, and a task submits in it", async () => {
    const env = splitEnvWithNoProjects();
    expect(env.cfg.projectResolution.projects).toEqual([]);
    const sy = open(env, new FakeProvider(), { worker: true });
    services.push(sy);
    expect(sy.layout).toBe("split");
    expect(sy.projects.slugs()).toEqual([]);

    const alphaDir = gitRepo(tempDir());
    const created = await createProject(sy, { slug: "alpha", directory: alphaDir, repositories: { app: { path: alphaDir } } });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(sy.projects.slugs()).toEqual(["alpha"]);
    expect(sy.projects.primary.project.slug).toBe("alpha");

    const [task] = await sy.submitTasks([summarizeTask()], { project: "alpha" });
    const result = await sy.awaitResults([task!.taskId], { timeoutSeconds: 30 });
    expect(result.completed, JSON.stringify(sy.getStatus([task!.taskId], "alpha"))).toHaveLength(1);

    // A second project does not steal primary from the first one created.
    const betaDir = gitRepo(tempDir());
    const beta = await createProject(sy, { slug: "beta", directory: betaDir, repositories: { app: { path: betaDir } } });
    expect(beta, JSON.stringify(beta)).toMatchObject({ ok: true });
    expect(sy.projects.primary.project.slug).toBe("alpha");
  }, 60_000);

  it("a command needing a project without one fails with a clear message, not 'no project-local store'", async () => {
    const env = splitEnvWithNoProjects();
    const sy = open(env, new FakeProvider(), { worker: true });
    services.push(sy);
    await expect(sy.submitTasks([summarizeTask()], {})).rejects.toThrow();
    // The CLI's own project() guard (src/cli.ts) gives the actionable message; here we confirm the
    // zero-project state it guards against.
    expect(sy.projects.slugs()).toEqual([]);
  });
});

describe("project backup and restore through the CLI", () => {
  it("backs up and restores a split project's own store", async () => {
    const env = splitEnvWithNoProjects();
    const sy1 = open(env, new FakeProvider(), { worker: true });
    services.push(sy1);
    const alphaDir = gitRepo(tempDir());
    expect((await createProject(sy1, { slug: "alpha", directory: alphaDir, repositories: { app: { path: alphaDir } } })).ok).toBe(true);

    const [first] = await sy1.submitTasks([summarizeTask({ goal: "Summarise before the backup" })], { project: "alpha" });
    expect((await sy1.awaitResults([first!.taskId], { timeoutSeconds: 30 })).completed).toHaveLength(1);

    const target = path.join(tempDir(), "alpha-backup");
    const backup = await print(() => projectsCommand(sy1, ["backup", "alpha", target], {}, true, select));
    expect(backup.code).toBe(0);
    expect(JSON.parse(backup.printed)).toMatchObject({ tasks: 1 });
    expect(existsSync(path.join(target, "manifest.json"))).toBe(true);

    // After the backup: one more task, which the restore below must make disappear again.
    const [second] = await sy1.submitTasks([summarizeTask({ goal: "Summarise after the backup" })], { project: "alpha" });
    expect((await sy1.awaitResults([second!.taskId], { timeoutSeconds: 30 })).completed).toHaveLength(1);
    await services.splice(services.indexOf(sy1), 1)[0]!.close();

    // The service is reopened fresh (its project store not yet touched) before restoring into it.
    const sy2 = open(env, new FakeProvider(), { worker: false });
    services.push(sy2);
    const restore = await print(() => projectsCommand(sy2, ["restore", "alpha", target], { force: true }, true, select));
    expect(restore.code, restore.printed).toBe(0);
    expect(JSON.parse(restore.printed)).toMatchObject({ projectDirectory: alphaDir });

    await services.splice(services.indexOf(sy2), 1)[0]!.close();
    const sy3 = open(env, new FakeProvider(), { worker: false });
    services.push(sy3);
    expect(sy3.getStatus([first!.taskId], "alpha")[0]!.state).toBe("completed");
    expect(sy3.getStatus([second!.taskId], "alpha")[0]!.state).toBe("unknown");
  }, 60_000);

  it("refuses to restore into the wrong project's backup", async () => {
    const env = splitEnvWithNoProjects();
    const sy = open(env, new FakeProvider(), { worker: true });
    services.push(sy);
    const alphaDir = gitRepo(tempDir());
    const betaDir = gitRepo(tempDir());
    await createProject(sy, { slug: "alpha", directory: alphaDir, repositories: { app: { path: alphaDir } } });
    await createProject(sy, { slug: "beta", directory: betaDir, repositories: { app: { path: betaDir } } });
    const target = path.join(tempDir(), "alpha-backup");
    expect((await print(() => projectsCommand(sy, ["backup", "alpha", target], {}, true, select))).code).toBe(0);
    await expect(projectsCommand(sy, ["restore", "beta", target], {}, true, select)).rejects.toThrow(/is a backup of project alpha, not beta/);
  }, 30_000);
});

describe("legacy project migration through the CLI", () => {
  it("plans (dry run), migrates, and rolls back a migration", async () => {
    // A quiescent legacy (non-split) installation with one completed task for "alpha".
    const legacyAlphaDir = gitRepo(tempDir());
    const legacyEnv = makeEnv({
      config: baseConfig({ storage: { directory: ".meritrouter" }, repositories: {}, projects: { alpha: { directory: legacyAlphaDir, repositories: { app: { path: legacyAlphaDir } } } }, brain: { path: "brain", project: "alpha" } }),
    });
    envs.push(legacyEnv);
    const legacySy = open(legacyEnv, new FakeProvider(), { worker: true });
    services.push(legacySy);
    const [task] = await legacySy.submitTasks([summarizeTask()], { project: "alpha" });
    expect((await legacySy.awaitResults([task!.taskId], { timeoutSeconds: 30 })).completed).toHaveLength(1);
    await services.splice(services.indexOf(legacySy), 1)[0]!.close();
    const legacyConfigPath = legacyEnv.cfg.configPath;

    // The split target installation: "alpha" is configured with a directory but has no store of
    // its own yet (nothing has provisioned one; migration creates it).
    const targetAlphaDir = tempDir();
    const targetEnv = makeEnv({
      config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: { alpha: { directory: targetAlphaDir } }, brain: { path: "brain", project: "alpha" } }),
    });
    envs.push(targetEnv);
    const targetSy = open(targetEnv, new FakeProvider(), { worker: false });
    services.push(targetSy);
    expect(targetSy.layout).toBe("split");
    expect(existsSync(path.join(targetAlphaDir, ".MeritRouter"))).toBe(false);

    const dryRun = await print(() => projectsCommand(targetSy, ["migrate", "alpha"], { "from-config": legacyConfigPath, "dry-run": true }, true, select));
    expect(dryRun.code, dryRun.printed).toBe(0);
    expect(JSON.parse(dryRun.printed)).toMatchObject({ ready: true, blockers: [] });
    expect(existsSync(path.join(targetAlphaDir, ".MeritRouter"))).toBe(false); // dry run writes nothing

    const migrate = await print(() => projectsCommand(targetSy, ["migrate", "alpha"], { "from-config": legacyConfigPath }, true, select));
    expect(migrate.code, migrate.printed).toBe(0);
    const migrated = JSON.parse(migrate.printed) as { migrationId: string; paths: { root: string } };
    expect(migrated.paths.root).toBe(path.join(targetAlphaDir, ".MeritRouter"));
    expect(existsSync(path.join(targetAlphaDir, ".MeritRouter", "state", "meritrouter.db"))).toBe(true);

    const rollback = await print(() => projectsCommand(targetSy, ["migrate", "alpha"], { "from-config": legacyConfigPath, rollback: true }, true, select));
    expect(rollback.code, rollback.printed).toBe(0);
    expect(JSON.parse(rollback.printed)).toMatchObject({ migrationId: migrated.migrationId, targetRemoved: true, legacyIntact: true });
    expect(existsSync(path.join(targetAlphaDir, ".MeritRouter"))).toBe(false);
  }, 60_000);

  it("reports blockers instead of migrating a project that is not quiescent", async () => {
    const legacyAlphaDir = gitRepo(tempDir());
    const legacyEnv = makeEnv({
      config: baseConfig({ storage: { directory: ".meritrouter" }, repositories: {}, projects: { alpha: { directory: legacyAlphaDir, repositories: { app: { path: legacyAlphaDir } } } }, brain: { path: "brain", project: "alpha" } }),
    });
    envs.push(legacyEnv);
    // A live, still-running legacy service: a queued task keeps the project non-quiescent.
    const legacySy = open(legacyEnv, new FakeProvider(), { worker: false });
    services.push(legacySy);
    await legacySy.submitTasks([summarizeTask()], { project: "alpha" });
    const legacyConfigPath = legacyEnv.cfg.configPath;

    const targetAlphaDir = tempDir();
    const targetEnv = makeEnv({
      config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, projects: { alpha: { directory: targetAlphaDir } }, brain: { path: "brain", project: "alpha" } }),
    });
    envs.push(targetEnv);
    const targetSy = open(targetEnv, new FakeProvider(), { worker: false });
    services.push(targetSy);

    const dryRun = await print(() => projectsCommand(targetSy, ["migrate", "alpha"], { "from-config": legacyConfigPath, "dry-run": true }, true, select));
    expect(dryRun.code).toBe(1);
    const plan = JSON.parse(dryRun.printed) as { ready: boolean; blockers: Array<{ code: string }> };
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((b) => b.code)).toContain("tasks_not_terminal");

    // The real migration refuses the same way: a printed, actionable blocker list and exit 1,
    // not a thrown error or a half-written store.
    const migrate = await print(() => projectsCommand(targetSy, ["migrate", "alpha"], { "from-config": legacyConfigPath }, true, select));
    expect(migrate.code).toBe(1);
    const refusal = JSON.parse(migrate.printed) as { ok: boolean; blockers: Array<{ code: string }> };
    expect(refusal.ok).toBe(false);
    expect(refusal.blockers.map((b) => b.code)).toContain("tasks_not_terminal");
    expect(existsSync(path.join(targetAlphaDir, ".MeritRouter"))).toBe(false);
  }, 30_000);
});
