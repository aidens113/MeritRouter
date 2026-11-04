import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { openDatabase } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { ProjectExecutionGrants } from "../src/storage/project-execution-grants.js";
import { ProjectQueueBindings } from "../src/storage/sqlite-task-queue.js";
import { LEGACY_MUTATION_LOCK_FAILURE } from "../src/storage/task-infrastructure-recovery.js";
import { resumeFor } from "../src/sessions/run-sessions.js";
import { classifyFailure } from "../src/core/disposition.js";
import { RepositoryMutationError } from "../src/workspaces/repository-mutation.js";
import { NativeContinuationSchema, type ChatMessage } from "../src/gateway/types.js";
import type { Executor } from "../src/core/executor.js";
import type { RunContext, RunOutcome } from "../src/runners/types.js";
import { SessionStore } from "../src/sessions/store.js";
import { Gate } from "../src/gateway/gate.js";
import { TaskRouter } from "../src/routing/router.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { projectRuntimeActivationRoots } from "../src/workspaces/worktree.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply } from "./helpers.js";

const cleanup: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-deadline-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const cfg = parseConfig({ version: 1, storage: { layout: "legacy", directory: "store" }, brain: { project: "alpha", path: "brain" },
    projects: { alpha: { repositories: { app: { path: "repo" } } }, beta: {} }, repositories: {}, team: { provider_concurrency_enabled: false }, panel: { auto_start: false, port: 9 }, discovery: { interval_minutes: 0 },
    execution: { job_timeout_seconds: 1200 }, profiles: { implement: { mode: "coding", tools: "scoped_edit_and_checks", workspace: "isolated_worktree" } } }, path.join(dir, "config.yaml"));
  const sy = new MeritRouter(cfg, { worker: false, coding: null, supervisor: null, now: () => now });
  cleanup.push(() => sy.close());
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "paused", profile: "implement", repositoryAliases: ["app"], goal: "preserved source", constraints: { acceptanceCriteria: ["done"] }, budget: { maxModelRequests: 17, maxPaidUsd: 0.5, timeoutSeconds: 600 } })], { project: "alpha" });
  sy.db.prepare("UPDATE tasks SET state='interrupted',run_count=1,deadline_at=?,started_at=? WHERE id='paused'").run(now - 1000, now - 120000);
  const recorder = sy.sessions.create({ taskId: "paused", role: "implementer", agentLabel: "fixture", profile: "implement" });
  recorder.end("interrupted", "user_paused");
  const row = sy.tasks.get("paused")!.row;
  const input = { operationId: "continue-1", project: "alpha", taskId: "paused", sessionId: recorder.id,
    expectedDeadlineAt: row.deadline_at!, expectedRunCount: row.run_count, expectedIncarnation: row.lease_incarnation,
    additionalSeconds: 300, reason: "User explicitly resumed the paused trial" };
  return { sy, dir, cfg: sy.projectContext("alpha"), input, now: () => now, advance: (ms: number) => { now += ms; } };
}
it("continues the exact paused task/session once with an audited deadline and unchanged accounting", () => {
  const f = fixture(), { sy, input } = f;
  const execution = sy.admission.createExecution("task", "implement", [{ taskId: "paused", itemId: "paused" }]);
  for (const [id, status, actual] of [["held", "reserved", null], ["billed", "succeeded", 0.04], ["unknown", "uncertain", null]] as const) {
    sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,?,?,?,?,?,?)").run(id, execution, "coding", "fake", status, f.now(), 10, 20);
    sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,?,?)").run(id, "paused", 10, 20);
    sy.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,actual_usd,created_at) VALUES(?,?,?,?,?,?,?)").run(id, "fake", "fake", "fake", 0.1, actual, f.now());
  }
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "execution_members"].map(table => sy.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = accounting(), spec = sy.tasks.get("paused")!.spec;
  const grant = sy.continueTaskExecution(input);
  expect(grant).toMatchObject({ disposition: "fresh", previousDeadlineAt: input.expectedDeadlineAt, deadlineAt: f.now() + 300000 });
  expect(sy.tasks.get("paused")!.row).toMatchObject({ state: "queued", state_reason: "resumed", run_count: 1, lease_owner: null });
  expect(sy.tasks.get("paused")!.spec).toEqual(spec);
  expect(accounting()).toBe(before);
  expect(sy.sessions.get(input.sessionId)).toMatchObject({ status: "interrupted", stopReason: "user_paused" });
  expect(sy.tasks.events("paused").at(-1)).toMatchObject({ type: "resumed", data: { sessionId: input.sessionId } });
  f.advance(10000);
  expect(sy.continueTaskExecution(input)).toEqual({ ...grant, disposition: "replayed" });
  expect(sy.tasks.get("paused")!.row.deadline_at).toBe(grant.deadlineAt);
  expect(() => sy.continueTaskExecution({ ...input, reason: "changed replay" })).toThrow(/replay changed/);
  expect(() => sy.continueTaskExecution({ ...input, operationId: "stack", expectedDeadlineAt: grant.deadlineAt })).toThrow(/already received/);
});
it.each(["foreign", "deadline", "run", "incarnation", "session", "reason", "duration"] as const)("rejects changed %s authority", kind => {
  const { sy, input } = fixture(), changed = { ...input };
  if (kind === "foreign") changed.project = "beta";
  if (kind === "deadline") changed.expectedDeadlineAt--;
  if (kind === "run") changed.expectedRunCount++;
  if (kind === "incarnation") changed.expectedIncarnation = "foreign";
  if (kind === "session") changed.sessionId = "foreign";
  if (kind === "reason") changed.reason = " ";
  if (kind === "duration") changed.additionalSeconds = 601;
  expect(() => sy.continueTaskExecution(changed)).toThrow();
  expect(sy.tasks.get("paused")!.row.deadline_at).toBe(input.expectedDeadlineAt);
});
it.each(["live", "cancelled", "terminal", "unsupported_interruption", "new_session"] as const)("rejects %s state without changing the deadline", kind => {
  const { sy, input } = fixture();
  if (kind === "live") sy.db.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=? WHERE id='paused'").run(Date.now() + 60000);
  if (kind === "cancelled") sy.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='paused'").run();
  if (kind === "terminal") sy.db.prepare("UPDATE tasks SET state='failed' WHERE id='paused'").run();
  if (kind === "unsupported_interruption") sy.db.prepare("UPDATE sessions SET stop_reason='tool_failure' WHERE id=?").run(input.sessionId);
  if (kind === "new_session") { const s = sy.sessions.create({ taskId: "paused", role: "implementer", agentLabel: "new", profile: "implement" }); s.end("interrupted", "user_paused"); }
  expect(() => sy.continueTaskExecution(input)).toThrow();
  expect(sy.tasks.get("paused")!.row.deadline_at).toBe(input.expectedDeadlineAt);
});
it("explicitly continues a recovered dead-owner session after its wall deadline without relabeling its stop or changing budgets", () => {
  const f = fixture(), { sy, input } = f;
  const recorder = sy.sessions.reopen(input.sessionId);
  sy.db.prepare("UPDATE tasks SET state='running',lease_owner='dead-owner',lease_expires_at=? WHERE id='paused'").run(f.now() - 1);
  const spec = sy.tasks.get("paused")!.spec;
  expect(sy.tasks.interrupt("paused", "different-owner", "process_died", input.expectedRunCount)).toBe(false);
  expect(sy.tasks.interrupt("paused", "dead-owner", "process_died", input.expectedRunCount)).toBe(true);
  const recovered = sy.sessions.markDeadRunning(session => session.id !== recorder.id);
  expect(recovered).toHaveLength(1);
  expect(sy.sessions.get(recorder.id)).toMatchObject({ status: "interrupted", stopReason: "process_died" });
  const before = sy.sessions.events(recorder.id, { limit: 10000 });
  const grant = sy.continueTaskExecution({ ...input, reason: "User explicitly continued the retained trial after framework-repair downtime" });
  expect(grant).toMatchObject({ disposition: "fresh", deadlineAt: f.now() + 300000 });
  expect(sy.tasks.get("paused")!.row).toMatchObject({ state: "queued", state_reason: "resumed", run_count: 1, lease_owner: null, lease_expires_at: null });
  expect(sy.tasks.get("paused")!.spec).toEqual(spec);
  expect(sy.sessions.events(recorder.id, { limit: 10000 })).toEqual(before);
  expect(sy.sessions.get(recorder.id)?.stopReason).toBe("process_died");
  expect(() => sy.continueTaskExecution({ ...input, operationId: "stack", expectedDeadlineAt: grant.deadlineAt })).toThrow(/already received/);
});
it.each(["cancel_requested", "failed_deadline"] as const)("never continues recovered process-death work with %s state", state => {
  const { sy, input } = fixture();
  sy.sessions.reopen(input.sessionId);
  sy.sessions.markDeadRunning(session => session.id !== input.sessionId);
  if (state === "cancel_requested") sy.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='paused'").run();
  else sy.db.prepare("UPDATE tasks SET state='failed',state_reason='deadline_exceeded' WHERE id='paused'").run();
  expect(() => sy.continueTaskExecution(input)).toThrow(/without an owner/);
  expect(sy.tasks.get("paused")!.row.deadline_at).toBe(input.expectedDeadlineAt);
});
it("accepts recovered queued work and preserves its named interrupted session", () => {
  const { sy, input } = fixture(); sy.tasks.resume("paused");
  expect(sy.continueTaskExecution(input).disposition).toBe("fresh");
  expect(sy.tasks.events("paused").at(-1)?.data).toEqual({ sessionId: input.sessionId });
});
it("expires ordinary queued work visibly and claims the next legacy task", () => {
  const { sy, input } = fixture(); sy.tasks.resume("paused");
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "next", profile: "implement", goal: "next", constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
  const claimed = sy.tasks.claim("worker", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 });
  expect(claimed.map(task => task.row.id)).toEqual(["next"]);
  expect(sy.tasks.get("paused")!.row).toMatchObject({ state: "failed", state_reason: "deadline_exceeded", deadline_at: input.expectedDeadlineAt });
});
it("settles an expired split FIFO leader before reservation and admits the next task", async () => {
  const f = fixture(), global = openDatabase(path.join(f.dir, "global"), { durability: "full" }), local = openDatabase(path.join(f.dir, "project"), { durability: "full" });
  cleanup.push(() => { local.close(); global.close(); });
  const installation = createCoordinationStoreIdentity(), identity = createProjectStoreIdentity(installation.installationId, "alpha");
  initializeStoreRole(global, installation); initializeStoreRole(local, identity); registerProjectStore(global, identity, path.join(f.dir, "project-owner"));
  const tasks = new TaskStore(local, f.now), grants = new ProjectExecutionGrants(global, () => ({ maxTasks: 1, maxSupervisors: 1, maxWritersPerRepository: 1, projectMaxTasks: null }), f.now);
  const bindings = new ProjectQueueBindings(grants), port = bindings.bindLocal({ identity, cfg: f.cfg, db: local, tasks, assertCurrent: () => {}, assertPinned: () => {} });
  cleanup.push(() => port.drain());
  for (const id of ["expired", "eligible"]) tasks.submit([WorkerTaskSchema.parse({ id, profile: "implement", goal: id, constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
  local.prepare("UPDATE tasks SET deadline_at=?,run_count=1,state_reason='resumed' WHERE id='expired'").run(f.now() - 1);
  const claimed = await port.claimTurn({ owner: "worker" }, [port.hint()!]);
  expect(claimed.map(task => task.row.id)).toEqual(["eligible"]);
  expect(tasks.get("expired")!.row).toMatchObject({ state: "failed", state_reason: "deadline_exceeded" });
  expect(global.prepare("SELECT COUNT(*) n FROM project_execution_grants").get()).toEqual({ n: 1 });
});




function refusedFixture(pendingEdit = false, dispatch?: 'log_request' | 'tool') {
  const f = fixture(), { sy } = f;
  const worktree = path.join(f.cfg.storageDir, 'worktrees', 'retained');
  mkdirSync(worktree, { recursive: true });
  const deadline = f.now() + 300000;
  sy.db.prepare("UPDATE tasks SET state='failed',state_reason=?,run_count=2,deadline_at=?,finished_at=? WHERE id='paused'").run(LEGACY_MUTATION_LOCK_FAILURE, deadline, f.now());
  const native = NativeContinuationSchema.parse({ provider: 'anthropic', routeProvider: 'fixture', baseUrl: 'https://example.test', model: 'fixture', prefixDigest: 'a'.repeat(64), content: [{ type: 'thinking', thinking: 'retained', signature: 'signed-original+/=' }, { type: 'text', text: 'Continue original work' }] });
  const messages: ChatMessage[] = [{ role: 'user', content: 'Original task' }, { role: 'assistant', content: 'Continue original work', nativeContinuation: native }];
  const workspace = { repos: [{ alias: 'app', worktree, baseCommit: 'a'.repeat(40), head: 'b'.repeat(40), branch: null }] };
  if (pendingEdit) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'old-edit', type: 'function', function: { name: 'write_file', arguments: '{}' } }] });
    const beforePause = sy.sessions.reopen(f.input.sessionId);
    beforePause.syncMessages(messages);
    beforePause.setWorkspace(workspace);
    beforePause.toolIntent({ callId: 'old-edit', name: 'write_file', args: {}, sideEffect: 'edit', idempotent: false });
    beforePause.end('interrupted', 'user_paused');
  }
  sy.tasks.event('paused', 'claimed', { owner: 'dead-owner', run: 2 });
  const session = sy.sessions.reopen(f.input.sessionId);
  session.syncMessages(messages);
  session.setWorkspace(workspace);
  if (dispatch === 'tool') session.toolIntent({ callId: 'tool', name: 'unknown-command', args: {}, sideEffect: 'command', idempotent: false });
  if (dispatch === 'log_request') session.append('model_request', { executionId: 'unknown', purpose: 'coding', messageCount: 2, maxTokens: 10, temperature: null, tools: [], toolChoice: null, responseFormat: null });
  session.end('failed', LEGACY_MUTATION_LOCK_FAILURE);
  const input = { ...f.input, operationId: 'infra-recover-1', expectedRunCount: 2, expectedDeadlineAt: deadline };
  const { additionalSeconds: _unused, ...recovery } = input;
  return { ...f, input: recovery, worktree, messages };
}
it('recovers only the exact pre-model lock failure into a linked native session without changing original history or budgets', () => {
  const f = refusedFixture(), { sy, input } = f;
  const before = sy.sessions.events(input.sessionId, { limit: 10000 }), originalSpec = sy.tasks.get('paused')!.spec;
  const receipt = sy.recoverTaskInfrastructureFailure(input);
  expect(receipt).toMatchObject({ disposition: 'fresh', deadlineAt: input.expectedDeadlineAt });
  expect(sy.recoverTaskInfrastructureFailure(input)).toEqual({ ...receipt, disposition: 'replayed' });
  expect(() => sy.recoverTaskInfrastructureFailure({ ...input, reason: 'changed replay' })).toThrow(/replay changed/);
  expect(sy.tasks.get('paused')!.row).toMatchObject({ state: 'queued', run_count: 2, deadline_at: input.expectedDeadlineAt });
  expect(sy.tasks.get('paused')!.spec).toEqual(originalSpec);
  const [claimed] = sy.tasks.claim('new-owner', { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 });
  const resumed = resumeFor({ cfg: f.cfg, tasks: sy.tasks, sessions: sy.sessions }, claimed!);
  expect(resumed?.plan.messages).toEqual(f.messages);
  expect(sy.sessions.transcript(resumed!.session.id)).toEqual(f.messages);
  expect(sy.sessions.get(resumed!.session.id)).toMatchObject({ previousSessionId: input.sessionId, status: 'running' });
  expect(sy.sessions.events(input.sessionId, { limit: 10000 })).toEqual(before);
  expect(sy.sessions.get(input.sessionId)).toMatchObject({ status: 'failed', stopReason: LEGACY_MUTATION_LOCK_FAILURE });
  expect(sy.db.prepare('SELECT COUNT(*) n FROM model_requests').get()).toEqual({ n: 0 });
});
it('leaves prior uncommitted edits to normal commit reconciliation without applying them in the recovery API', () => {
  const f = refusedFixture(true), oldPlan = f.sy.sessions.planResume(f.input.sessionId)!;
  expect(oldPlan.actions).toContainEqual(expect.objectContaining({ kind: 'reconcile_edits', policy: 'commit' }));
  f.sy.recoverTaskInfrastructureFailure(f.input);
  const [claimed] = f.sy.tasks.claim('new-owner', { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 60000 });
  const linked = resumeFor({ cfg: f.cfg, tasks: f.sy.tasks, sessions: f.sy.sessions }, claimed!);
  expect(linked?.plan.actions).toEqual(oldPlan.actions);
  expect(linked?.plan.workspace).toEqual(oldPlan.workspace);
  expect(f.sy.sessions.get(f.input.sessionId)?.status).toBe('failed');
});
it.each(['request', 'uncertain', 'log_request', 'tool', 'different_failure', 'live', 'foreign', 'changed_attempt', 'stale_deadline', 'outside_workspace'] as const)('refuses infrastructure continuation with %s evidence', kind => {
  const f = refusedFixture(false, kind === 'log_request' || kind === 'tool' ? kind : undefined), { sy, input } = f;
  if (kind === 'request' || kind === 'uncertain') {
    const execution = sy.admission.createExecution('task', 'implement', [{ taskId: 'paused', itemId: 'paused' }]);
    sy.db.prepare('INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,?,?,?,?,?,?)').run('new-request', execution, 'coding', 'fake', kind === 'uncertain' ? 'uncertain' : 'reserved', f.now(), 1, 1);
  }
  if (kind === 'different_failure') sy.db.prepare("UPDATE tasks SET state_reason='internal_error: model failed' WHERE id='paused'").run();
  if (kind === 'live') sy.db.prepare("UPDATE tasks SET lease_owner='live',lease_expires_at=? WHERE id='paused'").run(f.now() + 10000);
  if (kind === 'foreign') input.project = 'beta';
  if (kind === 'changed_attempt') input.expectedRunCount++;
  if (kind === 'stale_deadline') input.expectedDeadlineAt--;
  if (kind === 'outside_workspace') sy.db.prepare('UPDATE sessions SET workspace_json=? WHERE id=?').run(JSON.stringify({ repos: [{ alias: 'app', worktree: f.dir, baseCommit: 'a'.repeat(40), head: 'b'.repeat(40), branch: null }] }), input.sessionId);
  expect(() => sy.recoverTaskInfrastructureFailure(input)).toThrow(kind === 'log_request' || kind === 'tool' ? /model or tool dispatch evidence/ : undefined);
  expect(sy.tasks.get('paused')!.row.state).toBe('failed');
});
it('preserves expired infrastructure deadline unless FINAL explicitly grants one bounded execution window', () => {
  const f = refusedFixture(); f.advance(400000);
  expect(() => f.sy.recoverTaskInfrastructureFailure(f.input)).toThrow(/explicit bounded time grant/);
  expect(() => f.sy.recoverTaskInfrastructureFailure({ ...f.input, additionalSeconds: 601 })).toThrow(/exceeds/);
  const result = f.sy.recoverTaskInfrastructureFailure({ ...f.input, additionalSeconds: 600 });
  expect(result.deadlineAt).toBe(f.now() + 600000);
  expect(() => f.sy.recoverTaskInfrastructureFailure({ ...f.input, operationId: 'stack', expectedDeadlineAt: result.deadlineAt, additionalSeconds: 600 })).toThrow();
});
it('classifies typed repository lock refusal as interrupted while cancellation and deadline keep precedence', () => {
  const f = fixture(), err = new RepositoryMutationError('lock_busy', 'retained lock');
  const context = { cfg: f.cfg, now: f.now, deadline: () => f.now() + 10000 };
  expect(classifyFailure(err, new AbortController().signal, context)).toMatchObject({ kind: 'final', state: 'interrupted', stopReason: 'repository_mutation_blocked: lock_busy' });
  expect(classifyFailure(new Error('retained lock'), new AbortController().signal, context)).toMatchObject({ state: 'failed' });
  for (const [reason, state] of [['cancel', 'cancelled'], ['deadline', 'failed']] as const) { const controller = new AbortController(); controller.abort(reason); expect(classifyFailure(err, controller.signal, context)).toMatchObject({ state }); }
});



/** Real fake-route executor fixture; the original low-level deadline fixtures stay unchanged. */
async function executorInfrastructureFixture() {
  const env = makeEnv({ config: baseConfig({ storage: { layout: "legacy", directory: "store" } }) });
  cleanup.push(() => env.cleanup());
  const client = new ScriptedClient(() => reply("Unexpected infrastructure recovery transport")), sy = open(env, client, { worker: false });
  cleanup.push(() => sy.close());
  const [created] = await sy.submitTasks([{ profile: "inspect", goal: "Preserve the retained source", repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/app.ts"] }, routing: { tier: "T1" }, constraints: { acceptanceCriteria: ["identify the retained function"] },
    budget: { maxModelRequests: 17, maxPaidUsd: 0.5, timeoutSeconds: 600 } }]);
  const id = created!.taskId, limits = { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 600000 };
  sy.tasks.claim(sy.owner, limits);
  const root = projectRuntimeActivationRoots(sy.projectContext("demo")).worktrees; mkdirSync(root, { recursive: true });
  const worktree = path.join(root, "retained-infrastructure");
  execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: env.repo, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  const session = sy.sessions.create({ taskId: id, role: "inspector", agentLabel: "retained infrastructure", profile: "inspect", tier: "T1" });
  session.syncMessages([{ role: "user", content: "Retain the original goal" }, { role: "assistant", content: "Retain the original observations" }]);
  session.setWorkspace({ repos: [{ alias: "core", worktree, baseCommit: head, head, branch: null }] });
  session.end("interrupted", "user_paused"); sy.tasks.interrupt(id, sy.owner, "user paused");
  sy.tasks.resume(id, { sessionId: session.id }); sy.tasks.claim(sy.owner, limits);
  const refused = sy.sessions.reopen(session.id); refused.end("failed", LEGACY_MUTATION_LOCK_FAILURE);
  sy.tasks.finish(id, sy.owner, syntheticResult(id, "failed", LEGACY_MUTATION_LOCK_FAILURE), "failed");
  const task = sy.tasks.get(id)!;
  expect(sy.router.plan("inspect", "T1", ["text"]).candidates.length).toBeGreaterThan(0); expect(client.calls).toHaveLength(0);
  const input = { operationId: "executor-infrastructure-recovery", project: "demo", taskId: id, sessionId: session.id,
    expectedDeadlineAt: task.row.deadline_at!, expectedRunCount: task.row.run_count, expectedIncarnation: task.row.lease_incarnation,
    reason: "Recover the exact retained pre-provider infrastructure failure" };
  return { sy, id, input, worktree, limits, client };
}

it.each(["syncMessages", "setWorkspace", "note", "task_event"] as const)("closes and settles infrastructure recovery after its linked %s write fails", async fault => {
  const f = await executorInfrastructureFixture(), { sy, id } = f, original = sy.tasks.get(id)!;
  const history = readFileSync(sy.sessions.get(f.input.sessionId)!.logPath), sourcePath = path.join(f.worktree, "src/app.ts"), source = readFileSync(sourcePath);
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves"].map(table => sy.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = accounting(); sy.recoverTaskInfrastructureFailure(f.input);
  let injected = false;
  const create = SessionStore.prototype.create;
  vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
    const recorder = create.call(this, input);
    if (input.previousSessionId === f.input.sessionId && fault !== "task_event") vi.spyOn(recorder, fault).mockImplementationOnce(() => { injected = true; throw new Error("Transient infrastructure recording failure"); });
    return recorder;
  });
  if (fault === "task_event") {
    const event = sy.tasks.event.bind(sy.tasks);
    vi.spyOn(sy.tasks, "event").mockImplementation((taskId, type, data) => {
      if (!injected && taskId === id && type === "session_resumed") { injected = true; throw new Error("Transient infrastructure task-event failure"); }
      return event(taskId, type, data);
    });
  }
  const [task] = sy.tasks.claim(sy.owner, f.limits);
  const executor = (sy as unknown as { executor: Executor }).executor, gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Broken linked infrastructure recovery reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined(); expect(injected).toBe(true);
  expect(runner).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  const authors = sy.sessions.forTask(id), linked = authors.find(session => session.previousSessionId === f.input.sessionId)!;
  expect(authors).toHaveLength(2); expect(authors.some(session => session.status === "running")).toBe(false);
  expect(linked).toMatchObject({ status: "failed", stopReason: "infrastructure_recovery_recording_failed" });
  expect(sy.sessions.events(linked.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "ended", data: { status: "failed", stopReason: "infrastructure_recovery_recording_failed" } });
  expect(sy.tasks.get(id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy.tasks.get(id)!.spec).toEqual(original.spec); expect(accounting()).toBe(before);
  expect(readFileSync(sy.sessions.get(f.input.sessionId)!.logPath)).toEqual(history); expect(readFileSync(sourcePath)).toEqual(source);
});

it.each(["failedInfrastructureRecovery", "infrastructureRecoveryOperationId"] as const)("fails closed for malformed current infrastructure directive key %s", async key => {
  const f = await executorInfrastructureFixture(), { sy, id } = f, original = sy.tasks.get(id)!;
  const history = readFileSync(sy.sessions.get(f.input.sessionId)!.logPath), source = readFileSync(path.join(f.worktree, "src/app.ts"));
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves"].map(table => sy.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = accounting(); sy.recoverTaskInfrastructureFailure(f.input);
  sy.db.prepare("UPDATE events SET data_json=json_set(data_json,?,0) WHERE task_id=? AND type='resumed'").run(`$.${key}`, id);
  const [task] = sy.tasks.claim(sy.owner, f.limits), executor = (sy as unknown as { executor: Executor }).executor;
  const route = vi.spyOn(TaskRouter.prototype, "prepare"), gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(executor as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode").mockRejectedValue(new Error("Malformed infrastructure recovery reached a runner"));
  await expect(executor.runSingle(task!)).resolves.toBeUndefined();
  expect(runner).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled(); expect(f.client.calls).toHaveLength(0);
  expect(sy.tasks.get(id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: original.row.deadline_at });
  expect(sy.tasks.get(id)!.spec).toEqual(original.spec); expect(accounting()).toBe(before); expect(sy.sessions.forTask(id)).toHaveLength(1);
  expect(readFileSync(sy.sessions.get(f.input.sessionId)!.logPath)).toEqual(history); expect(readFileSync(path.join(f.worktree, "src/app.ts"))).toEqual(source);
});
