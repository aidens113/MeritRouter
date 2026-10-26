import { spawn } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { prepareGitProcess } from "../workspaces/git-process-policy.js";
import { git } from "../workspaces/git.js";
import { assertGitWriteTopology } from "../workspaces/git-write-topology.js";
import { CommitObjectSchema } from "./selected-commit-receipts.js";

export class SelectedRefPublicationError extends Error {
  constructor(readonly publication: "refused" | "uncertain" | "published", message: string) { super(message); }
}

/** Trusted host fault/verification callback; never exposed through model tools or stored DTOs. */
export interface PreparedRefControl {
  prepared?: (process: { pid: number; exited: Promise<void> }) => Promise<void>;
  committing?: (process: { pid: number }) => Promise<void>;
  timeoutMs?: number;
}

/**
 * File-backed Git only. A literal HEAD update prepares its own native HEAD lock, after which
 * raw HEAD type/target is checked before commit. Single-shot no-deref is insufficient.
 */
export async function publishSelectedRef(repo: string, input: {
  gitDirectory: string; head: string; branch: string; commit: string; env: Record<string, string>;
}, control: PreparedRefControl = {}): Promise<void> {
  const commit = CommitObjectSchema.parse(input.commit);
  if (input.head) CommitObjectSchema.parse(input.head);
  await assertGitWriteTopology(repo);
  const timeoutMs = z.number().int().min(50).max(10000).parse(control.timeoutMs ?? 10000);
  const format = (await git(repo, ["rev-parse", "--show-ref-format"])).trim();
  if (format !== "files") throw new SelectedRefPublicationError("refused", "Git ref backend cannot prove the required prepared HEAD lock");
  const actualGitDir = path.resolve((await git(repo, ["rev-parse", "--absolute-git-dir"])).trim());
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(actualGitDir) !== normalize(input.gitDirectory)) throw new SelectedRefPublicationError("refused", "Git publication owner changed");
  const headFile = path.join(actualGitDir, "HEAD"), lock = `${headFile}.lock`;
  try { await lstat(lock); throw new SelectedRefPublicationError("refused", "Foreign HEAD lock is present; it is preserved"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (input.branch) {
    await git(repo, ["check-ref-format", input.branch]);
    if ((await git(repo, ["symbolic-ref", "-q", input.branch], { allowExit: [1] })).trim()) throw new SelectedRefPublicationError("refused", "Chained symbolic branch targets are unsupported");
  }
  const policy = prepareGitProcess(repo, ["update-ref", "--stdin"], input.env);
  const child = spawn("git", policy.args, { cwd: repo, env: policy.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let outputBytes = 0, errorText = "", closed = false, exited = false, commitSent = false, acknowledged = false;
  const ownedLocks: Array<{ file: string; dev: number; ino: number }> = [];
  const exitedPromise = new Promise<void>(resolve => child.on("exit", () => { exited = true; resolve(); }));
  const queued: string[] = [], waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { fail = reject; }); void failure.catch(() => {});
  const exit = new Promise<number | null>((resolve) => {
    child.on("error", error => { fail(error); });
    child.on("close", code => {
      closed = true; const error = new Error(`Git ref transaction ended (${code}): ${errorText.slice(0, 1024)}`);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      resolve(code);
    });
  });
  child.stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString("utf8"); if (Buffer.byteLength(errorText) > 16384) { fail(new Error("Git ref diagnostics exceed limit")); child.kill(); } });
  child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 16384) { fail(new Error("Git ref response exceeds limit")); child.kill(); } });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { const waiter = waiters.shift(); if (waiter) waiter.resolve(line); else queued.push(line); });
  const timer = setTimeout(() => { fail(new Error("Git prepared ref transaction timed out")); child.kill(); }, timeoutMs);
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, failure]);
  const next = async (expected: string) => {
    const line = await bounded(queued.length ? Promise.resolve(queued.shift()!) : closed ? Promise.reject(new Error("Git ref transaction is closed")) : new Promise<string>((resolve, reject) => waiters.push({ resolve, reject })));
    if (line !== expected) throw new Error("Git ref transaction capability/protocol is unavailable");
  };
  try {
    child.stdin.write(`start\nupdate HEAD ${commit} ${input.head || "0".repeat(commit.length)}\nprepare\n`);
    await next("start: ok"); await next("prepare: ok");
    const owned = await lstat(lock);
    if (!owned.isFile() || owned.isSymbolicLink() || owned.nlink !== 1) throw new Error("Git did not establish a supported native HEAD lock");
    ownedLocks.push({ file: lock, dev: owned.dev, ino: owned.ino });
    const initialHead = await lstat(headFile);
    if (!initialHead.isFile() || initialHead.isSymbolicLink() || initialHead.nlink !== 1 || initialHead.size > 4096) throw new Error("Git HEAD file is unsafe");
    const expected = input.branch ? `ref: ${input.branch}` : input.head;
    if ((await readFile(headFile, "utf8")).trim() !== expected) throw new Error("Git HEAD symbolic type/target changed before prepared publication");
    if (input.branch) {
      const branchFile = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", input.branch], { timeoutMs: 10000 })).trim());
      const branchLock = `${branchFile}.lock`, stat = await lstat(branchLock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Git did not establish a supported native branch lock");
      ownedLocks.push({ file: branchLock, dev: stat.dev, ino: stat.ino });
    }
    if (control.prepared) await bounded(control.prepared({ pid: z.number().int().positive().parse(child.pid), exited: exitedPromise }));
    const headStat = await lstat(headFile);
    if (!headStat.isFile() || headStat.isSymbolicLink() || headStat.nlink !== 1 || headStat.size > 4096) throw new Error("Git HEAD file is unsafe");
    const raw = (await readFile(headFile, "utf8")).trim();
    if (raw !== expected) throw new Error("Git HEAD symbolic type/target changed before prepared publication");
    const current = await lstat(lock);
    if (closed || exited || child.exitCode !== null || child.signalCode !== null || current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink()) throw new Error("Prepared HEAD process/lock ownership changed");
    for (const owned of ownedLocks) {
      const stat = await lstat(owned.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== owned.dev || stat.ino !== owned.ino) throw new Error("Prepared Git ref lock ownership changed");
    }
    await assertGitWriteTopology(repo);
    child.stdin.end("commit\n"); commitSent = true;
    if (control.committing) await bounded(control.committing({ pid: z.number().int().positive().parse(child.pid) }));
    await next("commit: ok"); acknowledged = true;
    const code = await bounded(exit);
    if (code !== 0) throw new Error("Git exited after acknowledging ref publication");
  } catch (error) {
    throw new SelectedRefPublicationError(acknowledged ? "published" : commitSent ? "uncertain" : "refused", (error as Error).message);
  } finally {
    if (!closed) { if (!commitSent) child.stdin.end("abort\n"); else child.stdin.end(); }
    await exit;
    clearTimeout(timer); lines.close();
    if (!commitSent) {
      for (const owned of ownedLocks) {
        try {
          const current = await lstat(owned.file);
          if (!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await unlink(owned.file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
}
