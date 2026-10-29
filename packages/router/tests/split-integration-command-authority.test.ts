import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import type { RunContext } from "../src/runners/types.js";
import { SupervisorRunner } from "../src/runners/supervisor.js";
import { WorkerActionRequests, workerSourceIdentity } from "../src/harness/worker-actions.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { ProjectStoreIdentitySchema, readStoreIdentity } from "../src/projects/store-identity.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined, repo: string | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; if (repo) rmSync(repo, { recursive: true, force: true }); repo = undefined; }, 60_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const supervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const turns = (req: ChatRequest) => req.messages.filter(m => m.role === "assistant").length;
const outputs = (req: ChatRequest) => req.messages.filter(m => m.role === "tool").map(m => String(m.content));
const node = (label: string, fn: string, extra: Record<string, unknown> = {}) => ({ label, profile: "implement", goal: `Add ${fn}(a, b) to src/app.ts`, acceptance_criteria: [`${fn} exists`], allowed_paths: ["src/**"], difficulty: "T2", ...extra });

it("files source-bound human approvals at the own split integration cwd and preserves exact task boundaries", async () => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-split-command-")));
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/app.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  const cfg = baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: repo, repositories: { core: { path: repo } } } }, coding: { runner: "native" }, team: { provider_concurrency_enabled: false }, security: { outside_repository: "human_only" } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config: cfg });
  const script = [
    () => [call("delegate", { tasks: [node("a", "subtract")] })],
    () => [call("await_tasks", { timeout_seconds: 120 })],
    () => [call("accept_task", { task_id: "a", reason: "read subtract implementation" })],
    () => [call("delegate", { tasks: [node("b", "multiply", { depends_on: ["a"] })] })],
    () => [call("await_tasks", { timeout_seconds: 120 })],
    () => [call("accept_task", { task_id: "b", reason: "read multiply implementation" })],
    () => [call("finish_job", { status: "completed", summary: "integrated both functions", verified: [{ claim: "both integrated", evidence: "approved checks" }], not_verified: [] })],
  ];
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (supervisor(req)) {
      if (outputs(req).some(o => /NOT integrated|cwd must be/.test(o))) return reply(null, { ...served, toolCalls: [call("finish_job", { status: "blocked", summary: "integration failed", verified: [], not_verified: ["integration"] })] });
      return reply(null, { ...served, toolCalls: script[turns(req)]!() });
    }
    const fn = /Add (\w+)\(a, b\)/.exec(String(req.messages.find(m => m.role === "user")?.content))![1]!;
    return reply(null, { ...served, toolCalls: turns(req) === 0
      ? [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: `export function ${fn}(a: number, b: number) {\n  return a;\n}\n\nexport function add` })]
      : [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
  });
  let context: RunContext | undefined;
  sy = open(env, client, { worker: true, supervisor: { run: ctx => { context = ctx; return new SupervisorRunner().run(ctx); } } });
  await sy.createSplitProject({ slug: "alpha", directory: repo });
  const local = sy.projectStores("alpha"), actions = new WorkerActionRequests(local.db);
  const foreignJob = path.join(repo, ".MeritRouter", "worktrees", "job-foreign-core");
  git(repo, "worktree", "add", "-qb", "foreign-job", foreignJob, "HEAD");
  const command = `"${process.execPath}" -e "console.log('integration-command-passed')"`;
  const job = await sy.startJob({ project: "alpha", goal: "Add subtract and multiply", repositories: ["core"], checks: [command] });
  const expectedCwd = path.join(repo, ".MeritRouter", "worktrees", `job-${job.taskId}-core`);
  let finished = false, approvals = 0, checkedBoundaries = false;
  const completion = sy.awaitResults([job.taskId], { timeoutSeconds: 170, uncapped: true, project: "alpha" }).finally(() => { finished = true; });
  while (!finished) {
    for (const request of actions.list({ project: "alpha", taskId: job.taskId, status: "pending" })) {
      expect(request.action.cwd).toBe(realpathSync(expectedCwd));
      expect(request.action.command).toBe(command);
      expect(request.action.source).toBe(await workerSourceIdentity(expectedCwd));
      expect(actions.get("alpha", request.id)?.status).toBe("pending");
      if (!checkedBoundaries) {
        for (const cwd of [foreignJob, env.repo, path.join(repo, "src")]) await expect(actions.file(context!, { command, cwd, timeoutMs: 5000, reason: "must reject foreign exact cwd" })).rejects.toThrow(/cwd must be/);
        local.tasks.submit([WorkerTaskSchema.parse({ id: "unauthorized-reader", profile: "inspect", goal: "authority fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["cannot use supervisor cwd"] } })], { project: "alpha" });
        const reader = local.tasks.claim("fixture-reader", { maxConcurrent: 10, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 30000 }, { order: "project_fifo", project: ProjectStoreIdentitySchema.parse(readStoreIdentity(local.db)) }).find(t => t.row.id === "unauthorized-reader")!;
        expect(reader).toBeDefined();
        await expect(actions.file({ ...context!, taskId: reader.row.id, spec: reader.spec, taskLease: capturedLease(reader) }, { command, cwd: expectedCwd, timeoutMs: 5000, reason: "reader cannot execute in supervisor workspace" })).rejects.toThrow(/cwd must be/);
        local.tasks.finish(reader.row.id, "fixture-reader", syntheticResult(reader.row.id, "completed", "fixture complete"), "completed");
        checkedBoundaries = true;
      }
      const approved = await actions.decide({ project: "alpha", id: request.id, decision: "approve", reason: "Explicit fixture operator approves the exact captured integration command", actor: { kind: "operator" }, config: env.cfg });
      expect(approved).toMatchObject({ status: "completed", exitCode: 0 });
      expect(approved.output).toContain("integration-command-passed");
      approvals++;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const done = await completion;
  const transcript = client.requests.filter(supervisor).flatMap(outputs).join("\n");
  expect(done.completed[0]?.stopReason, transcript).toBe("supervisor_completed");
  expect(approvals).toBeGreaterThanOrEqual(3);
  const rows = local.db.prepare("SELECT task_id,state,after_head FROM merge_queue WHERE job_id=? ORDER BY created_at,rowid").all(job.taskId) as Array<{ task_id: string; state: string; after_head: string }>;
  expect(rows.map(r => r.state)).toEqual(["integrated", "integrated"]);
  const b = local.tasks.childrenOf(job.taskId).find(t => t.spec.label === "b")!;
  expect(local.db.prepare("SELECT base_sha FROM workspaces WHERE task_id=?").get(b.row.id)).toEqual({ base_sha: rows[0]!.after_head });
  expect(git(expectedCwd, "rev-parse", "HEAD").trim()).toBe(rows[1]!.after_head);
}, 200_000);

it("preserves the exact legacy supervisor integration root under installation storage", async () => {
  const cfg = baseConfig({ security: { outside_repository: "human_only" } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", max_model_requests: 30 };
  env = makeEnv({ config: cfg });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const job = await sy.startJob({ goal: "legacy command authority", repositories: ["core"] });
  const claimed = sy.tasks.claim("legacy-fixture", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 30000, supervisorProfiles: ["supervise"], maxSupervisors: 1 })[0]!;
  expect(claimed.row.id).toBe(job.taskId);
  const cwd = path.join(env.cfg.storageDir, "worktrees", `job-${job.taskId}-core`);
  git(env.repo, "worktree", "add", "-qb", "legacy-job", cwd, "HEAD");
  const context = { cfg: env.cfg, tasks: sy.tasks, taskId: job.taskId, spec: claimed.spec, taskLease: capturedLease(claimed), now: Date.now, signal: new AbortController().signal } as RunContext;
  const actions = new WorkerActionRequests(sy.db);
  const request = await actions.file(context, { command: `"${process.execPath}" --version`, cwd, timeoutMs: 5000, reason: "legacy fixture exact command" });
  expect(request.action.cwd).toBe(realpathSync(cwd));
  expect(request.status).toBe("pending");
  expect(await actions.decide({ project: claimed.row.project_id, id: request.id, decision: "approve", reason: "Explicit legacy fixture operator approval", actor: { kind: "operator" }, config: env.cfg })).toMatchObject({ status: "completed", exitCode: 0 });
}, 30_000);
