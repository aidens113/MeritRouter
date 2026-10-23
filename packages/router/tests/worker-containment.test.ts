import { afterEach, describe, expect, it } from "vitest";
import { linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import type { RunContext } from "../src/runners/types.js";
import { executeSupervisorCommand, WorkerActionRequests } from "../src/harness/worker-actions.js";
import { loadConfig } from "../src/config/load.js";
import { workerSourceIdentity } from "../src/harness/worker-actions.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { restoreCheckEvidence } from "../src/harness/check-evidence.js";
import { declaredCheckTool, editTools, type HarnessEnv } from "../src/harness/tools.js";
import { git } from "../src/workspaces/git.js";
import { workerActionTools } from "../src/harness/worker-action-tools.js";
import { RepoReader } from "../src/context/repo-reader.js";
import { normalizeRelPath } from "../src/context/repo-reader.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env, db: Db;
afterEach(() => { db?.close(); env?.cleanup(); });
function setup(policy = "human_only") {
  env = makeEnv({ config: baseConfig({ security: { outside_repository: policy } }) });
  db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db);
  tasks.submit([WorkerTaskSchema.parse({ id: "worker", profile: "inspect", goal: "probe", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["probe"] } })], { project: "demo" });
  const task = tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 })[0]!;
  const ctx = { cfg: env.cfg, tasks, taskId: task.row.id, taskLease: capturedLease(task), spec: task.spec, now: Date.now, signal: new AbortController().signal } as RunContext;
  return { ctx, store: new WorkerActionRequests(db) };
}
const input = () => ({ command: "node --version", cwd: env.repo, timeoutMs: 5000, reason: "runtime version needs supervisor host execution" });
const decision = (id: string) => ({ project: "demo", id, decision: "approve" as const, reason: "reviewed exact bounded command", actor: { kind: "operator" as const }, config: env.cfg });

describe("worker containment and supervisor actions", () => {
  it("never executes a pending outside-sentinel command, and denial cannot become approval", async () => {
    const { ctx, store } = setup();
    const sentinel = path.join(env.dir, "outside.txt");
    writeFileSync(sentinel, "preserved");
    const request = await store.file(ctx, { ...input(), command: `node -e "require('fs').writeFileSync('../outside.txt','changed')"` });
    expect(request.status).toBe("pending");
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
    expect((await store.decide({ ...decision(request.id), decision: "deny" })).status).toBe("denied");
    expect((await store.decide(decision(request.id))).status).toBe("denied");
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
  });
  it("operator approves one exact command, duplicate filing/approval never replays it", async () => {
    const { ctx, store } = setup();
    const first = await store.file(ctx, input());
    expect((await store.file(ctx, input())).id).toBe(first.id);
    const result = await store.decide(decision(first.id));
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/v\d+\.\d+\.\d+/);
    expect(await store.decide(decision(first.id))).toEqual(result);
    const next = await store.file(ctx, { ...input(), invocationId: "next-logical-check" });
    expect(next.id).not.toBe(first.id);
    expect((await store.decide(decision(next.id))).status).toBe("completed");
  });
  it("rejects foreign project, forged task identity, outside cwd, lease loss and changed source", async () => {
    const { ctx, store } = setup();
    await expect(store.file({ ...ctx, taskId: "foreign" }, input())).rejects.toThrow(/identity/);
    await expect(store.file(ctx, { ...input(), cwd: env.dir })).rejects.toThrow(/assigned repository/);
    const request = await store.file(ctx, input());
    await expect(store.decide({ ...decision(request.id), project: "foreign" })).rejects.toThrow(/unknown/);
    writeFileSync(path.join(env.repo, "README.md"), "changed");
    await expect(store.decide(decision(request.id))).rejects.toThrow(/source changed/);
    db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='worker'").run();
    expect((await store.decide(decision(request.id))).status).toBe("cancelled");
    expect(store.list({ project: "demo", status: "pending" })).toHaveLength(0);
  });
  it("re-reads disabled policy on approval and refuses untrusted supervisor self-approval", async () => {
    const { ctx, store } = setup();
    const request = await store.file(ctx, input());
    await expect(store.decide({ ...decision(request.id), actor: { kind: "supervisor", taskId: "worker", lease: ctx.taskLease! } })).rejects.toThrow(/human_only/);
    const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    raw.security = { outside_repository: "disabled" };
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    await expect(store.decide(decision(request.id))).rejects.toThrow(/disabled/);
    await expect(store.file(ctx, input())).rejects.toThrow(/disabled/);
  });
  it("generic operation needs a supervisor response and never becomes check evidence", async () => {
    const { ctx, store } = setup();
    const request = await store.fileOperation(ctx, { operation: "web_fetch", args: { url: "https://example.com" }, reason: "need external evidence" });
    await expect(store.decide(decision(request.id))).rejects.toThrow(/supply its bounded response/);
    const response = await store.decide({ ...decision(request.id), response: "Supervisor observed the external page." });
    expect(response.output).toContain("Supervisor-provided response");
    expect(response.exitCode).toBeNull();
  });
  it("restores exact check evidence after over 1000 unrelated events and rejects corrupt/foreign artifacts", async () => {
    const { ctx } = setup();
    ctx.artifacts = new ArtifactStore(db, env.cfg.storageDir);
    const good = ctx.artifacts.write({ taskId: ctx.taskId, kind: "check_log", label: "check", content: "one\ntwo\nthree\nfour" });
    const foreign = ctx.artifacts.write({ taskId: "other", kind: "check_log", label: "foreign", content: "foreign" });
    const bad = ctx.artifacts.write({ taskId: ctx.taskId, kind: "check_log", label: "bad", content: "before" });
    writeFileSync(ctx.artifacts.absolutePath(ctx.artifacts.get(bad)!), "corrupt");
    const source = await workerSourceIdentity(env.repo);
    for (const logRef of [good, foreign, bad]) ctx.tasks.event(ctx.taskId, "worker_check_run", { command: "node --version", exitCode: 0, logRef, source, sessionId: null });
    for (let i = 0; i < 1100; i++) ctx.tasks.event(ctx.taskId, "unrelated", { i });
    const harness = { ctx, universe: { refs: new Map() }, checks: { cwd: env.repo }, checkResults: [] } as unknown as HarnessEnv;
    await restoreCheckEvidence(harness);
    expect(harness.universe.refs.get(good)).toBe(4);
    expect(harness.universe.refs.has(foreign)).toBe(false);
    expect(harness.universe.refs.has(bad)).toBe(false);
    expect(harness.checkResults?.map(row => row.exitCode)).toEqual([0, null, null]);
    writeFileSync(path.join(env.repo, "README.md"), "source changed");
    harness.universe.refs.clear(); harness.checkResults = [];
    await restoreCheckEvidence(harness);
    expect(harness.universe.refs.size).toBe(0);
    expect(harness.checkResults?.every(row => row.exitCode === null)).toBe(true);
  });
  it("denies Windows alternate streams/device aliases and cascades private action data on task removal", async () => {
    const { ctx, store } = setup();
    for (const name of ["README.md:stream", ".git:stream", "NUL", "CON.txt", "folder./file", "file "]) expect(() => normalizeRelPath(name)).toThrow();
    const request = await store.file(ctx, input());
    db.prepare("DELETE FROM tasks WHERE id=?").run(ctx.taskId);
    expect(store.get("demo", request.id)).toBeNull();
  });
  it("refuses hardlink/junction host writes and trusted configuration edits through native file tools", async () => {
    const { ctx } = setup();
    const sentinel = path.join(env.dir, "outside.txt");
    writeFileSync(sentinel, "preserved");
    linkSync(sentinel, path.join(env.repo, "src", "linked.txt"));
    symlinkSync(env.dir, path.join(env.repo, "src", "escape"), "junction");
    const harness = { ctx, workspace: { alias: "core", root: env.repo, allowedPaths: ["**/*"] }, edits: new Set(), universe: { refs: new Map() } } as unknown as HarnessEnv;
    const write = editTools().find(tool => tool.def.function.name === "write_file")!;
    await expect(write.run({ path: "src/linked.txt", content: "changed" }, harness)).rejects.toThrow(/hard links/);
    await expect(write.run({ path: "src/escape/outside.txt", content: "changed" }, harness)).rejects.toThrow(/outside/);
    const configPath = path.join(env.repo, "trusted-config.yaml");
    writeFileSync(configPath, "security: human_only");
    ctx.cfg.configPath = configPath;
    await expect(write.run({ path: "trusted-config.yaml", content: "security: supervisor" }, harness)).rejects.toThrow(/trusted SwitchYard/);
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
  });
  it("files an undeclared command request without executing or granting access", async () => {
    const { ctx, store } = setup();
    const harness = { ctx, readers: new Map([["core", new RepoReader("core", env.repo, null)]]) } as unknown as HarnessEnv;
    const tool = workerActionTools().find(tool => tool.def.function.name === "request_supervisor_action")!;
    const output = JSON.parse(await tool.run({ command: "node --version", repository: "core", reason: "not in worker allowlist" }, harness));
    expect(output.status).toBe("pending");
    expect(store.get("demo", output.id)?.exitCode).toBeNull();
    await expect(tool.run({ command: "node --version", repository: "other", reason: "escape" }, harness)).rejects.toThrow(/assigned/);
  });
  it("refuses a check against pinned HEAD when working source is dirty", async () => {
    const { ctx, store } = setup();
    const commit = (await git(env.repo, ["rev-parse", "HEAD"])).trim();
    writeFileSync(path.join(env.repo, "README.md"), "changed after pin");
    const harness = { ctx, readers: new Map([["core", new RepoReader("core", env.repo, commit)]]), checks: { commands: ["node --version"], cwd: env.repo, timeoutMs: 5000, maxRuns: 1, env: {} } } as unknown as HarnessEnv;
    await expect(declaredCheckTool().run({ command: "node --version" }, harness)).rejects.toThrow(/pinned read revision/);
    expect(store.list({ project: "demo" })).toHaveLength(0);
  });
  it("cancels approved running host action when original worker authority is lost", async () => {
    const { ctx, store } = setup();
    const sentinel = path.join(env.dir, "outside.txt");
    writeFileSync(sentinel, "preserved");
    const request = await store.file(ctx, { ...input(), command: `node -e "setTimeout(()=>require('fs').writeFileSync('../outside.txt','changed'),2000)"` });
    const pending = store.decide(decision(request.id));
    const timer = setTimeout(() => db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(ctx.taskId), 300);
    try { expect((await pending).status).toBe("uncertain"); }
    finally { clearTimeout(timer); }
    expect(readFileSync(sentinel, "utf8")).toBe("preserved");
  }, 10000);
  it("requires a fresh operator approval and physical supervisor check after runtime progress at unchanged source", async () => {
    const { ctx, store } = setup();
    const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    raw.profiles.supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30 };
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    ctx.cfg.profiles.supervise = loadConfig(env.cfg.configPath).profiles.supervise;
    ctx.spec = WorkerTaskSchema.parse({ ...ctx.spec, profile: "supervise" });
    db.prepare("UPDATE tasks SET profile='supervise',spec_json=? WHERE id=?").run(JSON.stringify(ctx.spec), ctx.taskId);
    const runtime = path.join(env.dir, "runtime-state.txt"), executions = path.join(env.dir, "physical-checks.txt");
    writeFileSync(runtime, "before restart");
    const source = await workerSourceIdentity(env.repo);
    const command = `node -e "const fs=require('fs');fs.appendFileSync('../physical-checks.txt','run\\n');console.log(fs.readFileSync('../runtime-state.txt','utf8'))"`;
    async function approveInvocation(invocationId: string) {
      const waiting = executeSupervisorCommand(ctx, { command, cwd: env.repo, timeoutMs: 5000, reason: "Explicit supervisor runtime check", invocationId });
      let request;
      const until = Date.now() + 5000;
      while (!request && Date.now() < until) {
        request = store.list({ project: "demo", status: "pending" }).find(row => row.action.invocationId === invocationId);
        if (!request) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(request, "new logical check must await a new operator decision").toBeDefined();
      await store.decide(decision(request!.id));
      return { result: await waiting, id: request!.id };
    }
    const first = await approveInvocation("supervisor:first-check");
    expect(first.result.stdout).toContain("before restart");
    writeFileSync(runtime, "after restart");
    expect(await workerSourceIdentity(env.repo)).toBe(source);
    const second = await approveInvocation("supervisor:second-check");
    expect(second.id).not.toBe(first.id); expect(second.result.stdout).toContain("after restart");
    const replay = await executeSupervisorCommand(ctx, { command, cwd: env.repo, timeoutMs: 5000, reason: "Explicit supervisor runtime check", invocationId: "supervisor:second-check" });
    expect(replay.stdout).toBe(second.result.stdout);
    expect(readFileSync(executions, "utf8")).toBe("run\nrun\n");
    expect(store.list({ project: "demo" })).toHaveLength(2);
  }, 15000);
  it("executes configured custom supervisors using current persisted mode and refuses forged worker profile", async () => {
    const { ctx } = setup("supervisor");
    const spoofed = { ...ctx, spec: WorkerTaskSchema.parse({ ...ctx.spec, profile: "supervise" }) };
    await expect(executeSupervisorCommand(spoofed, input())).rejects.toThrow(/supervisor task/);
    const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    raw.profiles.inspect.mode = "supervisor"; raw.profiles.inspect.tools = "supervisor";
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    expect((await executeSupervisorCommand(ctx, input())).stdout).toMatch(/v\d+\.\d+\.\d+/);
    raw.profiles.inspect.mode = "read_only"; raw.profiles.inspect.tools = "repository_read";
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    await expect(executeSupervisorCommand(ctx, input())).rejects.toThrow(/supervisor task/);
  });
  it("allows a current custom supervisor to decide its child's exact action and revokes that authority with profile mode", async () => {
    const { ctx, store } = setup("supervisor");
    const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
    raw.profiles.inspect.mode = "supervisor"; raw.profiles.inspect.tools = "supervisor";
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    ctx.tasks.submit([WorkerTaskSchema.parse({ id: "child", parentTaskId: ctx.taskId, profile: "summarize", goal: "child", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["child"] } })], { project: "demo" });
    const child = ctx.tasks.claim("child-owner", { maxConcurrent: 2, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 })[0]!;
    const childContext = { ...ctx, taskId: child.row.id, spec: child.spec, taskLease: capturedLease(child) };
    const first = await store.file(childContext, { ...input(), invocationId: "custom-supervisor:first" });
    const actor = { kind: "supervisor" as const, taskId: ctx.taskId, lease: ctx.taskLease! };
    expect((await store.decide({ ...decision(first.id), actor })).status).toBe("completed");
    const next = await store.file(childContext, { ...input(), invocationId: "custom-supervisor:second" });
    raw.profiles.inspect.mode = "read_only"; raw.profiles.inspect.tools = "repository_read";
    writeFileSync(env.cfg.configPath, YAML.stringify(raw));
    await expect(store.decide({ ...decision(next.id), actor })).rejects.toThrow(/owning active supervisor/);
    expect(store.get("demo", next.id)?.status).toBe("pending");
  });
});
