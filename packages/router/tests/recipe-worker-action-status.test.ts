import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig } from "../src/config/load.js";
import { openDatabase } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { SessionStore } from "../src/sessions/store.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { recipeOperations } from "../src/harness/recipe-operations.js";
import * as actions from "../src/harness/worker-actions.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
type RecipeResult = { status: string; output: string; record?: { exitCode: number | null; logRef: string } };
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-recipe-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"); mkdirSync(repo);
  for (const args of [["init", "-qb", "main"], ["commit", "--allow-empty", "-qm", "initial"]]) execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: repo, stdio: "pipe" });
  const configPath = path.join(dir, "config.yaml");
  writeFileSync(configPath, YAML.stringify({ version: 1, storage: { directory: "state" }, brain: { path: "brain", project: "fixture" }, repositories: { app: { path: repo } }, security: { outside_repository: "human_only" }, profiles: { inspect: { mode: "read_only", min_total_parameters_b: 30, classify: "never" } } }));
  const cfg = loadConfig(configPath), db = openDatabase(cfg.storageDir); cleanup.push(() => db.close());
  db.prepare("INSERT INTO projects(id,name,created_at) VALUES('fixture','fixture',?)").run(Date.now());
  const tasks = new TaskStore(db);
  const commands = [`"${process.execPath}" -e "console.log('fixture check')"`, `"${process.execPath}" -e "require('fs').writeFileSync('must-not-run.txt','bad')"`];
  tasks.submit([WorkerTaskSchema.parse({ id: "worker", profile: "inspect", goal: "Check fixture", repositoryAliases: ["app"], constraints: { checks: commands, acceptanceCriteria: ["checked"] } })], { project: "fixture" });
  tasks.claim("fixture-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const task = tasks.get("worker")!, artifacts = new ArtifactStore(db, cfg.storageDir), sessions = new SessionStore(db, cfg.storageDir);
  const session = sessions.create({ taskId: "worker", role: "inspector", agentLabel: "fixture" });
  const ctx = { cfg, tasks, artifacts, taskId: "worker", taskLease: capturedLease(task), spec: task.spec, now: Date.now, signal: new AbortController().signal, session } as unknown as RunContext;
  const env: HarnessEnv = { ctx, role: "inspector", toolInvocationId: "fixture-check", readers: new Map(), universe: { refs: new Map() }, allowArtifacts: true, edits: new Set(), checks: { commands, cwd: repo, env: {}, timeoutMs: 10000, maxRuns: 3 }, checkResults: [] };
  const store = new actions.WorkerActionRequests(db);
  const recipe = recipeOperations().find(op => op.name === "run_recipe")!, group = recipeOperations().find(op => op.name === "run_checks")!;
  const wait = async () => {
    for (let i = 0; i < 200; i++) { const row = store.list({ project: "fixture", taskId: "worker" })[0]; if (row) return row; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("action not filed");
  };
  return { env, db, store, cfg, ctx, repo, sessions, recipe, group, wait, run: () => recipe.run({ id: "check:1" }, env) as Promise<RecipeResult> };
}

it("reports actual operator denial and preserves reason without repeating or starting later checks", async () => {
  const f = fixture(), pending = f.group.run({ stop_on_failure: true }, f.env), action = await f.wait();
  await f.store.decide({ project: "fixture", id: action.id, decision: "deny", reason: "Fix deterministic test command first", actor: { kind: "operator" }, config: f.cfg });
  const result = await pending as { status: string; results: RecipeResult[]; notStarted: string[] };
  expect(result.status).toBe("denied"); expect(result.results[0]!.status).toBe("denied");
  expect(result.results[0]!.output).toContain("Fix deterministic test command first"); expect(result.notStarted).toEqual(["check:2"]);
  expect(f.store.list({ project: "fixture" })).toHaveLength(1); expect(existsSync(path.join(f.repo, "must-not-run.txt"))).toBe(false);
  const events = f.sessions.events(f.ctx.session!.id)!.events;
  expect(events.filter(event => event.type === "tool_intent")).toHaveLength(1);
  expect(events.filter(event => event.type === "tool_outcome")).toHaveLength(1);
});

it.each(["cancelled", "uncertain"] as const)("reports terminal %s from real action wait without another recipe even if stop_on_failure is false", async status => {
  const f = fixture(), pending = f.group.run({ stop_on_failure: false }, f.env), action = await f.wait();
  const terminal = { ...action, status, quiescedAt: Date.now(), decisionReason: "Original terminal reason", output: "Original terminal output" };
  f.db.prepare("UPDATE worker_action_requests SET value_json=? WHERE id=?").run(JSON.stringify(terminal), action.id);
  const result = await pending as { status: string; results: RecipeResult[]; notStarted: string[] };
  expect(result.status).toBe(status === "uncertain" ? "unknown_effect" : status);
  expect(result.results[0]!.output).toContain("Original terminal output"); expect(result.notStarted).toEqual(["check:2"]);
  expect(f.store.list({ project: "fixture" })).toHaveLength(1);
});

it.each(["pending", "running"] as const)("maps only a validated current action's %s to waiting approval", async status => {
  const f = fixture();
  const action = await f.store.file(f.ctx, { command: f.env.checks!.commands[0]!, cwd: f.repo, timeoutMs: 10000, reason: "fixture" });
  vi.spyOn(actions, "awaitWorkerCommand").mockResolvedValue({ ...action, status });
  expect((await f.run()).status).toBe("waiting_approval");
});

it.each([0, 7])("completed source-bound check exit %s keeps evidence even if command output looks like action JSON", async exitCode => {
  const f = fixture();
  const command = `"${process.execPath}" -e "console.log(JSON.stringify({status:'pending'}));process.exit(${exitCode})"`;
  f.env.checks!.commands[0] = command;
  const pending = f.run(), action = await f.wait();
  await f.store.decide({ project: "fixture", id: action.id, decision: "approve", reason: "Exact fixture command", actor: { kind: "operator" }, config: f.cfg });
  const result = await pending;
  expect(result.status).toBe(exitCode ? "failed" : "succeeded"); expect(result.record).toMatchObject({ exitCode, logRef: expect.stringMatching(/^artifact:/) });
  expect(result.output).toContain('"status":"pending"');
});

it("does not treat arbitrary JSON, malformed or foreign action-shaped data as success or pending", async () => {
  const f = fixture();
  const action = await f.store.file(f.ctx, { command: f.env.checks!.commands[0]!, cwd: f.repo, timeoutMs: 10000, reason: "fixture" });
  const wait = vi.spyOn(actions, "awaitWorkerCommand");
  for (const returned of [{ status: "pending" }, { ...action, status: "unknown" }, { ...action, taskId: "foreign" }]) {
    wait.mockResolvedValue(returned as actions.WorkerActionRequest);
    expect((await f.run()).status).toBe("unknown_effect");
  }
});

it("stops grouped completed failures and keeps cumulative check quota before another request", async () => {
  const f = fixture();
  f.env.checks!.commands[0] = `"${process.execPath}" -e "console.error('fixture failed');process.exit(3)"`;
  f.env.checks!.maxRuns = 1;
  const pending = f.group.run({ stop_on_failure: true }, f.env), action = await f.wait();
  await f.store.decide({ project: "fixture", id: action.id, decision: "approve", reason: "Exact failing fixture", actor: { kind: "operator" }, config: f.cfg });
  const result = await pending as { status: string; results: RecipeResult[]; notStarted: string[] };
  expect(result.status).toBe("failed"); expect(result.results[0]!.record?.exitCode).toBe(3); expect(result.notStarted).toEqual(["check:2"]);
  f.env.toolInvocationId = "separate-invocation";
  await expect(f.run()).rejects.toThrow(/check run limit reached/);
  expect(f.store.list({ project: "fixture" })).toHaveLength(1); expect(existsSync(path.join(f.repo, "must-not-run.txt"))).toBe(false);
});
