import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "../src/workspaces/repository-mutation.js";
import { Worktrees, type Workspace } from "../src/workspaces/worktree.js";
import { prepareRepository } from "../src/workspaces/repository-prepare.js";
import { prepareProjectRepositories } from "../src/projects/repository-setup.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { git } from "../src/workspaces/git.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; env?.cleanup(); env = undefined; });
function fixture() {
  env = makeEnv({ files: { "app.txt": "initial" } }); db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db);
  tasks.submit([WorkerTaskSchema.parse({ id: "fixture", profile: "implement", goal: "fixture", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["checked"] } })], { project: "demo" });
  const root = path.join(env.dir, "worktrees"), worktrees = new Worktrees(db, root);
  return { tasks, root, worktrees };
}
async function pending(repo: string, mutation?: RepositoryMutationCapability) {
  writeFileSync(path.join(repo, "pending.txt"), "committed effect awaiting index reconciliation");
  const result = await commitSelectedApplication(repo, { actor: { agent: "fixture", role: "implementer" }, message: "pending fixture", paths: ["pending.txt"] },
    { ...(mutation ? { mutation } : {}), refPublished: async () => { throw new Error("injected index boundary failure"); } });
  expect(result.kind).toBe("reconciliation_required");
  return { head: (await git(repo, ["rev-parse", "HEAD"])).trim(), index: readFileSync(path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).trim())) };
}
async function prepared(worktrees: Worktrees, sourcePath = env!.repo) {
  return worktrees.prepare({ taskId: "fixture", run: 1, alias: "core", sourcePath });
}
const row = () => db!.prepare("SELECT * FROM workspaces WHERE task_id='fixture'").get();
const sha = (bytes: Buffer) => createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");

describe("metadata-safe workspace lifecycle", () => {
  it("refuses pending source preparation before directory/status writes", async () => {
    const { worktrees, root } = fixture(), before = await pending(env!.repo);
    await expect(prepared(worktrees)).rejects.toBeInstanceOf(RepositoryMutationError);
    expect(row()).toBeUndefined(); expect(existsSync(root)).toBe(false);
    expect((await git(env!.repo, ["rev-parse", "HEAD"])).trim()).toBe(before.head);
    expect(readFileSync(path.join(env!.repo, ".git", "index"))).toEqual(before.index);
  });
  it("refuses retained pending-worktree reuse before replacing the latest workspace pointer", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees); await pending(ws.worktreePath);
    const before = row();
    await expect(worktrees.prepare({ taskId: "fixture", run: 2, alias: "core", sourcePath: env!.repo })).rejects.toBeInstanceOf(RepositoryMutationError);
    expect(row()).toEqual(before); expect(existsSync(ws.worktreePath)).toBe(true);
  });
  it("rechecks a replacement attempt's pending receipt after an already admitted caller waits", async () => {
    const { worktrees } = fixture(); await prepared(worktrees);
    let waiting!: Promise<Workspace>, latest!: Workspace;
    await withRepositoryMutation([env!.repo], async mutation => {
      // The caller arrives before the replacement attempt/receipt and waits on this owner.
      waiting = worktrees.prepare({ taskId: "fixture", run: 3, alias: "core", sourcePath: env!.repo }, { timeoutMs: 30000 });
      void waiting.catch(() => undefined);
      latest = await worktrees.prepare({ taskId: "fixture", run: 2, alias: "core", sourcePath: env!.repo }, { mutation });
      await pending(latest.worktreePath, mutation);
    });
    await expect(waiting).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(worktrees.previous("fixture")!.worktreePath).toBe(latest.worktreePath);
    expect(existsSync(latest.worktreePath)).toBe(true);
  }, 60000);
  it("refuses collection and removal without touching pending index/source/status", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees), before = await pending(ws.worktreePath), stored = row();
    await expect(worktrees.collect(ws, ["**"], [])).rejects.toBeInstanceOf(RepositoryMutationError);
    await expect(worktrees.remove(ws)).rejects.toBeInstanceOf(RepositoryMutationError);
    expect(row()).toEqual(stored); expect(existsSync(ws.worktreePath)).toBe(true);
    expect((await git(ws.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(before.head);
    const index = path.resolve(ws.worktreePath, (await git(ws.worktreePath, ["rev-parse", "--git-path", "index"])).trim());
    expect(readFileSync(index)).toEqual(before.index);
  });
  it("collects application edits without importing private metadata into Git", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees), secret = Buffer.from("private-metadata-canary-never-imported");
    mkdirSync(path.join(ws.worktreePath, ".MeritRouter")); writeFileSync(path.join(ws.worktreePath, ".MeritRouter", "state.txt"), secret);
    writeFileSync(path.join(ws.worktreePath, "app.txt"), "application edit");
    const changes = await worktrees.collect(ws, ["app.txt"], []);
    expect(changes.changed).toEqual([{ status: "M", path: "app.txt" }]);
    expect(changes.patch).toContain("application edit"); expect(changes.patch).not.toContain(secret.toString());
    expect(changes.outOfScope).toEqual([]);
    await expect(git(ws.worktreePath, ["cat-file", "-e", sha(secret)])).rejects.toThrow();
  });
  it("preserves scope and protected-file classification while collecting deletions", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees);
    mkdirSync(path.join(ws.worktreePath, "tests")); writeFileSync(path.join(ws.worktreePath, "tests", "evaluator.ts"), "protected");
    writeFileSync(path.join(ws.worktreePath, "outside.txt"), "outside");
    const changes = await worktrees.collect(ws, ["app.txt"], ["tests/**"]);
    expect(changes.outOfScope.sort()).toEqual(["outside.txt", "tests/evaluator.ts"]);
    expect(changes.protectedChanged).toEqual(["tests/evaluator.ts"]);
  });
  it("preserves a configured source junction's spelling while fencing its physical owner", async () => {
    const { worktrees } = fixture(), alias = path.join(env!.dir, "source-alias");
    symlinkSync(env!.repo, alias, process.platform === "win32" ? "junction" : "dir");
    const ws = await prepared(worktrees, alias);
    expect(ws.sourcePath).toBe(alias); expect(worktrees.previous("fixture")!.sourcePath).toBe(alias);
    await worktrees.remove(ws); expect(existsSync(ws.worktreePath)).toBe(false);
    expect(db!.prepare("SELECT status FROM workspaces WHERE task_id='fixture'").get()).toEqual({ status: "removed" });
  });
  it("does not report removed when native Git refuses a dirty worktree", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees); writeFileSync(path.join(ws.worktreePath, "keep.txt"), "uncommitted evidence");
    const stored = row(); await expect(worktrees.remove(ws)).rejects.toThrow();
    expect(row()).toEqual(stored); expect(readFileSync(path.join(ws.worktreePath, "keep.txt"), "utf8")).toBe("uncommitted evidence");
  });
  it("refuses forged removal outside its managed directory", async () => {
    const { worktrees } = fixture(), ws = await prepared(worktrees), forged: Workspace = { ...ws, worktreePath: env!.repo };
    const stored = row(); await expect(worktrees.remove(forged)).rejects.toThrow(); expect(row()).toEqual(stored);
    expect(existsSync(env!.repo)).toBe(true); expect(existsSync(ws.worktreePath)).toBe(true);
  });
});

describe("metadata-safe initial repository preparation", () => {
  it("excludes private metadata before the first snapshot and preserves setup identity", async () => {
    fixture(); const target = path.join(env!.dir, "plain"); mkdirSync(path.join(target, ".MeritRouter"), { recursive: true });
    writeFileSync(path.join(target, ".MeritRouter", "state.txt"), "private initial snapshot canary"); writeFileSync(path.join(target, "app.txt"), "application");
    expect(await prepareRepository(target)).toMatchObject({ ok: true, action: "initialized" });
    expect((await git(target, ["ls-files"])).trim().split(/\r?\n/).sort()).toEqual([".gitignore", "app.txt"]);
    expect(await git(target, ["log", "-1", "--format=%an <%ae>|%s"])).toBe("MeritRouter <meritrouter@localhost>|MeritRouter: initial snapshot\n");
  });
  it("does not hide pending publication behind history fastpath or preparation events", async () => {
    const { tasks } = fixture(), before = await pending(env!.repo);
    await expect(prepareRepository(env!.repo)).rejects.toBeInstanceOf(RepositoryMutationError);
    const count = db!.prepare("SELECT COUNT(*) AS n FROM events WHERE type='repository_prepare'").get();
    await expect(prepareProjectRepositories({ db: db!, tasks, projects: new ProjectRegistry(env!.cfg) })).rejects.toBeInstanceOf(RepositoryMutationError);
    expect(db!.prepare("SELECT COUNT(*) AS n FROM events WHERE type='repository_prepare'").get()).toEqual(count);
    expect((await git(env!.repo, ["rev-parse", "HEAD"])).trim()).toBe(before.head);
    expect(readFileSync(path.join(env!.repo, ".git", "index"))).toEqual(before.index);
  });
  it("preserves initial snapshot repository aliases", async () => {
    fixture(); const target = path.join(env!.dir, "unborn"), alias = path.join(env!.dir, "unborn-alias"); mkdirSync(target);
    execFileSync("git", ["-C", target, "init", "-q"], { windowsHide: true }); writeFileSync(path.join(target, "app.txt"), "application");
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await prepareRepository(alias)).toMatchObject({ ok: true, path: alias, action: "snapshot" });
    expect((await git(target, ["ls-files"])).trim()).toBe("app.txt");
  });
});
