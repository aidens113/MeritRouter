import { afterEach, expect, it } from "vitest";
import { link, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withRepositoryMutation, RepositoryMutationError, isLocalRepositoryMutationContention } from "../src/workspaces/repository-mutation.js";
import { newRepositoryMutationOwner } from "../src/workspaces/repository-mutation-recovery.js";
import { classifyFailure } from "../src/core/disposition.js";
import { git } from "../src/workspaces/git.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId } from "../src/storage/task-leases.js";
import { makeEnv, type Env } from "./helpers.js";

const environments: Env[] = [], databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const env of environments.splice(0)) env.cleanup(); });
function fixture() { const env = makeEnv(); environments.push(env); return env; }
const lockFile = (root: string) => path.join(root, ".git", "meritrouter-mutation.lock");
async function hold(root: string) {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const operation = withRepositoryMutation([root], async () => { entered(); await released; });
  await ready;
  return { operation, release };
}
async function blocked(root: string) {
  let called = false;
  const error = await withRepositoryMutation([root], async () => { called = true; }, { timeoutMs: 50 }).then(() => null, failure => failure);
  expect(called).toBe(false);
  expect(error).toBeInstanceOf(RepositoryMutationError);
  expect(error.detail.kind).toBe("lock_busy");
  return error as RepositoryMutationError;
}

it("defers real same-common-owner contention through the lease port, preserves usage/deadline, and retries after release", async () => {
  const env = fixture(), linked = path.join(env.dir, "linked");
  await git(env.repo, ["worktree", "add", "--detach", linked, "HEAD"]);
  const db = openDatabase(env.cfg.storageDir); databases.push(db);
  let now = Date.now();
  const tasks = new TaskStore(db, () => now), leases = new SqliteTaskLeases(env.cfg, tasks, () => now);
  tasks.submit([WorkerTaskSchema.parse({ id: "contending-supervisor", profile: "summarize", goal: "Admission before model work", repositoryAliases: ["core"], budget: { maxModelRequests: 20 }, constraints: { acceptanceCriteria: ["exclusive mutation"] } })], { project: "demo" });
  const limits = { maxConcurrent: 2, maxWritersPerRepo: 2, leaseMs: 30000, defaultTimeoutMs: 60000 };
  const claimed = tasks.claim("live-host", limits)[0]!, before = tasks.get(claimed.row.id)!;
  const holder = await hold(env.repo);
  try {
    const originalLock = await readFile(lockFile(env.repo));
    const error = await blocked(linked);
    expect(isLocalRepositoryMutationContention(error)).toBe(true);
    expect(error.message).toContain(`live local owner ${process.pid}/`);
    expect(await readFile(lockFile(env.repo))).toEqual(originalLock);
    const disposition = classifyFailure(error, new AbortController().signal, { cfg: env.cfg, now: () => now, deadline: () => before.row.deadline_at! });
    expect(disposition.kind).toBe("defer");
    if (disposition.kind !== "defer") throw new Error("Expected exact local contention to defer");
    expect(disposition.at).toBe(now + 1000);
    const receipt = await leases.defer({ lease: capturedLease(claimed), operationId: leaseOperationId(now), nextAttemptAt: disposition.at, reason: disposition.reason });
    expect(receipt).toMatchObject({ kind: "defer", disposition: "applied", state: "waiting_for_capacity" });
    expect(tasks.get(claimed.row.id)!.row.deadline_at).toBe(before.row.deadline_at);
    expect(tasks.get(claimed.row.id)!.spec.budget).toEqual(before.spec.budget);
    expect(tasks.claim("too-early", limits)).toHaveLength(0);
    holder.release(); await holder.operation;
    now = disposition.at;
    const resumed = tasks.claim("live-host", limits)[0]!;
    expect(resumed.row.id).toBe(claimed.row.id);
    expect(resumed.row.run_count).toBe(claimed.row.run_count + 1);
    expect(resumed.row.deadline_at).toBe(before.row.deadline_at);
    expect(await withRepositoryMutation([linked], async () => "exclusive-owner")).toBe("exclusive-owner");
    expect(db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 0 });
  } finally { holder.release(); await holder.operation; }
});

it("never brands manually constructed, copied or serialized contention errors", async () => {
  const env = fixture(), holder = await hold(env.repo);
  try {
    const genuine = await blocked(env.repo);
    expect(isLocalRepositoryMutationContention(genuine)).toBe(true);
    for (const forged of [new RepositoryMutationError("lock_busy", genuine.message), { ...genuine }, JSON.parse(JSON.stringify(genuine))]) {
      expect(isLocalRepositoryMutationContention(forged)).toBe(false);
      if (forged instanceof RepositoryMutationError) expect(classifyFailure(forged, new AbortController().signal, { cfg: env.cfg, now: () => 1, deadline: () => 10000 })).toMatchObject({ kind: "final", state: "interrupted" });
    }
  } finally { holder.release(); await holder.operation; }
});

it.each(["foreign", "same-pid-without-handle", "stale", "malformed"])("preserves %s lock bytes and refuses automatic deferral", async kind => {
  const env = fixture(), file = lockFile(env.repo), owner = newRepositoryMutationOwner(path.dirname(file));
  const content = kind === "malformed" ? "unverified marker" : JSON.stringify({ ...owner, ...(kind === "foreign" ? { host: "foreign-host" } : kind === "stale" ? { pid: 2147483647 } : {}) });
  await writeFile(file, content);
  const error = await blocked(env.repo);
  expect(isLocalRepositoryMutationContention(error)).toBe(false);
  expect(classifyFailure(error, new AbortController().signal, { cfg: env.cfg, now: () => 1, deadline: () => 10000 })).toMatchObject({ kind: "final", state: "interrupted", stopReason: "repository_mutation_blocked: lock_busy" });
  expect(await readFile(file, "utf8")).toBe(content);
});

it.each(["replaced-identical", "changed-content", "hard-linked", "recovery-fence"])("refuses %s evidence even while a local scope is active", async kind => {
  const env = fixture(), file = lockFile(env.repo), moved = `${file}.original`, other = `${file}.other`, recovery = path.join(path.dirname(file), "meritrouter-mutation-recovery.lock");
  const holder = await hold(env.repo), content = await readFile(file);
  try {
    if (kind === "replaced-identical") { await rename(file, moved); await writeFile(file, content); }
    if (kind === "changed-content") { const owner = JSON.parse(content.toString()); owner.token = "0".repeat(32); await writeFile(file, JSON.stringify(owner)); }
    if (kind === "hard-linked") await link(file, other);
    if (kind === "recovery-fence") await writeFile(recovery, "recovery authority must be inspected");
    expect(isLocalRepositoryMutationContention(await blocked(env.repo))).toBe(false);
  } finally {
    if (kind === "replaced-identical") { await unlink(file); await rename(moved, file); }
    if (kind === "changed-content") await writeFile(file, content);
    if (kind === "hard-linked") await unlink(other);
    if (kind === "recovery-fence") await unlink(recovery);
    holder.release(); await holder.operation;
  }
});

it("preserves cancellation, shutdown, lease loss, deadline and nonqueue policy over live contention", async () => {
  const env = fixture(), holder = await hold(env.repo);
  try {
    const error = await blocked(env.repo), facts = { cfg: env.cfg, now: () => 100, deadline: () => 10000 };
    for (const reason of ["cancel", "shutdown", "lease_lost", "watchdog", "deadline"]) {
      const controller = new AbortController(); controller.abort(reason);
      const disposition = classifyFailure(error, controller.signal, facts);
      expect(disposition.kind).not.toBe("defer");
      if (reason === "cancel") expect(disposition).toMatchObject({ kind: "final", state: "cancelled" });
      if (reason === "shutdown" || reason === "lease_lost" || reason === "watchdog") expect(disposition.kind).toBe("abandon");
      if (reason === "deadline") expect(disposition).toMatchObject({ kind: "final", stopReason: "deadline_exceeded" });
    }
    expect(classifyFailure(error, new AbortController().signal, { ...facts, deadline: () => 100 })).toMatchObject({ kind: "final", stopReason: "deadline_exceeded" });
    expect(classifyFailure(error, new AbortController().signal, { ...facts, deadline: () => 500 })).toMatchObject({ kind: "final", state: "failed" });
    env.cfg.execution.on_capacity_exhausted = "fail";
    expect(classifyFailure(error, new AbortController().signal, facts)).toMatchObject({ kind: "final", state: "failed" });
  } finally { holder.release(); await holder.operation; }
});
