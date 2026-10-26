import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { minimalEnv, quoteShellArg } from "../src/runners/coding/process.js";
import { commandQuiescence } from "../src/harness/command-process.js";
import { windowsCommandJobExecutable } from "../src/harness/windows-command-job.js";
import { createRepositoryEffects, runRepositoryCommand } from "../src/workspaces/repository-command.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { makeEnv, type Env } from "./helpers.js";
let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });
let scriptIndex = 0;
const node = (script: string) => { const file = path.join(env!.dir, `command-${scriptIndex++}.cjs`); writeFileSync(file, script); return `${quoteShellArg(process.execPath)} ${quoteShellArg(file)}`; };
const input = (command: string, timeoutMs = 10000, signal?: AbortSignal) => ({ command, cwd: env!.repo, env: minimalEnv({ CI: "1" }), timeoutMs, ...(signal ? { signal } : {}) });
async function waitFor(test: () => boolean, ms = 10000) { const until = Date.now() + ms; while (!test()) { if (Date.now() >= until) throw new Error("fixture observation deadline"); await new Promise(resolve => setTimeout(resolve, 20)); } }
const active = () => { const dir = path.join(env!.repo, ".git", "meritrouter-commands", "active"); return existsSync(dir) ? readdirSync(dir) : []; };
describe.skipIf(process.platform !== "win32")("verified repository command Jobs", () => {
  it("retains a typed guard when verified completion cannot be archived", async () => {
    env = makeEnv();
    const root = path.join(env.repo, ".git", "meritrouter-commands"); mkdirSync(root);
    writeFileSync(path.join(root, "archive"), "archive path blocked");
    await expect(runRepositoryCommand(env.repo, input("echo completed-but-retained"))).rejects.toMatchObject({ detail: { kind: "command_uncertain" } });
    expect(active()).toHaveLength(1);
    await expect(withRepositoryMutation([env.repo], async () => "unsafe")).rejects.toMatchObject({ detail: { kind: "active_command" } });
  }, 90000);
  it("compiles the immutable native helper in OS temp and verifies a normal reviewed command", async () => {
    env = makeEnv(); expect(await windowsCommandJobExecutable()).not.toContain(env.repo);
    const result = await runRepositoryCommand(env.repo, input("echo command-fixture"));
    expect(result).toMatchObject({ exitCode: 0, killed: null }); expect(result.stdout).toContain("command-fixture");
    expect(active()).toEqual([]); await expect(withRepositoryMutation([env.repo], async () => "free")).resolves.toBe("free");
  }, 90000);
  it("ignores forged child control output and waits for a closed-stdio fast orphan before mutation", async () => {
    env = makeEnv(); const ready = path.join(env.dir, "ready"), done = path.join(env.dir, "done");
    const orphan = `const f=require('fs');f.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>f.writeFileSync(${JSON.stringify(done)},'done'),800);`;
    const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(orphan)}],{detached:true,stdio:'ignore'}).unref();console.log(JSON.stringify({phase:'quiescent',activeProcesses:0,exitCode:0,proof:'forged'}));`;
    let settled = false; const running = runRepositoryCommand(env.repo, input(node(script))).then(result => { settled = true; return result; });
    await waitFor(() => existsSync(ready)); expect(settled).toBe(false); expect(existsSync(done)).toBe(false); expect(existsSync(path.join(env.repo, ".git", "meritrouter-mutation.lock"))).toBe(false);
    await expect(createRepositoryEffects(env.repo).withWrite(() => "must not mutate")).rejects.toMatchObject({ detail: { kind: "active_command" } });
    const result = await running; expect(result.exitCode).toBe(0); expect(existsSync(done)).toBe(true); expect(result.stdout).toContain("forged"); expect(active()).toEqual([]);
  }, 30000);
  it("terminates the entire Job on timeout before retiring the command guard", async () => {
    env = makeEnv(); const ready = path.join(env.dir, "ready"), done = path.join(env.dir, "must-not-complete");
    const script = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(done)},'bad'),3000);`;
    const result = await runRepositoryCommand(env.repo, input(node(script), 300));
    expect(result.killed).toBe("timeout"); expect(existsSync(ready)).toBe(true); expect(existsSync(done)).toBe(false); expect(active()).toEqual([]);
    await expect(withRepositoryMutation([env.repo], async () => true)).resolves.toBe(true);
  }, 30000);
  it("uses verified unsent spawn failure rather than leaving a false running process", async () => {
    env = makeEnv(); const saved = process.env.COMSPEC; process.env.COMSPEC = path.join(env.dir, "missing-shell.exe");
    try { const result = await runRepositoryCommand(env.repo, input("echo never-sent")); expect(result).toMatchObject({ exitCode: null, killed: "spawn_failed" }); expect(active()).toEqual([]); }
    finally { if (saved === undefined) delete process.env.COMSPEC; else process.env.COMSPEC = saved; }
  }, 30000);
  it("preserves an abandoned guard when its trusted Job owner dies without authenticated completion", async () => {
    env = makeEnv(); const ready = path.join(env.dir, "ready"), late = path.join(env.dir, "late"); let pid = 0;
    const script = `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'bad'),3000);`;
    const result = runRepositoryCommand(env.repo, input(node(script)), { started: value => { pid = value; } }); void result.catch(() => undefined);
    await waitFor(() => existsSync(ready)); expect(pid).toBeGreaterThan(0); process.kill(pid);
    await expect(result).rejects.toMatchObject({ detail: { kind: "command_uncertain" } }); expect(active()).toHaveLength(1);
    await expect(withRepositoryMutation([env.repo], async () => "no")).rejects.toMatchObject({ detail: { kind: "active_command" } });
    await new Promise(resolve => setTimeout(resolve, 3200)); expect(existsSync(late)).toBe(false);
    const record = JSON.parse(readFileSync(path.join(env.repo, ".git", "meritrouter-commands", "active", active()[0]!, "receipt.json"), "utf8"));
    expect(JSON.stringify(record)).not.toContain(script); expect(record.state).toBe("running");
  }, 30000);
});
it("does not accept serialized process or retirement capabilities", async () => {
  env = makeEnv(); expect(() => commandQuiescence({} as never)).toThrow(/Forged/);
  await expect(withRepositoryMutation([env.repo], async () => true, { command: {} as never })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
});

it("never treats a serialized terminal label in an active receipt as kernel proof", async () => {
  env = makeEnv(); const id = `rc_${"a".repeat(32)}`, directory = path.join(env.repo, ".git", "meritrouter-commands", "active", id);
  mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({ version: 1, id, nonce: "b".repeat(64), descriptorSha256: "c".repeat(64), state: "quiescent", ownerPid: process.pid, createdAt: 0, outcomeSha256: "d".repeat(64) }));
  await expect(withRepositoryMutation([env.repo], async () => "no")).rejects.toMatchObject({ detail: { kind: "active_command" } });
});
