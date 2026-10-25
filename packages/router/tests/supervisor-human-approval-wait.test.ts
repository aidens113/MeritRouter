import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import YAML from "yaml";
import { WorkerTaskSchema } from "../src/core/task.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult, TaskStore } from "../src/storage/tasks.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { supervisorActionTools } from "../src/harness/worker-action-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { RunContext, SupervisorServices } from "../src/runners/types.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined;
afterEach(() => { db?.close(); env?.cleanup(); db = undefined; env = undefined; });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(policy: "human_only" | "supervisor" = "human_only") {
  const raw = baseConfig({ security: { outside_repository: policy } });
  Object.assign(raw.profiles, { supervise: { mode: "supervisor", tools: "supervisor", max_model_requests: 30 } });
  env = makeEnv({ config: raw });
  db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db);
  const spec = (id: string, parentTaskId?: string) => WorkerTaskSchema.parse({ id, profile: parentTaskId ? "inspect" : "supervise", ...(parentTaskId ? { parentTaskId } : {}), goal: "Wait for real operator capability", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Exact declared check runs"], checks: [`"${process.execPath}" --version`] } });
  tasks.submit([spec("job"), spec("worker", "job")], { project: "demo" });
  const claimed = tasks.claim("owner", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 120_000, supervisorProfiles: ["supervise"], maxSupervisors: 1 });
  const controller = new AbortController();
  const context = (id: string) => {
    const task = claimed.find(task => task.row.id === id)!;
    return { cfg: env!.cfg, tasks, taskId: id, spec: task.spec, taskLease: capturedLease(task), taskProject: "demo", now: Date.now, signal: controller.signal } as RunContext;
  };
  const broker = new WorkerActionRequests(db);
  const request = await broker.file(context("worker"), { command: `"${process.execPath}" --version`, cwd: env.repo, timeoutMs: 5000, reason: "Temporary fixture exact operator check" });
  const cancelled = vi.fn();
  const modelRequest = vi.fn(() => { throw new Error("await_tasks must not request a model"); });
  const awaitResults = vi.fn<SupervisorServices["awaitResults"]>(async () => {
    await sleep(25);
    const task = tasks.get("worker")!;
    return task.result ? { completed: [task.result], pending: [], timedOut: false } : { completed: [], pending: [{ taskId: "worker", state: task.row.state }], timedOut: true };
  });
  const services = { awaitResults, cancelTasks: cancelled, getTask: (id: string) => { const task = tasks.get(id)!; return { spec: task.spec, state: task.row.state, result: task.result }; } } as unknown as SupervisorServices;
  const ctx = { ...context("job"), services, gate: { request: modelRequest } } as unknown as RunContext;
  const state: SupervisorState = { ctx, db, actor: { agent: "supervisor:wait", role: "supervisor", task: "job", job: "job" }, repos: new Map(), briefChecks: new Set(), children: new Map([["worker", "worker"]]) };
  const harness = { ctx } as HarnessEnv;
  const tool = supervisorTools(state).find(tool => tool.def.function.name === "await_tasks")!;
  return {
    broker, request, ctx, tasks, controller, cancelled, modelRequest, awaitResults,
    wait: (timeout = 5) => tool.run({ task_ids: ["worker"], timeout_seconds: timeout }, harness),
    list: () => supervisorActionTools("job").find(tool => tool.def.function.name === "worker_action_requests")!.run({}, harness),
    policy: (outside_repository: "human_only" | "supervisor") => writeFileSync(env!.cfg.configPath, YAML.stringify({ ...raw, security: { outside_repository } })),
    decide: (decision: "approve" | "deny") => broker.decide({ project: "demo", id: request.id, decision, reason: "Explicit temporary fixture operator decision", actor: { kind: "operator" }, config: env!.cfg }),
  };
}

it.each(["approve", "deny"] as const)("holds human-only await_tasks without model calls or cancellation until actual operator %s", async decision => {
  const f = await fixture();
  let resolved = false;
  const waiting = f.wait().then(output => { resolved = true; return output; });
  await sleep(125);
  expect(f.awaitResults.mock.calls.length).toBeGreaterThan(1);
  expect(resolved).toBe(false);
  expect(f.broker.get("demo", f.request.id)?.status).toBe("pending");
  const rows = JSON.parse(await f.list());
  expect(rows[0]).toMatchObject({ approvalPolicy: "human_only", canApprove: false, waitingFor: "human_operator" });
  const decided = await f.decide(decision);
  expect(decided.status).toBe(decision === "approve" ? "completed" : "denied");
  const output = await waiting;
  expect(output).toContain(`worker action ${f.request.id}: ${decided.status}`);
  expect(output).not.toContain("decide_worker_action");
  expect(f.tasks.get("worker")!.row.state).toBe("running");
  expect(f.cancelled).not.toHaveBeenCalled();
  expect(f.modelRequest).not.toHaveBeenCalled();
});

it("wakes immediately for a pending action the supervisor is authorized to approve", async () => {
  const f = await fixture("supervisor");
  expect(await f.wait()).toContain("decide_worker_action");
  expect(f.awaitResults).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await f.list())[0]).toMatchObject({ approvalPolicy: "supervisor", canApprove: true, waitingFor: "supervisor_decision" });
  expect(f.broker.get("demo", f.request.id)?.status).toBe("pending");
});

it("rereads trusted policy while waiting and wakes after human-only becomes supervisor-capable", async () => {
  const f = await fixture();
  let resolved = false;
  const waiting = f.wait().then(output => { resolved = true; return output; });
  await sleep(100);
  expect(resolved).toBe(false);
  f.policy("supervisor");
  expect(f.ctx.cfg.security.outside_repository).toBe("human_only");
  expect(await waiting).toContain("decide_worker_action");
  expect(JSON.parse(await f.list())[0].canApprove).toBe(true);
});

it("honors explicit timeout and reports human-only waiting without impossible supervisor approval advice", async () => {
  const f = await fixture();
  const output = await f.wait(1);
  expect(output).toContain("awaiting human operator approval; supervisor cannot approve");
  expect(output).not.toContain("decide_worker_action");
  expect(f.broker.get("demo", f.request.id)?.status).toBe("pending");
  expect(f.cancelled).not.toHaveBeenCalled();
});

it("preserves explicit cancellation and task completion wakeups while human approval is pending", async () => {
  const f = await fixture();
  const waiting = f.wait();
  await sleep(100);
  f.controller.abort("Explicit user cancellation");
  expect(await waiting).toContain("awaiting human operator approval");
  expect(f.cancelled).not.toHaveBeenCalled();
  const result = syntheticResult("worker", "completed", "Explicit fixture completion");
  f.tasks.finish("worker", "owner", result, "completed");
  expect(await f.wait()).toContain("worker (inspect): completed");
});
