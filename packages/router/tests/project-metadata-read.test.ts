import { link, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoReader } from "../src/context/repo-reader.js";
import { git } from "../src/workspaces/git.js";
import { isProjectMetadataPath } from "../src/projects/metadata-policy.js";

let root: string;
let head: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "meritrouter-metadata-read-"));
  await git(root, ["init", "-q"]);
  for (const directory of [".MeritRouter", "nested/.mErItRoUtEr", "source"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, ".MeritRouter", "tracked.txt"), "needle PRIVATE_ROOT\nneedle PRIVATE_ROOT_2\n");
  await writeFile(path.join(root, "nested/.mErItRoUtEr", "tracked.txt"), "needle PRIVATE_NESTED\n");
  await writeFile(path.join(root, "source/app.txt"), "needle PUBLIC\n");
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(path.join(root, ".gitignore"), ".MeritRouter/ignored.txt\n");
  await writeFile(path.join(root, ".MeritRouter/untracked.txt"), "needle PRIVATE_UNTRACKED\n");
  await writeFile(path.join(root, ".MeritRouter/ignored.txt"), "needle PRIVATE_IGNORED\n");
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("private project metadata repository boundary", () => {
  it.each([null, "pinned"])("refuses explicit metadata reads (%s)", async commit => {
    const reader = new RepoReader("app", root, commit ? head : null);
    for (const file of [".MeritRouter/tracked.txt", ".meritrouter\\tracked.txt", "nested/.mErItRoUtEr/tracked.txt", ".MeritRouter/ignored.txt", ".MeritRouter/untracked.txt"]) {
      await expect(reader.readFile(file)).rejects.toThrow("Private MeritRouter metadata");
    }
    expect((await reader.readFile("source/app.txt")).content).toContain("PUBLIC");
  });
  it.each([null, "pinned"])("filters listing before limit (%s)", async commit => {
    const reader = new RepoReader("app", root, commit ? head : null);
    const listed = await reader.listFiles("", "*.txt", 1);
    expect(listed).toEqual({ files: ["source/app.txt"], truncated: false });
    await expect(reader.listFiles(".MeritRouter")).rejects.toThrow("Private MeritRouter metadata");
  });
  it.each([null, "pinned"])("filters search before limit and retains ordinary glob searches (%s)", async commit => {
    const reader = new RepoReader("app", root, commit ? head : null);
    const result = await reader.search("needle", { limit: 1 });
    expect(result.matches).toEqual([{ path: "source/app.txt", line: 1, text: "needle PUBLIC" }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect((await reader.search("needle", { pathGlob: "source/*.txt" })).matches).toHaveLength(1);
    expect((await reader.search("PRIVATE")).matches).toEqual([]);
    await expect(reader.search("needle", { pathGlob: ".MeritRouter/*.txt" })).rejects.toThrow("Private MeritRouter metadata");
  });
  it("refuses an ordinary in-root alias into metadata", async () => {
    await symlink(path.join(root, ".MeritRouter"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const reader = new RepoReader("app", root, null);
    await expect(reader.readFile("alias/tracked.txt")).rejects.toThrow();
    expect((await reader.listFiles()).files.some(file => file.startsWith("alias/"))).toBe(false);
    expect((await reader.search("PRIVATE")).matches).toEqual([]);
    expect((await reader.search("needle", { pathGlob: "alias/**" })).matches).toEqual([]);
    expect((await reader.readFile("source/app.txt")).content).toContain("PUBLIC");
  });
  it("refuses hard-linked aliases before direct reads, listing and grep", async () => {
    await link(path.join(root, ".MeritRouter/tracked.txt"), path.join(root, "hard-alias.txt"));
    const reader = new RepoReader("app", root, null);
    await expect(reader.readFile("hard-alias.txt")).rejects.toThrow("multiple hard links");
    expect((await reader.listFiles()).files).not.toContain("hard-alias.txt");
    expect((await reader.search("PRIVATE")).matches).toEqual([]);
    expect((await reader.search("needle", { pathGlob: "hard-alias.txt" })).matches).toEqual([]);
    expect((await reader.search("needle")).matches.map(match => match.path)).toEqual(["source/app.txt"]);
  });
  it("fails closed on excessive physical alias exclusions", async () => {
    for (let i = 0; i < 129; i++) await link(path.join(root, ".MeritRouter/tracked.txt"), path.join(root, `alias-${i}.txt`));
    const reader = new RepoReader("app", root, null);
    await expect(reader.search("PRIVATE")).rejects.toThrow("128 unsafe-path exclusions");
    expect((await reader.search("needle", { pathGlob: "source/**" })).matches).toHaveLength(1);
  });
  it("honors an already-aborted signal before filesystem/search work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("operator aborted"));
    const reader = new RepoReader("app", root, null);
    await expect(reader.search("PRIVATE", { signal: controller.signal })).rejects.toThrow("operator aborted");
    await expect(reader.listFiles("", undefined, 100, controller.signal)).rejects.toThrow("operator aborted");
  });
  it("allows ordinary source when the reader root itself is under project metadata", async () => {
    const workspace = path.join(root, ".MeritRouter/jobs/readable-job/repositories/app");
    await mkdir(workspace, { recursive: true });
    await git(workspace, ["init", "-q"]);
    await writeFile(path.join(workspace, "app.txt"), "needle WORKSPACE_SOURCE\n");
    const reader = new RepoReader("app", workspace, null);
    expect((await reader.readFile("app.txt")).content).toContain("WORKSPACE_SOURCE");
    expect((await reader.listFiles()).files).toEqual(["app.txt"]);
    expect((await reader.search("needle")).matches[0]?.text).toBe("needle WORKSPACE_SOURCE");
  });
  it("recognizes reserved components without hiding similarly named application paths", () => {
    for (const value of [".MeritRouter", "nested/.MERITROUTER/a", "nested\\.meritrouter\\a", ".MeritRouter. /a"]) expect(isProjectMetadataPath(value)).toBe(true);
    for (const value of ["MeritRouter/app", ".MeritRouter-notes.txt", "src/meritrouter.ts"]) expect(isProjectMetadataPath(value)).toBe(false);
  });
});
