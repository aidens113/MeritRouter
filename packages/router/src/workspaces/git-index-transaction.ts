import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isProjectMetadataPath } from "../projects/metadata-policy.js";
import { assertGitWriteTopology } from "./git-write-topology.js";

declare const indexBrand: unique symbol;
/** Host-only active lease; JSON, object copies and expired leases never authorize index overrides. */
export interface GitIndexCapability { readonly [indexBrand]: true }
interface IndexLease { repo: string; index: string; active: boolean; deadline: number; pending: Set<Promise<unknown>>; head: string; branch: string; headIndex?: boolean }
const leases = new WeakMap<object, IndexLease>();
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const canonical = (value: string) => {
  const real = realpathSync(value);
  return process.platform === "win32" ? real.toLowerCase() : real;
};

/** Track the actual returned command promise; even accidentally unawaited work is drained. */
export function runGitIndexCommand<T>(capability: GitIndexCapability, run: () => Promise<T>): Promise<T> {
  const lease = capability && typeof capability === "object" ? leases.get(capability) : undefined;
  if (!lease || !lease.active || Date.now() > lease.deadline) return Promise.reject(new Error("Inactive or forged Git index capability"));
  const command = run();
  lease.pending.add(command);
  void command.then(() => lease.pending.delete(command), () => lease.pending.delete(command));
  return command;
}

async function revokeAndDrain(capability: GitIndexCapability): Promise<boolean> {
  const lease = leases.get(capability)!;
  lease.active = false;
  const pending = [...lease.pending];
  await Promise.allSettled(pending);
  return pending.length > 0;
}

/** Internal process-policy bridge: never mints a capability or accepts an index filename. */
export function authorizedGitIndex(capability: GitIndexCapability, cwd: string, args: readonly string[]): string {
  const lease = capability && typeof capability === "object" ? leases.get(capability) : undefined;
  if (!lease || !lease.active || Date.now() > lease.deadline || canonical(cwd) !== lease.repo) throw new Error("Inactive, forged or foreign Git index capability");
  const command = args[0];
  if (args.length > 256 || args.reduce((sum, arg) => sum + arg.length, 0) > 32768) throw new Error("Git index command exceeds supported argument bounds");
  const initialize = args.length === 2 && command === "read-tree" && (args[1] === "--empty" || lease.headIndex && args[1] === lease.head && !!lease.head);
  const applyCached = args.join("\0") === ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"].join("\0");
  if (!["add", "ls-files", "diff", "write-tree"].includes(command ?? "") && !initialize && !applyCached) {
    throw new Error("Git index capability cannot authorize this command");
  }
  if (args.some(arg => /^--(?:index-output|output|pathspec-from-file)(?:=|$)/.test(arg))) throw new Error("Git index capability cannot redirect files");
  const stat = lstatSync(path.dirname(lease.index));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git index temporary directory changed");
  return lease.index;
}

/** Snapshot captured under the native index lock; no raw index filename is exposed. */
export function gitIndexSnapshot(capability: GitIndexCapability): { head: string; branch: string } {
  const lease = leases.get(capability);
  if (!lease || !lease.active) throw new Error("Inactive Git index capability");
  return { head: lease.head, branch: lease.branch };
}

/** Secondary index starts from immutable expected HEAD; callback cannot publish it directly. */
export async function withHeadGitIndex<T>(base: GitIndexCapability, action: (candidate: GitIndexCapability) => Promise<T>): Promise<T> {
  const parent = leases.get(base);
  if (!parent || !parent.active) throw new Error("Inactive Git index capability");
  const capability = Object.freeze({}) as GitIndexCapability;
  leases.set(capability, { ...parent, index: path.join(path.dirname(parent.index), `candidate-${randomBytes(8).toString("hex")}.index`), active: true, pending: new Set(), headIndex: true });
  const { git } = await import("./git.js");
  try {
    await git(parent.repo, ["read-tree", parent.head || "--empty"], { index: capability });
    const result = await action(capability);
    if (await revokeAndDrain(capability)) throw new Error("Candidate index commands were not awaited");
    return result;
  } finally { await revokeAndDrain(capability); }
}

export interface GitIndexPublicationSnapshot<T> {
  gitDirectory: string;
  indexPath: string;
  originalIndex: Buffer | null;
  nextIndex: Buffer;
  head: string;
  branch: string;
  result: T;
}

async function directoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Git index metadata has a linked/non-directory ancestor");
  }
}

async function indexBytes(index: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(index);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_INDEX_BYTES) throw new Error("Git index must be a bounded unlinked regular file");
    return await readFile(index);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean { return a === null ? b === null : b !== null && a.equals(b); }

/** Check paths without reading their content. Missing ordinary paths can represent deletions. */
export async function assertSafeIndexInput(repo: string, relative: string, allowMissing: boolean): Promise<void> {
  if (!relative || relative.length > 4096 || relative.includes("\0") || relative.startsWith("/") || /^[A-Za-z]:/.test(relative)
    || relative.split(/[\\/]/).some(part => part === "..") || isProjectMetadataPath(relative)) throw new Error("Private or invalid Git staging input refused");
  const root = canonical(repo);
  let current = path.resolve(repo);
  const components = relative.split("/");
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]!);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Linked Git staging inputs are refused");
    if (i < components.length - 1 && !stat.isDirectory()) throw new Error("Git staging input has a non-directory ancestor");
    if (i === components.length - 1 && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Hardlinked or non-file Git staging input refused");
    const resolved = canonical(current), owned = path.relative(root, resolved);
    if (owned === ".." || owned.startsWith(`..${path.sep}`) || path.isAbsolute(owned) || isProjectMetadataPath(owned)) throw new Error("Git staging input escapes safe application content");
  }
}

/**
 * Trusted host staging transaction only: callback cannot commit/update HEAD using its capability.
 * Original index is published only after callback, full index/path preflight and HEAD/branch/index snapshot rechecks.
 * Cooperating native Git writers respect index.lock; hostile filesystem races remain out of scope.
 */
export async function withGitIndexTransaction<T>(repo: string, action: (index: GitIndexCapability) => Promise<T>, publication?: (snapshot: GitIndexPublicationSnapshot<T>) => Promise<void>): Promise<T> {
  const { git } = await import("./git.js");
  const { assertNoTrackedProjectMetadata } = await import("./metadata-exclusion.js");
  // Metadata and write-topology preflights run once, under the native index lock and before
  // any effect; an unlocked copy of the same checks only repeated their Git processes.
  const location = (await git(repo, ["rev-parse", "--absolute-git-dir", "--git-path", "index"])).split("\n").map(line => line.trim());
  if (!location[0] || !location[1]) throw new Error("Git index location could not be resolved");
  const gitDir = path.resolve(location[0]);
  const index = path.resolve(repo, location[1]);
  const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(index) !== normalized(path.join(gitDir, "index"))) throw new Error("Git index location does not match its worktree metadata");
  await directoryChain(gitDir);
  const lock = `${index}.lock`;
  const deadline = Date.now() + 2000;
  let handle: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try { handle = await open(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Git index lock is busy; foreign locks are preserved");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const owned = await handle.stat();
  let temp: string | null = null, capability: GitIndexCapability | null = null, validation: GitIndexCapability | null = null, closed = false, published = false;
  try {
    await directoryChain(gitDir);
    // Snapshot first, then check metadata: the final recheck proves HEAD and the native index
    // are still these exact inputs, so the metadata verdict below still applies to them.
    const before = await indexBytes(index);
    const head = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [1] })).trim();
    const branch = (await git(repo, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] })).trim();
    await assertNoTrackedProjectMetadata(repo);
    await assertGitWriteTopology(repo);
    if (!before && head) throw new Error("A committed repository with a missing index requires explicit recovery");
    temp = path.join(gitDir, `meritrouter-index-${randomBytes(12).toString("hex")}`);
    await mkdir(temp, { mode: 0o700 });
    const temporaryIndex = path.join(temp, "index");
    capability = Object.freeze({}) as GitIndexCapability;
    leases.set(capability, { repo: canonical(repo), index: temporaryIndex, active: true, deadline: Date.now() + 60000, pending: new Set(), head, branch });
    if (before) {
      const file = await open(temporaryIndex, "wx", 0o600);
      try { await file.writeFile(before); } finally { await file.close(); }
    } else await git(repo, ["read-tree", "--empty"], { index: capability, timeoutMs: 10000 });
    const result = await action(capability);
    if (await revokeAndDrain(capability)) throw new Error("Git index commands were not awaited; transaction refused after draining");
    validation = Object.freeze({}) as GitIndexCapability;
    leases.set(validation, { ...leases.get(capability)!, active: true, pending: new Set() });
    const staged = await git(repo, ["ls-files", "--stage", "-z"], { index: validation, timeoutMs: 10000 });
    const entries = staged.split("\0").filter(Boolean);
    if (entries.length > MAX_ENTRIES) throw new Error("Git index exceeds the supported entry bound");
    for (const entry of entries) {
      const match = /^([0-7]{6}) [a-f0-9]{40,64} 0\t([\s\S]+)$/.exec(entry);
      if (!match || match[1] === "160000") throw new Error("Unsupported or unmerged candidate index entry");
      await assertSafeIndexInput(repo, match[2]!, true);
    }
    if ((await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [1] })).trim() !== head
      || (await git(repo, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] })).trim() !== branch
      || !sameBytes(before, await indexBytes(index))) throw new Error("Repository HEAD/index changed during staging");
    // The under-lock metadata check ran after `before`/`head` were read and this proves both are
    // unchanged now: same HEAD commit (so tree) and byte-identical native index. An unborn HEAD
    // also depends on other branch refs, so it is checked again.
    if (!head) await assertNoTrackedProjectMetadata(repo);
    const after = await indexBytes(temporaryIndex);
    if (!after) throw new Error("Temporary Git index is missing");
    await revokeAndDrain(validation);
    if (publication) await publication({ gitDirectory: gitDir, indexPath: index, originalIndex: before ? Buffer.from(before) : null, nextIndex: Buffer.from(after), head, branch, result });
    await rm(temp, { recursive: true }); temp = null;
    await handle.writeFile(after); await handle.sync(); await handle.close(); closed = true;
    await directoryChain(gitDir);
    const current = await lstat(lock);
    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error("Git index lock ownership changed");
    await rename(lock, index);
    published = true;
    return result;
  } finally {
    if (capability) await revokeAndDrain(capability);
    if (validation) await revokeAndDrain(validation);
    if (!closed) await handle.close();
    if (!published) {
      try {
        const current = await lstat(lock);
        if (!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await unlink(lock);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
