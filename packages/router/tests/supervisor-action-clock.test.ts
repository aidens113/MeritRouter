import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WorkerTaskSchema } from "../src/core/task.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult, TaskStore } from "../src/storage/tasks.js";
import { WorkerActionRequests } from "../src/harness/worker-actions.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { RunContext, SupervisorServices } from "../src/runners/types.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined;
afterEach(() => { db?.close(); env?.cleanup(); db = undefined; env = undefined; });

async function fixture(completedTarget = false) {
  // Authority deliberately predates wall time; only injected time may expire these leases.
  let clock = Date.UTC(2020, 0, 1);
  const now = () => clock;
  const cfg = baseConfig();
  Object.assign(cfg.profiles, { supervise: { mode: "supervisor", tools: "supervisor", max_model_requests: 30 } });
  env = makeEnv({ config: cfg });
  db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db, now);
  const spec = (id: string, parentTaskId?: string) => WorkerTaskSchema.parse({ id, profile: parentTaskId ? "inspect" : "supervise", ...(parentTaskId ? { parentTaskId } : {}), goal: "clock regression", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["bounded check succeeds"] } });
  tasks.submit([spec("job"), spec("worker", "job"), spec("done", "job")], { project: "demo" });
  const claimed = tasks.claim("owner", { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 120_000, supervisorProfiles: ["supervise"], maxSupervisors: 1 });
  expect(claimed.map(task => task.row.id).sort()).toEqual(["done", "job", "worker"]);
  const job = claimed.find(task => task.row.id === "job")!, worker = claimed.find(task => task.row.id === "worker")!;
  const result = syntheticResult("done", "completed", "finished fixture target");
  tasks.finish("done", "owner", result, "completed");
  const context = (task: typeof worker) => ({ cfg: env!.cfg, tasks, taskId: task.row.id, spec: task.spec, taskLease: capturedLease(task), taskProject: "demo", now, signal: new AbortController().signal }) as RunContext;
  const store = new WorkerActionRequests(db, now);
  const output = path.join(env.repo, "approved-clock-check.txt");
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('approved-clock-check.txt','executed');console.log('clock-check-passed')"`;
  const request = await store.file(context(worker), { command, cwd: env.repo, timeoutMs: 5000, reason: "Explicit operator execution for historical-clock regression" });
  const awaitResults = vi.fn<SupervisorServices["awaitResults"]>().mockResolvedValueOnce(completedTarget
    ? { completed: [result], pending: [], timedOut: false }
    : { completed: [], pending: [{ taskId: "worker", state: "running" }], timedOut: true });
  // A second iteration means the actual await_tasks predicate missed the pending action.
  awaitResults.mockRejectedValue(new Error("await_tasks failed to return for a pending worker action"));
  const unused = () => { throw new Error("unexpected service operation in await_tasks regression"); };
  const services: SupervisorServices = {
    awaitResults,
    getTask: (id) => { const task = tasks.get(id); return task ? { spec: task.spec, state: task.row.state, result: task.result } : null; },
    submitTasks: async () => unused(), cancelTasks: unused, acceptTask: unused, rejectTask: unused,
  };
  const state: SupervisorState = { ctx: { ...context(job), services }, db, actor: { agent: "supervisor:clock", role: "supervisor", task: "job", job: "job" }, repos: new Map(), briefChecks: new Set(), children: new Map([["worker", "worker"], ["done", "done"]]) };
  const tool = supervisorTools(state).find(candidate => candidate.def.function.name === "await_tasks")!;
  return { store, request, output, awaitResults, advance: () => { clock += 61_000; }, wait: () => tool.run({ task_ids: [completedTarget ? "done" : "worker"], timeout_seconds: 30 }, {} as HarnessEnv) };
}

it("preserves a historical-clock pending action through the real await_tasks early-return predicate and operator execution", async () => {
  const f = await fixture();
  expect(existsSync(f.output)).toBe(false);
  expect(await f.wait()).toContain(`worker action ${f.request.id}`);
  expect(f.awaitResults).toHaveBeenCalledTimes(1);
  expect(f.store.get("demo", f.request.id)?.status).toBe("pending");
  const executed = await f.store.decide({ project: "demo", id: f.request.id, decision: "approve", reason: "reviewed exact fixture command", actor: { kind: "operator" }, config: env!.cfg });
  expect(executed.status).toBe("completed");
  expect(executed.exitCode).toBe(0);
  expect(executed.output).toContain("clock-check-passed");
  expect(readFileSync(f.output, "utf8")).toBe("executed");
});

it("projects pending actions with the injected clock when completed targets short-circuit the loop predicate", async () => {
  const f = await fixture(true);
  const output = await f.wait();
  expect(output).toContain(`worker action ${f.request.id}`);
  expect(output).toContain("decide_worker_action");
  expect(output).toContain("done (inspect): completed");
  expect(f.store.get("demo", f.request.id)?.status).toBe("pending");
});

it("still cancels an expired original lease when the authoritative injected clock advances", async () => {
  const f = await fixture(true);
  f.advance();
  expect(await f.wait()).not.toContain(`worker action ${f.request.id}`);
  expect(f.store.get("demo", f.request.id)).toMatchObject({ status: "cancelled", decisionReason: "Original task authority ended before execution" });
  expect(existsSync(f.output)).toBe(false);
});
