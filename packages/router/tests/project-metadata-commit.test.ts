import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorIdentity, commitAs, revertCommits, SelectedCommitError, trailerArgs, undoLines } from "../src/attribution/index.js";
import { commitCapturedApplication, commitInitialApplicationSnapshot, commitSelectedApplication, unpackSelectedCommitOutcome } from "../src/attribution/selected-commit.js";
import { readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";
import { git } from "../src/workspaces/git.js";
import * as gitModule from "../src/workspaces/git.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const actor = { agent: "worker:commit", role: "implementer", task: "task\r\ncontinued", model: "fake/model" };
async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), "meritrouter-attributed-")); roots.push(root);
  await git(root, ["init", "-q", "-b", "main"]); await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "a.txt"), "initial A\n"); await writeFile(path.join(root, "b.txt"), "initial B\n");
  await git(root, ["add", "-A"]); await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
  return root;
}
const index = (root: string) => path.join(root, ".git", "index");

describe("metadata-safe attributed wrapper activation", () => {
  it("keeps created setup snapshots empty when an untracked file arrives before the initial commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meritrouter-attributed-")); roots.push(root);
    await git(root, ["init", "-q", "-b", "main"]); await writeFile(path.join(root, "arriving.txt"), "must remain untracked\n");
    expect((await commitInitialApplicationSnapshot(root, "created")).kind).toBe("committed");
    expect(await git(root, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("");
    expect(await git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("arriving.txt\n");
    expect(await git(root, ["log", "-1", "--format=%an%n%ae%n%B"])).toBe("MeritRouter\nmeritrouter@localhost\nMeritRouter: initial commit\n\n");
  });

  it.each(["created", "snapshot"] as const)("preserves an independent native HEAD that wins before %s setup's index snapshot", async kind => {
    const root = await mkdtemp(path.join(tmpdir(), "meritrouter-attributed-")); roots.push(root);
    await git(root, ["init", "-q", "-b", "main"]); await writeFile(path.join(root, "arriving.txt"), "independent content\n");
    let independent = "", original!: Buffer;
    const outcome = await commitInitialApplicationSnapshot(root, kind, { admitted: async () => {
      await git(root, ["add", "arriving.txt"]);
      await git(root, ["-c", "user.name=Independent", "-c", "user.email=independent@example.invalid", "commit", "-qm", "independent commit"]);
      independent = (await git(root, ["rev-parse", "HEAD"])).trim();
      await writeFile(path.join(root, "later.txt"), "unrelated staged arrival\n"); await git(root, ["add", "later.txt"]);
      original = await readFile(index(root));
    } });
    expect(outcome).toEqual({ kind: "unchanged", commit: null });
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(independent); expect(await readFile(index(root))).toEqual(original);
    expect(await readFile(path.join(root, "arriving.txt"), "utf8")).toBe("independent content\n");
    expect(await readFile(path.join(root, "later.txt"), "utf8")).toBe("unrelated staged arrival\n");
    expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1\n"); expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("later.txt\n");
  });
  it.each([undefined, []])("preserves legacy all-path semantics for paths=%j", async paths => {
    const root = await repo(); await writeFile(path.join(root, "a.txt"), "new A\n"); await writeFile(path.join(root, "b.txt"), "new B\n");
    expect(await commitAs(root, actor, "all", paths === undefined ? {} : { paths })).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(root, ["show", "HEAD:a.txt"])).toBe("new A\n"); expect(await git(root, ["show", "HEAD:b.txt"])).toBe("new B\n");
    expect(await commitAs(root, actor, "unchanged", { paths })).toBeNull();
  });

  it("preserves partially staged selected B and unrelated staged A using current selected content", async () => {
    const root = await repo(); await writeFile(path.join(root, "a.txt"), "staged A\n"); await git(root, ["add", "a.txt"]);
    await writeFile(path.join(root, "a.txt"), "later A\n"); await writeFile(path.join(root, "b.txt"), "partial B\n"); await git(root, ["add", "b.txt"]);
    await writeFile(path.join(root, "b.txt"), "current B\n"); await commitAs(root, actor, "B only", { paths: ["b.txt"] });
    expect(await git(root, ["show", "HEAD:a.txt"])).toBe("initial A\n"); expect(await git(root, ["show", ":a.txt"])).toBe("staged A\n");
    expect(await git(root, ["show", "HEAD:b.txt"])).toBe("current B\n"); expect(await git(root, ["show", ":b.txt"])).toBe("current B\n");
  });

  it("preserves exact native message, identity and extra-trailer semantics through commitAs", async () => {
    const root = await repo(), reference = await repo(), message = "\n Subject  \n\nBody\r\n\nAgent: previous\n", extra = { Worker: "first\nsecond" };
    for (const dir of [root, reference]) await git(dir, ["config", "trailer.where", "start"]);
    await writeFile(path.join(root, "a.txt"), "edit\n"); await commitAs(root, actor, message, { extraTrailers: extra });
    const identity = actorIdentity(actor), env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
    await git(reference, ["commit", "-q", "--allow-empty", "-m", message, ...trailerArgs(actor, extra)], { env });
    const object = await git(root, ["cat-file", "commit", "HEAD"]), native = await git(reference, ["cat-file", "commit", "HEAD"]);
    expect(object.slice(object.indexOf("\n\n") + 2)).toBe(native.slice(native.indexOf("\n\n") + 2));
    expect(await git(root, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"])).toBe(`${identity.name}\n${identity.email}\n${identity.name}\n${identity.email}\n`);
  });

  it.each(["refused", "reconciliation_required", "publication_uncertain"] as const)("throws typed %s instead of ordinary null or false success", async kind => {
    const root = await repo(), head = (await git(root, ["rev-parse", "HEAD"])).trim(), original = await readFile(index(root)); await writeFile(path.join(root, "b.txt"), "selected\n");
    const fail = async () => { throw new Error(`fixture ${kind}`); };
    const control = kind === "refused" ? { prepared: fail } : kind === "reconciliation_required" ? { refPublished: fail } : { committing: fail };
    const error = await commitAs(root, actor, "typed outcome", {}, control).catch(value => value);
    expect(error).toBeInstanceOf(SelectedCommitError); expect(error.detail.kind).toBe(kind);
    const receipt = await readCommitReceipt(root, error.detail.receiptId);
    expect(receipt.record.commit).toBe(error.detail.commit); expect(await readFile(index(root))).toEqual(original);
    if (kind === "refused") expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
    if (kind === "reconciliation_required") expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(error.detail.commit);
    expect(receipt.record.state).toBe(kind === "refused" ? "refused" : kind === "publication_uncertain" ? "uncertain" : "head_published");
  });

  it("refuses undo before filesystem/sequencer effects and does not notify hooks when publication is pending", async () => {
    const root = await repo(), base = (await git(root, ["rev-parse", "HEAD"])).trim(); await writeFile(path.join(root, "b.txt"), "pending content\n");
    expect((await commitSelectedApplication(root, { actor, message: "pending" }, { refPublished: async () => { throw new Error("retain pending"); } })).kind).toBe("reconciliation_required");
    const original = await readFile(index(root)), source = await readFile(path.join(root, "b.txt")), status = await git(root, ["status", "--porcelain"]); let hooks = 0;
    await expect(undoLines(root, "b.txt", [[1, 1]], actor, "undo", { onUndone: () => { hooks++; } })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    await expect(revertCommits(root, [base], actor, "undo", { onUndone: () => { hooks++; } })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(hooks).toBe(0); expect(await readFile(index(root))).toEqual(original); expect(await readFile(path.join(root, "b.txt"))).toEqual(source); expect(await git(root, ["status", "--porcelain"])).toBe(status);
  });

  it("validates undo runtime inputs before changing source", async () => {
    const root = await repo(), original = await readFile(index(root)), source = await readFile(path.join(root, "b.txt"));
    await expect(undoLines(root, "b.txt", [[1, 1]], actor, "bad\0reason")).rejects.toThrow();
    await expect(undoLines(root, "b.txt", [[1, 10000000]], actor, "oversized")).rejects.toThrow(/line budget/);
    await expect(revertCommits(root, ["--all"], actor, "unsafe revision")).rejects.toThrow();
    expect(await readFile(index(root))).toEqual(original); expect(await readFile(path.join(root, "b.txt"))).toEqual(source);
  });

  it("publishes the supplied captured tree without importing newer worktree content", async () => {
    const root = await repo(), head = (await git(root, ["rev-parse", "HEAD"])).trim(); await writeFile(path.join(root, "b.txt"), "captured\n"); await git(root, ["add", "b.txt"]);
    const tree = (await git(root, ["write-tree"])).trim();
    const outcome = await commitCapturedApplication(root, { actor, message: "captured", head, tree }, { sealed: async () => { await writeFile(path.join(root, "b.txt"), "newer unstaged\n"); } });
    expect(unpackSelectedCommitOutcome(outcome)).toMatch(/^[a-f0-9]{40}$/);
    expect((await git(root, ["rev-parse", "HEAD^{tree}"])).trim()).toBe(tree); expect(await git(root, ["show", "HEAD:b.txt"])).toBe("captured\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("newer unstaged\n");
  });

  it("preserves exact receipt and original index when authority is lost after captured ref publication", async () => {
    const root = await repo(), head = (await git(root, ["rev-parse", "HEAD"])).trim(); await writeFile(path.join(root, "b.txt"), "captured\n"); await git(root, ["add", "b.txt"]);
    const tree = (await git(root, ["write-tree"])).trim(), original = await readFile(index(root)); let authorized = true;
    const outcome = await commitCapturedApplication(root, { actor, message: "captured", head, tree }, { assertAuthority: () => { if (!authorized) throw new Error("authority revoked"); }, refPublished: async () => { authorized = false; } });
    expect(outcome.kind).toBe("reconciliation_required"); expect(await readFile(index(root))).toEqual(original);
    if (outcome.kind !== "reconciliation_required") throw new Error("expected typed post-publication outcome");
    expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(outcome.commit); expect((await readCommitReceipt(root, outcome.receiptId)).record.state).toBe("head_published");
  });

  it("surfaces failed revert abort without committing or reporting undo success", async () => {
    const root = await repo(); await writeFile(path.join(root, "b.txt"), "first\n"); const first = (await commitAs(root, actor, "first"))!;
    await writeFile(path.join(root, "b.txt"), "later\n"); const current = await commitAs(root, actor, "later");
    const originalGit = gitModule.git; let hooks = 0;
    vi.spyOn(gitModule, "git").mockImplementation((repo, args, options) => args[0] === "revert" && args[1] === "--abort" ? Promise.reject(new Error("fixture abort failed")) : originalGit(repo, args, options));
    await expect(revertCommits(root, [first], actor, "undo", { onUndone: () => { hooks++; } })).rejects.toThrow(/recovery failed.*fixture abort failed/);
    expect(hooks).toBe(0); expect((await originalGit(root, ["rev-parse", "HEAD"])).trim()).toBe(current);
  });
});
