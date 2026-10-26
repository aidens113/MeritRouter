import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/workspaces/git.js";
import { stageWithoutProjectMetadata } from "../src/workspaces/metadata-staging.js";
import { withGitIndexTransaction, type GitIndexCapability } from "../src/workspaces/git-index-transaction.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(path.join(tmpdir(), "meritrouter-index-")); roots.push(root); return root; }
async function repo(committed = true) {
  const root = await temp(); await git(root, ["init", "-q", "-b", "main"]);
  if (committed) {
    await writeFile(path.join(root, "app.txt"), "original"); await git(root, ["add", "app.txt"]);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  }
  return root;
}
const indexPath = (root: string) => path.join(root, ".git", "index");
async function clean(root: string) {
  await expect(lstat(`${indexPath(root)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(path.join(root, ".git"))).filter(name => name.startsWith("meritrouter-index-"))).toEqual([]);
}
async function sentinel(root: string) {
  await mkdir(path.join(root, ".MeritRouter"));
  const content = `PRIVATE-${root}`;
  const file = path.join(root, ".MeritRouter", "state.db"); await writeFile(file, content);
  const hash = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
  return { file, object: path.join(root, ".git", "objects", hash.slice(0, 2), hash.slice(2)) };
}

describe("host-owned metadata-safe index transaction", () => {
  it("rejects raw, forged and copied capabilities and revokes successful scopes", async () => {
    const root = await repo(), foreign = await repo();
    await expect(git(root, ["ls-files"], { env: { GIT_INDEX_FILE: path.join(root, "outside-index") } })).rejects.toThrow(/override denied/);
    await expect(git(root, ["ls-files"], { index: {} as GitIndexCapability })).rejects.toThrow(/forged/);
    let captured!: GitIndexCapability;
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);
    await withGitIndexTransaction(root, async index => {
      captured = index;
      expect(await git(root, ["ls-files"], { index })).toContain("app.txt");
      await expect(git(foreign, ["ls-files"], { index })).rejects.toThrow(/foreign/);
      await expect(git(root, ["ls-files"], { index: { ...index } })).rejects.toThrow(/forged/);
      await expect(git(root, ["commit", "--allow-empty", "-m", "forbidden"], { index })).rejects.toThrow(/cannot authorize/);
    });
    await expect(git(root, ["ls-files"], { index: captured })).rejects.toThrow(/Inactive/);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    await clean(root);
  });

  it("stages selected app content while preserving unrelated staged bytes and HEAD", async () => {
    const root = await repo();
    await writeFile(path.join(root, "other.txt"), "staged version"); await git(root, ["add", "other.txt"]);
    await writeFile(path.join(root, "other.txt"), "later worktree version");
    await writeFile(path.join(root, "app.txt"), "selected app");
    const head = await git(root, ["rev-parse", "HEAD"]);
    await stageWithoutProjectMetadata(root, { paths: ["app.txt"] });
    expect(await git(root, ["show", ":other.txt"])).toBe("staged version");
    expect(await git(root, ["show", ":app.txt"])).toBe("selected app");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
    await clean(root);
  });

  it("preserves positive/negative wildcard selection and treats an explicit empty selection as no-op", async () => {
    const root = await repo(); await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "take.txt"), "take"); await writeFile(path.join(root, "src", "skip.txt"), "skip");
    const before = await readFile(indexPath(root));
    await stageWithoutProjectMetadata(root, { paths: [] });
    expect(await readFile(indexPath(root))).toEqual(before);
    await stageWithoutProjectMetadata(root, { paths: ["src/**", ":(exclude)src/skip.txt"] });
    expect(await git(root, ["ls-files", "-z"])).toBe("app.txt\0src/take.txt\0");
    await clean(root);
  });

  it("skips reserved metadata under negated ignore without copying its bytes into Git", async () => {
    const root = await repo(), secret = await sentinel(root);
    await writeFile(path.join(root, ".gitignore"), "!.MeritRouter/\n");
    await writeFile(path.join(root, "app.txt"), "safe change");
    await stageWithoutProjectMetadata(root);
    expect(await git(root, ["ls-files", "-z"])).not.toContain(".MeritRouter");
    await expect(lstat(secret.object)).rejects.toMatchObject({ code: "ENOENT" });
    await clean(root);
  });

  it.skipIf(process.platform === "win32")("skips actual POSIX trailing-dot/space metadata aliases before content staging", async () => {
    const root = await repo();
    for (const component of [".MeritRouter.", ".MeritRouter "]) {
      await mkdir(path.join(root, component)); await writeFile(path.join(root, component, "private"), "private");
    }
    await stageWithoutProjectMetadata(root);
    expect(await git(root, ["ls-files", "-z"])).toBe("app.txt\0");
  });

  it.each(["hardlink", "junction"])("refuses selected private %s aliases before copying content or changing index", async kind => {
    const root = await repo(), secret = await sentinel(root), before = await readFile(indexPath(root));
    if (kind === "hardlink") await link(secret.file, path.join(root, "alias.txt"));
    else await symlink(path.dirname(secret.file), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(root, "app.txt"), "unstaged ordinary change");
    await expect(stageWithoutProjectMetadata(root)).rejects.toThrow(/[Ll]inked|Hardlinked/);
    expect(await readFile(indexPath(root))).toEqual(before);
    await expect(lstat(secret.object)).rejects.toMatchObject({ code: "ENOENT" });
    await clean(root);
  });

  it("preserves ordinary tracked deletions", async () => {
    const root = await repo(); await rm(path.join(root, "app.txt"));
    await stageWithoutProjectMetadata(root);
    expect(await git(root, ["diff", "--cached", "--name-status"])).toContain("D\tapp.txt");
    await clean(root);
  });

  it("handles unborn/no-index staging and leaves failures without an index", async () => {
    const failed = await repo(false);
    await expect(withGitIndexTransaction(failed, async () => { throw new Error("host staging failure"); })).rejects.toThrow(/host staging failure/);
    await expect(lstat(indexPath(failed))).rejects.toMatchObject({ code: "ENOENT" }); await clean(failed);
    const root = await repo(false); await writeFile(path.join(root, "app.txt"), "first snapshot");
    await stageWithoutProjectMetadata(root);
    expect(await git(root, ["show", ":app.txt"])).toBe("first snapshot"); await clean(root);
  });

  it("preserves original index on host callback and postflight failures", async () => {
    const root = await repo(), before = await readFile(indexPath(root));
    await writeFile(path.join(root, "app.txt"), "temporary stage");
    await expect(withGitIndexTransaction(root, async index => {
      await git(root, ["add", "app.txt"], { index }); throw new Error("host staging failure");
    })).rejects.toThrow(/host staging failure/);
    expect(await readFile(indexPath(root))).toEqual(before); await clean(root);
    await mkdir(path.join(root, ".MeritRouter")); await writeFile(path.join(root, ".MeritRouter", "fake.txt"), "fixture only");
    await expect(withGitIndexTransaction(root, async index => {
      await git(root, ["add", "-f", ".MeritRouter/fake.txt"], { index });
    })).rejects.toThrow(/Private or invalid/);
    expect(await readFile(indexPath(root))).toEqual(before); await clean(root);
  });

  it("drains and refuses commands accidentally left unawaited before scope return", async () => {
    const root = await repo(), before = await readFile(indexPath(root));
    let command!: Promise<string>, captured!: GitIndexCapability;
    await expect(withGitIndexTransaction(root, async index => {
      captured = index; command = git(root, ["add", "app.txt"], { index });
    })).rejects.toThrow(/not awaited.*draining/);
    await expect(command).resolves.toBe("");
    await expect(git(root, ["ls-files"], { index: captured })).rejects.toThrow(/Inactive/);
    expect(await readFile(indexPath(root))).toEqual(before); await clean(root);
  });

  it("preserves foreign native locks even when old", async () => {
    const root = await repo(), lock = `${indexPath(root)}.lock`, before = await readFile(indexPath(root));
    await writeFile(lock, "foreign owner"); await utimes(lock, new Date(0), new Date(0));
    await expect(stageWithoutProjectMetadata(root)).rejects.toThrow(/foreign locks are preserved/);
    expect(await readFile(lock, "utf8")).toBe("foreign owner"); expect(await readFile(indexPath(root))).toEqual(before);
  }, 15000);

  it("serializes concurrent staging and supports linked worktree indexes independently", async () => {
    const root = await repo(); await writeFile(path.join(root, "app.txt"), "new app");
    await Promise.all([stageWithoutProjectMetadata(root), stageWithoutProjectMetadata(root)]);
    expect(await git(root, ["show", ":app.txt"])).toBe("new app"); await clean(root);
    const linked = path.join(await temp(), "linked"); await git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
    const before = await readFile(indexPath(root)); await writeFile(path.join(linked, "app.txt"), "linked app");
    await stageWithoutProjectMetadata(linked);
    expect(await git(linked, ["show", ":app.txt"])).toBe("linked app"); expect(await readFile(indexPath(root))).toEqual(before);
  }, 30000);

  it("refuses tracked/indexed contamination and explicit private requests before index mutation", async () => {
    const root = await repo(); await sentinel(root);
    const before = await readFile(indexPath(root));
    await expect(stageWithoutProjectMetadata(root, { paths: [".MeritRouter/state.db"] })).rejects.toThrow(/Private MeritRouter/);
    expect(await readFile(indexPath(root))).toEqual(before);
    await git(root, ["add", "-f", ".MeritRouter/state.db"]);
    const contaminated = await readFile(indexPath(root));
    await expect(stageWithoutProjectMetadata(root)).rejects.toThrow(/already indexed/);
    expect(await readFile(indexPath(root))).toEqual(contaminated);
  });
});
