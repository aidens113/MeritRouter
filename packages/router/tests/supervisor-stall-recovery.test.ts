import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MeritRouter } from "../src/core/service.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { resumeFor } from "../src/sessions/run-sessions.js";
import { recordGrant } from "../src/admission/job-pool.js";
import type { Executor } from "../src/core/executor.js";
import { baseResult, type RunContext, type RunOutcome } from "../src/runners/types.js";
import { SessionStore } from "../src/sessions/store.js";
import { Gate } from "../src/gateway/gate.js";
import { TaskRouter } from "../src/routing/router.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const reason = "repeated_tool_call:task_result";
const limits = { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60_000, defaultTimeoutMs: 3600_000, supervisorProfiles: ["supervise"], maxSupervisors: 4, supervisorTimeoutMs: 3600_000 };
async function fixture(profile: "supervise" | "inspect" = "supervise", failure = reason) {
  const cfg = baseConfig();
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" };
  env = makeEnv({ config: cfg });
  const client = new ScriptedClient(() => reply("unused"));
  sy = open(env, client, { worker: false });
  const [task] = await sy.submitTasks([{ profile, goal: "Recover settled supervisor observations", repositoryAliases: ["core"], budget: { maxModelRequests: 40 }, constraints: { acceptanceCriteria: ["deliver reviewed result"] } }]);
  const id = task!.taskId;
  sy.tasks.claim("fixture", limits);
  const session = sy.sessions.create({ taskId: id, jobId: id, role: profile === "supervise" ? "supervisor" : "inspector", agentLabel: "fixture", profile, tier: "T3" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo, encoding: "utf8" }).trim();
  session.setWorkspace({ repos: [{ alias: "core", worktree: env.repo, branch: "main", baseCommit: head, head }] });
  session.syncMessages([{ role: "system", content: "supervisor charter" }, { role: "user", content: "goal" }, { role: "assistant", content: "", tool_calls: [{ id: "effect", type: "function", function: { name: "integrate_task", arguments: '{"task_id":"child"}' } }] }, { role: "tool", tool_call_id: "effect", content: "integrated exactly once" }]);
  session.end("failed", failure);
  sy.tasks.finish(id, "fixture", syntheticResult(id, "failed", failure), "failed");
  return { id, session, head, client };
}

it("explicitly continues a settled failed supervisor in a linked session while preserving history, child grants, budget and deadline", async () => {
  const { id, session } = await fixture();
  const [child] = await sy!.submitTasks([{ profile: "inspect", parentTaskId: id, goal: "Retained child", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] } }]);
  recordGrant(sy!.db, { taskId: child!.taskId, jobId: id, requests: 8, source: "supervisor" }, Date.now());
  // Trusted fake-provider accounting fixture: two physical requests already spent.
  sy!.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('stall-execution','task','supervise','completed',?)").run(Date.now());
  for (const request of ["stall-request-1", "stall-request-2"]) {
    sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,'stall-execution','execution','fixture-model','succeeded',?,10,10)").run(request, Date.now());
    sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,10,10)").run(request, id);
  }
  const original = sy!.tasks.get(id)!, events = sy!.sessions.events(session.id)!.events, used = sy!.admission.taskTotals(id);
  expect(used.requests).toBe(2);
  expect(() => sy!.tasks.resume(id)).toThrow(/not interrupted/);
  expect(sy!.resumeTask(id, "demo")).toBe("queued");
  expect(() => sy!.resumeTask(id, "demo")).toThrow();
  expect(sy!.tasks.get(id)!.row.deadline_at).toBe(original.row.deadline_at);
  expect(sy!.tasks.get(id)!.spec.budget).toEqual(original.spec.budget);
  expect(sy!.admission.taskTotals(id)).toEqual(used);
  expect(sy!.tasks.childrenOf(id).map(task => task.row.id)).toContain(child!.taskId);
  sy!.tasks.claim("fixture2", limits);
  const resumed = resumeFor({ cfg: env!.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, sy!.tasks.get(id)!);
  expect(resumed).not.toBeNull();
  const linked = sy!.sessions.get(resumed!.session.id)!;
  expect(linked.previousSessionId).toBe(session.id);
  expect(linked.workspace).toEqual(sy!.sessions.get(session.id)!.workspace);
  expect(resumed!.plan.messages.some(message => message.content === "integrated exactly once")).toBe(true);
  expect(sy!.sessions.get(session.id)!.status).toBe("failed");
  expect(sy!.sessions.events(session.id)!.events).toEqual(events);
  const receipt = sy!.tasks.events(id, 100).find(event => event.type === "session_resumed")!;
  expect(receipt.data).toMatchObject({ sessionId: linked.id, previousSessionId: session.id });
  // A second interruption still retains the completed effect's tool receipt.
  resumed!.session.end("interrupted", "fixture shutdown");
  sy!.tasks.interrupt(id, "fixture2", "fixture shutdown");
  sy!.resumeTask(id, "demo");
  sy!.tasks.claim("fixture3", limits);
  const second = resumeFor({ cfg: env!.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, sy!.tasks.get(id)!);
  expect(second!.plan.messages.some(message => message.content === "integrated exactly once")).toBe(true);
  expect(sy!.tasks.get(id)!.row.deadline_at).toBe(original.row.deadline_at);
});

it.each(["deadline_exceeded", "budget_exhausted", "provider_failed", "repeated_tool_call:run_check"])("refuses unrelated failed reason %s", async failure => {
  const { id } = await fixture("supervise", failure);
  expect(() => sy!.resumeTask(id, "demo")).toThrow(/recoverable/);
  expect(sy!.tasks.get(id)!.row.state).toBe("failed");
});

it.each(["expired", "cancelled", "wrong-project", "exhausted", "missing-workspace", "corrupt-log", "wrong-role"])("refuses unsafe recovery: %s", async condition => {
  const { id, session } = await fixture(condition === "wrong-role" ? "inspect" : "supervise");
  if (condition === "expired") sy!.db.prepare("UPDATE tasks SET deadline_at=? WHERE id=?").run(Date.now() - 1, id);
  if (condition === "cancelled") sy!.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(id);
  if (condition === "missing-workspace") rmSync(env!.repo, { recursive: true });
  if (condition === "corrupt-log") appendFileSync(sy!.sessions.get(session.id)!.logPath, "invalid json\n");
  if (condition === "exhausted") {
    const [child] = await sy!.submitTasks([{ profile: "inspect", parentTaskId: id, goal: "Hold remaining budget", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] } }]);
    recordGrant(sy!.db, { taskId: child!.taskId, jobId: id, requests: 40, source: "supervisor" }, Date.now());
  }
  expect(() => sy!.resumeTask(id, condition === "wrong-project" ? "foreign" : "demo")).toThrow();
  expect(sy!.tasks.get(id)!.row.state).toBe("failed");
});

it.each(["missing-workspace", "corrupt-log", "changed-mode", "missing-named-session"])("fails closed if retained authority disappears after queueing: %s", async condition => {
  const { id, session } = await fixture();
  sy!.resumeTask(id, "demo");
  sy!.tasks.claim("fixture2", limits);
  if (condition === "missing-workspace") rmSync(env!.repo, { recursive: true });
  if (condition === "corrupt-log") appendFileSync(sy!.sessions.get(session.id)!.logPath, "invalid json\n");
  if (condition === "changed-mode") env!.cfg.profiles.supervise!.mode = "read_only";
  if (condition === "missing-named-session") sy!.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: "missing-retained-session", failedObservationRecovery: true }), id);
  expect(() => resumeFor({ cfg: env!.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, sy!.tasks.get(id)!)).toThrow();
  expect(sy!.sessions.forTask(id)).toHaveLength(1);
});


it.each(["syncMessages", "setWorkspace", "resumed", "note", "task_event"] as const)("closes and settles observation recovery after its linked %s write fails", async fault => {
  const f = await fixture(), original = sy!.tasks.get(f.id)!;
  const history = readFileSync(sy!.sessions.get(f.session.id)!.logPath), source = readFileSync(path.join(env!.repo, "src/app.ts"));
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves"].map(table => sy!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = accounting(); sy!.resumeTask(f.id, "demo");
  let injected = false;
  const create = SessionStore.prototype.create;
  vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
    const recorder = create.call(this, input);
    if (input.previousSessionId === f.session.id && fault !== "task_event") vi.spyOn(recorder, fault).mockImplementationOnce(() => { injected = true; throw new Error("Transient observation recording failure"); });
    return recorder;
  });
  if (fault === "task_event") {
    const event = sy!.tasks.event.bind(sy!.tasks);
    vi.spyOn(sy!.tasks, "event").mockImplementation((id, type, data) => {
      if (!injected && id === f.id && type === "session_resumed") { injected = true; throw new Error("Transient observation task-event failure"); }
      return event(id, type, data);
    });
  }
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = (sy as unknown as { executor: Executor }).executor;
  const gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Broken linked observation recovery reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined(); expect(injected).toBe(true);
  expect(runner).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
  const authors = sy!.sessions.forTask(f.id), linked = authors.find(session => session.previousSessionId === f.session.id)!;
  expect(authors).toHaveLength(2); expect(authors.some(session => session.status === "running")).toBe(false);
  expect(linked).toMatchObject({ status: "failed", stopReason: "supervisor_observation_recovery_recording_failed" });
  expect(sy!.sessions.events(linked.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "ended", data: { status: "failed", stopReason: "supervisor_observation_recovery_recording_failed" } });
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(accounting()).toBe(before);
  expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(history); expect(readFileSync(path.join(env!.repo, "src/app.ts"))).toEqual(source);
});

it.each([false, true])("retains ordinary unreadable-session fallback after a historical explicit recovery (malformed unknown: %s)", async malformedUnknown => {
  const f = await fixture(); sy!.resumeTask(f.id, "demo");
  const [first] = sy!.tasks.claim("linked-owner", limits), linked = resumeFor({ cfg: env!.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, first!)!;
  linked.session.end("interrupted", "user_paused"); sy!.tasks.interrupt(f.id, "linked-owner", "user paused"); sy!.resumeTask(f.id, "demo");
  if (malformedUnknown) sy!.db.prepare("UPDATE events SET data_json=? WHERE id=(SELECT MAX(id) FROM events WHERE task_id=? AND type='resumed')").run(JSON.stringify({ unknownResumeOption: true }), f.id);
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = (sy as unknown as { executor: Executor }).executor;
  vi.spyOn(SessionStore.prototype, "reopen").mockImplementationOnce(() => { throw new Error("Transient ordinary session read failure"); });
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockImplementation(async ctx => {
    expect(ctx.resume).toBeNull();
    return { state: "completed", result: baseResult({ executionStatus: "completed", acceptanceStatus: "not_verified", stopReason: "supervisor_blocked" }) };
  });
  const gate = vi.spyOn(Gate.prototype, "request"); await expect(executor.runSingle(task!)).resolves.toBeUndefined();
  expect(runner).toHaveBeenCalledOnce(); expect(gate).not.toHaveBeenCalled();
  expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
  expect(sy!.tasks.events(f.id).some(event => event.type === "session_resume_failed" && (event.data as { error?: string }).error === "Transient ordinary session read failure")).toBe(true);
});

it("fails closed for malformed current observation directive key failedObservationRecovery", async () => {
  const f = await fixture(), original = sy!.tasks.get(f.id)!;
  const history = readFileSync(sy!.sessions.get(f.session.id)!.logPath), source = readFileSync(path.join(env!.repo, "src/app.ts"));
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves"].map(table => sy!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = accounting(); sy!.resumeTask(f.id, "demo");
  sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.failedObservationRecovery',0) WHERE task_id=? AND type='resumed'").run(f.id);
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = (sy as unknown as { executor: Executor }).executor;
  const route = vi.spyOn(TaskRouter.prototype, "prepare"), gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Malformed observation recovery reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined();
  expect(runner).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(accounting()).toBe(before); expect(sy!.sessions.forTask(f.id)).toHaveLength(1);
  expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(history); expect(readFileSync(path.join(env!.repo, "src/app.ts"))).toEqual(source);
});
