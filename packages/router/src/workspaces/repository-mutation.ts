import { randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertNoPendingCommitPublication } from "../attribution/selected-commit-receipts.js";
import { git } from "./git.js";

declare const mutationBrand: unique symbol;
/** Host-only scope; object copies, serialized values and expired scopes cannot authorize writes. */
export interface RepositoryMutationCapability { readonly [mutationBrand]: true }
export const RepositoryMutationFailureSchema = z.object({
  kind: z.enum(["pending_publication", "lock_busy", "invalid_capability", "ownership_changed", "unawaited_mutation"]),
  reason: z.string().max(4096),
  receiptId: z.string().regex(/^pc_[a-f0-9]{32}$/).optional(),
}).strict();
export class RepositoryMutationError extends Error {
  readonly detail: z.infer<typeof RepositoryMutationFailureSchema>;
  constructor(kind: z.infer<typeof RepositoryMutationFailureSchema>["kind"], reason: string, receiptId?: string) {
    super(reason.slice(0, 4096));
    this.name = "RepositoryMutationError";
    this.detail = RepositoryMutationFailureSchema.parse({ kind, reason: this.message, ...(receiptId ? { receiptId } : {}) });
  }
}
interface Owner { repo: string; gitDirectory: string; commonDirectory: string }
interface Lease { active: boolean; owners: Set<string>; pending: Set<Promise<unknown>>; capability: RepositoryMutationCapability }
interface OwnedLock { file: string; directory: string; content: Buffer; handle: Awaited<ReturnType<typeof open>>; dev: number; ino: number }
const leases = new WeakMap<object, Lease>();
const repositories = z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(1).max(128);
const optionsSchema = z.object({ capability: z.unknown().optional(), timeoutMs: z.number().int().min(50).max(60000).default(10000) }).strict();
const lockRecord = z.object({ version: z.literal(1), token: z.string().regex(/^[a-f0-9]{32}$/), pid: z.number().int().positive() }).strict();
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

async function directoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RepositoryMutationError("ownership_changed", "Repository mutation metadata has a linked or invalid ancestor");
  }
}
async function resolveOwners(input: string[]): Promise<Owner[]> {
  const resolved: Owner[] = [];
  for (const repo of [...new Set(input)]) {
    const physical = await realpath(repo);
    // Registered repository roots may themselves be directory aliases. Resolve that
    // authorized root first; aliases must share one physical owner and lock ordering.
    const gitDirectory = path.resolve(physical, (await git(physical, ["rev-parse", "--absolute-git-dir"])).trim());
    const commonDirectory = path.resolve(physical, (await git(physical, ["rev-parse", "--git-common-dir"])).trim());
    await directoryChain(gitDirectory); await directoryChain(commonDirectory);
    const physicalGit = await realpath(gitDirectory), physicalCommon = await realpath(commonDirectory);
    resolved.push({ repo: physical, gitDirectory: physicalGit, commonDirectory: physicalCommon });
  }
  return resolved;
}
async function validateOwners(owners: Owner[]): Promise<void> {
  for (const owner of owners) {
    const [current] = await resolveOwners([owner.repo]);
    if (!current || key(current.gitDirectory) !== key(owner.gitDirectory) || key(current.commonDirectory) !== key(owner.commonDirectory)) throw new RepositoryMutationError("ownership_changed", "Repository mutation owner changed during admission");
    try { await assertNoPendingCommitPublication(owner.repo); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "Repository publication requires explicit reconciliation";
      const receiptId = /^Publication (pc_[a-f0-9]{32}) requires explicit reconciliation$/.exec(reason)?.[1];
      throw new RepositoryMutationError("pending_publication", reason, receiptId);
    }
  }
}
async function acquire(directory: string, deadline: number): Promise<OwnedLock> {
  const file = path.join(directory, "meritrouter-mutation.lock");
  for (;;) {
    await directoryChain(directory);
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new RepositoryMutationError("lock_busy", "Repository mutation lock is busy; foreign or stale locks are preserved");
      await new Promise(resolve => setTimeout(resolve, 25)); continue;
    }
    const content = Buffer.from(JSON.stringify(lockRecord.parse({ version: 1, token: randomBytes(16).toString("hex"), pid: process.pid })));
    const stat = await handle.stat();
    const owned = { file, directory, content, handle, dev: stat.dev, ino: stat.ino };
    try { await handle.writeFile(content); await handle.sync(); return owned; }
    catch (error) { await release(owned); throw error; }
  }
}
async function release(owned: OwnedLock): Promise<void> {
  try {
    await directoryChain(owned.directory);
    const stat = await lstat(owned.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.size > 1024) throw new RepositoryMutationError("ownership_changed", "Repository mutation lock ownership changed; replacement is preserved");
    const content = await readFile(owned.file);
    try { lockRecord.parse(JSON.parse(content.toString("utf8"))); }
    catch { throw new RepositoryMutationError("ownership_changed", "Repository mutation lock record changed; replacement is preserved"); }
    if (!content.equals(owned.content)) throw new RepositoryMutationError("ownership_changed", "Repository mutation lock content changed; replacement is preserved");
    await owned.handle.close();
    const closed = await lstat(owned.file);
    if (!closed.isFile() || closed.isSymbolicLink() || closed.nlink !== 1 || closed.dev !== owned.dev || closed.ino !== owned.ino) throw new RepositoryMutationError("ownership_changed", "Repository mutation lock ownership changed before release; replacement is preserved");
    await unlink(owned.file);
  } catch (error) {
    if (error instanceof RepositoryMutationError) throw error;
    throw new RepositoryMutationError("ownership_changed", "Repository mutation lock ownership could not be verified; evidence is preserved");
  } finally { await owned.handle.close().catch(() => {}); }
}
function activeLease(capability: RepositoryMutationCapability): Lease {
  const lease = capability && typeof capability === "object" ? leases.get(capability) : undefined;
  if (!lease?.active) throw new RepositoryMutationError("invalid_capability", "Inactive, forged or expired repository mutation capability");
  return lease;
}

export interface RepositoryMutationOptions { capability?: RepositoryMutationCapability; timeoutMs?: number }
/**
 * Lock order: sorted physical common Git owners, then native index/ref locks inside action.
 * Never call while holding a SQLite transaction. Locks are cooperative, never stolen by age.
 * Reentrant scopes cannot add owners; every requested worktree gets its own under-lock gate.
 */
export function withRepositoryMutation<T>(input: string[], action: (capability: RepositoryMutationCapability) => Promise<T>, options: RepositoryMutationOptions = {}): Promise<T> {
  let requested: string[], parsed: z.infer<typeof optionsSchema>;
  try { requested = repositories.parse(input); parsed = optionsSchema.parse(options); }
  catch (error) { return Promise.reject(error); }
  if (parsed.capability !== undefined) {
    let lease: Lease;
    try { lease = activeLease(parsed.capability as RepositoryMutationCapability); } catch (error) { return Promise.reject(error); }
    const running = (async () => {
      const owners = await resolveOwners(requested);
      activeLease(lease.capability);
      if (owners.some(owner => !lease.owners.has(key(owner.commonDirectory)))) throw new RepositoryMutationError("invalid_capability", "Repository mutation capability cannot widen its owner scope");
      await validateOwners(owners); activeLease(lease.capability);
      return action(lease.capability);
    })();
    lease.pending.add(running);
    void running.then(() => lease.pending.delete(running), () => lease.pending.delete(running));
    return running;
  }
  return (async () => {
    const owners = await resolveOwners(requested);
    const directories = [...new Map(owners.map(owner => [key(owner.commonDirectory), owner.commonDirectory])).values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const locks: OwnedLock[] = [], deadline = Date.now() + parsed.timeoutMs;
    try {
      for (const directory of directories) locks.push(await acquire(directory, deadline));
      await validateOwners(owners);
      const capability = Object.freeze({}) as RepositoryMutationCapability;
      const lease: Lease = { active: true, owners: new Set(directories.map(key)), pending: new Set(), capability };
      leases.set(capability, lease);
      let result!: T, failure: unknown, failed = false;
      try { result = await action(capability); } catch (error) { failed = true; failure = error; }
      lease.active = false;
      const outstanding = [...lease.pending]; await Promise.allSettled(outstanding);
      if (failed) throw failure;
      if (outstanding.length) throw new RepositoryMutationError("unawaited_mutation", "Repository mutation commands were not awaited; scopes drained before unlock");
      return result;
    } finally {
      let failure: unknown;
      for (const owned of locks.reverse()) { try { await release(owned); } catch (error) { failure ??= error; } }
      if (failure) throw failure;
    }
  })();
}
