import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { hostname, tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile, lstat, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { git } from "../src/workspaces/git.js";
import { inspectRepositoryMutationLock, reconcileRepositoryMutationLock } from "../src/workspaces/repository-mutation-recovery.js";
import { inspectNativeIndexLock, reconcileNativeIndexLock, inspectNativeIndexRecoveryFence, reconcileNativeIndexRecoveryFence } from "../src/workspaces/native-index-lock-recovery.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
const race = vi.hoisted(() => ({ replacement: null as string | null, gateReplacement: null as string | null, restoreFailure: false, pauseAfterNativeRename: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
    const actual = await original<typeof import("node:fs/promises")>();
    return { ...actual, link: async (from: Parameters<typeof actual.link>[0], to: Parameters<typeof actual.link>[1]) => {
            if (race.restoreFailure) throw Object.assign(Error("fixture restore refused"), { code: "EACCES" });
            return actual.link(from, to);
        }, rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
            if (race.replacement !== null && String(from).endsWith("index.lock") && String(to).endsWith("original.lock")) {
                const bytes = race.replacement;
                race.replacement = null;
                await actual.writeFile(from, bytes);
            }
            if (race.gateReplacement !== null && String(from).endsWith("meritrouter-mutation-recovery.lock") && String(to).endsWith("original.lock")) {
                const bytes = race.gateReplacement; race.gateReplacement = null; await actual.writeFile(from, bytes);
            }
            await actual.rename(from, to);
            if (race.pauseAfterNativeRename && String(from).endsWith("index.lock") && String(to).endsWith("original.lock"))
                await race.pauseAfterNativeRename();
        } };
});
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
    race.replacement = null;
    race.gateReplacement = null;
    race.restoreFailure = false;
    race.pauseAfterNativeRename = null;
    for (const c of children.splice(0))
        if (c.exitCode === null && c.signalCode === null) {
            const done = once(c, "exit");
            c.kill();
            await done;
        }
    for (const r of roots.splice(0)) {
        if (path.dirname(r) !== path.resolve(tmpdir()) || !path.basename(r).startsWith("mr-native-index-"))
            throw Error("fixture boundary");
        await rm(r, { recursive: true, force: true });
    }
});
async function fixture() {
    const repo = await mkdtemp(path.join(tmpdir(), "mr-native-index-"));
    roots.push(repo);
    await git(repo, ["init", "-q"]);
    await writeFile(path.join(repo, "app.txt"), "unchanged");
    await git(repo, ["add", "app.txt"]);
    await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
    const common = path.join(repo, ".git"), outerFile = path.join(common, "meritrouter-mutation.lock"), file = path.join(common, "index.lock");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(outerFile)},JSON.stringify({version:2,token:'${"a".repeat(32)}',instance:'${"b".repeat(32)}',host:require('node:os').hostname(),pid:process.pid,commonDirectory:${JSON.stringify(common)},createdAt:Date.now()}));console.log('ready');setInterval(()=>{},1000)`;
    const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(c);
    await once(c.stdout!, "data");
    const done = once(c, "exit");
    c.kill();
    await done;
    await writeFile(file, "");
    const outer = await inspectRepositoryMutationLock(repo), control = { outerExpected: outer.expected, quiescence: {
            host: hostname(), gitProcessesStopped: true as const, evidence: "Fixture child ended; all Git commands awaited and no Git process remains."
        } };
    return {
        repo, common, file, outerFile, control
    };
}
it("archives empty native marker without changing original index, HEAD, source or outer fence", async () => {
    const f = await fixture(), index = await readFile(path.join(f.common, "index")), head = await readFile(path.join(f.common, "HEAD")), outer = await readFile(f.outerFile), source = await readFile(path.join(f.repo, "app.txt")), seen = await inspectNativeIndexLock(f.repo, f.control);
    expect(seen.eligible).toBe(true);
    const result = await reconcileNativeIndexLock(f.repo, {
        ...f.control, expected: seen.expected, reason: "exact killed fixture owner"
    });
    expect(await readFile(path.join(result.archive, "original.lock"))).toEqual(Buffer.alloc(0));
    expect(await readFile(path.join(result.archive, "original.index"))).toEqual(index);
    expect(await readFile(path.join(f.common, "index"))).toEqual(index);
    expect(await readFile(path.join(f.common, "HEAD"))).toEqual(head);
    expect(await readFile(f.outerFile)).toEqual(outer);
    expect(await readFile(path.join(f.repo, "app.txt"))).toEqual(source);
    await expect(lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await inspectRepositoryMutationLock(f.repo)).eligible).toBe(true);
});
it.each(["nonempty", "foreign", "outer", "index", "head"])("refuses %s proof change", async (kind) => {
    const f = await fixture(), before = await inspectNativeIndexLock(f.repo, f.control);
    let control = { ...f.control };
    if (kind === "nonempty")
        await writeFile(f.file, "potential unpublished index");
    if (kind === "foreign")
        control = { ...control, quiescence: { ...control.quiescence, host: "foreign.invalid" } };
    if (kind === "outer")
        control = { ...control, outerExpected: "0".repeat(64) };
    if (kind === "index")
        await writeFile(path.join(f.common, "index"), Buffer.concat([await readFile(path.join(f.common, "index")), Buffer.from("changed")]));
    if (kind === "head")
        await writeFile(path.join(f.common, "HEAD"), "0".repeat(40) + "\n");
    await expect(reconcileNativeIndexLock(f.repo, {
        ...control, expected: before.expected, reason: "must refuse changed proof"
    })).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(kind === "nonempty" ? "potential unpublished index" : "");
    expect(await readFile(f.outerFile, "utf8")).toContain('"version":2');
});
it.each(["command", "publication", "native"])("refuses %s guard while retaining empty marker", async (kind) => {
    const f = await fixture();
    if (kind === "native")
        await writeFile(path.join(f.common, "HEAD.lock"), "preserve");
    else {
        const p = path.join(f.common, kind === "command" ? "meritrouter-commands/active" : "meritrouter-publications/pending");
        await mkdir(p, { recursive: true });
        await mkdir(path.join(p, "invalid-receipt"));
    }
    const outer = await inspectRepositoryMutationLock(f.repo), control = { ...f.control, outerExpected: outer.expected }, seen = await inspectNativeIndexLock(f.repo, control);
    expect(seen.eligible).toBe(false);
    await expect(reconcileNativeIndexLock(f.repo, {
        ...control, expected: seen.expected, reason: "refuse guards"
    })).rejects.toThrow(/refused/);
    expect((await readFile(f.file)).length).toBe(0);
});
it("refuses live outer owner", async () => {
    const f = await fixture(), owner = JSON.parse(await readFile(f.outerFile, "utf8"));
    await writeFile(f.outerFile, JSON.stringify({ ...owner, pid: process.pid }));
    const outer = await inspectRepositoryMutationLock(f.repo), control = { ...f.control, outerExpected: outer.expected }, seen = await inspectNativeIndexLock(f.repo, control);
    expect(seen.eligible).toBe(false);
    await expect(reconcileNativeIndexLock(f.repo, {
        ...control, expected: seen.expected, reason: "refuse live"
    })).rejects.toThrow(/refused/);
});
it("preserves nonempty replacement at final rename and keeps outer barrier", async () => {
    const f = await fixture(), seen = await inspectNativeIndexLock(f.repo, f.control), outer = await readFile(f.outerFile);
    race.replacement = "nonempty replacement index";
    await expect(reconcileNativeIndexLock(f.repo, {
        ...f.control, expected: seen.expected, reason: "race"
    })).rejects.toThrow(/replacement and outer barrier preserved/);
    expect(await readFile(f.file, "utf8")).toBe("nonempty replacement index");
    expect((await lstat(f.file)).nlink).toBe(2);
    expect(await readFile(f.outerFile)).toEqual(outer);
    await expect(withRepositoryMutation([f.repo], async () => "unsafe", { timeoutMs: 50 })).rejects.toThrow(/lock is busy/);
});
it("serializes native retirement against explicit outer-marker recovery", async () => {
    const f = await fixture();
    const seen = await inspectNativeIndexLock(f.repo, f.control);
    let entered!: () => void, release!: () => void;
    const renamed = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    race.pauseAfterNativeRename = async () => { entered(); await waiting; };
    const native = reconcileNativeIndexLock(f.repo, { ...f.control, expected: seen.expected, reason: "serialize native and outer operations" });
    await renamed;
    try {
        const outer = await inspectRepositoryMutationLock(f.repo);
        expect(outer.eligible).toBe(true);
        await expect(reconcileRepositoryMutationLock(f.repo, { expected: outer.expected, reason: "must wait for native completion" })).rejects.toMatchObject({ code: "EEXIST" });
        expect(await readFile(f.outerFile, "utf8")).toContain('"version":2');
        await expect(withRepositoryMutation([f.repo], async () => "unsafe", { timeoutMs: 50 })).rejects.toThrow(/recovery is in progress/);
    } finally { release(); }
    expect((await native).reconciled).toBe(true);
});
it("retains shared recovery barrier when raced native marker restoration fails", async () => {
    const f = await fixture(), seen = await inspectNativeIndexLock(f.repo, f.control);
    race.replacement = "retained raced index"; race.restoreFailure = true;
    await expect(reconcileNativeIndexLock(f.repo, { ...f.control, expected: seen.expected, reason: "restore failure" })).rejects.toThrow(/retirement unverified/);
    await expect(lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(f.common, "meritrouter-mutation-recovery.lock"))).isFile()).toBe(true);
    await expect(withRepositoryMutation([f.repo], async () => "unsafe", { timeoutMs: 50 })).rejects.toThrow(/recovery is in progress/);
});
it("reconciles an orphan recovery fence before empty native retirement without recursive locks", async () => {
    const f = await fixture(), gate = path.join(f.common, "meritrouter-mutation-recovery.lock");
    await writeFile(gate, await readFile(f.outerFile));
    const outer = await readFile(f.outerFile), marker = await readFile(f.file);
    const seen = await inspectNativeIndexRecoveryFence(f.repo, f.control);
    expect(seen.eligible).toBe(true);
    const result = await reconcileNativeIndexRecoveryFence(f.repo, { ...f.control, expected: seen.expected, reason: "fixture prior recovery owner died" });
    expect(await readFile(path.join(result.archive, "original.lock"))).toEqual(outer);
    expect(await readFile(f.outerFile)).toEqual(outer); expect(await readFile(f.file)).toEqual(marker);
    await expect(lstat(gate)).rejects.toMatchObject({ code: "ENOENT" });
    const native = await inspectNativeIndexLock(f.repo, f.control);
    expect((await reconcileNativeIndexLock(f.repo, { ...f.control, expected: native.expected, reason: "continue native recovery" })).reconciled).toBe(true);
});
it.each(["live", "foreign", "malformed"])("refuses %s orphan recovery fence", async kind => {
    const f = await fixture(), gate = path.join(f.common, "meritrouter-mutation-recovery.lock"), owner = JSON.parse(await readFile(f.outerFile, "utf8"));
    const bytes = kind === "malformed" ? "uncertain" : JSON.stringify({ ...owner, ...(kind === "live" ? { pid: process.pid } : { host: "foreign.invalid" }) });
    await writeFile(gate, bytes);
    if (kind === "malformed") await expect(inspectNativeIndexRecoveryFence(f.repo, f.control)).rejects.toThrow();
    else { const seen = await inspectNativeIndexRecoveryFence(f.repo, f.control); expect(seen.eligible).toBe(false); await expect(reconcileNativeIndexRecoveryFence(f.repo, { ...f.control, expected: seen.expected, reason: "refuse owner" })).rejects.toThrow(/unverified/); }
    expect(await readFile(gate, "utf8")).toBe(bytes); expect((await readFile(f.file)).length).toBe(0);
});
it("restores malformed orphan-gate replacement while preserving outer/native barriers", async () => {
    const f = await fixture(), gate = path.join(f.common, "meritrouter-mutation-recovery.lock");
    await writeFile(gate, await readFile(f.outerFile)); const seen = await inspectNativeIndexRecoveryFence(f.repo, f.control);
    race.gateReplacement = "malformed raced gate";
    await expect(reconcileNativeIndexRecoveryFence(f.repo, { ...f.control, expected: seen.expected, reason: "raced orphan fence" })).rejects.toThrow(/replacement and outer\/native barriers preserved/);
    expect(await readFile(gate, "utf8")).toBe("malformed raced gate"); expect((await readFile(f.file)).length).toBe(0); expect((await lstat(f.outerFile)).isFile()).toBe(true);
    await expect(withRepositoryMutation([f.repo], async () => "unsafe", { timeoutMs: 50 })).rejects.toThrow(/recovery is in progress/);
});
