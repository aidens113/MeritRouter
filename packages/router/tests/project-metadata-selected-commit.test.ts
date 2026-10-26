import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../src/workspaces/git.js";
import { commitInitialApplicationSnapshot, commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { assertNoPendingCommitPublication, inspectSelectedCommitPublication, readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";

const roots: string[] = [];
const actor = { agent: "implementer:fixture", role: "implementer", model: "fake/model", task: "fixture" };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(path.join(tmpdir(), "meritrouter-selected-")); roots.push(root); return root; }
async function repo(unborn = false) {
  const root = await temp(); await git(root, ["init", "-q", "-b", "main"]);
  if (!unborn) {
    await writeFile(path.join(root, "a.txt"), "HEAD A"); await writeFile(path.join(root, "b.txt"), "HEAD B");
    await git(root, ["add", "-A"]); await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  }
  return root;
}
const idx = (root: string) => path.join(root, ".git", "index");
async function clean(root: string) {
  await expect(lstat(`${idx(root)}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(path.join(root, ".git"))).filter(name => name.startsWith("meritrouter-index-"))).toEqual([]);
}
const input = (paths?: string[]) => ({ actor, message: "Selected fixture", ...(paths === undefined ? {} : { paths }) });

describe("immutable metadata-safe selected commit", () => {
  it("commits selected current B only and preserves unrelated staged A exactly", async () => {
    const root = await repo();
    await writeFile(path.join(root, "a.txt"), "staged A"); await git(root, ["add", "a.txt"]);
    await writeFile(path.join(root, "a.txt"), "later A");
    await writeFile(path.join(root, "b.txt"), "partially staged B"); await git(root, ["add", "b.txt"]);
    await writeFile(path.join(root, "b.txt"), "current complete B");
    const result = await commitSelectedApplication(root, { ...input(["b.txt"]), extraTrailers: { Worker: "fixture" } });
    expect(result.kind).toBe("committed");
    expect(await git(root, ["show", "HEAD:a.txt"])).toBe("HEAD A");
    expect(await git(root, ["show", "HEAD:b.txt"])).toBe("current complete B");
    expect(await git(root, ["show", ":a.txt"])).toBe("staged A");
    expect(await git(root, ["show", ":b.txt"])).toBe("current complete B");
    expect(await git(root, ["log", "-1", "--format=%an%n%ae%n%B"])).toContain("implementer fixture (fake/model)\nimplementer.fixture@meritrouter.local\nSelected fixture");
    expect(await git(root, ["log", "-1", "--format=%B"])).toContain("Agent: implementer:fixture\nRole: implementer\nModel: fake/model\nTask: fixture\nWorker: fixture");
    if (result.kind === "committed") expect((await inspectSelectedCommitPublication(root, result.receiptId)).observed).toBe("complete");
    await clean(root);
  });

  it("transfers binary/non-ASCII selected blobs immutably and ignores worktree edits after seal", async () => {
    const root = await repo(), file = "données-猫.bin", bytes = Buffer.from([0, 255, 1, 2, 10, 200]);
    await writeFile(path.join(root, file), bytes);
    const result = await commitSelectedApplication(root, input([`:(literal)${file}`]), { sealed: async () => { await writeFile(path.join(root, file), "later worktree edit"); } });
    expect(result.kind).toBe("committed");
    const expected = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
    expect((await git(root, ["rev-parse", `HEAD:${file}`])).trim()).toBe(expected);
    expect((await git(root, ["rev-parse", `:${file}`])).trim()).toBe(expected);
    expect(await readFile(path.join(root, file), "utf8")).toBe("later worktree edit"); await clean(root);
  });

  it("handles staged-new/deleted selected paths and wildcard exclusion", async () => {
    const root = await repo();
    await rm(path.join(root, "b.txt")); await git(root, ["add", "-A"]);
    await writeFile(path.join(root, "new.txt"), "staged new"); await git(root, ["add", "new.txt"]);
    await writeFile(path.join(root, "skip.txt"), "unselected");
    const result = await commitSelectedApplication(root, input(["*.txt", ":(exclude)a.txt", ":(exclude)skip.txt"]));
    expect(result.kind).toBe("committed");
    expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("a.txt\nnew.txt\n");
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe(""); await clean(root);
  });

  it("keeps explicit empty/no-change results distinct and supports allowEmpty", async () => {
    const root = await repo(), old = (await git(root, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(root, "b.txt"), "not selected");
    expect(await commitSelectedApplication(root, input([]))).toEqual({ kind: "unchanged", commit: null });
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(old);
    expect((await commitSelectedApplication(root, { ...input([]), allowEmpty: true })).kind).toBe("committed");
    expect(await git(root, ["show", "HEAD:b.txt"])).toBe("HEAD B");
    expect(await commitSelectedApplication(root, input(["a.txt"]))).toEqual({ kind: "unchanged", commit: null }); await clean(root);
  });

  it("supports unborn and detached HEAD publication", async () => {
    const initial = await repo(true); await writeFile(path.join(initial, "first.txt"), "first");
    expect((await commitSelectedApplication(initial, input())).kind).toBe("committed");
    expect(await git(initial, ["show", "HEAD:first.txt"])).toBe("first");
    const root = await repo(); await git(root, ["switch", "--detach", "-q", "HEAD"]);
    await writeFile(path.join(root, "b.txt"), "detached B");
    expect((await commitSelectedApplication(root, input(["b.txt"]))).kind).toBe("committed");
    expect(await git(root, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] })).toBe(""); await clean(root);
  });

  it.each(["attached-other-branch", "detached-to-attached"])("refuses same-oid symbolic race %s under prepared HEAD lock", async race => {
    const root = await repo(), old = (await git(root, ["rev-parse", "HEAD"])).trim();
    await git(root, ["branch", "other", old]);
    if (race === "detached-to-attached") await git(root, ["switch", "--detach", "-q", "HEAD"]);
    const before = await readFile(idx(root)); await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { beforePrepare: async () => { await git(root, ["symbolic-ref", "HEAD", "refs/heads/other"]); } });
    expect(result.kind).toBe("refused");
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(old);
    expect((await git(root, ["rev-parse", "refs/heads/main"])).trim()).toBe(old);
    expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it("holds HEAD lock while prepared and blocks an ordinary symbolic change", async () => {
    const root = await repo(); await git(root, ["branch", "other", "HEAD"]); await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { prepared: async () => {
      await expect(git(root, ["symbolic-ref", "HEAD", "refs/heads/other"])).rejects.toThrow(/lock|exists/);
    } });
    expect(result.kind).toBe("committed"); expect((await git(root, ["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/main"); await clean(root);
  });

  it("refuses an old-oid race without rolling an external HEAD advance back", async () => {
    const root = await repo(), old = (await git(root, ["rev-parse", "HEAD"])).trim(), before = await readFile(idx(root));
    const tree = (await git(root, ["rev-parse", "HEAD^{tree}"])).trim();
    const external = (await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-p", old, "-m", "external advance"])).trim();
    await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { beforePrepare: async () => { await git(root, ["update-ref", "HEAD", external, old]); } });
    expect(result.kind).toBe("refused"); expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(external);
    expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it("preserves foreign HEAD lock and index on publication refusal", async () => {
    const root = await repo(), before = await readFile(idx(root));
    await writeFile(path.join(root, ".git", "HEAD.lock"), "foreign"); await writeFile(path.join(root, "b.txt"), "selected B");
    expect((await commitSelectedApplication(root, input(["b.txt"]))).kind).toBe("refused");
    expect(await readFile(path.join(root, ".git", "HEAD.lock"), "utf8")).toBe("foreign"); expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it("retains durable exact index backups after ref publication failure without rolling HEAD back", async () => {
    const root = await repo(), before = await readFile(idx(root)), old = (await git(root, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { refPublished: async () => { throw new Error("injected pre-index publication failure"); } });
    expect(result.kind).toBe("reconciliation_required");
    if (result.kind !== "reconciliation_required") throw new Error("expected committed pending index");
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(result.commit);
    expect(result.commit).not.toBe(old); expect(await readFile(idx(root))).toEqual(before);
    expect((await inspectSelectedCommitPublication(root, result.receiptId)).observed).toBe("head_published_index_pending");
    expect((await readCommitReceipt(root, result.receiptId)).record.state).toBe("head_published");
    await expect(commitSelectedApplication(root, input(["b.txt"]))).rejects.toThrow(/explicit reconciliation/); await clean(root);
  });

  it.each(["dead-child", "timeout"])("refuses prepared %s with no HEAD/index effects", async failure => {
    const root = await repo(), before = await readFile(idx(root)), old = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { refTimeoutMs: failure === "timeout" ? 500 : 10000,
      prepared: async ({ pid, exited }) => { if (failure === "dead-child") { process.kill(pid); await exited; } else await new Promise<void>(() => {}); } });
    expect(result.kind).toBe("refused"); expect(await git(root, ["rev-parse", "HEAD"])).toBe(old); expect(await readFile(idx(root))).toEqual(before); await clean(root);
    await expect(lstat(path.join(root, ".git", "HEAD.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(root, ".git", "refs", "heads", "main.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an uncertain commit acknowledgement and retains a readable receipt", async () => {
    const root = await repo(), before = await readFile(idx(root)); await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { committing: async () => { throw new Error("injected acknowledgement failure"); } });
    expect(result.kind).toBe("publication_uncertain");
    if (result.kind !== "publication_uncertain") throw new Error("expected uncertain publication");
    expect((await readCommitReceipt(root, result.receiptId)).record.state).toBe("uncertain");
    expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it.each(["hardlink", "junction"])("refuses private %s aliases before creating private objects or publishing", async kind => {
    const root = await repo(), before = await readFile(idx(root)), old = await git(root, ["rev-parse", "HEAD"]);
    await mkdir(path.join(root, ".MeritRouter")); const secret = `PRIVATE-${root}`; const file = path.join(root, ".MeritRouter", "secret"); await writeFile(file, secret);
    if (kind === "hardlink") await link(file, path.join(root, "alias")); else await symlink(path.dirname(file), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(commitSelectedApplication(root, input())).rejects.toThrow(/[Ll]inked|Hardlinked/);
    const hash = createHash("sha1").update(`blob ${Buffer.byteLength(secret)}\0${secret}`).digest("hex");
    await expect(lstat(path.join(root, ".git", "objects", hash.slice(0, 2), hash.slice(2)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(old); expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it.skipIf(process.platform !== "win32")("supports approved long Windows cwd and deep ordinary files without global config writes", async () => {
    const parent = await temp();
    const root = path.join(parent, "p".repeat(Math.max(1, 232 - parent.length - 1)));
    await mkdir(root); await git(root, ["init", "-q", "-b", "main"]);
    const relative = `${"d".repeat(60)}/app.txt`; await mkdir(path.dirname(path.join(root, relative))); await writeFile(path.join(root, relative), "deep app");
    expect((await commitSelectedApplication(root, input())).kind).toBe("committed");
    expect(await git(root, ["show", `HEAD:${relative}`])).toBe("deep app");
  });

  it.each(["created", "snapshot"] as const)("preserves fixed setup %s identity/message without Actor trailers", async kind => {
    const root = await repo(true);
    if (kind === "snapshot") await writeFile(path.join(root, "app.txt"), "initial app");
    expect((await commitInitialApplicationSnapshot(root, kind)).kind).toBe("committed");
    expect(await git(root, ["log", "-1", "--format=%an%n%ae%n%B"])).toBe(`MeritRouter\nmeritrouter@localhost\nMeritRouter: ${kind === "created" ? "initial commit" : "initial snapshot"}\n\n`);
    expect(await git(root, ["log", "-1", "--format=%B"])).not.toContain("Agent:");
    await clean(root);
  });

  it("preserves unrelated staged-new entries during an unborn selected commit", async () => {
    const root = await repo(true); await writeFile(path.join(root, "a.txt"), "staged A"); await git(root, ["add", "a.txt"]);
    await writeFile(path.join(root, "b.txt"), "selected B");
    expect((await commitSelectedApplication(root, input(["b.txt"]))).kind).toBe("committed");
    expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("b.txt\n");
    expect(await git(root, ["show", ":a.txt"])).toBe("staged A"); await clean(root);
  });

  it("rejects tampered retained index backups and unknown receipt versions", async () => {
    const root = await repo(); await writeFile(path.join(root, "b.txt"), "selected B");
    const result = await commitSelectedApplication(root, input(["b.txt"]), { refPublished: async () => { throw new Error("retain pending backup fixture"); } });
    if (result.kind !== "reconciliation_required") throw new Error("expected retained fixture");
    const handle = await readCommitReceipt(root, result.receiptId), backup = path.join(handle.directory, "next.index"), content = await readFile(backup);
    await writeFile(backup, "tampered"); await expect(readCommitReceipt(root, result.receiptId)).rejects.toThrow(/differs/);
    await writeFile(backup, content); await writeFile(path.join(handle.directory, "receipt.json"), JSON.stringify({ ...handle.record, version: 999 }));
    await expect(readCommitReceipt(root, result.receiptId)).rejects.toThrow(); await clean(root);
  });

  it("rechecks unresolved publication under the index lock for an already admitted caller", async () => {
    const root = await repo(), before = await readFile(idx(root));
    await writeFile(path.join(root, "b.txt"), "first selected");
    let second!: Promise<Awaited<ReturnType<typeof commitSelectedApplication>>>;
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const first = await commitSelectedApplication(root, input(["b.txt"]), {
      sealed: async () => {
        second = commitSelectedApplication(root, input(["b.txt"]), { admitted: async () => { admitted(); } });
        // Attach rejection observation before the first invocation releases the lock.
        void second.catch(() => {});
        await admission;
      },
      refPublished: async () => { await writeFile(path.join(root, "b.txt"), "second selected"); throw new Error("leave pending publication"); },
    });
    expect(first.kind).toBe("reconciliation_required");
    await expect(second).rejects.toThrow(/explicit reconciliation/);
    expect(await git(root, ["show", "HEAD:b.txt"])).toBe("first selected");
    expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it.each(["refs/heads", "logs/refs/heads", "objects/ab"])("refuses redirected %s before native writes", async relative => {
    const root = await repo(), foreign = await temp(), before = await readFile(idx(root)), head = await git(root, ["rev-parse", "HEAD"]);
    const target = path.join(root, ".git", ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    try { await rename(target, path.join(foreign, "original")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const redirected = path.join(foreign, "original"); await mkdir(redirected, { recursive: true });
    const sentinel = path.join(redirected, "foreign.txt"); await writeFile(sentinel, "preserve foreign");
    const files = await readdir(redirected);
    await symlink(redirected, target, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(root, "b.txt"), "refuse selected");
    await expect(commitSelectedApplication(root, input(["b.txt"]))).rejects.toThrow(/linked|unsafe/i);
    expect(await readdir(redirected)).toEqual(files); expect(await readFile(sentinel, "utf8")).toBe("preserve foreign");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(head); expect(await readFile(idx(root))).toEqual(before); await clean(root);
  });

  it("refuses hardlinked packed refs without mutating their foreign owner", async () => {
    const root = await repo(), foreign = await temp(); execFileSync("git", ["-C", root, "pack-refs", "--all"], { windowsHide: true });
    const file = path.join(root, ".git", "packed-refs"), before = await readFile(file);
    await link(file, path.join(foreign, "refs")); await writeFile(path.join(root, "b.txt"), "selected");
    await expect(commitSelectedApplication(root, input(["b.txt"]))).rejects.toThrow(/linked|unsafe/i);
    expect(await readFile(path.join(foreign, "refs"))).toEqual(before); await clean(root);
  });

  it("supports linked-worktree common refs and packed original branches", async () => {
    const root = await repo(), parent = await temp(), checkout = path.join(parent, "linked");
    execFileSync("git", ["-C", root, "pack-refs", "--all"], { windowsHide: true }); await git(root, ["worktree", "add", "-qb", "linked", checkout]);
    await writeFile(path.join(checkout, "b.txt"), "linked selected");
    expect((await commitSelectedApplication(checkout, input(["b.txt"]))).kind).toBe("committed");
    expect(await git(checkout, ["show", "HEAD:b.txt"])).toBe("linked selected");
    expect(await git(root, ["show", "HEAD:b.txt"])).toBe("HEAD B");
  });

  it("releases terminal index backups and separates historical evidence from current index state", async () => {
    const root = await repo(); await writeFile(path.join(root, "b.txt"), "first");
    const first = await commitSelectedApplication(root, input(["b.txt"]));
    if (first.kind !== "committed") throw new Error("expected commit");
    const archived = await readCommitReceipt(root, first.receiptId);
    expect(archived.record.backups).toBe("released"); expect(path.basename(path.dirname(archived.directory))).toBe(first.receiptId.slice(3, 5));
    expect(await readdir(archived.directory)).toEqual(["receipt.json"]);
    await writeFile(path.join(root, "a.txt"), "later staging"); await git(root, ["add", "a.txt"]);
    expect(await inspectSelectedCommitPublication(root, first.receiptId)).toMatchObject({ historical: "complete", observed: "historical_complete" });
    await writeFile(path.join(root, "b.txt"), "second");
    expect((await commitSelectedApplication(root, input(["b.txt"]))).kind).toBe("committed");
    expect(await inspectSelectedCommitPublication(root, first.receiptId)).toMatchObject({ historical: "complete", observed: "historical_complete" });
    // Unrelated historical archives are outside the bounded pending admission scan.
    const archive = path.dirname(path.dirname(archived.directory));
    await Promise.all(Array.from({ length: 1001 }, (_, n) => writeFile(path.join(archive, `historical-${n}`), "not admission input")));
    await expect(assertNoPendingCommitPublication(root)).resolves.toBeUndefined(); await clean(root);
  });
});
