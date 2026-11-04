import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, link, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertNoPendingCommitPublication } from "../attribution/selected-commit-receipts.js";
import { assertNoActiveRepositoryCommand } from "./repository-command.js";
import { git } from "./git.js";
import { exactRepositoryRoot } from "./repository-root.js";

const Token = z.string().regex(/^[a-f0-9]{32}$/), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryMutationOwnerSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), token: Token, pid: z.number().int().positive() }).strict(),
  z.object({ version: z.literal(2), token: Token, pid: z.number().int().positive(), host: z.string().min(1).max(256), instance: Token,
    commonDirectory: z.string().min(1).max(4096), createdAt: z.number().int().nonnegative() }).strict(),
]);
const instance = randomBytes(16).toString("hex");
export function newRepositoryMutationOwner(commonDirectory: string) {
  return RepositoryMutationOwnerSchema.parse({ version: 2, token: randomBytes(16).toString("hex"), pid: process.pid, host: hostname(), instance, commonDirectory, createdAt: Date.now() });
}
const LegacyOwnerSchema = z.object({ host: z.string().min(1).max(256), pid: z.number().int().positive(), token: Token,
  evidence: z.string().trim().min(1).max(4000) }).strict();
const ControlSchema = z.object({ legacyOwner: LegacyOwnerSchema.optional() }).strict();
const RecoverySchema = ControlSchema.extend({ expected: Hash, reason: z.string().trim().min(1).max(2000) }).strict();
const key = (s: string) => process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function safeDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root; let at = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, component); const stat = await lstat(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Mutation recovery metadata ancestor changed");
  }
}
async function readLock(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) throw new Error("Mutation lock is not a bounded unlinked regular file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("Mutation lock changed while opening");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error("Mutation lock changed while reading");
    const owner = RepositoryMutationOwnerSchema.parse(JSON.parse(bytes.toString("utf8")));
    return { bytes, owner, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: sha(bytes) } };
  } finally { await handle.close(); }
}
/** Unknown probes, permission errors and PID reuse all remain ineligible. */
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}
export async function repositoryMutationRecoveryInProgress(directory: string): Promise<boolean> {
  try { await lstat(path.join(directory, "meritrouter-mutation-recovery.lock")); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function nativeLocks(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["index.lock", "HEAD.lock", "packed-refs.lock", "shallow.lock", "config.lock"]) {
    try { await lstat(path.join(directory, name)); found.push(path.join(directory, name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const pending = [path.join(directory, "refs")]; let count = 0;
  while (pending.length) {
    const at = pending.pop()!; let entries;
    try { await safeDirectory(at); entries = await readdir(at, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const entry of entries) {
      if (++count > 4096) throw new Error("Native ref lock inventory exceeds its bound");
      if (entry.isSymbolicLink()) throw new Error("Linked native ref metadata is unverified");
      if (entry.name.endsWith(".lock")) found.push(path.join(at, entry.name));
      else if (entry.isDirectory()) pending.push(path.join(at, entry.name));
    }
  }
  return found;
}
async function observe(repo: string, control: z.infer<typeof ControlSchema>, recoveryFence = false) {
  const root = await realpath(z.string().min(1).max(4096).refine(s => !s.includes("\0")).parse(repo)), locations = await exactRepositoryRoot(root), commonDirectory = await realpath(locations.commonDirectory);
  await safeDirectory(commonDirectory);
  const file = path.join(commonDirectory, recoveryFence ? "meritrouter-mutation-recovery.lock" : "meritrouter-mutation.lock"), seen = await readLock(file), blockers: string[] = [];
  if (recoveryFence && seen.owner.version !== 2) blockers.push("recovery_fence_requires_modern_owner");
  if (seen.owner.version === 2) {
    if (seen.owner.host !== hostname()) blockers.push("foreign_host");
    if (key(seen.owner.commonDirectory) !== key(commonDirectory)) blockers.push("foreign_physical_owner");
  } else {
    const proof = control.legacyOwner;
    if (!proof || proof.host !== hostname() || proof.pid !== seen.owner.pid || proof.token !== seen.owner.token) blockers.push("legacy_same_host_attestation_required");
  }
  if (!absent(seen.owner.pid)) blockers.push("owner_live_or_unknown");
  if (recoveryFence) {
    try {
      const mutation = await readLock(path.join(commonDirectory, "meritrouter-mutation.lock"));
      if (mutation.owner.version === 2 && (mutation.owner.host !== hostname() || key(mutation.owner.commonDirectory) !== key(commonDirectory)) || !absent(mutation.owner.pid)) blockers.push("mutation_owner_live_or_unverified");
      if (mutation.owner.version === 1 && (!control.legacyOwner || control.legacyOwner.host !== hostname() || control.legacyOwner.pid !== mutation.owner.pid || control.legacyOwner.token !== mutation.owner.token)) blockers.push("legacy_mutation_owner_attestation_required");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const worktrees = (await git(root, ["worktree", "list", "--porcelain", "-z"], { maxBuffer: 1024 * 1024 })).split("\0").filter(s => s.startsWith("worktree ")).map(s => s.slice(9)).sort();
  if (!worktrees.length || worktrees.length > 128) throw new Error("Mutation recovery worktree inventory exceeds its bound");
  for (const tree of worktrees) {
    const physical = await realpath(tree), owner = await exactRepositoryRoot(physical);
    if (key(await realpath(owner.commonDirectory)) !== key(commonDirectory)) throw new Error("Mutation recovery worktree owner changed");
    try { await assertNoPendingCommitPublication(physical); } catch (e) { blockers.push(`publication:${tree}:${(e as Error).message}`); }
    try { await assertNoActiveRepositoryCommand(physical); } catch (e) { blockers.push(`command:${tree}:${(e as Error).message}`); }
    for (const lock of await nativeLocks(owner.gitDirectory)) blockers.push(`native_lock:${lock}`);
  }
  for (const lock of await nativeLocks(commonDirectory)) if (!blockers.includes(`native_lock:${lock}`)) blockers.push(`native_lock:${lock}`);
  const snapshot = { version: 1 as const, root, commonDirectory, file, owner: seen.owner, identity: seen.identity, worktrees, blockers,
    legacyOwner: control.legacyOwner ?? null };
  return { snapshot, expected: sha(JSON.stringify(snapshot)), eligible: !blockers.length, bytes: seen.bytes };
}
/** Read-only: legacy records deliberately require explicit FINAL evidence, never a guessed host. */
export async function inspectRepositoryMutationLock(repo: string, raw: z.input<typeof ControlSchema> = {}) {
  const { bytes: _bytes, ...result } = await observe(repo, ControlSchema.parse(raw)); return result;
}
async function durable(file: string, content: Buffer | string) {
  const handle = await open(file, "wx", 0o600); try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function restoreRetiredMarker(retired: string, file: string): Promise<boolean> {
  await link(retired, file).catch(() => {});
  try { await lstat(file); return true; } catch { return false; }
}
/** Explicit conditional recovery; archives original bytes and receipt without changing Git/source. */
export async function reconcileRepositoryMutationLock(repo: string, raw: z.input<typeof RecoverySchema>) {
  const input = RecoverySchema.parse(raw), before = await observe(repo, input);
  if (before.expected !== input.expected) throw new Error("Mutation recovery snapshot changed");
  if (!before.eligible) throw new Error(`Mutation recovery refused: ${before.snapshot.blockers.join("; ")}`);
  const directory = before.snapshot.commonDirectory, gate = path.join(directory, "meritrouter-mutation-recovery.lock");
  const gateBytes = Buffer.from(JSON.stringify(newRepositoryMutationOwner(directory)));
  await durable(gate, gateBytes);
  const gateStat = await lstat(gate);
  let releaseGate = true;
  try {
    const current = await observe(repo, input);
    if (!current.eligible || current.expected !== input.expected) throw new Error("Mutation recovery snapshot changed before archive");
    const archiveRoot = path.join(directory, "meritrouter-mutation-recovery");
    try { await mkdir(archiveRoot, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await safeDirectory(archiveRoot);
    const archive = path.join(archiveRoot, `${before.snapshot.owner.token}-${randomBytes(8).toString("hex")}`);
    await mkdir(archive, { mode: 0o700 }); await safeDirectory(archive);
    await durable(path.join(archive, "observed.lock"), before.bytes);
    const receipt = { version: 1, at: Date.now(), actor: { host: hostname(), pid: process.pid, instance }, reason: input.reason,
      expected: input.expected, snapshot: before.snapshot, proof: { kind: "same_host_pid_absent", basis: "ESRCH" } };
    await durable(path.join(archive, "receipt.json"), JSON.stringify(receipt));
    // Recheck exact bytes/inode and physical guards immediately before retiring the marker.
    const final = await observe(repo, input);
    if (!final.eligible || final.expected !== input.expected) throw new Error("Mutation recovery snapshot changed at retirement");
    const retired = path.join(archive, "original.lock");
    // Until the moved inode/content are proved, keep the independent recovery barrier.
    releaseGate = false;
    await rename(before.snapshot.file, retired);
    let moved: Awaited<ReturnType<typeof readLock>>;
    try { moved = await readLock(retired); }
    catch {
      releaseGate = await restoreRetiredMarker(retired, before.snapshot.file);
      throw new Error("Malformed mutation lock replacement preserved; retirement is unverified");
    }
    if (JSON.stringify(moved.identity) !== JSON.stringify(before.snapshot.identity)) {
      // Never discard a raced replacement. Restore only without overwriting another marker.
      releaseGate = await restoreRetiredMarker(retired, before.snapshot.file);
      throw new Error("Mutation lock replacement preserved; retirement is unverified");
    }
    releaseGate = true;
    await durable(path.join(archive, "completed.json"), JSON.stringify({ expected: input.expected, retiredAt: Date.now(), originalSha256: sha(moved.bytes) }));
    return { reconciled: true as const, archive, ...receipt };
  } finally {
    if (releaseGate) {
      const stat = await lstat(gate);
      if (stat.dev !== gateStat.dev || stat.ino !== gateStat.ino || !(await readFile(gate)).equals(gateBytes)) throw new Error("Mutation recovery guard replacement preserved");
      await unlink(gate);
    }
  }
}

/** A crashed recovery retains its own fence. It is reconciled explicitly, without another lock. */
export async function inspectRepositoryMutationRecoveryFence(repo: string, raw: z.input<typeof ControlSchema> = {}) {
  const { bytes: _bytes, ...result } = await observe(repo, ControlSchema.parse(raw), true); return result;
}
export async function reconcileRepositoryMutationRecoveryFence(repo: string, raw: z.input<typeof RecoverySchema>) {
  const input = RecoverySchema.parse(raw), before = await observe(repo, input, true);
  if (before.expected !== input.expected || !before.eligible) throw new Error("Recovery fence changed or its owner/guards are unverified");
  const root = path.join(before.snapshot.commonDirectory, "meritrouter-mutation-recovery");
  try { await mkdir(root, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  await safeDirectory(root);
  const archive = path.join(root, `fence-${before.snapshot.owner.token}-${randomBytes(8).toString("hex")}`);
  await mkdir(archive, { mode: 0o700 }); await safeDirectory(archive);
  await durable(path.join(archive, "observed.lock"), before.bytes);
  const receipt = { version: 1, at: Date.now(), actor: { host: hostname(), pid: process.pid, instance }, reason: input.reason, expected: input.expected, snapshot: before.snapshot };
  await durable(path.join(archive, "receipt.json"), JSON.stringify(receipt));
  const final = await observe(repo, input, true);
  if (final.expected !== input.expected || !final.eligible) throw new Error("Recovery fence changed at retirement");
  const retired = path.join(archive, "original.lock"); await rename(before.snapshot.file, retired);
  let moved: Awaited<ReturnType<typeof readLock>>;
  try { moved = await readLock(retired); }
  catch {
    await restoreRetiredMarker(retired, before.snapshot.file);
    throw new Error("Malformed recovery fence replacement preserved; retirement unverified");
  }
  if (JSON.stringify(moved.identity) !== JSON.stringify(before.snapshot.identity)) {
    await restoreRetiredMarker(retired, before.snapshot.file);
    throw new Error("Recovery fence replacement preserved; retirement unverified");
  }
  await durable(path.join(archive, "completed.json"), JSON.stringify({ expected: input.expected, retiredAt: Date.now(), originalSha256: sha(moved.bytes) }));
  return { reconciled: true as const, archive, ...receipt };
}
