import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/workspaces/git.js";
import { assertNoTrackedProjectMetadata, ensureProjectMetadataExcluded } from "../src/workspaces/metadata-exclusion.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(path.join(tmpdir(), "meritrouter-exclude-")); roots.push(root); return root; }
async function repo(committed = true) {
  const root = await temp();
  await git(root, ["init", "-q", "-b", "main"]);
  if (committed) {
    await writeFile(path.join(root, "app.txt"), "app");
    await git(root, ["add", "app.txt"]);
    await commit(root);
  }
  return root;
}
async function commit(root: string) { await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]); }
const exclude = (root: string) => path.join(root, ".git", "info", "exclude");
const index = (root: string) => path.join(root, ".git", "index");
async function privateFile(root: string, relative = ".MeritRouter/state.db") {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "private");
  return relative;
}

describe("metadata exclusion foundation (no staging)", () => {
  it("accepts clean and unborn repositories without creating an index", async () => {
    const root = await repo(false);
    await expect(assertNoTrackedProjectMetadata(root)).resolves.toBeUndefined();
    await ensureProjectMetadataExcluded(root);
    await expect(lstat(index(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(exclude(root), "utf8"))).toContain("MeritRouter private project metadata");
  });

  it.each([".MeritRouter/state.db", "nested/.mErItRoUtEr/state.db"])("refuses HEAD metadata %s even after staged deletion, preserving index/exclude", async relative => {
    const root = await repo();
    await privateFile(root, relative);
    await git(root, ["add", "-f", "--", relative]);
    await commit(root);
    execFileSync("git", ["rm", "-q", "--", relative], { cwd: root, windowsHide: true });
    const before = await readFile(index(root)), beforeExclude = await readFile(exclude(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/already tracked/);
    expect(await readFile(index(root))).toEqual(before);
    expect(await readFile(exclude(root))).toEqual(beforeExclude);
  });

  it("refuses forced private index entries alongside app changes without mutating either", async () => {
    const root = await repo();
    await writeFile(exclude(root), ".MeritRouter/\n");
    await privateFile(root);
    await writeFile(path.join(root, "app.txt"), "staged app change");
    await git(root, ["add", "app.txt"]);
    await git(root, ["add", "-f", ".MeritRouter/state.db"]);
    const before = await readFile(index(root)), beforeExclude = await readFile(exclude(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/already indexed/);
    expect(await readFile(index(root))).toEqual(before);
    expect(await readFile(exclude(root))).toEqual(beforeExclude);
  });

  it.each([Buffer.from("# custom\n*.local\n"), Buffer.from("# custom\r\n*.local"), Buffer.from([0xff, 0xfe, 0x23])])("preserves arbitrary existing exclude bytes and is idempotent", async before => {
    const root = await repo();
    await writeFile(exclude(root), before);
    const beforeIndex = await readFile(index(root));
    await ensureProjectMetadataExcluded(root);
    const after = await readFile(exclude(root));
    expect(after.subarray(0, before.length)).toEqual(before);
    if (before.includes(Buffer.from("\r\n"))) expect(after.subarray(before.length).toString()).toContain("\r\n# MeritRouter");
    await ensureProjectMetadataExcluded(root);
    expect(await readFile(exclude(root))).toEqual(after);
    expect(await readFile(index(root))).toEqual(beforeIndex);
    await expect(lstat(`${exclude(root)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores untracked root/nested/case metadata without ignoring similar app names", async () => {
    const root = await repo();
    await privateFile(root);
    await privateFile(root, "nested/.mErItRoUtEr/state.db");
    await privateFile(root, ".MeritRouter-tools/app.txt");
    await ensureProjectMetadataExcluded(root);
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(untracked.split("\0").filter(Boolean)).toEqual([".MeritRouter-tools/app.txt"]);
  });

  it("reasserts exclusion after a later negation and remains idempotent", async () => {
    const root = await repo();
    await ensureProjectMetadataExcluded(root);
    const overridden = Buffer.concat([await readFile(exclude(root)), Buffer.from("!.MeritRouter/\n")]);
    await writeFile(exclude(root), overridden);
    await privateFile(root);
    expect(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toContain(".MeritRouter/state.db");
    const beforeIndex = await readFile(index(root));
    await ensureProjectMetadataExcluded(root);
    const repaired = await readFile(exclude(root));
    expect(repaired.subarray(0, overridden.length)).toEqual(overridden);
    expect(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toBe("");
    await ensureProjectMetadataExcluded(root);
    expect(await readFile(exclude(root))).toEqual(repaired);
    expect(await readFile(index(root))).toEqual(beforeIndex);
  });

  it("refuses an overflowing append without publishing and accepts an exactly fitting idempotent output", async () => {
    const root = await repo(), max = 1024 * 1024;
    const original = Buffer.from(`#${"x".repeat(max - 1)}`);
    await writeFile(exclude(root), original);
    const beforeIndex = await readFile(index(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/nothing published/);
    expect(await readFile(exclude(root))).toEqual(original);
    expect(await readFile(index(root))).toEqual(beforeIndex);
    await expect(lstat(`${exclude(root)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(exclude(root), "");
    await ensureProjectMetadataExcluded(root);
    const suffix = await readFile(exclude(root));
    await writeFile(exclude(root), "#".repeat(max - suffix.length - 1));
    await ensureProjectMetadataExcluded(root);
    const exact = await readFile(exclude(root));
    expect(exact.length).toBe(max);
    await ensureProjectMetadataExcluded(root);
    expect(await readFile(exclude(root))).toEqual(exact);
    expect(await readFile(index(root))).toEqual(beforeIndex);
  });

  it("serializes concurrent callers without duplicate/truncated blocks", async () => {
    const root = await repo();
    await Promise.all([ensureProjectMetadataExcluded(root), ensureProjectMetadataExcluded(root)]);
    const text = await readFile(exclude(root), "utf8");
    expect(text.match(/# MeritRouter private project metadata/g)).toHaveLength(1);
    await expect(lstat(`${exclude(root)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);

  it("shares common exclude correctly between linked worktrees with independent indexes", async () => {
    const root = await repo(), linked = path.join(await temp(), "linked");
    await git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
    const linkedIndex = path.resolve(linked, (await git(linked, ["rev-parse", "--git-path", "index"])).trim());
    const before = await readFile(linkedIndex);
    await ensureProjectMetadataExcluded(linked);
    await ensureProjectMetadataExcluded(root);
    await privateFile(linked, ".meritrouter/private.json");
    expect(await git(linked, ["ls-files", "--others", "--exclude-standard", "-z"])).toBe("");
    expect(await readFile(linkedIndex)).toEqual(before);
    expect((await readFile(exclude(root), "utf8")).match(/# MeritRouter private project metadata/g)).toHaveLength(1);
  });

  it("preserves a foreign stale lock and original exclude/index on bounded refusal", async () => {
    const root = await repo(), lock = `${exclude(root)}.lock`;
    await writeFile(lock, "foreign owner");
    await utimes(lock, new Date(0), new Date(0));
    const before = await readFile(index(root)), beforeExclude = await readFile(exclude(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/foreign locks are preserved/);
    expect(await readFile(lock, "utf8")).toBe("foreign owner");
    expect(await readFile(index(root))).toEqual(before);
    expect(await readFile(exclude(root))).toEqual(beforeExclude);
  }, 15000);

  it("refuses redirected info ancestry without writing outside Git ownership", async () => {
    const root = await repo(), outside = await temp();
    await writeFile(path.join(outside, "exclude"), "external sentinel");
    await rm(path.join(root, ".git", "info"), { recursive: true });
    await symlink(outside, path.join(root, ".git", "info"), process.platform === "win32" ? "junction" : "dir");
    const before = await readFile(index(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/linked or non-directory/);
    expect(await readFile(path.join(outside, "exclude"), "utf8")).toBe("external sentinel");
    await expect(lstat(path.join(outside, "exclude.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(index(root))).toEqual(before);
  });

  it("fails closed on corrupt index without rewriting it", async () => {
    const root = await repo();
    await writeFile(index(root), "invalid index");
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow();
    expect(await readFile(index(root), "utf8")).toBe("invalid index");
  });

  it("refuses a hardlinked exclude file and preserves its outside target", async () => {
    const root = await repo(), outside = path.join(await temp(), "exclude");
    await writeFile(outside, "external sentinel");
    await rm(exclude(root)); await link(outside, exclude(root));
    const before = await readFile(index(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/unlinked regular file/);
    expect(await readFile(outside, "utf8")).toBe("external sentinel");
    expect(await readFile(index(root))).toEqual(before);
  });

  it("does not mistake malformed HEAD for an unborn repository", async () => {
    const root = await repo(false);
    await writeFile(path.join(root, ".git", "HEAD"), "not a valid head\n");
    const beforeExclude = await readFile(exclude(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow();
    expect(await readFile(exclude(root))).toEqual(beforeExclude);
    await expect(lstat(index(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on unmerged index entries", async () => {
    const root = await repo();
    await git(root, ["switch", "-qc", "other"]);
    await writeFile(path.join(root, "app.txt"), "other");
    await git(root, ["add", "app.txt"]); await commit(root);
    await git(root, ["switch", "-q", "main"]);
    await writeFile(path.join(root, "app.txt"), "main");
    await git(root, ["add", "app.txt"]); await commit(root);
    await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "other"], { allowExit: [1] });
    const before = await readFile(index(root));
    await expect(ensureProjectMetadataExcluded(root)).rejects.toThrow(/unmerged/);
    expect(await readFile(index(root))).toEqual(before);
  });
});
