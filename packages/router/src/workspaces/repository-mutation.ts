import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertNoPendingCommitPublication } from "../attribution/selected-commit-receipts.js";
import { git } from "./git.js";
import { EXACT_ROOT_REV_PARSE, EnclosingRepositoryError, parseExactRepositoryRoot } from "./repository-root.js";
import { assertNoActiveRepositoryCommand, assertRepositoryCommandPermitScope, type RepositoryCommandPermits } from "./repository-command.js";
import { newRepositoryMutationOwner, RepositoryMutationOwnerSchema, repositoryMutationRecoveryInProgress } from "./repository-mutation-recovery.js";

declare const mutationBrand: unique symbol;
/** Host-only scope; object copies, serialized values and expired scopes cannot authorize writes. */
export interface RepositoryMutationCapability { readonly [mutationBrand]: true }
export const RepositoryMutationFailureSchema = z.object({
  kind: z.enum(["pending_publication", "active_command", "command_uncertain", "lock_busy", "invalid_capability", "ownership_changed", "unawaited_mutation"]),
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
// Only this module's still-open exact lock handle can establish local contention.
// A same-PID JSON marker, serialized error or copied error is not that authority.
const activeLocks = new Map<string, OwnedLock>();
const localContentions = new WeakSet<RepositoryMutationError>();
export function isLocalRepositoryMutationContention(error: unknown): boolean {
  return error instanceof RepositoryMutationError && localContentions.has(error);
}
const repositories = z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).min(1).max(128);
const expectedDirectories = repositories.refine(values => values.every(value => path.isAbsolute(value) && path.resolve(value) === value), "Expected common directories must be canonical absolute physical paths");
const optionsSchema = z.object({ capability: z.unknown().optional(), command: z.unknown().optional(), expectedCommonDirectories: expectedDirectories.optional(), timeoutMs: z.number().int().min(50).max(60000).default(10000) }).strict();
const lockRecord = RepositoryMutationOwnerSchema;
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
    // One rev-parse answers both locations and proves `physical` is the repository's own root.
    // Git discovery walks up, so a non-repository folder would otherwise lock an enclosing
    // repository (a home folder can be one); that repository is never ours to fence.
    let gitDirectory: string, commonDirectory: string;
    try { ({ gitDirectory, commonDirectory } = await parseExactRepositoryRoot(physical, await git(physical, [...EXACT_ROOT_REV_PARSE]))); }
    catch (error) {
      if (error instanceof EnclosingRepositoryError) throw new RepositoryMutationError("ownership_changed", error.message);
      throw error;
    }
    await directoryChain(gitDirectory); await directoryChain(commonDirectory);
    const physicalGit = await realpath(gitDirectory), physicalCommon = await realpath(commonDirectory);
    resolved.push({ repo: physical, gitDirectory: physicalGit, commonDirectory: physicalCommon });
  }
  return resolved;
}
function assertExpectedOwners(owners: Owner[], expected?: string[]): void {
  if (expected === undefined) return;
  // These strings pin authority established by an earlier physical proof. Resolving them
  // again through realpath would let a replacement link redefine the approved owner.
  const pinned = new Set(expected.map(key)), actual = new Set(owners.map(owner => key(owner.commonDirectory)));
  if (pinned.size !== actual.size || [...actual].some(directory => !pinned.has(directory))) throw new RepositoryMutationError("ownership_changed", "Repository mutation owner differs from the pinned common directories");
}
/** `resolved` is true only when `owners` were resolved after the lock that fences them was held. */
async function validateOwners(owners: Owner[], command?: RepositoryCommandPermits, resolved = false): Promise<void> {
  await assertRepositoryCommandPermitScope(owners.map(owner => owner.gitDirectory), command);
  for (const owner of owners) {
    const [current] = resolved ? [owner] : await resolveOwners([owner.repo]);
    if (!current || key(current.gitDirectory) !== key(owner.gitDirectory) || key(current.commonDirectory) !== key(owner.commonDirectory)) throw new RepositoryMutationError("ownership_changed", "Repository mutation owner changed during admission");
    try { await assertNoPendingCommitPublication(owner.repo); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "Repository publication requires explicit reconciliation";
      const receiptId = /^Publication (pc_[a-f0-9]{32}) requires explicit reconciliation$/.exec(reason)?.[1];
      throw new RepositoryMutationError("pending_publication", reason, receiptId);
    }
    try { await assertNoActiveRepositoryCommand(owner.repo, command); }
    catch (error) { if (error instanceof RepositoryMutationError) throw error; throw new RepositoryMutationError("active_command", "Repository command ownership is unknown; retained guard requires inspection"); }
  }
}
async function acquire(directory: string, deadline: number): Promise<OwnedLock> {
  const file = path.join(directory, "meritrouter-mutation.lock");
  for (;;) {
    await directoryChain(directory);
    if (await repositoryMutationRecoveryInProgress(directory)) {
      if (Date.now() >= deadline) throw new RepositoryMutationError("lock_busy", "Repository mutation recovery is in progress; guard retained");
      await new Promise(resolve => setTimeout(resolve, 25)); continue;
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw await contentionFailure(directory);
      await new Promise(resolve => setTimeout(resolve, 25)); continue;
    }
    const content = Buffer.from(JSON.stringify(newRepositoryMutationOwner(directory)));
    const stat = await handle.stat();
    const owned = { file, directory, content, handle, dev: stat.dev, ino: stat.ino };
    try {
      await handle.writeFile(content); await handle.sync();
      if (await repositoryMutationRecoveryInProgress(directory)) {
        throw new RepositoryMutationError("lock_busy", "Repository mutation recovery is in progress; guard retained");
      }
      activeLocks.set(key(directory), owned);
      return owned;
    }
    catch (error) { await release(owned); throw error; }
  }
}
/** Classify an observation, never acquire a capability or retire another owner's marker. */
async function contentionFailure(directory: string): Promise<RepositoryMutationError> {
  const unknown = () => new RepositoryMutationError("lock_busy", "Repository mutation lock is busy; foreign or stale locks are preserved");
  const owned = activeLocks.get(key(directory));
  if (!owned) return unknown();
  try {
    if (await repositoryMutationRecoveryInProgress(directory)) return unknown();
    const before = await lstat(owned.file), handle = await owned.handle.stat();
    const matches = (stat: typeof before) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === owned.dev && stat.ino === owned.ino && stat.size === owned.content.length;
    if (!matches(before) || !matches(handle)) return unknown();
    const content = await readFile(owned.file), owner = lockRecord.parse(JSON.parse(content.toString("utf8")));
    if (!content.equals(owned.content) || owner.version !== 2 || owner.pid !== process.pid || key(owner.commonDirectory) !== key(directory)) return unknown();
    const after = await lstat(owned.file);
    if (!matches(after) || await repositoryMutationRecoveryInProgress(directory)) return unknown();
    // No await after this identity check: release revokes the registry synchronously.
    if (activeLocks.get(key(directory)) !== owned) return unknown();
    const error = new RepositoryMutationError("lock_busy", `Repository mutation live local owner ${owner.pid}/${owner.token} holds ${directory}; bounded admission deferred without taking its lock`);
    localContentions.add(error);
    return error;
  } catch { return unknown(); }
}
async function release(owned: OwnedLock): Promise<void> {
  if (activeLocks.get(key(owned.directory)) === owned) activeLocks.delete(key(owned.directory));
  try {
    await directoryChain(owned.directory);
    const stat = await lstat(owned.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.size > 32768) throw new RepositoryMutationError("ownership_changed", "Repository mutation lock ownership changed; replacement is preserved");
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

export interface RepositoryMutationOptions {
  capability?: RepositoryMutationCapability;
  command?: RepositoryCommandPermits;
  /** Previously proven canonical physical owners; compared lexically before any lock acquisition. */
  expectedCommonDirectories?: string[];
  timeoutMs?: number;
}
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
      // The enclosing scope already holds every common-owner lock, so this resolution is under
      // lock; a second resolution immediately after it cannot observe a different admission.
      const owners = await resolveOwners(requested);
      assertExpectedOwners(owners, parsed.expectedCommonDirectories);
      activeLease(lease.capability);
      if (owners.some(owner => !lease.owners.has(key(owner.commonDirectory)))) throw new RepositoryMutationError("invalid_capability", "Repository mutation capability cannot widen its owner scope");
      await validateOwners(owners, parsed.command as RepositoryCommandPermits | undefined, true); activeLease(lease.capability);
      return action(lease.capability);
    })();
    lease.pending.add(running);
    void running.then(() => lease.pending.delete(running), () => lease.pending.delete(running));
    return running;
  }
  return (async () => {
    const owners = await resolveOwners(requested);
    assertExpectedOwners(owners, parsed.expectedCommonDirectories);
    const directories = [...new Map(owners.map(owner => [key(owner.commonDirectory), owner.commonDirectory])).values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const locks: OwnedLock[] = [], deadline = Date.now() + parsed.timeoutMs;
    try {
      for (const directory of directories) locks.push(await acquire(directory, deadline));
      await validateOwners(owners, parsed.command as RepositoryCommandPermits | undefined);
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
