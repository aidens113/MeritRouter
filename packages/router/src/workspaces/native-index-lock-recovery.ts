import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { lstat, open, readFile, realpath, mkdir, rename, link, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exactRepositoryRoot } from "./repository-root.js";
import { git } from "./git.js";
import { inspectRepositoryMutationLock, newRepositoryMutationOwner, RepositoryMutationOwnerSchema } from "./repository-mutation-recovery.js";
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Token = z.string().regex(/^[a-f0-9]{32}$/);
const ControlSchema = z.object({
    outerExpected: Hash, legacyOwner: z.object({
        host: z.string().min(1).max(256), pid: z.number().int().positive(), token: Token, evidence: z.string().trim().min(1).max(4000)
    }).strict().optional(), quiescence: z.object({
        host: z.string().min(1).max(256), gitProcessesStopped: z.literal(true), evidence: z.string().trim().min(1).max(4000)
    }).strict()
}).strict();
const RecoverySchema = ControlSchema.extend({ expected: Hash, reason: z.string().trim().min(1).max(2000) }).strict();
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const key = (s: string) => process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s);
const isTargetLock = (blocker: string, file: string) => blocker.startsWith("native_lock:") && key(blocker.slice(12)) === key(file);
async function directoryChain(directory: string) {
    const absolute = path.resolve(directory), root = path.parse(absolute).root;
    let at = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
        at = path.join(at, part);
        const s = await lstat(at);
        if (!s.isDirectory() || s.isSymbolicLink())
            throw Error("Index recovery metadata ancestor is linked or invalid");
    }
}
async function fileProof(file: string, max: number) {
    const s = await lstat(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max)
        throw Error("Index recovery requires bounded single-link regular metadata");
    const h = await open(file, "r");
    try {
        const f = await h.stat();
        if (f.dev !== s.dev || f.ino !== s.ino || f.size !== s.size)
            throw Error("Index metadata changed while opening");
        const bytes = await h.readFile();
        if (bytes.length !== s.size)
            throw Error("Index metadata changed while reading");
        return { bytes, identity: {
                dev: s.dev, ino: s.ino, size: s.size, sha256: hash(bytes)
            } };
    }
    finally {
        await h.close();
    }
}
async function indexState(repo: string, gitDirectory: string) {
    const index = await fileProof(path.join(gitDirectory, "index"), 32 * 1024 * 1024), headFile = await fileProof(path.join(gitDirectory, "HEAD"), 16384);
    const head = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [1] })).trim(), branch = (await git(repo, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] })).trim();
    return {
        proof: {
            index: index.identity, headFile: headFile.identity, head, branch
        }, indexBytes: index.bytes, headBytes: headFile.bytes
    };
}
async function observe(repo: string, input: z.infer<typeof ControlSchema>) {
    const root = await realpath(z.string().min(1).max(4096).refine(s => !s.includes("\0")).parse(repo));
    const owner = await exactRepositoryRoot(root);
    const gitDirectory = await realpath(owner.gitDirectory);
    const commonDirectory = await realpath(owner.commonDirectory);
    await directoryChain(gitDirectory);
    await directoryChain(commonDirectory);
    const outer = await inspectRepositoryMutationLock(root, input.legacyOwner ? { legacyOwner: input.legacyOwner } : {});
    const file = path.join(gitDirectory, "index.lock");
    const native = await fileProof(file, 32 * 1024 * 1024);
    const state = await indexState(root, gitDirectory);
    const blockers = outer.snapshot.blockers.filter(b => !isTargetLock(b, file));
    if (outer.expected !== input.outerExpected)
        blockers.push("outer_mutation_snapshot_changed");
    if (input.quiescence.host !== hostname())
        blockers.push("foreign_quiescence_attestation");
    if (native.identity.size !== 0)
        blockers.push("nonempty_index_lock_requires_publication_investigation");
    if (!outer.snapshot.blockers.some(b => isTargetLock(b, file)))
        blockers.push("native_index_lock_missing_from_outer_inventory");
    const snapshot = {
        version: 1 as const, root, gitDirectory, commonDirectory, file, outerExpected: outer.expected, outerSnapshot: outer.snapshot, indexLock: native.identity, indexState: state.proof, quiescence: input.quiescence, blockers
    };
    return {
        snapshot, expected: hash(JSON.stringify(snapshot)), eligible: blockers.length === 0, bytes: native.bytes, indexBytes: state.indexBytes, headBytes: state.headBytes
    };
}
/** Explicit FINAL evidence is required because native index.lock contains no owner identity. */
export async function inspectNativeIndexLock(repo: string, raw: z.input<typeof ControlSchema>) {
    const { bytes: _bytes, indexBytes: _index, headBytes: _head, ...result } = await observe(repo, ControlSchema.parse(raw));
    return result;
}
async function durable(file: string, content: Buffer | string) {
    const h = await open(file, "wx", 0o600);
    try {
        await h.writeFile(content);
        await h.sync();
    }
    finally {
        await h.close();
    }
}
/** Retire only an empty native index marker; the exact dead outer fence remains untouched. */
export async function reconcileNativeIndexLock(repo: string, raw: z.input<typeof RecoverySchema>) {
    const input = RecoverySchema.parse(raw), before = await observe(repo, input);
    if (before.expected !== input.expected)
        throw Error("Native index recovery snapshot changed");
    if (!before.eligible)
        throw Error(`Native index recovery refused: ${before.snapshot.blockers.join("; ")}`);
    // Shared with outer-marker recovery: neither operation can retire the other's fence.
    const gate = path.join(before.snapshot.commonDirectory, "meritrouter-mutation-recovery.lock");
    const gateBytes = Buffer.from(JSON.stringify(newRepositoryMutationOwner(before.snapshot.commonDirectory)));
    await durable(gate, gateBytes);
    const gateStat = await lstat(gate);
    let releaseGate = true;
    try {
      const current = await observe(repo, input);
      if (!current.eligible || current.expected !== input.expected)
        throw Error("Native index recovery changed after exclusive admission");
      return await retireNativeIndexMarker(repo, input, before);
    } catch (error) {
      // A failed restoration must leave the independent shared recovery barrier in place.
      try { await lstat(before.snapshot.file); } catch { releaseGate = false; }
      throw error;
    } finally {
      if (releaseGate) {
        const current = await lstat(gate);
        if (current.dev !== gateStat.dev || current.ino !== gateStat.ino || !(await readFile(gate)).equals(gateBytes))
          throw Error("Native index recovery fence replacement preserved");
        await unlink(gate);
      }
    }
}

async function retireNativeIndexMarker(repo: string, input: z.infer<typeof RecoverySchema>, before: Awaited<ReturnType<typeof observe>>) {
    const root = path.join(before.snapshot.commonDirectory, "meritrouter-native-index-recovery");
    try {
        await mkdir(root, { mode: 0o700 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
            throw e;
    }
    await directoryChain(root);
    const archive = path.join(root, randomBytes(16).toString("hex"));
    await mkdir(archive, { mode: 0o700 });
    await directoryChain(archive);
    await durable(path.join(archive, "observed.lock"), before.bytes);
    await durable(path.join(archive, "original.index"), before.indexBytes);
    await durable(path.join(archive, "HEAD"), before.headBytes);
    const receipt = {
        version: 1, at: Date.now(), actor: { host: hostname(), pid: process.pid }, reason: input.reason, expected: input.expected, snapshot: before.snapshot
    };
    await durable(path.join(archive, "receipt.json"), JSON.stringify(receipt));
    const final = await observe(repo, input);
    if (!final.eligible || final.expected !== input.expected)
        throw Error("Native index recovery snapshot changed at retirement");
    const retired = path.join(archive, "original.lock");
    await rename(before.snapshot.file, retired);
    try {
        const moved = await fileProof(retired, 32 * 1024 * 1024);
        if (JSON.stringify(moved.identity) !== JSON.stringify(before.snapshot.indexLock))
            throw Error("Native index marker replacement");
        const after = await indexState(before.snapshot.root, before.snapshot.gitDirectory);
        if (JSON.stringify(after.proof) !== JSON.stringify(before.snapshot.indexState))
            throw Error("Native index or HEAD changed after retirement");
        const outer = await inspectRepositoryMutationLock(before.snapshot.root, input.legacyOwner ? { legacyOwner: input.legacyOwner } : {});
        const expectedOuter = { ...before.snapshot.outerSnapshot, blockers: before.snapshot.outerSnapshot.blockers.filter(b => !isTargetLock(b, before.snapshot.file)) };
        if (JSON.stringify(outer.snapshot) !== JSON.stringify(expectedOuter))
            throw Error("Outer mutation guard changed after retirement");
        await durable(path.join(archive, "completed.json"), JSON.stringify({
            expected: input.expected, retiredAt: Date.now(), originalIndexSha256: after.proof.index.sha256, head: after.proof.head
        }));
        return {
            reconciled: true as const, archive, ...receipt
        };
    }
    catch (e) {
        await link(retired, before.snapshot.file).catch(() => {
        });
        throw Error(`Native index retirement unverified; replacement and outer barrier preserved: ${(e as Error).message}`);
    }
}

async function observeNativeRecoveryFence(repo: string, input: z.infer<typeof ControlSchema>) {
    const native = await observe(repo, input);
    const gate = path.join(native.snapshot.commonDirectory, "meritrouter-mutation-recovery.lock");
    const proof = await fileProof(gate, 32768);
    const owner = RepositoryMutationOwnerSchema.parse(JSON.parse(proof.bytes.toString("utf8")));
    const blockers = [...native.snapshot.blockers];
    if (owner.version !== 2) blockers.push("native_recovery_fence_requires_modern_owner");
    else if (owner.host !== hostname() || key(owner.commonDirectory) !== key(native.snapshot.commonDirectory))
        blockers.push("native_recovery_fence_foreign_owner");
    try { process.kill(owner.pid, 0); blockers.push("native_recovery_fence_owner_alive"); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") blockers.push("native_recovery_fence_owner_unknown");
    }
    const snapshot = {
        version: 1 as const,
        nativeSnapshot: native.snapshot,
        nativeExpected: native.expected,
        gate,
        owner,
        identity: proof.identity,
        blockers,
    };
    return { snapshot, expected: hash(JSON.stringify(snapshot)), eligible: blockers.length === 0, bytes: proof.bytes };
}

/** The retained outer and empty native markers fence this pre-retirement crash recovery. */
export async function inspectNativeIndexRecoveryFence(repo: string, raw: z.input<typeof ControlSchema>) {
    const { bytes: _bytes, ...result } = await observeNativeRecoveryFence(repo, ControlSchema.parse(raw));
    return result;
}

export async function reconcileNativeIndexRecoveryFence(repo: string, raw: z.input<typeof RecoverySchema>) {
    const input = RecoverySchema.parse(raw);
    const before = await observeNativeRecoveryFence(repo, input);
    if (before.expected !== input.expected || !before.eligible)
        throw Error("Native recovery fence changed or ownership/remaining barriers are unverified");
    const root = path.join(before.snapshot.nativeSnapshot.commonDirectory, "meritrouter-native-index-recovery");
    try { await mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await directoryChain(root);
    const archive = path.join(root, `fence-${randomBytes(16).toString("hex")}`);
    await mkdir(archive, { mode: 0o700 });
    await directoryChain(archive);
    await durable(path.join(archive, "observed.lock"), before.bytes);
    const receipt = { version: 1, at: Date.now(), actor: { host: hostname(), pid: process.pid }, reason: input.reason, expected: input.expected, snapshot: before.snapshot };
    await durable(path.join(archive, "receipt.json"), JSON.stringify(receipt));
    const final = await observeNativeRecoveryFence(repo, input);
    if (!final.eligible || final.expected !== input.expected)
        throw Error("Native recovery fence changed at retirement");
    const retired = path.join(archive, "original.lock");
    await rename(before.snapshot.gate, retired);
    try {
        const moved = await fileProof(retired, 32768);
        if (JSON.stringify(moved.identity) !== JSON.stringify(before.snapshot.identity))
            throw Error("Native recovery fence replacement");
        const native = await observe(repo, input);
        if (!native.eligible || native.expected !== before.snapshot.nativeExpected)
            throw Error("Native or outer barriers changed during recovery fence retirement");
        await durable(path.join(archive, "completed.json"), JSON.stringify({ expected: input.expected, retiredAt: Date.now(), nativeExpected: native.expected }));
        return { reconciled: true as const, archive, ...receipt };
    } catch (error) {
        await link(retired, before.snapshot.gate).catch(() => {});
        throw Error(`Native recovery fence retirement unverified; replacement and outer/native barriers preserved: ${(error as Error).message}`);
    }
}
