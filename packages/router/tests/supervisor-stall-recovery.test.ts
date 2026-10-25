import { afterEach, expect, it } from "vitest";
import { appendFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { MeritRouter } from "../src/core/service.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { resumeFor } from "../src/sessions/run-sessions.js";
import { recordGrant } from "../src/admission/job-pool.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const reason = "repeated_tool_call:task_result";
const limits = { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 60_000, defaultTimeoutMs: 3600_000, supervisorProfiles: ["supervise"], maxSupervisors: 4, supervisorTimeoutMs: 3600_000 };
async function fixture(profile: "supervise" | "inspect" = "supervise", failure = reason) {
  const cfg = baseConfig();
  (cfg.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" };
  env = makeEnv({ config: cfg });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const [task] = await sy.submitTasks([{ profile, goal: "Recover settled supervisor observations", repositoryAliases: ["core"], budget: { maxModelRequests: 40 }, constraints: { acceptanceCriteria: ["deliver reviewed result"] } }]);
  const id = task!.taskId;
  sy.tasks.claim("fixture", limits);
  const session = sy.sessions.create({ taskId: id, jobId: id, role: profile === "supervise" ? "supervisor" : "inspector", agentLabel: "fixture", profile, tier: "T3" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo, encoding: "utf8" }).trim();
  session.setWorkspace({ repos: [{ alias: "core", worktree: env.repo, branch: "main", baseCommit: head, head }] });
  session.syncMessages([{ role: "system", content: "supervisor charter" }, { role: "user", content: "goal" }, { role: "assistant", content: "", tool_calls: [{ id: "effect", type: "function", function: { name: "integrate_task", arguments: '{"task_id":"child"}' } }] }, { role: "tool", tool_call_id: "effect", content: "integrated exactly once" }]);
  session.end("failed", failure);
  sy.tasks.finish(id, "fixture", syntheticResult(id, "failed", failure), "failed");
  return { id, session, head };
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
