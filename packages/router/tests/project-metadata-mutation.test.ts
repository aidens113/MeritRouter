import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { git } from "../src/workspaces/git.js";
import { stageWithoutProjectMetadata } from "../src/workspaces/metadata-staging.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "../src/workspaces/repository-mutation.js";

const roots: string[] = [], children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }> = [];
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) { if (child.exitCode === null) child.kill(); await closed; }
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith("meritrouter-mutation-") || path.dirname(root) !== path.resolve(tmpdir())) throw new Error("Refusing non-fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
const actor = { agent: "worker:mutation", role: "implementer" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function temp() { const root = await mkdtemp(path.join(tmpdir(), "meritrouter-mutation-")); roots.push(root); return root; }
async function repo() {
  const root = await temp(); await git(root, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(root, "app.txt"), "initial"); await git(root, ["add", "app.txt"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
  return root;
}
const lock = (root: string) => path.join(root, ".git", "meritrouter-mutation.lock");

/** Compile the actual bounded imported source graph, not a copied lock implementation. */
async function childModule(): Promise<string> {
  const root = await temp(), output = path.join(root, "compiled"), sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
  await mkdir(output); await writeFile(path.join(output, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(path.resolve(sourceRoot, "..", "node_modules"), path.join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const pending = [path.join(sourceRoot, "workspaces", "repository-mutation.ts")], seen = new Set<string>();
  while (pending.length) {
    const source = pending.pop()!; if (seen.has(source)) continue; seen.add(source);
    const relative = path.relative(sourceRoot, source);
    if (relative.startsWith("..") || seen.size > 32) throw new Error("Mutation source graph exceeds supported test boundary");
    const content = await readFile(source, "utf8");
    for (const match of content.matchAll(/\b(?:from\s+|import\s*\()\s*["'](\.[^"']+\.js)["']/g)) pending.push(path.resolve(path.dirname(source), match[1]!.slice(0, -3) + ".ts"));
    const destination = path.join(output, relative.replace(/\.ts$/, ".js")); await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  }
  return pathToFileURL(path.join(output, "workspaces", "repository-mutation.js")).href;
}

describe("host-owned repository mutation fence", () => {
  it("serializes opposite-order multi-owner acquisitions without deadlock", async () => {
    const a = await repo(), b = await repo(), events: string[] = [];
    await Promise.all([
      withRepositoryMutation([a, b], async () => { events.push("a"); await Promise.resolve(); events.push("A"); }),
      withRepositoryMutation([b, a], async () => { events.push("b"); await Promise.resolve(); events.push("B"); }),
    ]);
    expect(["aAbB", "bBaA"]).toContain(events.join(""));
    await expect(lstat(lock(a))).rejects.toMatchObject({ code: "ENOENT" }); await expect(lstat(lock(b))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows independent Git owners to progress while another owner is held", async () => {
    const a = await repo(), b = await repo(), entered = deferred(), release = deferred();
    const first = withRepositoryMutation([a], async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    try { expect(await withRepositoryMutation([b], async () => "independent")).toBe("independent"); }
    finally { release.resolve(); await first; }
  });

  it("supports host reentrancy and rejects forged, copied, foreign and expired capabilities", async () => {
    const a = await repo(), b = await repo(); let retained!: RepositoryMutationCapability;
    await withRepositoryMutation([a], async capability => {
      retained = capability;
      expect(await withRepositoryMutation([a], async nested => nested === capability, { capability })).toBe(true);
      for (const forged of [{}, { ...capability }, JSON.parse(JSON.stringify(capability))]) await expect(withRepositoryMutation([a], async () => {}, { capability: forged as RepositoryMutationCapability })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
      await expect(withRepositoryMutation([b], async () => {}, { capability })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
      await expect(lstat(lock(b))).rejects.toMatchObject({ code: "ENOENT" });
    });
    await expect(withRepositoryMutation([a], async () => {}, { capability: retained })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
  });

  it("gives a configured repository directory alias the same physical owner scope", async () => {
    const root = await repo(), parent = await temp(), alias = path.join(parent, "registered-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await withRepositoryMutation([alias], async capability => {
      expect((await lstat(lock(root))).isFile()).toBe(true);
      expect(await withRepositoryMutation([root], async () => "physical", { capability })).toBe("physical");
    });
  });

  it("drains unawaited nested mutations before releasing and revokes the scope", async () => {
    const root = await repo(), entered = deferred(), release = deferred(); let finished = false, capability!: RepositoryMutationCapability;
    const outer = withRepositoryMutation([root], async cap => {
      capability = cap;
      const nested = withRepositoryMutation([root], async () => { entered.resolve(); await release.promise; finished = true; }, { capability: cap });
      void nested.catch(() => {}); await entered.promise;
    });
    void outer.catch(() => {}); await entered.promise;
    await expect(withRepositoryMutation([root], async () => {}, { timeoutMs: 50 })).rejects.toMatchObject({ detail: { kind: "lock_busy" } });
    expect(finished).toBe(false); release.resolve();
    await expect(outer).rejects.toMatchObject({ detail: { kind: "unawaited_mutation" } }); expect(finished).toBe(true);
    await expect(lstat(lock(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withRepositoryMutation([root], async () => {}, { capability })).rejects.toBeInstanceOf(RepositoryMutationError);
  });

  it("preserves foreign stale locks and their exact bytes", async () => {
    const root = await repo(), file = lock(root); await writeFile(file, "unknown foreign lock"); await utimes(file, new Date(0), new Date(0));
    let called = false;
    await expect(withRepositoryMutation([root], async () => { called = true; }, { timeoutMs: 50 })).rejects.toMatchObject({ detail: { kind: "lock_busy" } });
    expect(called).toBe(false); expect(await readFile(file, "utf8")).toBe("unknown foreign lock");
  });

  it("preserves a replaced own lock instead of deleting foreign evidence", async () => {
    const root = await repo();
    await expect(withRepositoryMutation([root], async () => { await rename(lock(root), `${lock(root)}.moved`); await writeFile(lock(root), "replacement"); })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(await readFile(lock(root), "utf8")).toBe("replacement");
  });

  it("checks linked-worktree journals even when a parent lease already owns the common Git owner", async () => {
    const root = await repo(), parent = await temp(), linked = path.join(parent, "linked");
    await git(root, ["worktree", "add", "-qb", "linked", linked]);
    await withRepositoryMutation([root], async capability => { expect(await withRepositoryMutation([linked], async () => "linked", { capability })).toBe("linked"); });
    await writeFile(path.join(linked, "app.txt"), "published without index");
    const result = await commitSelectedApplication(linked, { actor, message: "pending" }, { refPublished: async () => { throw new Error("retain publication fixture"); } });
    expect(result.kind).toBe("reconciliation_required"); let called = false;
    await withRepositoryMutation([root], async capability => {
      await expect(withRepositoryMutation([linked], async () => { called = true; }, { capability })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    });
    expect(called).toBe(false);
  });

  it("blocks stage-only effects behind unresolved publication and supports trusted nested selected commits", async () => {
    const root = await repo(); await writeFile(path.join(root, "app.txt"), "selected");
    await withRepositoryMutation([root], async mutation => {
      await stageWithoutProjectMetadata(root, { paths: ["app.txt"] }, { mutation });
      expect((await commitSelectedApplication(root, { actor, message: "nested" }, { mutation })).kind).toBe("committed");
    });
    await writeFile(path.join(root, "app.txt"), "next");
    expect((await commitSelectedApplication(root, { actor, message: "pending" }, { refPublished: async () => { throw new Error("retain pending"); } })).kind).toBe("reconciliation_required");
    const index = path.join(root, ".git", "index"), exclude = path.join(root, ".git", "info", "exclude"), before = await readFile(index), excluded = await readFile(exclude), head = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "app.txt"), "must not stage");
    await expect(stageWithoutProjectMetadata(root)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(await readFile(index)).toEqual(before); expect(await readFile(exclude)).toEqual(excluded); expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("serializes actual independent Node processes through the same physical owner lock", async () => {
    const root = await repo(), module = await childModule();
    const program = `import { withRepositoryMutation } from ${JSON.stringify(module)}; await withRepositoryMutation([process.argv[1]], async () => { console.log('acquired'); await new Promise(resolve => process.stdin.once('data', resolve)); }); console.log('released');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, root], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve)); children.push({ child, closed });
    let output = "", errors = "";
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("acquired")) resolve(); });
      child.once("error", reject); child.once("close", () => { if (!output.includes("acquired")) reject(new Error(errors || "Child mutation admission failed")); });
    });
    await ready;
    await expect(withRepositoryMutation([root], async () => {}, { timeoutMs: 50 })).rejects.toMatchObject({ detail: { kind: "lock_busy" } });
    expect(JSON.parse(await readFile(lock(root), "utf8")).pid).toBe(child.pid);
    child.stdin.end("release\n"); expect(await closed, errors).toBe(0);
    expect(await withRepositoryMutation([root], async () => "parent")).toBe("parent");
    expect(output).toContain("released");
  });
});
