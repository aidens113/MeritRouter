import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import { sealRetainedCheckedTask } from "../src/harness/checked-task-candidate.js";
import { workerSourceIdentity } from "../src/harness/worker-actions.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const raw = (...args: string[]) => execFileSync("git", args, { cwd: env!.repo, encoding: "utf8" }).trim();
const limits = { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 600_000, defaultTimeoutMs: 3600_000, supervisorProfiles: ["supervise"], maxSupervisors: 4, supervisorTimeoutMs: 3600_000 };
async function fixture() {
  const cfg = baseConfig();
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" };
  env = makeEnv({ config: cfg }); sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const [parent] = await sy.submitTasks([{ profile: "supervise", goal: "Integrate retained checked candidate", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["retained work"] } }]);
  sy.tasks.claim("fixture-parent", limits);
  const [child] = await sy.submitTasks([{ profile: "implement", label: "retained", parentTaskId: parent!.taskId, goal: "Install checked lockfile", repositoryAliases: ["core"], writableRepository: "core", constraints: { allowedPaths: ["package-lock.json"], checks: ["npm install", "npm run typecheck"], acceptanceCriteria: ["lockfile checked"] } }]);
  sy.tasks.claim("fixture-child", limits);
  const lease = capturedLease(sy.tasks.get(child!.taskId)!);
  const head = raw("rev-parse", "HEAD");
  writeFileSync(path.join(env.repo, "package-lock.json"), '{"lockfileVersion":3}\n'); raw("add", "package-lock.json");
  const tree = raw("write-tree"), source = await workerSourceIdentity(env.repo);
  const patch = execFileSync("git", ["diff", "--cached", "--binary", head], { cwd: env.repo, encoding: "utf8" });
  const digest = createHash("sha256").update(patch).digest("hex");
  const executionId = sy.admission.createExecution("task", "implement", [{ taskId: child!.taskId, itemId: child!.taskId }]);
  const result = syntheticResult(child!.taskId, "completed", "worker_submitted"); result.acceptanceStatus = "met"; result.scopeViolation = []; result.protectedPathsChanged = [];
  for (const [index, command] of ["npm install", "npm run typecheck"].entries()) {
    const logRef = sy.artifacts.write({ taskId: child!.taskId, executionId, kind: "check_log", label: command, content: `exit0\nrevision ${tree}` });
    result.checks.push({ command, exitCode: 0, logRef, revision: tree, artifactDigest: digest });
    const action = { id: `fixture-action-${index}`, project: "demo", taskId: child!.taskId, status: "completed", action: { command, cwd: env.repo, invocationId: `final_check:${executionId}:${index}`, timeoutMs: 300000, reason: "fixture exact check", source, lease, jobId: parent!.taskId }, decisionReason: "fixture operator", decidedBy: "operator", output: "exit0", exitCode: 0, createdAt: Date.now(), quiescedAt: Date.now() };
    sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(action.id, "demo", child!.taskId, action.id, JSON.stringify(action), Date.now());
  }
  const session = sy.sessions.create({ taskId: child!.taskId, jobId: parent!.taskId, role: "implementer", agentLabel: "implementer:retained", profile: "implement", tier: "T2" });
  session.setWorkspace({ repos: [{ alias: "core", worktree: env.repo, branch: null, baseCommit: head, head }] });
  session.modelResponse({ requestId: "fixture-request", endpoint: { id: "fake/model" }, response: reply("submitted"), attempts: [], estimatedInputTokens: 100 } as unknown as GateResponse);
  session.end("completed", "worker_submitted");
  sy.tasks.finish(child!.taskId, "fixture-child", result, "completed");
  const controller = new AbortController();
  const ctx = { taskId: parent!.taskId, taskLease: capturedLease(sy.tasks.get(parent!.taskId)!), cfg: env.cfg, tasks: sy.tasks, artifacts: sy.artifacts, now: Date.now, signal: controller.signal } as RunContext;
  return { ctx, controller, parent: parent!.taskId, child: child!.taskId, input: { taskId: child!.taskId, alias: "core", worktree: env.repo, head, base: head, tree } };
}
function mutateAction(index: number, update: (action: any) => void) {
  const id = `fixture-action-${index}`, row = sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=?").get(id) as { value_json: string };
  const action = JSON.parse(row.value_json); update(action); sy!.db.prepare("UPDATE worker_action_requests SET value_json=? WHERE id=?").run(JSON.stringify(action), id);
}

it("seals the exact old checked index with original worker/model attribution and preserves check records", async () => {
  const f = await fixture(), before = sy!.tasks.get(f.child)!.result!.checks;
  const head = await sealRetainedCheckedTask(f.ctx, f.input);
  expect(raw("rev-parse", "HEAD^{tree}")).toBe(f.input.tree);
  expect(raw("rev-parse", `${head}^`)).toBe(f.input.head);
  expect(raw("show", "-s", "--format=%B")).toContain(`Task: ${f.child}`);
  expect(raw("show", "-s", "--format=%B")).toContain("Model: fake/model");
  expect(sy!.tasks.get(f.child)!.result!.checks).toEqual(before);
  expect(sy!.tasks.events(f.child, 30).some(event => event.type === "checked_candidate_sealed")).toBe(true);
});

it("fails closed when capped uncertain rows could hide older unresolved execution", async () => {
  const f = await fixture();
  const row = sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id='fixture-action-0'").get() as { value_json: string };
  const insert = sy!.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)");
  sy!.db.transaction(() => {
    for (let index = 0; index <= 500; index++) {
      const action = JSON.parse(row.value_json);
      action.id = `uncertain-${index}`; action.status = "uncertain"; action.exitCode = null; action.createdAt = index;
      if (index === 0) delete action.quiescedAt;
      insert.run(action.id, "demo", f.child, action.id, JSON.stringify(action), index);
    }
  })();
  await expect(sealRetainedCheckedTask(f.ctx, f.input)).rejects.toThrow(/lacks exact/);
  expect(raw("rev-parse", "HEAD")).toBe(f.input.head);
});

it.each(["source", "pending", "running", "uncertain", "nested-task", "nested-project", "lease-task", "lease-project", "lease-run", "missing-action", "head", "index", "worktree", "untracked", "mixed-revision", "mixed-digest", "foreign-artifact", "scope", "protected", "wrong-parent", "lab", "cancelled"])("refuses unproved retained candidate: %s", async condition => {
  const f = await fixture();
  if (condition === "source") mutateAction(0, action => { action.action.source = "0".repeat(64); });
  if (["pending", "running", "uncertain"].includes(condition)) mutateAction(0, action => { action.status = condition; if (condition === "uncertain") delete action.quiescedAt; });
  if (condition === "nested-task") mutateAction(0, action => { action.taskId = "foreign"; });
  if (condition === "nested-project") mutateAction(0, action => { action.project = "foreign"; });
  if (condition === "lease-task") mutateAction(0, action => { action.action.lease.taskId = "foreign"; });
  if (condition === "lease-project") mutateAction(0, action => { action.action.lease.project = "foreign"; });
  if (condition === "lease-run") mutateAction(0, action => { action.action.lease.runCount++; });
  if (condition === "missing-action") sy!.db.prepare("DELETE FROM worker_action_requests WHERE id='fixture-action-1'").run();
  if (condition === "head") f.input.head = "0".repeat(40);
  if (condition === "index") { writeFileSync(path.join(env!.repo, "package-lock.json"), "changed\n"); raw("add", "package-lock.json"); }
  if (condition === "worktree") writeFileSync(path.join(env!.repo, "package-lock.json"), "unstaged\n");
  if (condition === "untracked") writeFileSync(path.join(env!.repo, "extra.txt"), "unsealed\n");
  if (["mixed-revision", "mixed-digest", "foreign-artifact", "scope", "protected"].includes(condition)) {
    const result = sy!.tasks.get(f.child)!.result!;
    if (condition === "mixed-revision") result.checks[1]!.revision = "0".repeat(40);
    if (condition === "mixed-digest") result.checks[1]!.artifactDigest = "0".repeat(64);
    if (condition === "foreign-artifact") result.checks[1]!.logRef = sy!.artifacts.write({ taskId: f.parent, executionId: "foreign", kind: "check_log", label: "foreign", content: "foreign" });
    if (condition === "scope") result.scopeViolation = ["outside.txt"];
    if (condition === "protected") result.protectedPathsChanged = ["tests/changed.ts"];
    sy!.db.prepare("UPDATE tasks SET result_json=? WHERE id=?").run(JSON.stringify(result), f.child);
  }
  if (condition === "wrong-parent") f.ctx.taskId = f.child;
  if (condition === "lab") {
    const spec = sy!.tasks.get(f.child)!.spec; spec.constraints.labChecks = ["typecheck"];
    sy!.db.prepare("UPDATE tasks SET spec_json=? WHERE id=?").run(JSON.stringify(spec), f.child);
  }
  if (condition === "cancelled") f.controller.abort("cancelled");
  const before = raw("rev-parse", "HEAD");
  await expect(sealRetainedCheckedTask(f.ctx, f.input)).rejects.toThrow();
  expect(raw("rev-parse", "HEAD")).toBe(before);
});
