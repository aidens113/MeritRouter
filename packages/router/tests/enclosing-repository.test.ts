import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { editTools, withRepositoryToolWrite, type HarnessEnv } from "../src/harness/tools.js";
import { evidenceUniverse } from "../src/core/worker-output.js";
import { withRepositoryMutation, RepositoryMutationError } from "../src/workspaces/repository-mutation.js";
import { ensureProjectMetadataExcluded } from "../src/workspaces/metadata-exclusion.js";
import { assertGitWriteTopology } from "../src/workspaces/git-write-topology.js";
import { createRepositoryEffects } from "../src/workspaces/repository-command.js";
import { EnclosingRepositoryError, exactRepositoryRoot } from "../src/workspaces/repository-root.js";

// A user's home folder can itself be a Git repository, so Git discovery from any folder that is
// not a repository (an OS temp directory, a fresh workspace) can land in it. These tests build an
// enclosing repository inside OS temp storage, put a bare folder under it, and prove MeritRouter
// never locks, excludes into, or otherwise writes the enclosing repository's metadata.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(path.join(tmpdir(), "mr-enclosing-")); dirs.push(d); return d; }
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
function repository(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "README.md"), "enclosing\n");
  run(dir, "add", "README.md");
  run(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  // A pre-existing exclude file so the hash covers real content, not just absence.
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "info", "exclude"), "# owner rules\n*.log\n");
  return dir;
}
/** Every path under .git with its content hash: exclude, index, refs, HEAD, locks, receipts. */
function snapshot(gitDirectory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), rel = path.relative(gitDirectory, file).split(path.sep).join("/"), stat = lstatSync(file);
      if (stat.isDirectory()) { out[`${rel}/`] = "dir"; walk(file); }
      else out[rel] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  walk(gitDirectory);
  return out;
}
function enclosed(): { enclosing: string; root: string; gitDirectory: string } {
  const enclosing = repository(path.join(tmp(), "enclosing"));
  const root = path.join(enclosing, "work", "space");
  mkdirSync(root, { recursive: true });
  return { enclosing, root, gitDirectory: path.join(enclosing, ".git") };
}
function authority(): never {
  return { taskId: "t1", taskLease: { taskId: "t1", owner: "owner", runCount: 1, project: "demo", incarnation: "a".repeat(32) }, tasks: { dispatchable: () => true }, signal: new AbortController().signal, cfg: { configPath: path.join(tmpdir(), "mr-enclosing-unused-config.yaml") } } as never;
}
function env(root: string): HarnessEnv {
  return { ctx: authority(), role: "implementer", readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: "core", root, allowedPaths: null }, edits: new Set() };
}

describe("enclosing repositories are never acted on", () => {
  it("records the enclosing repository's key metadata before and after", () => {
    const { gitDirectory } = enclosed();
    const before = snapshot(gitDirectory);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["info/exclude", "index", "HEAD", "refs/heads/main"]));
  });

  it("exact-root resolution refuses folders inside a repository and accepts real roots", async () => {
    const { enclosing, root } = enclosed();
    await expect(exactRepositoryRoot(root)).rejects.toBeInstanceOf(EnclosingRepositoryError);
    await expect(exactRepositoryRoot(path.join(enclosing, "work"))).rejects.toBeInstanceOf(EnclosingRepositoryError);
    await expect(exactRepositoryRoot(path.join(enclosing, ".git"))).rejects.toBeInstanceOf(EnclosingRepositoryError);
    await expect(exactRepositoryRoot(path.join(enclosing, ".git", "refs"))).rejects.toBeInstanceOf(EnclosingRepositoryError);
    expect((await exactRepositoryRoot(enclosing)).bare).toBe(false);
    const linked = path.join(path.dirname(enclosing), "linked");
    run(enclosing, "worktree", "add", "-q", linked);
    const owner = await exactRepositoryRoot(linked);
    expect(owner.gitDirectory.toLowerCase()).toContain(`${path.sep}worktrees${path.sep}`.toLowerCase());
    const bare = path.join(path.dirname(enclosing), "bare.git");
    run(path.dirname(enclosing), "init", "-q", "--bare", bare);
    expect((await exactRepositoryRoot(bare)).bare).toBe(true);
    await expect(exactRepositoryRoot(path.join(bare, "refs"))).rejects.toBeInstanceOf(EnclosingRepositoryError);
  });

  it("repository mutation scopes refuse a non-root folder without locking the enclosing repository", async () => {
    const { root, gitDirectory } = enclosed();
    const before = snapshot(gitDirectory);
    let ran = false;
    const refused = await withRepositoryMutation([root], async () => { ran = true; }).catch(error => error);
    expect(refused).toBeInstanceOf(RepositoryMutationError);
    expect((refused as RepositoryMutationError).detail.kind).toBe("ownership_changed");
    expect((refused as Error).message).toMatch(/not a Git repository root/);
    expect(ran).toBe(false);
    await expect(createRepositoryEffects(root).withWrite(() => { ran = true; })).rejects.toThrow(/not a Git repository root/);
    expect(ran).toBe(false);
    expect(snapshot(gitDirectory)).toEqual(before);
  });

  it("the private-metadata exclude writer refuses a non-root folder and leaves info/exclude untouched", async () => {
    const { root, gitDirectory } = enclosed();
    const before = snapshot(gitDirectory);
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/not a Git repository root/);
    expect(snapshot(gitDirectory)).toEqual(before);
    expect(readFileSync(path.join(gitDirectory, "info", "exclude"), "utf8")).toBe("# owner rules\n*.log\n");
  });

  it("the Git write-topology guard refuses a non-root folder", async () => {
    const { root, gitDirectory } = enclosed();
    const before = snapshot(gitDirectory);
    await expect(assertGitWriteTopology(root)).rejects.toBeInstanceOf(EnclosingRepositoryError);
    expect(snapshot(gitDirectory)).toEqual(before);
  });

  it("file tools in a non-repository workspace write without any repository fence", async () => {
    const { root, gitDirectory } = enclosed();
    const before = snapshot(gitDirectory);
    let fenced: unknown = "unset";
    await withRepositoryToolWrite(env(root), guarded => { fenced = guarded.repositoryMutation; });
    expect(fenced).toBeUndefined();
    const [write, replace, remove] = editTools();
    await expect(write!.run({ path: "src/a.txt", content: "one\n" }, env(root))).resolves.toMatch(/wrote src\/a\.txt/);
    await expect(replace!.run({ path: "src/a.txt", old_text: "one", new_text: "two" }, env(root))).resolves.toMatch(/replaced/);
    expect(readFileSync(path.join(root, "src", "a.txt"), "utf8")).toBe("two\n");
    await expect(remove!.run({ path: "src/a.txt" }, env(root))).resolves.toMatch(/deleted/);
    expect(existsSync(path.join(root, "src", "a.txt"))).toBe(false);
    expect(snapshot(gitDirectory)).toEqual(before);
  });

  it("a workspace that is its own repository root is still fenced, and the exclude writer still works there", async () => {
    const own = repository(path.join(tmp(), "own"));
    let fenced: unknown;
    await withRepositoryToolWrite(env(own), guarded => { fenced = guarded.repositoryMutation; });
    expect(fenced).toBeDefined();
    await expect(editTools()[0]!.run({ path: "b.txt", content: "x" }, env(own))).resolves.toMatch(/wrote b\.txt/);
    await ensureProjectMetadataExcluded(own);
    expect(readFileSync(path.join(own, ".git", "info", "exclude"), "utf8")).toMatch(/MeritRouter private project metadata/);
    expect(existsSync(path.join(own, ".git", "meritrouter-mutation.lock"))).toBe(false);
  });

  it("a broken .git entry at the workspace root fails closed instead of falling back to the enclosing repository", async () => {
    const { root, gitDirectory } = enclosed();
    writeFileSync(path.join(root, ".git"), "gitdir: missing\n");
    const before = snapshot(gitDirectory);
    await expect(editTools()[0]!.run({ path: "c.txt", content: "x" }, env(root))).rejects.toThrow();
    expect(existsSync(path.join(root, "c.txt"))).toBe(false);
    expect(snapshot(gitDirectory)).toEqual(before);
  });
});
