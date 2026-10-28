import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { mergeBranchKey } from "../src/storage/merge-branch-lock.js";
import { assertStoreRole } from "../src/storage/store-role.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { MergeQueue } from "../src/workspaces/merge-queue.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined, repo: string | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; if (repo) rmSync(repo, { recursive: true, force: true }); repo = undefined; }, 60_000);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const supervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const turns = (req: ChatRequest) => req.messages.filter(m => m.role === "assistant").length;
const outputs = (req: ChatRequest) => req.messages.filter(m => m.role === "tool").map(m => String(m.content));
const node = (label: string, fn: string, extra: Record<string, unknown> = {}) => ({ label, profile: "implement", goal: `Add ${fn}(a, b) to src/app.ts`, acceptance_criteria: [`${fn} exists`], allowed_paths: ["src/**"], difficulty: "T2", ...extra });

it("integrates accept_task through the actual split service and bases its dependent on that integrated head", async () => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-split-integration-")));
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src/app.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  const cfg = baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: repo, repositories: { core: { path: repo } } } }, coding: { runner: "native" }, team: { provider_concurrency_enabled: false } });
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config: cfg });
  const script = [
    () => [call("delegate", { tasks: [node("a", "subtract")] })],
    () => [call("await_tasks", { timeout_seconds: 120 })],
    () => [call("accept_task", { task_id: "a", reason: "read subtract implementation" })],
    () => [call("delegate", { tasks: [node("b", "multiply", { depends_on: ["a"] })] })],
    () => [call("await_tasks", { timeout_seconds: 120 })],
    () => [call("accept_task", { task_id: "b", reason: "read multiply implementation" })],
    () => [call("finish_job", { status: "completed", summary: "integrated both functions", verified: [{ claim: "both integrated", evidence: "accept_task results" }], not_verified: [] })],
  ];
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (supervisor(req)) {
      if (outputs(req).some(o => /NOT integrated|Project store contains/.test(o))) return reply(null, { ...served, toolCalls: [call("finish_job", { status: "blocked", summary: "integration failed", verified: [], not_verified: ["integration"] })] });
      return reply(null, { ...served, toolCalls: script[turns(req)]!() });
    }
    const fn = /Add (\w+)\(a, b\)/.exec(String(req.messages.find(m => m.role === "user")?.content))![1]!;
    return reply(null, { ...served, toolCalls: turns(req) === 0
      ? [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: `export function ${fn}(a: number, b: number) {\n  return a;\n}\n\nexport function add` })]
      : [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
  });
  sy = open(env, client, { worker: true });
  await sy.createSplitProject({ slug: "alpha", directory: repo });
  const job = await sy.startJob({ project: "alpha", goal: "Add subtract and multiply", repositories: ["core"] });
  const done = await sy.awaitResults([job.taskId], { timeoutSeconds: 170 });
  const transcript = client.requests.filter(supervisor).flatMap(outputs).join("\n");
  expect(done.timedOut, transcript).toBe(false);
  expect(done.completed, JSON.stringify({ done, status: sy.getStatus([job.taskId], "alpha"), transcript, requests: client.requests.length })).toHaveLength(1);
  expect(transcript).not.toContain("Project store contains unclassified or shared metadata");
  expect(done.completed[0]!.stopReason, transcript).toBe("supervisor_completed");
  const local = sy.projectStores("alpha");
  const rows = local.db.prepare("SELECT task_id,state,after_head FROM merge_queue WHERE job_id=? ORDER BY created_at,rowid").all(job.taskId) as Array<{ task_id: string; state: string; after_head: string }>;
  expect(rows.map(r => r.state)).toEqual(["integrated", "integrated"]);
  const b = local.tasks.childrenOf(job.taskId).find(t => t.spec.label === "b")!;
  expect(local.db.prepare("SELECT base_sha FROM workspaces WHERE task_id=?").get(b.row.id)).toEqual({ base_sha: rows[0]!.after_head });
  expect(git(repo, "show", `${rows[1]!.after_head}:src/app.ts`)).toContain("export function multiply");
  expect(local.db.prepare("SELECT key FROM meta WHERE key LIKE 'merge-branch:%'").all()).toEqual([]);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM merge_queue").get()).toEqual({ n: 0 });

  const item = local.db.prepare("SELECT detail_json FROM merge_queue WHERE task_id=?").get(rows[0]!.task_id) as { detail_json: string };
  const binding = JSON.parse(item.detail_json).mergeBranchBinding;
  const key = mergeBranchKey(binding.physicalOwner, binding.branch);
  const lock = { nonce: randomUUID(), host: hostname(), pid: process.pid, instance: randomUUID(), owner: binding.queueOwner, heartbeat: Date.now(), jobId: job.taskId, leaseOwner: null, runCount: null, binding };
  const identity = readStoreIdentity(local.db)!;
  const set = (metadataKey: string, value: unknown) => {
    local.db.prepare("DELETE FROM meta WHERE key LIKE 'merge-branch:%' OR key='provider_discovery_last'").run();
    local.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(metadataKey, JSON.stringify(value));
  };
  try {
    set(key, lock);
    expect(() => assertStoreRole(local.db, identity)).not.toThrow();
    for (const [candidateKey, value] of [
      [`merge-branch:${"0".repeat(64)}`, lock],
      [key, { ...lock, jobId: "foreign-job" }],
      [key, { ...lock, owner: "foreign-owner" }],
      [key, { ...lock, binding: { ...binding, itemId: "foreign-item" } }],
      [key, { ...lock, binding: { ...binding, physicalOwner: path.join(repo, "foreign.git") } }],
      [key, { ...lock, binding: { ...binding, branch: "foreign-branch" } }],
      [key, { ...lock, binding: { ...binding, projectStore: { ...binding.projectStore, generation: binding.projectStore.generation + 1 } } }],
      [key, { ...lock, binding: { ...binding, projectStore: { ...binding.projectStore, projectId: randomUUID() } } }],
      [key, { ...lock, unexpected: true }],
      [key, { pid: "malformed" }],
      ["provider_discovery_last", lock],
    ] as Array<[string, unknown]>) {
      set(candidateKey, value);
      expect(() => assertStoreRole(local.db, identity), candidateKey).toThrow(/metadata/);
    }
  } finally { local.db.prepare("DELETE FROM meta WHERE key LIKE 'merge-branch:%' OR key='provider_discovery_last'").run(); }

  // Refused repository admission may provision a lock binding but must not change queue evidence.
  local.tasks.submit([WorkerTaskSchema.parse({ id: "foreign-source", parentTaskId: job.taskId, profile: "implement", goal: "refusal fixture", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["fixture"] } })], { project: "alpha" });
  const original = local.db.prepare("SELECT integration_worktree,source_base,source_head FROM merge_queue WHERE task_id=?").get(rows[0]!.task_id) as { integration_worktree: string; source_base: string; source_head: string };
  const queue = new MergeQueue(local.db, local.tasks, "split-refusal-owner");
  const refused = queue.enqueue({ jobId: job.taskId, taskId: "foreign-source", kind: "task", repo: "core", branch: `meritrouter/job-${job.taskId}`, integrationWorktree: original.integration_worktree, sourceWorktree: env.repo, sourceBase: original.source_base, sourceHead: original.source_head, commits: [original.source_head], acceptance: null });
  const before = queue.get(refused.id);
  await expect(queue.run(refused.id, { committer: { name: "fixture", email: "fixture@example.invalid" }, integrated: () => undefined })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
  expect(queue.get(refused.id)).toEqual(before);
  expect(local.db.prepare("SELECT key FROM meta WHERE key LIKE 'merge-branch:%'").all()).toEqual([]);
  expect(() => assertStoreRole(local.db, identity)).not.toThrow();
}, 200_000);
