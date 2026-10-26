import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { MergeQueue, abortInProgress, type MergeHooks } from "../src/workspaces/merge-queue.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import * as gitModule from "../src/workspaces/git.js";

let dir: string | undefined, db: Db | undefined;
afterEach(() => { vi.restoreAllMocks(); db?.close(); db = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const native = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
const hooks: MergeHooks = { committer: { name: "Fixture", email: "fixture@example.invalid" }, integrated: () => undefined };
function fixture() {
  dir = mkdtempSync(path.join(tmpdir(), "merit-merge-"));
  native(dir, "init", "-q"); native(dir, "config", "core.autocrlf", "false"); writeFileSync(path.join(dir, "app.txt"), "base\n"); native(dir, "add", "."); native(dir, "commit", "-qm", "base");
  const base = native(dir, "rev-parse", "HEAD").trim(), target = path.join(dir, "target"), source = path.join(dir, "source");
  native(dir, "worktree", "add", "-qb", "integration", target, base); native(dir, "worktree", "add", "--detach", source, base);
  writeFileSync(path.join(source, "feature.txt"), "feature\n"); native(source, "add", "."); native(source, "commit", "-qm", "feature");
  const head = native(source, "rev-parse", "HEAD").trim(); db = openDatabase(path.join(dir, "storage")); const tasks = new TaskStore(db);
  tasks.submit(["job", "child"].map(id => WorkerTaskSchema.parse({ id, profile: "inspect", goal: id, repositoryAliases: [], constraints: { acceptanceCriteria: ["fixture"] } })), { project: "fixture" });
  const queue = new MergeQueue(db, tasks, "fixture-owner"), item = queue.enqueue({ jobId: "job", taskId: "child", kind: "task", repo: "core", branch: "integration", integrationWorktree: target, sourceWorktree: source, sourceBase: base, sourceHead: head, commits: [head], acceptance: null });
  return { base, target, source, head, queue, item, tasks };
}
async function pending(root: string) {
  writeFileSync(path.join(root, "pending.txt"), "retain pending\n");
  const out = await commitSelectedApplication(root, { actor: { agent: "fixture", role: "implementer" }, message: "pending", paths: ["pending.txt"] }, { refPublished: async () => { throw new Error("retain"); } });
  if (out.kind !== "reconciliation_required") throw new Error("Expected real pending publication");
  return readCommitReceipt(root, out.receiptId);
}
function state(f: ReturnType<typeof fixture>) {
  const index = (root: string) => readFileSync(path.resolve(root, native(root, "rev-parse", "--git-path", "index").trim()));
  return { item: f.queue.get(f.item.id), target: native(f.target, "rev-parse", "HEAD"), source: native(f.source, "rev-parse", "HEAD"), targetIndex: index(f.target), sourceIndex: index(f.source), targetStatus: native(f.target, "status", "--porcelain"), sourceStatus: native(f.source, "status", "--porcelain"), events: db!.prepare("SELECT * FROM events ORDER BY id").all() };
}

describe("merge queue repository admission", () => {
  it.each(["target", "source"] as const)("refuses retained pending %s before queue state, abort or pick", async root => {
    const f = fixture(), receipt = await pending(f[root]), before = state(f), bytes = readFileSync(path.join(receipt.directory, "receipt.json")), validateSource = vi.fn();
    await expect(f.queue.run(f.item.id, { ...hooks, validateSource })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(state(f)).toEqual(before); expect(readFileSync(path.join(receipt.directory, "receipt.json"))).toEqual(bytes); expect(validateSource).not.toHaveBeenCalled();
  });

  it.each(["target", "source"] as const)("refuses pending %s during interrupted recovery before abort or queue ownership change", async root => {
    const f = fixture(); db!.prepare("UPDATE merge_queue SET state='integrating',owner='dead-run',attempts=1,before_head=? WHERE id=?").run(f.base, f.item.id);
    const receipt = await pending(f[root]), before = state(f), bytes = readFileSync(path.join(receipt.directory, "receipt.json"));
    await expect(new MergeQueue(db!, f.tasks, "recovery").recover("job", hooks)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(state(f)).toEqual(before); expect(readFileSync(path.join(receipt.directory, "receipt.json"))).toEqual(bytes);
  });

  it("integrates normally and releases common-owner lease during long checks", async () => {
    const f = fixture();
    const out = await f.queue.run(f.item.id, { ...hooks, checks: async () => {
      await withRepositoryMutation([f.target, f.source], async () => undefined, { timeoutMs: 50 });
      return [{ command: "fixture", exitCode: 0 }];
    } });
    expect(out.state).toBe("integrated"); expect(readFileSync(path.join(f.target, "feature.txt"), "utf8")).toBe("feature\n");
    expect(out.detail.ownedPicks).toEqual([{ source: f.head, head: out.afterHead, parent: f.base }]);
    expect(out.detail.checks).toEqual([{ command: "fixture", exitCode: 0 }]);
  });

  it("preserves ordinary owned acceptance rollback", async () => {
    const f = fixture(); db!.prepare("UPDATE merge_queue SET acceptance_json=? WHERE id=?").run(JSON.stringify({ reason: "fixture" }), f.item.id);
    const out = await f.queue.run(f.item.id, { ...hooks, accept: () => { throw new Error("fixture refusal"); } });
    expect(out.state).toBe("refused"); expect(native(f.target, "rev-parse", "HEAD").trim()).toBe(f.base); expect(existsSync(path.join(f.target, "feature.txt"))).toBe(false);
  });

  it("preserves a known foreign HEAD advance instead of rolling it back", async () => {
    const f = fixture(); db!.prepare("UPDATE merge_queue SET acceptance_json=? WHERE id=?").run(JSON.stringify({ reason: "fixture" }), f.item.id);
    let foreign = "";
    await expect(f.queue.run(f.item.id, { ...hooks, accept: () => {
      writeFileSync(path.join(f.target, "foreign.txt"), "independent\n"); native(f.target, "add", "foreign.txt"); native(f.target, "commit", "-qm", "independent"); foreign = native(f.target, "rev-parse", "HEAD").trim(); throw new Error("fixture refusal");
    } })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(native(f.target, "rev-parse", "HEAD").trim()).toBe(foreign); expect(readFileSync(path.join(f.target, "foreign.txt"), "utf8")).toBe("independent\n"); expect(f.queue.get(f.item.id)?.state).toBe("picked");
  });

  it("retains a native pick missing its durable ownership record for explicit recovery", async () => {
    const f = fixture(); native(f.target, "cherry-pick", "-x", f.head);
    db!.prepare("UPDATE merge_queue SET state='integrating',owner='dead-run',attempts=1,before_head=? WHERE id=?").run(f.base, f.item.id);
    const before = state(f);
    await expect(new MergeQueue(db!, f.tasks, "recovery").recover("job", hooks)).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(state(f)).toEqual(before);
  });

  it("does not lock or mutate a foreign source owner", async () => {
    const f = fixture(), foreign = path.join(dir!, "foreign-owner");
    native(dir!, "init", "-q", foreign); native(foreign, "config", "core.autocrlf", "false"); writeFileSync(path.join(foreign, "x"), "x"); native(foreign, "add", "."); native(foreign, "commit", "-qm", "foreign");
    db!.prepare("UPDATE merge_queue SET source_worktree=? WHERE id=?").run(foreign, f.item.id);
    const before = f.queue.get(f.item.id);
    await expect(f.queue.run(f.item.id, hooks)).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(f.queue.get(f.item.id)).toEqual(before); expect(existsSync(path.join(foreign, ".git", "meritrouter-mutation.lock"))).toBe(false);
  });

  it("preserves queue evidence when the retained integration target is missing", async () => {
    const f = fixture(); native(dir!, "worktree", "remove", f.target);
    const before = f.queue.get(f.item.id), events = db!.prepare("SELECT * FROM events ORDER BY id").all();
    await expect(f.queue.run(f.item.id, hooks)).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    await expect(new MergeQueue(db!, f.tasks, "recovery").recover("job", hooks)).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(f.queue.get(f.item.id)).toEqual(before); expect(db!.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(events);
    expect(existsSync(path.join(dir!, ".git", "meritrouter-mutation.lock"))).toBe(false);
  });

  it("surfaces abort failure and retains actual sequencer evidence", async () => {
    const f = fixture(); writeFileSync(path.join(f.target, "app.txt"), "different\n"); native(f.target, "add", "app.txt"); native(f.target, "commit", "-qm", "different");
    const original = gitModule.git;
    // Use a real cherry-pick conflict, which leaves the marker consumed by this queue helper.
    native(f.source, "checkout", "--detach", f.base); writeFileSync(path.join(f.source, "app.txt"), "conflict\n"); native(f.source, "add", "app.txt"); native(f.source, "commit", "-qm", "conflict");
    try { native(f.target, "cherry-pick", native(f.source, "rev-parse", "HEAD").trim()); } catch { /* real conflict expected */ }
    const marker = path.resolve(f.target, native(f.target, "rev-parse", "--git-path", "CHERRY_PICK_HEAD").trim()); expect(existsSync(marker)).toBe(true);
    vi.spyOn(gitModule, "git").mockImplementation((repo, args, options) => args[0] === "cherry-pick" && args[1] === "--abort" ? Promise.reject(new Error("fixture abort failure")) : original(repo, args, options));
    const conflictedIndex = readFileSync(path.resolve(f.target, native(f.target, "rev-parse", "--git-path", "index").trim()));
    await expect(abortInProgress(f.target)).rejects.toThrow("fixture abort failure"); expect(existsSync(marker)).toBe(true);
    expect(readFileSync(path.resolve(f.target, native(f.target, "rev-parse", "--git-path", "index").trim()))).toEqual(conflictedIndex);
  });
});
