import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { projectRuntimeActivationRoots } from "../src/workspaces/worktree.js";
import { projectRuntimePaths, assertRuntimeCwdSupported, PROJECT_RUNTIME_DIRECTORY } from "../src/projects/runtime-paths.js";
import { projectContext } from "../src/projects/context.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { baseConfig, makeEnv, commitAll, type Env } from "./helpers.js";

// ---------- unit tests of the pure root function ----------

describe("projectRuntimeActivationRoots", () => {
  it("keeps the exact legacy layout when there is no project directory", () => {
    const roots = projectRuntimeActivationRoots({ storageDir: "/install/.meritrouter", projectDirectory: null });
    expect(roots).toEqual({
      worktrees: path.join("/install/.meritrouter", "worktrees"),
      agentHome: path.join("/install/.meritrouter", "agent-home"),
      split: false,
    });
  });

  it("keeps the exact legacy layout when a project directory is set but storage is still the installation's", () => {
    // This is today's production shape: ProjectRegistry sets `projectDirectory` from config but
    // never overlays `storageDir`, so a project with a configured directory still shares the
    // installation's storage until the project runtime registry (B1) activates its split store.
    const projectDirectory = process.platform === "win32" ? "C:\\work\\my-project" : "/work/my-project";
    const roots = projectRuntimeActivationRoots({ storageDir: "/install/.meritrouter", projectDirectory });
    expect(roots.split).toBe(false);
    expect(roots.worktrees).toBe(path.join("/install/.meritrouter", "worktrees"));
    expect(roots.agentHome).toBe(path.join("/install/.meritrouter", "agent-home"));
  });

  it("moves to the project's readable runtime root when storageDir already is the project's own state directory", () => {
    const projectDirectory = process.platform === "win32" ? "C:\\work\\my-project" : "/work/my-project";
    const paths = projectRuntimePaths(projectDirectory);
    const roots = projectRuntimeActivationRoots({ storageDir: paths.state, projectDirectory });
    expect(roots.split).toBe(true);
    expect(roots.worktrees).toBe(path.join(paths.root, "worktrees"));
    expect(roots.agentHome).toBe(path.join(paths.root, "agent-home"));
  });

  it("matches split mode case-insensitively on win32 but not elsewhere", () => {
    const projectDirectory = process.platform === "win32" ? "C:\\Work\\My-Project" : "/work/my-project";
    const paths = projectRuntimePaths(projectDirectory);
    const caseVaried = paths.state.toUpperCase();
    const roots = projectRuntimeActivationRoots({ storageDir: caseVaried, projectDirectory });
    if (process.platform === "win32") {
      expect(roots.split).toBe(true);
      expect(roots.worktrees).toBe(path.join(paths.root, "worktrees"));
    } else {
      // POSIX paths are case-sensitive, so an upper-cased state directory does not match and the
      // context stays legacy (its storageDir is treated as the installation's own, verbatim).
      expect(roots.split).toBe(false);
      expect(roots.worktrees).toBe(path.join(caseVaried, "worktrees"));
    }
  });

  it("treats a context with no explicit projectDirectory field (plain ResolvedConfig shape) as legacy", () => {
    const roots = projectRuntimeActivationRoots({ storageDir: "/install/.meritrouter" });
    expect(roots.split).toBe(false);
    expect(roots.worktrees).toBe(path.join("/install/.meritrouter", "worktrees"));
  });

  it("refuses a split-mode worktree whose Windows cwd would exceed the supported length", () => {
    const projectDirectory = process.platform === "win32"
      ? "C:\\" + "deeply-nested-directory-name-".repeat(6)
      : "/deeply-nested-directory-name-".repeat(6);
    const paths = projectRuntimePaths(projectDirectory);
    const roots = projectRuntimeActivationRoots({ storageDir: paths.state, projectDirectory });
    expect(roots.split).toBe(true);
    const candidateWorktree = path.join(roots.worktrees, "task-fixture-r1-abc123");
    if (process.platform === "win32" && candidateWorktree.length > 240) {
      expect(() => assertRuntimeCwdSupported(candidateWorktree)).toThrow(/240-character/);
    } else {
      // Not on win32, or the fixture path happened to stay short: the assertion is a no-op/passes.
      expect(() => assertRuntimeCwdSupported(candidateWorktree)).not.toThrow();
    }
  });
});

// ---------- containment check: TaskAttemptSource.sourcePath via register() ----------

let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined, splitDir: string | undefined;

afterEach(async () => {
  if (manager) await manager.close();
  db?.close();
  env?.cleanup();
  if (splitDir) rmSync(splitDir, { recursive: true, force: true });
  manager = undefined;
  db = undefined;
  env = undefined;
  splitDir = undefined;
});

function setupSplit() {
  env = makeEnv({
    config: baseConfig({
      repositories: {},
      brain: { path: "brain", project: "alpha" },
      projects: { alpha: { repositories: { app: { path: "repo" } } } },
    }),
  });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  splitDir = mkdtempSync(path.join(tmpdir(), "meritrouter-split-project-"));
  const paths = projectRuntimePaths(splitDir);
  mkdirSync(paths.state, { recursive: true });
  const legacy = registry.require("alpha");
  // The shape `ProjectRuntimeRegistry.openRegistered` builds (runtime-registry.ts ~line 68): same
  // global config, overlaid with the project's own directory and its split `storageDir`.
  const split = projectContext(env.cfg, {
    project: legacy.project,
    projectDirectory: splitDir,
    repositories: legacy.repositories,
    repositoryPaths: legacy.repositoryPaths,
    storageDir: paths.state,
  });
  manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: (slug) => (slug === "alpha" ? split : registry.require(slug)), monitor: false });
  return { manager, split, paths };
}

async function registerFrom(m: LabManager, worktreeRoot: string, id: string) {
  const spec = WorkerTaskSchema.parse({ id, profile: "implement", goal: "change fixture value", repositoryAliases: ["app"], writableRepository: "app", constraints: { allowedPaths: ["app.txt"], acceptanceCriteria: ["works"] } });
  new TaskStore(db!).submit([spec], { project: "alpha" });
  db!.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,run_count=1,deadline_at=? WHERE id=?").run(Date.now() + 120000, Date.now() + 120000, id);
  const base = (await git(env!.repo, ["rev-parse", "HEAD"])).trim();
  const workspace = await new Worktrees(db!, worktreeRoot).prepare({ taskId: id, run: 1, alias: "app", sourcePath: env!.repo, baseCommit: base });
  writeFileSync(path.join(workspace.worktreePath, "app.txt"), "changed");
  commitAll(workspace.worktreePath, `fixture change\n\nAgent: fixture\nModel: fake/model\nTask: ${id}`);
  const commit = (await git(workspace.worktreePath, ["rev-parse", "HEAD"])).trim();
  const executionId = `execution-${id}`, sessionId = `session-${id}`;
  db!.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'task','implement','running',?)").run(executionId, Date.now());
  db!.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,?,?)").run(executionId, id, id);
  db!.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at) VALUES(?,?,'implementer','fixture','implement','running','fixture',?,?,?)")
    .run(sessionId, id, JSON.stringify({ repos: [{ alias: "app", worktree: workspace.worktreePath, branch: null, baseCommit: base, head: commit }] }), Date.now(), Date.now());
  return m.taskAttempts.register({ taskId: id, project: "alpha", runCount: 1, leaseOwner: "worker", executionId, sessionId, sourceWorktree: workspace.worktreePath, writableAlias: "app", repositories: [{ alias: "app", sourcePath: env!.repo, baseCommit: base, head: commit }] });
}

describe("task-attempt containment uses the same split-mode root as worktree creation", () => {
  it("registers a task attempt whose worktree sits under the project's split runtime root", async () => {
    const { manager: m, split } = setupSplit();
    const roots = projectRuntimeActivationRoots(split);
    expect(roots.split).toBe(true);
    const handle = await registerFrom(m, roots.worktrees, "split-accepted");
    expect(handle.taskId).toBe("split-accepted");
  }, 30000);

  it("refuses a worktree that is outside the split root (for example, under the legacy installation worktrees directory) while the project runs split", async () => {
    const { manager: m } = setupSplit();
    const legacyRoot = path.join(env!.cfg.storageDir, "worktrees");
    await expect(registerFrom(m, legacyRoot, "split-refused")).rejects.toThrow(/managed isolated task worktree/);
  }, 30000);
});

describe("legacy same-DB projects keep exactly today's worktree/agent-home paths", () => {
  it("places worktrees directly under storageDir when there is no split project directory", () => {
    expect(PROJECT_RUNTIME_DIRECTORY).toBe(".MeritRouter");
    const cfg = { storageDir: path.join(tmpdir(), "install-dir", ".meritrouter"), projectDirectory: null };
    expect(projectRuntimeActivationRoots(cfg).worktrees).toBe(path.join(cfg.storageDir, "worktrees"));
    expect(projectRuntimeActivationRoots(cfg).agentHome).toBe(path.join(cfg.storageDir, "agent-home"));
  });
});
