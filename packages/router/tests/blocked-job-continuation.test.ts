import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { NativeContinuationSchema, type ChatMessage } from "../src/gateway/types.js";
import type { GateResponse } from "../src/gateway/gate.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseResult, type RunContext, type RunOutcome } from "../src/runners/types.js";
import type { Executor } from "../src/core/executor.js";
import { Gate } from "../src/gateway/gate.js";
import { TaskRouter } from "../src/routing/router.js";
import { resumeFor } from "../src/sessions/run-sessions.js";
import { SessionStore } from "../src/sessions/store.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { recordGrant } from "../src/admission/job-pool.js";
import { blockedJobRunPolicy } from "../src/storage/blocked-job-continuation.js";
import { projectRuntimeActivationRoots } from "../src/workspaces/worktree.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { applyResume } from "../src/harness/resume.js";
import { SupervisorRunner } from "../src/runners/supervisor.js";
import * as gitCommands from "../src/workspaces/git.js";
import * as repositoryMutation from "../src/workspaces/repository-mutation.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const STOP = "supervisor_blocked";
const limits = { maxConcurrent: 4, maxWritersPerRepo: 4, leaseMs: 300000, defaultTimeoutMs: 3600000, supervisorProfiles: ["supervise"], maxSupervisors: 4, supervisorTimeoutMs: 3600000 };
const toolCall = (id: string, status: "blocked" | "completed") => ({ id, type: "function" as const, function: { name: "finish_job", arguments: JSON.stringify({ status, summary: "honest status", verified: [], not_verified: [] }) } });
async function fixture(options: { dirty?: boolean; foreign?: boolean; unresolved?: boolean; profile?: "supervise" | "inspect"; stop?: string } = {}) {
  const config = baseConfig({ storage: { layout: "legacy", directory: ".meritrouter" } });
  (config.profiles as Record<string, unknown>).supervise = { mode: "supervisor", tools: "supervisor", max_model_requests: 40, max_output_tokens: 4000, classify: "never", min_tier: "T3" };
  env = makeEnv({ config }); const client = new ScriptedClient(() => reply("unused")); sy = open(env, client, { worker: false });
  const [created] = await sy.submitTasks([{ profile: options.profile ?? "supervise", goal: "Continue the retained original goal", repositoryAliases: ["core"], budget: { maxModelRequests: 40, maxPaidUsd: 5, timeoutSeconds: 3600 }, constraints: { acceptanceCriteria: ["independent delivery acceptance"] } }]);
  const id = created!.taskId;
  sy.tasks.claim("initial-owner", limits);
  const cfg = sy.projectContext("demo"), root = projectRuntimeActivationRoots(cfg).worktrees;
  mkdirSync(root, { recursive: true });
  const worktree = path.join(root, "retained");
  if (options.foreign) execFileSync("git", ["clone", "--local", env.repo, worktree], { stdio: "pipe" });
  else execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: env.repo, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const session = sy.sessions.create({ taskId: id, jobId: id, role: options.profile === "inspect" ? "inspector" : "supervisor", agentLabel: "retained supervisor", profile: options.profile ?? "supervise", tier: "T3" });
  const native = NativeContinuationSchema.parse({ provider: "anthropic", routeProvider: "fixture", baseUrl: "https://native.example.test", model: "fixture", prefixDigest: "a".repeat(64),
    content: [{ type: "thinking", thinking: "retained native reasoning", signature: "unaltered-signature+/=" }, { type: "tool_use", id: "old-blocked", name: "finish_job", input: JSON.parse(toolCall("old-blocked", "blocked").function.arguments) }] });
  const messages: ChatMessage[] = [{ role: "system", content: "original charter" }, { role: "user", content: "original goal" }, { role: "assistant", content: null, tool_calls: [toolCall("old-blocked", "blocked")], nativeContinuation: native }, { role: "tool", tool_call_id: "old-blocked", content: "accepted" }];
  session.syncMessages(messages);
  session.setWorkspace({ repos: [{ alias: "core", worktree, branch: null, head, baseCommit: head }] });
  if (options.unresolved) session.toolIntent({ callId: "unknown-command", name: "run_command", args: { command: "echo unknown" }, sideEffect: "command", idempotent: false });
  session.end("completed", options.stop ?? STOP);
  sy.tasks.finish(id, "initial-owner", syntheticResult(id, "completed", options.stop ?? STOP), "completed");
  if (options.dirty) writeFileSync(path.join(worktree, "unproved.txt"), "uncommitted");
  const task = sy.tasks.get(id)!;
  const input = { operationId: "continue-blocked-1", project: "demo", taskId: id, sessionId: session.id,
    expectedDeadlineAt: task.row.deadline_at!, expectedRunCount: task.row.run_count, expectedIncarnation: task.row.lease_incarnation,
    reason: "User continued the unfinished goal after an operator resource decision" };
  return { id, session, cfg, worktree, head, messages, input, client };
}
function currentContext(f: Awaited<ReturnType<typeof fixture>>) {
  sy!.tasks.claim("continued-owner", limits);
  const task = sy!.tasks.get(f.id)!, resumed = resumeFor({ cfg: f.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, task)!;
  const ctx = { cfg: f.cfg, taskId: f.id, spec: task.spec, profile: f.cfg.profiles.supervise, tasks: sy!.tasks, session: resumed.session, resume: { plan: resumed.plan }, now: Date.now,
    taskLease: { taskId: f.id, project: "demo", owner: "continued-owner", runCount: task.row.run_count, incarnation: task.row.lease_incarnation }, signal: new AbortController().signal,
  } as unknown as RunContext;
  return { task, resumed, ctx };
}

async function historicalTimeout(f: Awaited<ReturnType<typeof fixture>>) {
  const [created] = await sy!.submitTasks([{ profile: "inspect", parentTaskId: f.id, goal: "Retained dependency install", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["install"] } }]);
  const childId = created!.taskId;
  sy!.tasks.claim("child-owner", { ...limits, limit: 1 });
  const row = sy!.tasks.get(childId)!.row;
  sy!.tasks.finish(childId, "child-owner", syntheticResult(childId, "failed", "command_timeout"), "failed");
  const action = { id: "historical-timeout", project: "demo", taskId: childId, status: "uncertain", quiescedAt: Date.now(),
    action: { command: "npm install", cwd: f.worktree, timeoutMs: 30000, reason: "Install dependencies", source: "a".repeat(64), jobId: f.id,
      lease: { taskId: childId, project: "demo", owner: "child-owner", runCount: row.run_count, incarnation: row.lease_incarnation } },
    decisionReason: "Approved exact source", decidedBy: "FINAL", output: "Process timeout; killed and quiesced. Outcome remains unknown.", exitCode: null, createdAt: Date.now() - 30000 };
  const save = () => sy!.db.prepare("INSERT OR REPLACE INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(action.id, "demo", action.taskId, "historical-timeout", JSON.stringify(action, null, 2), action.createdAt);
  save();
  return { childId, action, save };
}

it("retains a terminal descendant's host-quiesced timed-out install as UNKNOWN history after a later same-source install succeeded", async () => {
  const f = await fixture(), h = await historicalTimeout(f);
  const completed = { ...h.action, id: "later-completed", status: "completed", output: "Install completed", exitCode: 0, createdAt: Date.now(), action: { ...h.action.action, timeoutMs: 300000 } };
  sy!.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(completed.id, "demo", h.childId, "later-completed", JSON.stringify(completed, null, 2), completed.createdAt);
  const history = () => sy!.db.prepare("SELECT value_json FROM worker_action_requests ORDER BY id").all();
  const before = JSON.stringify(history());
  expect((await sy!.continueBlockedJob(f.input)).disposition).toBe("fresh");
  expect(JSON.stringify(history())).toBe(before);
  expect(JSON.parse((history()[0] as { value_json: string }).value_json).status).toBe("uncertain");
  expect(sy!.tasks.get(h.childId)!.row.state).toBe("failed");
});

it.each(["unquiesced", "own_root", "live_descendant", "owned_terminal", "active_session", "wrong_project", "wrong_task", "wrong_id", "pending", "running"] as const)("refuses historical uncertainty with %s evidence", async kind => {
  const f = await fixture(), h = await historicalTimeout(f);
  if (kind === "unquiesced") delete (h.action as { quiescedAt?: number }).quiescedAt;
  if (kind === "own_root") h.action.taskId = f.id;
  if (kind === "live_descendant") sy!.db.prepare("UPDATE tasks SET state='queued' WHERE id=?").run(h.childId);
  if (kind === "owned_terminal") sy!.db.prepare("UPDATE tasks SET lease_owner='live-owner',lease_expires_at=? WHERE id=?").run(Date.now() + 60000, h.childId);
  if (kind === "active_session") sy!.sessions.create({ taskId: h.childId, jobId: f.id, role: "inspector", agentLabel: "still running", profile: "inspect" });
  if (kind === "wrong_project") h.action.project = "foreign";
  if (kind === "pending" || kind === "running") h.action.status = kind;
  h.save();
  if (kind === "wrong_task" || kind === "wrong_id") sy!.db.prepare(`UPDATE worker_action_requests SET value_json=json_set(value_json,?,?) WHERE id=?`).run(kind === "wrong_task" ? "$.taskId" : "$.id", "forged", h.action.id);
  const before = sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=?").get(h.action.id);
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow();
  expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
  expect(sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=?").get(h.action.id)).toEqual(before);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "host timestamp", null])("refuses malformed quiesced timestamp %s without altering the UNKNOWN action", async timestamp => {
  const f = await fixture(), h = await historicalTimeout(f);
  sy!.db.prepare("UPDATE worker_action_requests SET value_json=json_set(value_json,'$.quiescedAt',?) WHERE id=?").run(timestamp, h.action.id);
  const before = sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=?").get(h.action.id);
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow();
  expect(sy!.db.prepare("SELECT value_json FROM worker_action_requests WHERE id=?").get(h.action.id)).toEqual(before);
});

it.each(["lease_lost", "cancelled"] as const)("blocks %s before any active continuation Git read or mutation admission", async kind => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input); const { ctx } = currentContext(f);
  if (kind === "lease_lost") sy!.db.prepare("UPDATE tasks SET lease_owner='replacement' WHERE id=?").run(f.id);
  else sy!.db.prepare("UPDATE tasks SET state='cancel_requested',cancel_requested=1 WHERE id=?").run(f.id);
  const reads = vi.spyOn(gitCommands, "git"), locks = vi.spyOn(repositoryMutation, "withRepositoryMutation");
  await expect(new SupervisorRunner().run(ctx)).rejects.toThrow(/captured task lease/);
  expect(reads).not.toHaveBeenCalled(); expect(locks).not.toHaveBeenCalled();
});

it.each(["lease_lost", "cancelled"] as const)("blocks %s during asynchronous proof before taking a mutation lock", async kind => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input); const { ctx } = currentContext(f);
  const original = gitCommands.git, locks = vi.spyOn(repositoryMutation, "withRepositoryMutation");
  let changed = false;
  vi.spyOn(gitCommands, "git").mockImplementation(async (cwd, args, options) => {
    const result = await original(cwd, args, options);
    if (!changed && args.join(" ") === "rev-parse HEAD^{tree}") {
      changed = true;
      if (kind === "lease_lost") sy!.db.prepare("UPDATE tasks SET lease_owner='replacement' WHERE id=?").run(f.id);
      else sy!.db.prepare("UPDATE tasks SET state='cancel_requested',cancel_requested=1 WHERE id=?").run(f.id);
    }
    return result;
  });
  await expect(new SupervisorRunner().run(ctx)).rejects.toThrow(/captured task lease/);
  expect(changed).toBe(true); expect(locks).not.toHaveBeenCalled();
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.worktree, encoding: "utf8" }).trim()).toBe(f.head);
});

it.each(["lease_lost", "cancelled"] as const)("blocks %s during the under-lock proof and releases the lock before any supervisor effects", async kind => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input); const { ctx } = currentContext(f);
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: f.worktree, encoding: "utf8" }).trim(), marker = path.resolve(f.worktree, common, "meritrouter-mutation.lock");
  const original = gitCommands.git;
  let changed = false;
  vi.spyOn(gitCommands, "git").mockImplementation(async (cwd, args, options) => {
    const result = await original(cwd, args, options);
    if (!changed && existsSync(marker) && args.join(" ") === "rev-parse HEAD^{tree}") {
      changed = true;
      if (kind === "lease_lost") sy!.db.prepare("UPDATE tasks SET lease_owner='replacement' WHERE id=?").run(f.id);
      else sy!.db.prepare("UPDATE tasks SET state='cancel_requested',cancel_requested=1 WHERE id=?").run(f.id);
    }
    return result;
  });
  await expect(new SupervisorRunner().run(ctx)).rejects.toThrow(/captured task lease/);
  expect(changed).toBe(true); expect(existsSync(marker)).toBe(false);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.worktree, encoding: "utf8" }).trim()).toBe(f.head);
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.worktree, encoding: "utf8" }).trim()).toBe("");
});

it("does not impose a new log bound on an unrelated ordinary resume", async () => {
  const f = await fixture({ stop: "supervisor_completed" });
  const current = sy!.sessions.create({ taskId: f.id, jobId: f.id, role: "supervisor", agentLabel: "ordinary resumed author", profile: "supervise" });
  const log = sy!.sessions.get(current.id)!.logPath;
  appendFileSync(log, Array.from({ length: 10001 }, (_, index) => JSON.stringify({ seq: current.lastSeq + index + 1, at: Date.now(), type: "note", data: { text: "ordinary long-history note" } }) + "\n").join(""));
  expect(readFileSync(log, "utf8").trim().split("\n").length).toBeGreaterThan(10000);
  const read = vi.spyOn(SessionStore.prototype, "events");
  try {
    const ctx = { cfg: f.cfg, tasks: sy!.tasks, taskId: f.id, session: current, resume: { plan: { messages: f.messages } }, now: Date.now } as unknown as RunContext;
    expect(await blockedJobRunPolicy(ctx)).toBeNull(); expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

it("continues an exact blocked task with an additive receipt and preserves original history, source, caps, deadline, charges and child grants", async () => {
  const f = await fixture();
  const [child] = await sy!.submitTasks([{ profile: "inspect", parentTaskId: f.id, goal: "retained child", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["inspect"] } }]);
  recordGrant(sy!.db, { taskId: child!.taskId, jobId: f.id, requests: 4, source: "supervisor" }, Date.now());
  const original = sy!.tasks.get(f.id)!, originalLog = readFileSync(sy!.sessions.get(f.session.id)!.logPath), source = execFileSync("git", ["show", "--format=raw", "HEAD"], { cwd: f.worktree });
  const financial = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "task_request_grants", "job_budget_carves", "budget_requests"].map(table => sy!.db.prepare(`SELECT * FROM ${table}`).all()));
  const funds = financial();
  expect(() => sy!.resumeTask(f.id, "demo")).toThrow(/FINAL-rejected/);
  const receipt = await sy!.continueBlockedJob(f.input);
  expect(receipt).toMatchObject({ disposition: "fresh", previousDeadlineAt: f.input.expectedDeadlineAt, deadlineAt: f.input.expectedDeadlineAt });
  expect(await sy!.continueBlockedJob(f.input)).toEqual({ ...receipt, disposition: "replayed" });
  await expect(sy!.continueBlockedJob({ ...f.input, reason: "different replay" })).rejects.toThrow(/replay changed/);
  await expect(sy!.continueBlockedJob({ ...f.input, operationId: "stacked" })).rejects.toThrow();
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "queued", state_reason: "resumed", deadline_at: original.row.deadline_at, run_count: original.row.run_count });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(sy!.tasks.childrenOf(f.id)[0]!.row.id).toBe(child!.taskId);
  expect(financial()).toBe(funds); expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(originalLog);
  expect(execFileSync("git", ["show", "--format=raw", "HEAD"], { cwd: f.worktree })).toEqual(source);
  const { resumed } = currentContext(f);
  expect(sy!.sessions.get(resumed.session.id)).toMatchObject({ previousSessionId: f.session.id, status: "running" });
  expect(resumed.plan.messages).toEqual(f.messages);
  expect(resumed.plan.messages.find(message => message.role === "assistant")!.nativeContinuation).toEqual(f.messages[2]!.role === "assistant" ? f.messages[2]!.nativeContinuation : null);
  expect(sy!.sessions.events(resumed.session.id)!.events.filter(event => event.type === "model_response")).toEqual([]);
  expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(originalLog);
});

it("does not reaccept the old blocked terminal, but reuses a later real accepted terminal after a crash", async () => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input);
  const { resumed, ctx } = currentContext(f), policy = await blockedJobRunPolicy(ctx);
  expect(policy).toEqual({ skipSettledTerminal: true });
  const accept = vi.fn(async () => ({ ok: true as const, value: "finished" }));
  const env = { ctx, edits: new Set(), readers: new Map(), universe: { refs: new Map() } } as unknown as HarnessEnv;
  const terminal = { def: { type: "function" as const, function: { name: "finish_job", description: "finish", parameters: {} } }, accept };
  const applied = await applyResume({ env, messages: resumed.plan.messages, tools: [], terminal }, { plan: resumed.plan, actor: { agent: "fixture", role: "supervisor", model: null }, pointer: null, settledTerminalPolicy: "continue_blocked_job" });
  expect(applied.kind).toBe("continue"); expect(accept).not.toHaveBeenCalled();
  const freshCall = toolCall("fresh-completed", "completed");
  const response = { requestId: "fresh-request", endpoint: { id: "fixture" }, attempts: [], estimatedInputTokens: 100, response: reply(null, { toolCalls: [freshCall] }) } as unknown as GateResponse;
  resumed.session.modelResponse(response);
  resumed.plan.messages.push({ role: "assistant", content: null, tool_calls: [freshCall] }, { role: "tool", tool_call_id: freshCall.id, content: "accepted" });
  resumed.session.syncMessages(resumed.plan.messages);
  expect(await blockedJobRunPolicy(ctx)).toBeNull();
  const recovered = await applyResume({ env, messages: resumed.plan.messages, tools: [], terminal }, { plan: resumed.plan, actor: { agent: "fixture", role: "supervisor", model: null }, pointer: null });
  expect(recovered).toMatchObject({ kind: "finished", value: "finished" }); expect(accept).toHaveBeenCalledOnce();
});

it("requires an explicit bounded time grant when the old deadline elapsed, without raising request or paid caps", async () => {
  const f = await fixture(), expired = Date.now() - 1000;
  sy!.db.prepare("UPDATE tasks SET deadline_at=? WHERE id=?").run(expired, f.id);
  const input = { ...f.input, expectedDeadlineAt: expired }, original = sy!.tasks.get(f.id)!.spec;
  await expect(sy!.continueBlockedJob(input)).rejects.toThrow(/explicit bounded execution time/);
  await expect(sy!.continueBlockedJob({ ...input, additionalSeconds: 3601 })).rejects.toThrow(/exceeds/);
  const before = Date.now(), result = await sy!.continueBlockedJob({ ...input, additionalSeconds: 600 });
  expect(result.previousDeadlineAt).toBe(expired); expect(result.deadlineAt).toBeGreaterThanOrEqual(before + 600000);
  expect(result.deadlineAt).toBeLessThanOrEqual(Date.now() + 600000); expect(sy!.tasks.get(f.id)!.spec).toEqual(original);
});

it.each(["project", "session", "run", "incarnation", "deadline", "blank_reason"] as const)("rejects changed exact %s authority", async condition => {
  const f = await fixture(), input = { ...f.input };
  if (condition === "project") input.project = "foreign";
  if (condition === "session") input.sessionId = "foreign";
  if (condition === "run") input.expectedRunCount++;
  if (condition === "incarnation") input.expectedIncarnation = "foreign";
  if (condition === "deadline") input.expectedDeadlineAt--;
  if (condition === "blank_reason") input.reason = " ";
  await expect(sy!.continueBlockedJob(input)).rejects.toThrow(); expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
});

it.each(["owner", "cancel", "failed_worker", "ordinary_complete", "exhausted", "corrupt", "newer_session"] as const)("refuses ineligible %s work", async condition => {
  const f = await fixture(condition === "failed_worker" ? { profile: "inspect" } : condition === "ordinary_complete" ? { stop: "supervisor_completed" } : {});
  if (condition === "owner") sy!.db.prepare("UPDATE tasks SET lease_owner='active',lease_expires_at=? WHERE id=?").run(Date.now() + 60000, f.id);
  if (condition === "cancel") sy!.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(f.id);
  if (condition === "exhausted") { sy!.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('used','task','supervise','done',?)").run(Date.now());
    for (let i = 0; i < 40; i++) { sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,'used','fixture','fake','succeeded',?,1,1)").run(`used-${i}`, Date.now()); sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,1,1)").run(`used-${i}`, f.id); } }
  if (condition === "corrupt") appendFileSync(sy!.sessions.get(f.session.id)!.logPath, "not-json\n");
  if (condition === "newer_session") { const newer = sy!.sessions.create({ taskId: f.id, jobId: f.id, role: "supervisor", agentLabel: "newer", profile: "supervise" }); newer.end("completed", STOP); }
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow(); expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
});

it.each(["dirty", "foreign", "unresolved"] as const)("refuses %s retained workspace or effect evidence", async condition => {
  const f = await fixture({ [condition]: true });
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow(); expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: f.worktree, encoding: "utf8" }).trim();
  if (condition === "foreign") expect(() => readFileSync(path.resolve(f.worktree, common, "meritrouter-mutation.lock"))).toThrow();
});

it("preserves a real existing candidate for the FINAL delivery path rather than resuming it through blocked continuation", async () => {
  const f = await fixture(), deliveries = new ProductDeliveries(sy!.db), hash = "a".repeat(64);
  deliveries.saveSpec(f.id, "demo", { schemaVersion: 1, id: "delivery", revision: 1, source: { ref: "brain:spec.md", digest: hash }, originalInstruction: sy!.tasks.get(f.id)!.spec.goal,
    ownerId: "initiator", users: ["user"], platforms: ["browser"], workflows: ["complete goal"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [],
    criteria: [{ id: "goal", priority: "required", behavior: "Complete original goal", applicability: { status: "applicable" }, requiredEvidence: ["journey"] }] });
  deliveries.setCandidate(f.id, "demo", { repositories: { core: { head: f.head, tree: f.head } }, testDigest: hash, recipeDigest: hash, environmentDigest: hash, dependencyDigest: hash, fixtureDigest: hash, browserGeneration: null });
  const before = JSON.stringify(deliveries.status(f.id, "demo"));
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow(/existing FINAL delivery path/);
  expect(JSON.stringify(deliveries.status(f.id, "demo"))).toBe(before); expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
});

it.each(["command", "action"] as const)("refuses an active retained %s without changing the completed task", async kind => {
  const f = await fixture();
  if (kind === "command") {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: f.worktree, encoding: "utf8" }).trim(), id = `rc_${"a".repeat(32)}`;
    const directory = path.join(gitDir, "meritrouter-commands", "active", id); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({ version: 1, id, nonce: "b".repeat(64), descriptorSha256: "c".repeat(64), state: "prepared", ownerPid: process.pid, createdAt: Date.now() }));
  } else sy!.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES('pending','demo',?,'pending',?,?)").run(f.id, JSON.stringify({ status: "pending" }), Date.now());
  await expect(sy!.continueBlockedJob(f.input)).rejects.toThrow(); expect(sy!.tasks.get(f.id)!.row.state).toBe("completed");
});

it.each(["changed_head", "changed_branch", "dirty_after_queue", "forged_note", "missing_note", "changed_receipt", "changed_log"] as const)("refuses post-queue %s changes before supervisor effects", async condition => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input);
  const { ctx, resumed } = currentContext(f);
  if (condition === "changed_head") { writeFileSync(path.join(f.worktree, "changed.txt"), "later source"); execFileSync("git", ["add", "changed.txt"], { cwd: f.worktree }); execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "changed candidate"], { cwd: f.worktree, stdio: "pipe" }); }
  if (condition === "changed_branch") execFileSync("git", ["switch", "-c", "unexpected-branch"], { cwd: f.worktree, stdio: "pipe" });
  if (condition === "dirty_after_queue") writeFileSync(path.join(f.worktree, "dirty.txt"), "uncommitted");
  if (condition === "forged_note") resumed.session.note("blocked_job_continuation", { operationId: "unrecorded", previousSessionId: f.session.id, receiptDigest: "b".repeat(64) });
  if (condition === "missing_note") { const log = sy!.sessions.get(resumed.session.id)!.logPath; writeFileSync(log, readFileSync(log, "utf8").split("\n").filter(line => !line.includes('"text":"blocked_job_continuation"')).join("\n")); }
  if (condition === "changed_receipt") sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.proofDigest',?) WHERE task_id=? AND type='blocked_job_continued'").run("c".repeat(64), f.id);
  if (condition === "changed_log") appendFileSync(sy!.sessions.get(f.session.id)!.logPath, "corrupt original\n");
  await expect(blockedJobRunPolicy(ctx)).rejects.toThrow();
});

it.each(["forged", "mixed"] as const)("rejects a %s claimed directive before creating any linked author session", async kind => {
  const f = await fixture(); await sy!.continueBlockedJob(f.input);
  sy!.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: f.session.id, blockedJobContinuation: true, blockedJobOperationId: kind === "forged" ? "forged" : f.input.operationId, ...(kind === "mixed" ? { freshWorkspace: true } : {}) }), f.id);
  sy!.tasks.claim("next", limits);
  expect(() => resumeFor({ cfg: f.cfg, tasks: sy!.tasks, sessions: sy!.sessions }, sy!.tasks.get(f.id)!)).toThrow(kind === "forged" ? /receipt/ : /malformed/);
  expect(sy!.sessions.forTask(f.id)).toHaveLength(1);
});


const taskExecutor = (service: MeritRouter) => (service as unknown as { executor: Executor }).executor;
const retainedAccounting = (service: MeritRouter) => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves"]
  .map(table => service.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

it.each(["missing_receipt", "changed_receipt", "forged_operation", "removed_directive", "plain_directive", "replaced_directive"] as const)("settles the actual executor before routing or runner dispatch when blocked authority is %s", async condition => {
  const f = await fixture();
  const original = sy!.tasks.get(f.id)!, history = readFileSync(sy!.sessions.get(f.session.id)!.logPath);
  const source = readFileSync(path.join(f.worktree, "src/app.ts")), accounting = retainedAccounting(sy!);
  await sy!.continueBlockedJob(f.input);
  if (condition === "missing_receipt") sy!.db.prepare("DELETE FROM events WHERE task_id=? AND type='blocked_job_continued'").run(f.id);
  if (condition === "changed_receipt") sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.proofDigest',?) WHERE task_id=? AND type='blocked_job_continued'").run("c".repeat(64), f.id);
  if (condition === "forged_operation") sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.blockedJobOperationId','forged') WHERE task_id=? AND type='resumed'").run(f.id);
  if (condition === "removed_directive") sy!.db.prepare("DELETE FROM events WHERE task_id=? AND type='resumed'").run(f.id);
  if (condition === "plain_directive") sy!.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: f.session.id }), f.id);
  if (condition === "replaced_directive") sy!.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: f.session.id, failedObservationRecovery: true }), f.id);
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = taskExecutor(sy!);
  const route = vi.spyOn(TaskRouter.prototype, "prepare"), gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Rejected continuation reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined();
  expect(route).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(retainedAccounting(sy!)).toBe(accounting);
  expect(sy!.sessions.forTask(f.id)).toHaveLength(1); expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(history);
  expect(readFileSync(path.join(f.worktree, "src/app.ts"))).toEqual(source);
});

it.each(["syncMessages", "setWorkspace", "note", "task_event"] as const)("closes and settles blocked recovery after its linked %s write fails", async fault => {
  const f = await fixture(), original = sy!.tasks.get(f.id)!;
  const history = readFileSync(sy!.sessions.get(f.session.id)!.logPath), source = readFileSync(path.join(f.worktree, "src/app.ts")), accounting = retainedAccounting(sy!);
  await sy!.continueBlockedJob(f.input);
  let injected = false;
  const create = SessionStore.prototype.create;
  vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
    const recorder = create.call(this, input);
    if (input.previousSessionId === f.session.id && fault !== "task_event") vi.spyOn(recorder, fault).mockImplementationOnce(() => { injected = true; throw new Error("Transient linked recording failure"); });
    return recorder;
  });
  if (fault === "task_event") {
    const event = sy!.tasks.event.bind(sy!.tasks);
    vi.spyOn(sy!.tasks, "event").mockImplementation((id, type, data) => {
      if (!injected && id === f.id && type === "session_resumed") { injected = true; throw new Error("Transient linked task-event failure"); }
      return event(id, type, data);
    });
  }
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = taskExecutor(sy!);
  const gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Broken linked recovery reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined();
  expect(injected).toBe(true); expect(runner).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  const authors = sy!.sessions.forTask(f.id), linked = authors.find(session => session.previousSessionId === f.session.id)!;
  expect(authors).toHaveLength(2); expect(authors.some(session => session.status === "running")).toBe(false);
  expect(linked).toMatchObject({ status: "failed", stopReason: "blocked_job_continuation_recording_failed" });
  expect(sy!.sessions.events(linked.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "ended", data: { status: "failed", stopReason: "blocked_job_continuation_recording_failed" } });
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(retainedAccounting(sy!)).toBe(accounting);
  expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(history); expect(readFileSync(path.join(f.worktree, "src/app.ts"))).toEqual(source);
});

it("passes the exact retained blocked transcript and workspace to the actual executor's valid runner", async () => {
  const f = await fixture(), history = readFileSync(sy!.sessions.get(f.session.id)!.logPath), original = sy!.tasks.get(f.id)!;
  await sy!.continueBlockedJob(f.input);
  const [task] = sy!.tasks.claim(sy!.owner, limits), executor = taskExecutor(sy!);
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockImplementation(async ctx => {
    expect(ctx.resume?.plan.messages).toEqual(f.messages); expect(ctx.resume?.plan.workspace).toEqual(sy!.sessions.get(f.session.id)!.workspace);
    expect(sy!.sessions.get(ctx.session!.id)).toMatchObject({ previousSessionId: f.session.id, status: "running" });
    return { state: "completed", result: baseResult({ executionStatus: "completed", acceptanceStatus: "not_verified", stopReason: "supervisor_blocked" }) };
  });
  await expect(executor.runSingle(task!)).resolves.toBeUndefined(); expect(runner).toHaveBeenCalledOnce();
  expect(sy!.tasks.get(f.id)!.row).toMatchObject({ state: "completed", state_reason: "supervisor_blocked", deadline_at: original.row.deadline_at });
  expect(sy!.tasks.get(f.id)!.spec).toEqual(original.spec); expect(f.client.calls).toHaveLength(0);
  expect(readFileSync(sy!.sessions.get(f.session.id)!.logPath)).toEqual(history);
});
