import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import { DEFAULT_GITIGNORE, folderState, prepareRepository } from "../src/workspaces/repository-prepare.js";
import { REPOSITORY_PREPARE_EVENT } from "../src/projects/repository-setup.js";
import { createProject, inspectRepositoryPath, projectAttention, projectOverview, saveProjectRepositories } from "../src/admin/insights.js";
import { doctorChecks } from "../src/cli/doctor.js";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

// Repository preparation: SwitchYard makes a project's repository folder a usable git repository
// itself (create, init, first snapshot), never touches one with history, and leaves only what it
// cannot fix (git missing, a file, permissions) as an error.

const IDENTITY_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
const savedEnv: Record<string, string | undefined> = {};
let home: string;

beforeAll(() => {
  // No global or system git identity: an empty-identity global config that also forbids git
  // guessing one from the host name, so a commit without an explicit identity fails.
  home = mkdtempSync(path.join(tmpdir(), "switchyard-prepare-home-"));
  const globalConfig = path.join(home, "gitconfig");
  writeFileSync(globalConfig, "[user]\n\tuseConfigOnly = true\n");
  for (const k of IDENTITY_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const k of IDENTITY_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(home, { recursive: true, force: true });
});

let dir: string | undefined;
let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const temp = () => (dir = mkdtempSync(path.join(tmpdir(), "switchyard-prepare-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const commits = (repo: string) => Number(git(repo, "rev-list", "--count", "HEAD"));
const tracked = (repo: string) => git(repo, "ls-files").split(/\r?\n/).filter(Boolean).sort();

describe("prepareRepository", () => {
  it("creates a missing folder, sets up git, and makes an empty first commit as SwitchYard", async () => {
    const target = path.join(temp(), "nested", "my-app");
    const r = await prepareRepository(target);
    expect(r).toMatchObject({ ok: true, action: "created", path: target, gitignore: false });
    expect(r.message).toBe(`SwitchYard created ${target} and set up git`);
    expect(commits(target)).toBe(1);
    expect(git(target, "log", "-1", "--format=%an <%ae>|%s")).toBe("SwitchYard <switchyard@localhost>|SwitchYard: initial commit");
    expect(tracked(target)).toEqual([]);
    expect(folderState(target)).toBe("repository");
  });

  it("sets up git in a plain folder, writes the default .gitignore, and commits a first snapshot", async () => {
    const target = path.join(temp(), "plain");
    mkdirSync(path.join(target, "src"), { recursive: true });
    mkdirSync(path.join(target, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(target, "src", "index.ts"), "export {};\n");
    writeFileSync(path.join(target, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    writeFileSync(path.join(target, ".env"), "SECRET=1\n");
    writeFileSync(path.join(target, "debug.log"), "log\n");
    const r = await prepareRepository(target);
    expect(r).toMatchObject({ ok: true, action: "initialized", gitignore: true });
    expect(r.message).toContain("committed a first snapshot");
    expect(readFileSync(path.join(target, ".gitignore"), "utf8")).toBe(DEFAULT_GITIGNORE);
    for (const line of ["node_modules/", ".env", ".env.*", "*.log", "dist/", "build/", ".venv/", "__pycache__/", ".DS_Store"]) expect(DEFAULT_GITIGNORE.split("\n")).toContain(line);
    expect(tracked(target)).toEqual([".gitignore", "src/index.ts"]);
    expect(commits(target)).toBe(1);
    expect(git(target, "log", "-1", "--format=%s")).toBe("SwitchYard: initial snapshot");
  });

  it("keeps an existing .gitignore and commits what it allows", async () => {
    const target = path.join(temp(), "own-ignore");
    mkdirSync(target);
    writeFileSync(path.join(target, ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(target, "secret.txt"), "x\n");
    writeFileSync(path.join(target, "notes.log"), "kept: the user's .gitignore does not ignore logs\n");
    const r = await prepareRepository(target);
    expect(r).toMatchObject({ ok: true, action: "initialized", gitignore: false });
    expect(readFileSync(path.join(target, ".gitignore"), "utf8")).toBe("secret.txt\n");
    expect(tracked(target)).toEqual([".gitignore", "notes.log"]);
  });

  it("commits the current files of a repository with no commits, without adding a .gitignore", async () => {
    const target = path.join(temp(), "unborn");
    mkdirSync(target);
    git(target, "init", "-q");
    writeFileSync(path.join(target, "a.txt"), "a\n");
    expect(folderState(target)).toBe("unborn");
    const r = await prepareRepository(target);
    expect(r).toMatchObject({ ok: true, action: "snapshot" });
    expect(existsSync(path.join(target, ".gitignore"))).toBe(false);
    expect(tracked(target)).toEqual(["a.txt"]);
    expect(commits(target)).toBe(1);
  });

  it("makes an empty first commit in an empty repository with no commits", async () => {
    const target = path.join(temp(), "unborn-empty");
    mkdirSync(target);
    git(target, "init", "-q");
    expect(await prepareRepository(target)).toMatchObject({ ok: true, action: "snapshot" });
    expect(commits(target)).toBe(1);
  });

  it("never touches a repository with history (and is idempotent)", async () => {
    const target = path.join(temp(), "history");
    mkdirSync(target);
    writeFileSync(path.join(target, "a.txt"), "a\n");
    git(target, "init", "-q");
    commitAll(target, "user commit");
    writeFileSync(path.join(target, "untracked.txt"), "left alone\n");
    const head = git(target, "rev-parse", "HEAD");
    expect(await prepareRepository(target)).toMatchObject({ ok: true, action: "unchanged" });
    expect(git(target, "rev-parse", "HEAD")).toBe(head);
    expect(git(target, "status", "--porcelain")).toBe("?? untracked.txt");
    expect(existsSync(path.join(target, ".gitignore"))).toBe(false);

    const fresh = path.join(dir!, "fresh");
    expect(await prepareRepository(fresh)).toMatchObject({ action: "created" });
    expect(await prepareRepository(fresh)).toMatchObject({ ok: true, action: "unchanged" });
    expect(commits(fresh)).toBe(1);
  });

  it("produces one first commit when two callers prepare the same folder at once", async () => {
    const plain = path.join(temp(), "race-plain");
    mkdirSync(plain);
    writeFileSync(path.join(plain, "a.txt"), "a\n");
    const missing = path.join(dir!, "race-missing");
    const [a, b, c, d] = await Promise.all([prepareRepository(plain), prepareRepository(plain), prepareRepository(missing), prepareRepository(missing)]);
    expect([a, b].map((r) => r.ok && r.action).sort()).toEqual(["initialized", "unchanged"]);
    expect([c, d].map((r) => r.ok && r.action).sort()).toEqual(["created", "unchanged"]);
    expect(commits(plain)).toBe(1);
    expect(commits(missing)).toBe(1);
  });

  it("reports a file in place of the folder, and git missing, with a fix", async () => {
    const file = path.join(temp(), "not-a-folder");
    writeFileSync(file, "x");
    const r = await prepareRepository(file);
    expect(r).toMatchObject({ ok: false, error: "not_a_folder" });
    expect(!r.ok && r.message).toMatch(/is a file, not a folder\. Choose a folder/);

    const savedPath = process.env.PATH;
    process.env.PATH = path.join(dir!, "no-git-here");
    try {
      const g = await prepareRepository(path.join(dir!, "needs-git"));
      expect(g).toMatchObject({ ok: false, error: "git_missing" });
      expect(!g.ok && g.message).toMatch(/git is not installed or not on PATH\. Install git/);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(path.join(dir!, "needs-git"))).toBe(false);
  });

  it("refuses a folder holding another repository's tracked files, but nests under one that tracks nothing there", async () => {
    const outer = temp();
    git(outer, "init", "-q");
    const sub = path.join(outer, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "a.txt"), "a");
    git(outer, "add", "-A");
    git(outer, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "outer");
    const r = await prepareRepository(sub);
    expect(r).toMatchObject({ ok: false, error: "inside_repository" });
    expect(!r.ok && r.message).toMatch(/holds files tracked by the git repository .*Use .* as the repository/);
    expect(existsSync(path.join(sub, ".git"))).toBe(false);

    const untracked = path.join(outer, "scratch");
    mkdirSync(untracked);
    writeFileSync(path.join(untracked, "b.txt"), "b");
    expect(await prepareRepository(untracked)).toMatchObject({ ok: true, action: "initialized" });
    expect(await prepareRepository(path.join(outer, "new", "app"))).toMatchObject({ ok: true, action: "created" });
    expect(commits(outer)).toBe(1);
  });

  it("refuses to snapshot the home folder", async () => {
    const fakeHome = temp();
    writeFileSync(path.join(fakeHome, "notes.txt"), "x");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = fakeHome;
    try {
      const r = await prepareRepository(fakeHome);
      expect(r).toMatchObject({ ok: false, error: "too_broad" });
      expect(!r.ok && r.message).toMatch(/is your home folder; SwitchYard will not commit everything/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(existsSync(path.join(fakeHome, ".git"))).toBe(false);
  });
});

/** One project whose `app` repository is configured at `folder` (relative to the config). */
function projectEnv(folder: string): Env {
  env = makeEnv({ config: { ...baseConfig(), repositories: {}, projects: { alpha: { name: "Alpha", repositories: { app: { path: folder } } } } } });
  return env;
}

const prepareEvents = (s: Switchyard) =>
  (s.db.prepare("SELECT data_json FROM events WHERE type = ? ORDER BY id").all(REPOSITORY_PREPARE_EVENT) as Array<{ data_json: string }>).map((r) => JSON.parse(r.data_json) as Record<string, unknown>);

describe("where repositories are prepared", () => {
  it("prepares a configured missing repository when the service starts, records it, and shows a notice", async () => {
    const e = projectEnv("my-app");
    const target = path.join(e.dir, "my-app");
    expect(existsSync(target)).toBe(false);
    sy = open(e, new ScriptedClient(() => reply("{}")), { worker: true });
    const deadline = Date.now() + 20_000;
    while (!prepareEvents(sy).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(prepareEvents(sy)).toEqual([{ project: "alpha", alias: "app", path: target, action: "created", message: `SwitchYard created ${target} and set up git` }]);
    expect(folderState(target)).toBe("repository");
    const ov = projectOverview(sy, "alpha");
    expect(ov.notices).toEqual([`Repository app: SwitchYard created ${target} and set up git.`]);
    expect(ov.attention).toEqual([]);
    // A second start finds it ready and records nothing more.
    expect((await sy.prepareRepositories()).map((p) => p.result.ok && p.result.action)).toEqual(["unchanged"]);
    expect(prepareEvents(sy)).toHaveLength(1);
  });

  it("no longer lists a missing or non-git repository as attention; only what SwitchYard cannot fix", async () => {
    const e = projectEnv("plain");
    mkdirSync(path.join(e.dir, "plain"));
    sy = open(e, new ScriptedClient(() => reply("{}")));
    expect(projectAttention(sy, "alpha")).toEqual([]);
    expect(projectOverview(sy, "alpha").attention).toEqual([]);
    // Doctor before preparing: a warning saying what will happen, not a failure.
    expect(doctorChecks(sy).find((c) => c.check === "alpha repo app")).toMatchObject({ ok: true, level: "warn", detail: expect.stringContaining("git will be set up") });
    const prepared = await sy.prepareRepositories();
    expect(doctorChecks(sy, { prepared }).find((c) => c.check === "alpha repo app")).toMatchObject({ ok: true, level: "ok", detail: expect.stringContaining("set up git in") });
    expect(projectOverview(sy, "alpha").notices[0]).toMatch(/set up git in .*plain, added a default \.gitignore, and committed a first snapshot\.$/);

    // A file where the folder should be is the remaining error, in attention and doctor.
    rmSync(path.join(e.dir, "plain"), { recursive: true, force: true });
    writeFileSync(path.join(e.dir, "plain"), "x");
    const again = await sy.prepareRepositories();
    expect(again[0]!.result).toMatchObject({ ok: false, error: "not_a_folder" });
    expect(projectAttention(sy, "alpha")).toEqual([expect.stringMatching(/^Repository app: .*plain is a file, not a folder/)]);
    expect(doctorChecks(sy, { prepared: again }).find((c) => c.check === "alpha repo app")).toMatchObject({ ok: false, level: "fail" });
    // The same failure is recorded once.
    await sy.prepareRepositories();
    expect(prepareEvents(sy).filter((x) => x.action === "error")).toHaveLength(1);
  });

  it("prepares folders when a project is created and when its repositories are saved", async () => {
    const e = projectEnv("alpha-app");
    mkdirSync(path.join(e.dir, "alpha-app"));
    sy = open(e, new ScriptedClient(() => reply("{}")));
    expect(inspectRepositoryPath(sy, "gamma-app")).toMatchObject({ problem: null, hint: "will be created and set up with git" });
    const made = await createProject(sy, { slug: "gamma", repositories: { app: { path: "gamma-app" } } });
    expect(made).toMatchObject({ ok: true, prepared: [expect.stringMatching(/^repository app: SwitchYard created/)] });
    expect(folderState(path.join(e.dir, "gamma-app"))).toBe("repository");

    writeFileSync(path.join(e.dir, "a-file"), "x");
    const refused = await createProject(sy, { slug: "delta", repositories: { app: { path: "a-file" } } });
    expect(refused).toMatchObject({ ok: false, errors: [expect.stringMatching(/^repository app: .*a-file is a file, not a folder/)] });

    writeFileSync(path.join(e.dir, "alpha-app", "x.txt"), "x\n");
    expect(await saveProjectRepositories(sy, "alpha", [{ alias: "app", path: "alpha-app", writable: true }, { alias: "docs", path: "alpha-docs", writable: true }])).toEqual({ ok: true });
    expect(tracked(path.join(e.dir, "alpha-app"))).toEqual([".gitignore", "x.txt"]);
    expect(commits(path.join(e.dir, "alpha-docs"))).toBe(1);
    expect(prepareEvents(sy).map((x) => `${x.project}/${x.alias}:${x.action}`)).toEqual(["gamma/app:created", "alpha/app:initialized", "alpha/docs:created"]);
  });
});
