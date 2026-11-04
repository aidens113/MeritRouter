import path from "node:path";
import { mkdtempSync, rmSync, cpSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId } from "../src/storage/task-leases.js";
import { SessionStore } from "../src/sessions/store.js";
import { TaskStore } from "../src/storage/tasks.js";
import { Gate } from "../src/gateway/gate.js";
import { Executor } from "../src/core/executor.js";
import type { RunContext, RunOutcome } from "../src/runners/types.js";
import { GatewayError } from "../src/core/errors.js";
import { baseConfig, makeEnv, open, ScriptedClient, servedFor, reply, goodOutput } from "./helpers.js";
import { resumeFor, ResumeDirectiveSchema } from "../src/sessions/run-sessions.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(explicitTimeout = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-maintenance-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const cfg = parseConfig({ version: 1, storage: { layout: "legacy", directory: "store" }, brain: { project: "alpha", path: "brain" },
    projects: { alpha: {}, beta: {} }, repositories: {}, team: { provider_concurrency_enabled: false }, panel: { auto_start: false, port: 9 }, discovery: { interval_minutes: 0 },
    execution: { job_timeout_seconds: 600 }, profiles: { inspect: { mode: "read_only" } } }, path.join(dir, "config.yaml"));
  const sy = new MeritRouter(cfg, { worker: false, now: () => now });
  cleanup.push(() => sy.close());
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "retained", profile: "inspect", goal: "Preserved task", constraints: { acceptanceCriteria: ["done"] }, budget: { maxModelRequests: 17, maxPaidUsd: 0.5, ...(explicitTimeout ? { timeoutSeconds: 600 } : {}) } })], { project: "alpha" });
  const [claimed] = sy.tasks.claim("original-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 600000 });
  const session = sy.sessions.create({ taskId: "retained", role: "implementer", agentLabel: "original", profile: "inspect", tier: "T1" });
  session.syncMessages([{ role: "user", content: "Original task" }, { role: "assistant", content: "Retained analysis" }]);
  session.end("interrupted", "shutdown");
  const leases = new SqliteTaskLeases(sy.projectContext("alpha"), sy.tasks);
  await leases.interrupt({ lease: capturedLease(claimed!), operationId: leaseOperationId(now), reason: "worker shut down" });
  now += 700000;
  const row = sy.tasks.get("retained")!.row;
  const input = { operationId: "maintenance-1", project: "alpha", taskId: "retained", sessionId: session.id, expectedDeadlineAt: row.deadline_at!, expectedRunCount: row.run_count, expectedIncarnation: row.lease_incarnation, additionalSeconds: 300,
    reason: "Continue after verified framework maintenance", maintenance: { cause: "operator_framework_maintenance" as const, timeoutProvenance: "configured_default" as const, authorizationReference: "User resumed retained task after framework repairs", noUserHardDeadline: true as const } };
  return { sy, input, cfg: sy.projectContext("alpha"), now: () => now };
}
function claim(f: Awaited<ReturnType<typeof fixture>>) {
  return f.sy.tasks.claim("new-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 600000 })[0]!;
}
it("continues genuine same-task shutdown once, preserves accounting and original memory, and validates the next claim", async () => {
  const f = await fixture(), { sy, input } = f;
  const execution = sy.admission.createExecution("task", "inspect", [{ taskId: "retained", itemId: "retained" }]);
  sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,?,?,?,?,?,?)").run("uncertain", execution, "read_only", "fake", "uncertain", f.now(), 1, 1);
  sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,?,?)").run("uncertain", "retained", 1, 1);
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "execution_members"].map(table => sy.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = accounting(), spec = sy.tasks.get("retained")!.spec, history = sy.sessions.events(input.sessionId, { limit: 10000 });
  const grant = sy.continueTaskExecution(input);
  expect(grant).toMatchObject({ disposition: "fresh", previousDeadlineAt: input.expectedDeadlineAt, deadlineAt: f.now() + 300000 });
  expect(sy.continueTaskExecution(input)).toEqual({ ...grant, disposition: "replayed" });
  expect(() => sy.continueTaskExecution({ ...input, reason: "Changed" })).toThrow(/replay changed/);
  expect(() => sy.continueTaskExecution({ ...input, operationId: "stack", expectedDeadlineAt: grant.deadlineAt })).toThrow(/already received/);
  const resumed = resumeFor({ cfg: f.cfg, tasks: sy.tasks, sessions: sy.sessions }, claim(f));
  expect(resumed?.plan.messages).toEqual([{ role: "user", content: "Original task" }, { role: "assistant", content: "Retained analysis" }]);
  expect(sy.sessions.get(resumed!.session.id)).toMatchObject({ previousSessionId: input.sessionId, status: "running" });
  expect(sy.sessions.events(input.sessionId, { limit: 10000 })).toEqual(history);
  expect(sy.sessions.get(input.sessionId)).toMatchObject({ status: "interrupted", stopReason: "shutdown" });
  expect(sy.tasks.get("retained")!.spec).toEqual(spec);
  expect(accounting()).toBe(before);
});
it.each(["no_opt_in", "explicit_timeout", "wrong_reason", "missing_receipt", "wrong_incarnation", "wrong_run", "wrong_deadline", "wrong_project", "cancelled", "owner", "active_session", "active_request", "live_descendant", "changed_session_log", "oversized_grant"] as const)("refuses unsafe maintenance continuation: %s", async kind => {
  const f = await fixture(kind === "explicit_timeout"), { sy, input } = f;
  if (kind === "no_opt_in") delete (input as Partial<typeof input>).maintenance;
  if (kind === "wrong_reason") sy.db.prepare("UPDATE tasks SET state_reason='tool failure' WHERE id='retained'").run();
  if (kind === "missing_receipt") sy.db.prepare("DELETE FROM task_lease_operations").run();
  if (kind === "wrong_incarnation") input.expectedIncarnation = "different";
  if (kind === "wrong_run") input.expectedRunCount++;
  if (kind === "wrong_deadline") input.expectedDeadlineAt--;
  if (kind === "wrong_project") input.project = "beta";
  if (kind === "cancelled") sy.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='retained'").run();
  if (kind === "owner") sy.db.prepare("UPDATE tasks SET lease_owner='foreign',lease_expires_at=? WHERE id='retained'").run(f.now()+10000);
  if (kind === "active_session") sy.sessions.create({ taskId: "retained", role: "reviewer", agentLabel: "active", profile: "inspect" });
  if (kind === "active_request") {
    const execution = sy.admission.createExecution("task", "inspect", [{ taskId: "retained", itemId: "retained" }]);
    sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES(?,?,?,?,?,?,?,?)").run("held", execution, "read_only", "fake", "reserved", f.now(), 1, 1);
    sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,?,?)").run("held", "retained", 1, 1);
  }
  if (kind === "live_descendant") {
    sy.tasks.submit([WorkerTaskSchema.parse({ id: "child", parentTaskId: "retained", profile: "inspect", goal: "Child", constraints: { acceptanceCriteria: ["done"] } })], { project: "alpha" });
    sy.db.prepare("UPDATE tasks SET state='running',lease_owner='child-owner',lease_expires_at=? WHERE id='child'").run(f.now()+10000);
  }
  if (kind === "changed_session_log") sy.db.prepare("UPDATE sessions SET stop_reason='process_died' WHERE id=?").run(input.sessionId);
  if (kind === "oversized_grant") input.additionalSeconds = 601;
  const before = sy.tasks.get("retained")!.row.deadline_at;
  expect(() => sy.continueTaskExecution(input)).toThrow();
  expect(sy.tasks.get("retained")!.row.deadline_at).toBe(before);
});
it.each(["missing_receipt", "tampered_receipt", "wrong_generation", "cancelled", "changed_memory", "malformed_directive", "removed_directive", "plain_directive"] as const)("fails before resumed-session creation when %s changes after grant", async kind => {
  const f = await fixture(), { sy, input } = f;
  sy.continueTaskExecution(input);
  if (kind === "missing_receipt") sy.db.prepare("DELETE FROM events WHERE type='execution_time_continued'").run();
  if (kind === "tampered_receipt") sy.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.maintenanceProof.taskSpecDigest',?) WHERE type='execution_time_continued'").run("a".repeat(64));
  if (kind === "malformed_directive") sy.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.freshWorkspace',1) WHERE type='resumed'").run();
  if (kind === "removed_directive") sy.db.prepare("DELETE FROM events WHERE type='resumed'").run();
  if (kind === "plain_directive") sy.db.prepare("UPDATE events SET data_json=? WHERE type='resumed'").run(JSON.stringify({ sessionId: input.sessionId }));
  const task = claim(f);
  if (kind === "wrong_generation") { sy.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id='retained'").run(); task.row.run_count++; }
  if (kind === "cancelled") { sy.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='retained'").run(); task.row.cancel_requested = 1; }
  if (kind === "changed_memory") sy.db.prepare("UPDATE sessions SET agent_label='tampered' WHERE id=?").run(input.sessionId);
  const count = sy.sessions.forTask("retained").length;
  expect(() => resumeFor({ cfg: f.cfg, tasks: sy.tasks, sessions: sy.sessions }, task)).toThrow();
  expect(sy.sessions.forTask("retained")).toHaveLength(count);
});
it("rejects mixed maintenance/recovery resume authority", () => {
  expect(ResumeDirectiveSchema.safeParse({ sessionId: "old", maintenanceContinuation: true, maintenanceOperationId: "op", blockedJobContinuation: true, blockedJobOperationId: "other" }).success).toBe(false);
});

it.each([["legacy", "valid"], ["split", "valid"], ["split", "missing_receipt"], ["split", "missing_directive"], ["split", "resume_io_failure"], ["split", "resume_messages_failure"], ["split", "resume_workspace_failure"], ["split", "resume_note_failure"], ["split", "resume_task_event_failure"]] as const)("real %s SDK shutdown and %s maintenance resume preserve dispatch authority", async (layout, scenario) => {
  const env = makeEnv({ config: baseConfig({ storage: { directory: "store", layout: "legacy" }, execution: { max_concurrent_tasks: 1, lease_seconds: 30, job_timeout_seconds: 600 } }) });
  cleanup.push(() => env.cleanup());
  let projectDirectory = env.repo;
  if (layout === "split") {
    projectDirectory = mkdtempSync(path.join(tmpdir(), "mr-maintenance-project-"));
    cleanup.push(() => rmSync(projectDirectory, { recursive: true, force: true }));
    cpSync(env.repo, projectDirectory, { recursive: true });
  }
  if (layout === "split") env.cfg = parseConfig(baseConfig({ storage: { directory: "coordination", layout: "split" }, repositories: {}, brain: { path: "brain", project: "demo" }, projects: { demo: { directory: projectDirectory, repositories: { core: { path: projectDirectory } } } }, execution: { max_concurrent_tasks: 1, lease_seconds: 30, job_timeout_seconds: 600 } }), env.cfg.configPath);
  let offset = 0, sy: MeritRouter, hung = false;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const tool = (name: string, args: unknown, id: string) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const client = new ScriptedClient((req, _n, signal) => {
    const served = servedFor(sy, req);
    const read = req.messages.some(message => message.role === "tool" && message.content.startsWith("ref: core:src/app.ts"));
    if (!read) return reply(null, { ...served, toolCalls: [tool("read_file", { alias: "core", path: "src/app.ts" }, "read")] });
    if (!hung) { hung = true; started(); return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new GatewayError("aborted", "shutdown drained request")))); }
    return reply(null, { ...served, toolCalls: [tool("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"), "submit")] });
  });
  sy = open(env, client, { worker: true, now: () => Date.now() + offset });
  cleanup.push(() => sy.close());
  if (layout === "split") await sy.createSplitProject({ slug: "demo", directory: projectDirectory });
  const workspaceHead = scenario === "resume_workspace_failure" ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDirectory, encoding: "utf8" }).trim() : null;
  const originalCreate = SessionStore.prototype.create;
  // Read-only runs need no workspace pointer by default. Record this fixture's real source
  // while its original author is running so the later workspace-copy fault is reachable.
  const recordWorkspace = workspaceHead ? vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
    const recorder = originalCreate.call(this, input);
    if (input.profile === "inspect" && input.role !== "classifier" && !input.previousSessionId)
      recorder.setWorkspace({ repos: [{ alias: "core", worktree: projectDirectory, baseCommit: workspaceHead, head: workspaceHead, branch: "main" }] });
    return recorder;
  }) : null;
  const [submitted] = await sy.submitTasks([{ profile: "inspect", goal: "Locate add", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["names the file"] } }]);
  await entered;
  recordWorkspace?.mockRestore();
  await sy.close();
  offset = 700000;
  sy = open(env, client, { worker: false, now: () => Date.now() + offset });
  const stores = layout === "split" ? sy.projectStores("demo") : sy;
  const task = stores.tasks.get(submitted!.taskId)!, session = stores.sessions!.forTask(task.row.id).find(value => value.role !== "classifier")!;
  expect(task.row).toMatchObject({ state: "interrupted", state_reason: "worker shut down", lease_owner: null });
  expect(session).toMatchObject({ status: "interrupted", stopReason: "shutdown" });
  if (workspaceHead) expect(session.workspace?.repos).toEqual([{ alias: "core", worktree: projectDirectory, baseCommit: workspaceHead, head: workspaceHead, branch: "main" }]);
  const original = stores.sessions!.events(session.id, { limit: 10000 });
  const used = (stores.db.prepare("SELECT COUNT(*) n FROM request_charges WHERE task_id=?").get(task.row.id) as { n: number }).n;
  const continued = sy.continueTaskExecution({ operationId: "real-sdk-maintenance", project: "demo", taskId: task.row.id, sessionId: session.id, expectedDeadlineAt: task.row.deadline_at!, expectedRunCount: task.row.run_count, expectedIncarnation: task.row.lease_incarnation, additionalSeconds: 300, reason: "User resumed after maintenance", maintenance: { cause: "operator_framework_maintenance", timeoutProvenance: "configured_default", authorizationReference: "Test operator resume", noUserHardDeadline: true } });
  expect((stores.db.prepare("SELECT COUNT(*) n FROM request_charges WHERE task_id=?").get(task.row.id) as { n: number }).n).toBe(used);
  if (scenario === "missing_receipt") stores.db.prepare("DELETE FROM events WHERE task_id=? AND type='execution_time_continued'").run(task.row.id);
  if (scenario === "missing_directive") stores.db.prepare("UPDATE events SET data_json=? WHERE task_id=? AND type='resumed'").run(JSON.stringify({ sessionId: session.id }), task.row.id);
  const requestsBeforeResume = client.requests.length, source = readFileSync(path.join(projectDirectory, "src/app.ts"));
  const accountingTables = ["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "job_budget_carves", "project_request_protocol", "project_request_holds", "project_request_spend"];
  const accounting = JSON.stringify(accountingTables.map(table => stores.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const postCreateFailure = scenario === "resume_messages_failure" || scenario === "resume_workspace_failure" || scenario === "resume_note_failure" || scenario === "resume_task_event_failure";
  let injected = false;
  await sy.close();
  if (scenario === "resume_io_failure") {
    const originalCreate = SessionStore.prototype.create;
    let injected = false;
    const create = vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
      if (!injected && input.previousSessionId === session.id) {
        injected = true;
        throw new Error("Injected retained author session I/O failure");
      }
      return originalCreate.call(this, input);
    });
    cleanup.push(() => create.mockRestore());
  }
  if (postCreateFailure) {
    const originalCreate = SessionStore.prototype.create;
    vi.spyOn(SessionStore.prototype, "create").mockImplementation(function (this: SessionStore, input) {
      const recorder = originalCreate.call(this, input);
      if (input.previousSessionId === session.id && scenario !== "resume_task_event_failure") {
        const method = scenario === "resume_messages_failure" ? "syncMessages" : scenario === "resume_workspace_failure" ? "setWorkspace" : "note";
        vi.spyOn(recorder, method).mockImplementationOnce(() => { injected = true; throw new Error("Transient maintenance recording failure"); });
      }
      return recorder;
    });
    if (scenario === "resume_task_event_failure") {
      const originalEvent = TaskStore.prototype.event;
      vi.spyOn(TaskStore.prototype, "event").mockImplementation(function (this: TaskStore, id, type, data) {
        if (!injected && id === task.row.id && type === "session_resumed") { injected = true; throw new Error("Transient maintenance task-event failure"); }
        return originalEvent.call(this, id, type, data);
      });
    }
  }
  const gate = vi.spyOn(Gate.prototype, "request");
  const runner = vi.spyOn(Executor.prototype as unknown as { runMode: (ctx: RunContext) => Promise<RunOutcome> }, "runMode");
  sy = open(env, client, { worker: true, now: () => Date.now() + offset });
  const result = await sy.awaitResults([task.row.id], { timeoutSeconds: 30 });
  if (scenario !== "valid") {
    expect(result.completed[0]).toMatchObject({ executionStatus: "failed" });
    const failedStores = layout === "split" ? sy.projectStores("demo") : sy;
    expect(client.requests).toHaveLength(requestsBeforeResume); expect(gate).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
    if (postCreateFailure) expect(injected).toBe(true);
    const authors = failedStores.sessions!.forTask(task.row.id).filter(value => value.role !== "classifier");
    expect(authors).toHaveLength(postCreateFailure ? 2 : 1); expect(authors.some(value => value.status === "running")).toBe(false);
    if (postCreateFailure) {
      const linked = authors.find(value => value.previousSessionId === session.id)!;
      expect(linked).toMatchObject({ status: "failed", stopReason: "maintenance_continuation_recording_failed" });
      expect(failedStores.sessions!.events(linked.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "ended", data: { status: "failed", stopReason: "maintenance_continuation_recording_failed" } });
    }
    expect(failedStores.tasks.get(task.row.id)!.row).toMatchObject({ state: "failed", lease_owner: null, lease_expires_at: null, deadline_at: continued.deadlineAt });
    expect(failedStores.tasks.get(task.row.id)!.spec).toEqual(task.spec);
    expect(JSON.stringify(accountingTables.map(table => failedStores.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).toBe(accounting);
    expect(readFileSync(path.join(projectDirectory, "src/app.ts"))).toEqual(source);
    expect(failedStores.sessions!.events(session.id, { limit: 10000 })).toEqual(original);
    return;
  }
  expect(result.completed[0]).toMatchObject({ executionStatus: "completed", stopReason: "worker_submitted" });
  const resumedStores = layout === "split" ? sy.projectStores("demo") : sy;
  expect(resumedStores.sessions!.events(session.id, { limit: 10000 })).toEqual(original);
  expect(resumedStores.sessions!.forTask(task.row.id).filter(value => value.role !== "classifier")).toHaveLength(2);
  expect((resumedStores.db.prepare("SELECT COUNT(*) n FROM request_charges WHERE task_id=?").get(task.row.id) as { n: number }).n).toBeGreaterThan(used);
}, 60000);

it.each(["pending", "running", "uncertain", "quiesced_uncertain"] as const)("requires resolved or host-quiesced command history: %s", async status => {
  const f = await fixture(), { sy, input } = f;
  const action = { id: "action", project: "alpha", taskId: "retained", status: status === "quiesced_uncertain" ? "uncertain" : status, ...(status === "quiesced_uncertain" ? { quiescedAt: f.now() - 1 } : {}) };
  sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run("action", "alpha", "retained", "action", JSON.stringify(action), f.now());
  if (status === "quiesced_uncertain") {
    expect(sy.continueTaskExecution(input).disposition).toBe("fresh");
    expect(JSON.parse((sy.db.prepare("SELECT value_json FROM worker_action_requests WHERE id='action'").get() as { value_json: string }).value_json)).toEqual(action);
  } else expect(() => sy.continueTaskExecution(input)).toThrow(/command actions/);
});
it.each(["prepared", "bound", "dispatch_intent", "uncertain", "quarantined"] as const)("refuses split protocol authority before a model-request projection exists: %s", async phase => {
  const f = await fixture(), { sy, input } = f;
  sy.db.prepare("INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at) VALUES('prepared','alpha','{}','fingerprint','{}','{}','{}',?,?,?)").run(phase, f.now(), f.now());
  sy.db.prepare("INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd) VALUES('prepared','retained','alpha',?,?,1,1,0)").run(input.expectedIncarnation, input.expectedRunCount);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  expect(() => sy.continueTaskExecution(input)).toThrow(/split request authority/);
  expect(sy.tasks.get("retained")!.row.deadline_at).toBe(input.expectedDeadlineAt);
});

it("refuses active merge authority before granting time", async () => {
  const { sy, input, now } = await fixture();
  sy.db.prepare("INSERT INTO merge_queue(id,job_id,task_id,kind,repo_alias,branch,lock_key,integration_worktree,source_base,source_head,commits_json,state,created_at,updated_at) VALUES('merge','retained','retained','task','app','branch','lock','worktree','base','head','[]','queued',?,?)").run(now(), now());
  expect(() => sy.continueTaskExecution(input)).toThrow(/active integration/);
});
