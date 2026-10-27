import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync as realExecFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess } from "../src/brain/access.js";
import { openDatabase } from "../src/storage/db.js";
import { commitAs, type Actor } from "../src/attribution/index.js";
import { splitExcludePathspecs } from "../src/workspaces/metadata-staging.js";
import { makeEnv, type Env } from "./helpers.js";

// Count every child process the router starts, by Git subcommand. Selected-commit safety
// (mutation fence, owned index transaction, guarded ref publication) must not cost the
// ~70 Git commands (~170-200 processes) per commit it did after 96d4a86: worker reports are
// serial Brain commits. `dropCached` simulates Git returning an empty `ls-files --cached`.
const spawned = vi.hoisted(() => ({ calls: [] as string[][], on: false, dropCached: false }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const record = (file: unknown, args: unknown) => {
    if (spawned.on && Array.isArray(args)) spawned.calls.push([String(file), ...args.map(String)]);
  };
  const execFile = ((file: string, args: unknown, ...rest: unknown[]) => { record(file, args); return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest); }) as unknown as typeof real.execFile;
  const custom = (real.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>)[promisify.custom]!;
  Object.defineProperty(execFile, promisify.custom, { value: (file: string, args: unknown, ...rest: unknown[]) => {
    record(file, args);
    if (spawned.dropCached && Array.isArray(args) && args.includes("ls-files") && args.includes("--cached")) return Object.assign(Promise.resolve({ stdout: "", stderr: "" }), { child: {} });
    return custom(file, args, ...rest);
  } });
  return {
    ...real, default: real, execFile,
    execFileSync: ((file: string, args: unknown, ...rest: unknown[]) => { record(file, args); return (real.execFileSync as (...a: unknown[]) => unknown)(file, args, ...rest); }) as typeof real.execFileSync,
    spawn: ((file: string, args: unknown, ...rest: unknown[]) => { record(file, args); return (real.spawn as (...a: unknown[]) => unknown)(file, args, ...rest); }) as typeof real.spawn,
    spawnSync: ((file: string, args: unknown, ...rest: unknown[]) => { record(file, args); return (real.spawnSync as (...a: unknown[]) => unknown)(file, args, ...rest); }) as typeof real.spawnSync,
  };
});

/** Subcommand after Git's global options, e.g. "rev-parse --git-common-dir". */
function label(call: string[]): string {
  const args = call.slice(1);
  let i = 0;
  while (i < args.length && (args[i] === "--no-pager" || args[i] === "-c")) i += args[i] === "-c" ? 2 : 1;
  const command = args[i] ?? "";
  return command === "rev-parse" || command === "config" ? `${command} ${args[i + 1] ?? ""}` : command;
}
/** The process policy's per-call probes (workspaces/git-process-policy.ts), not pipeline commands. */
const policyProbe = (name: string) => name === "config --no-includes" || name === "rev-parse --show-toplevel";
interface Measured<T> { result: T; spawns: number; commands: number; ms: number; byCommand: Record<string, number> }
async function measure<T>(run: () => Promise<T>): Promise<Measured<T>> {
  spawned.calls = []; spawned.on = true;
  const start = performance.now();
  try {
    const result = await run();
    const byCommand: Record<string, number> = {};
    for (const call of spawned.calls) byCommand[label(call)] = (byCommand[label(call)] ?? 0) + 1;
    const probes = Object.entries(byCommand).filter(([name]) => policyProbe(name)).reduce((sum, [, count]) => sum + count, 0);
    return { result, spawns: spawned.calls.length, commands: spawned.calls.length - probes, ms: Math.round(performance.now() - start), byCommand };
  } finally { spawned.on = false; }
}
const report = (values: Record<string, Measured<unknown>>) => {
  if (process.env.MERITROUTER_SPAWN_REPORT === "1") console.log(JSON.stringify(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { spawns: value.spawns, commands: value.commands, ms: value.ms, byCommand: value.byCommand }])), null, 1));
};

let env: Env | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { spawned.on = false; spawned.dropCached = false; db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const actor: Actor = { agent: "supervisor:j1", role: "supervisor", model: "paid:anthropic/x", job: "j1" };
const gitOut = (repo: string, ...args: string[]) => realExecFileSync("git", args, { cwd: repo, encoding: "utf8" });

// Budgets sit above the measured counts (see the fix report) and far below the regression.
// Machine load changes wall time, never these counts. Generous timeouts: the assertion is the count.
describe("selected-commit process budget", () => {
  it("keeps Brain initialisation and steady-state Brain writes and updates bounded, and commits every update", async () => {
    env = makeEnv(); db = openDatabase(env.cfg.storageDir);
    const brain = new Brain(env.cfg, db);
    const supervisor = new BrainAccess(db, env.cfg).principalFor("supervisor", { project: "demo", effort: "job-j1", repos: ["core"], jobId: "j1", tier: "T2", task: null });
    const init = await measure(() => brain.ensure());
    await brain.write(supervisor, actor, "projects/demo/decisions/warm.md", "# Warm\n\nfirst\n");
    const write = await measure(() => brain.write(supervisor, actor, "projects/demo/decisions/note.md", "# Note\n\nsecond\n"));
    const update = await measure(() => brain.write(supervisor, actor, "projects/demo/decisions/note.md", "# Note\n\nthird\n"));
    report({ init, write, update });
    expect(write.result.commit).toMatch(/^[a-f0-9]{40}$/);
    // A tracked modification used to be silently skipped (commit null, file left dirty).
    expect(update.result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(gitOut(brain.root, "status", "--porcelain", "--", "projects")).toBe("");
    for (const step of [write, update]) { expect(step.commands).toBeLessThanOrEqual(60); expect(step.spawns).toBeLessThanOrEqual(150); }
    expect(init.commands).toBeLessThanOrEqual(75);
    expect(init.spawns).toBeLessThanOrEqual(175);
  }, 180_000);

  it("keeps commitAs of a tracked modification and of a deletion bounded, and commits both", async () => {
    env = makeEnv({ files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "README.md": "# Fixture\n" } });
    await commitAs(env.repo, actor, "warm", { paths: [":(literal)README.md"], allowEmpty: true });
    writeFileSync(path.join(env.repo, "src/a.ts"), "export const a = 2;\n");
    const modified = await measure(() => commitAs(env!.repo, actor, "modify a", { paths: [":(literal)src/a.ts"] }));
    unlinkSync(path.join(env.repo, "src/b.ts"));
    const deleted = await measure(() => commitAs(env!.repo, actor, "delete b", { paths: [":(literal)src/b.ts"] }));
    report({ modified, deleted });
    expect(modified.result).toMatch(/^[a-f0-9]{40}$/);
    expect(deleted.result).toMatch(/^[a-f0-9]{40}$/);
    expect(gitOut(env.repo, "status", "--porcelain")).toBe("");
    for (const step of [modified, deleted]) { expect(step.commands).toBeLessThanOrEqual(50); expect(step.spawns).toBeLessThanOrEqual(130); }
  }, 180_000);
});

describe("selected staging never trusts ls-files exclude magic", () => {
  it("splits long and short exclude magic into positive forms", () => {
    expect(splitExcludePathspecs([":(literal)docs/", ":(exclude,literal)docs/.lock", ":!tmp", ":^/build", "src", ":/top"])).toEqual({
      include: [":(literal)docs/", "src", ":/top"], exclude: [":(literal)docs/.lock", ":()tmp", ":(top)build"],
    });
    expect(splitExcludePathspecs([":(exclude).lock"])).toEqual({ include: ["."], exclude: [":().lock"] });
    expect(() => splitExcludePathspecs([":(exclude"])).toThrow(/magic/);
    expect(() => splitExcludePathspecs([":#x"])).toThrow(/magic/);
  });

  it("commits a tracked edit selected with an exclude pathspec and leaves the excluded file alone", async () => {
    env = makeEnv({ files: { "docs/a.md": "a\n", "docs/b.md": "b\n", "README.md": "# Fixture\n" } });
    writeFileSync(path.join(env.repo, "docs/a.md"), "a2\n");
    writeFileSync(path.join(env.repo, "docs/b.md"), "b2\n");
    writeFileSync(path.join(env.repo, "docs/.lock"), "");
    const commit = await commitAs(env.repo, actor, "docs", { paths: [":(literal)docs/", ":(exclude,literal)docs/b.md", ":(exclude,literal)docs/.lock"] });
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(gitOut(env.repo, "show", "--name-only", "--format=", commit!).trim()).toBe("docs/a.md");
    expect(gitOut(env.repo, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M docs/b.md", "?? docs/.lock"]);
  }, 180_000);

  it("fails loudly when the selection listing drops a changed tracked path, instead of reporting unchanged", async () => {
    env = makeEnv({ files: { "src/a.ts": "export const a = 1;\n", "README.md": "# Fixture\n" } });
    const head = gitOut(env.repo, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(env.repo, "src/a.ts"), "export const a = 2;\n");
    spawned.dropCached = true;
    await expect(commitAs(env.repo, actor, "modify a", { paths: [":(literal)src/a.ts"] })).rejects.toThrow(/missed 1 changed tracked path/);
    spawned.dropCached = false;
    expect(gitOut(env.repo, "rev-parse", "HEAD").trim()).toBe(head);
    expect(gitOut(env.repo, "status", "--porcelain")).toBe(" M src/a.ts\n");
  }, 180_000);
});
