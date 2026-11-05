import { afterEach, expect, it } from "vitest";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { Executor } from "../src/core/executor.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId } from "../src/storage/task-leases.js";
import { resumeFor } from "../src/sessions/run-sessions.js";
import { ask, baseResult } from "../src/runners/types.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient } from "./helpers.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const start = Date.now();
  const policy = { source: "synthetic startup fixture", suite_version: "1", metric_scale: "points", rank_metric: "planning", capability_floors: { planning: 70 } };
  const observation = { endpoint_id: "openrouter/vendor/big-a:free", provider: "openrouter", model: "vendor/big-a:free", source_model_id: "fixture", mapping_source: "Exact synthetic fixture route", source: policy.source, source_url: "https://example.invalid/startup", suite_version: "1", metric_scale: "points", checked_at: new Date(start - 1000).toISOString(), expires_at: new Date(start + 300000).toISOString(), metrics: { planning: 80 } };
  const env = makeEnv({ config: baseConfig({ storage: { layout: "legacy", directory: "store" }, profiles: { ...baseConfig().profiles, supervise: { mode: "supervisor", tools: "supervisor", classify: "never", min_total_parameters_b: 100, max_model_requests: 20 } }, supervisor: { job_timeout_seconds: 7200, routing: { minimum_quality: "ranked_capable", ranking_policy: policy, ranking_evidence: [observation] } } }) });
  cleanup.push(() => env.cleanup());
  let now = start;
  const client = new ScriptedClient(() => reply("Live retry reached the fake provider"));
  const sy = open(env, client, { worker: false, panelLifecycle: "passive", now: () => now, supervisor: { run: async ctx => {
    const executionId = ctx.gate.admission.createExecution("task", ctx.spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    await ask(ctx, { executionId, purpose: "supervision", chat: { messages: ctx.resume!.plan.messages, max_tokens: 20 } });
    return { state: "completed", result: baseResult({ executionStatus: "completed", stopReason: "fixture_completed", summary: "Retained supervisor continued" }) };
  } } });
  cleanup.push(() => sy.close());
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "retained", profile: "supervise", goal: "Retained supervisor", constraints: { acceptanceCriteria: ["verified later"] }, budget: { maxModelRequests: 20, maxPaidUsd: 0.5 } })], { project: "demo" });
  const claim = () => sy.tasks.claim(sy.owner, { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 600000 })[0]!;
  const runClaim = (task: ReturnType<typeof claim>) => (sy as unknown as { executor: Executor }).executor.runSingle(task);
  const original = claim(), session = sy.sessions.create({ taskId: "retained", jobId: "retained", role: "supervisor", agentLabel: "retained", profile: "supervise", tier: "T3" });
  session.syncMessages([{ role: "user", content: "Original retained goal" }, { role: "assistant", content: "Retained plan" }]);
  session.end("interrupted", "shutdown");
  const historic = sy.admission.createExecution("task", "supervise", [{ taskId: "retained", itemId: "retained" }]);
  sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES('historic',?,'supervision','fake','uncertain',?,1,1)").run(historic, now);
  sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES('historic','retained',1,1)").run();
  await new SqliteTaskLeases(sy.projectContext("demo"), sy.tasks).interrupt({ lease: capturedLease(original), operationId: leaseOperationId(now), reason: "worker shut down" });
  now += 700000;
  const grant = sy.continueTaskExecution({ operationId: "maintenance", project: "demo", taskId: "retained", sessionId: session.id, expectedDeadlineAt: original.row.deadline_at!, expectedRunCount: original.row.run_count, expectedIncarnation: original.row.lease_incarnation,
    additionalSeconds: 7200, reason: "Resume after framework maintenance", maintenance: { cause: "operator_framework_maintenance", timeoutProvenance: "configured_default", authorizationReference: "Fixture user resumed", noUserHardDeadline: true } });
  const oldMemory = sy.sessions.events(session.id, { limit: 10000 }), oldSpec = sy.tasks.get("retained")!.spec;
  now++;
  const failed = claim();
  await runClaim(failed);
  expect(sy.tasks.get("retained")!.row).toMatchObject({ state: "failed", run_count: 2, deadline_at: grant.deadlineAt });
  expect(sy.tasks.get("retained")!.row.state_reason).toContain("No authorized eligible supervisor endpoint");
  expect(client.requests).toHaveLength(0);
  expect(sy.sessions.forTask("retained")).toHaveLength(1);
  const input = { operationId: "startup-retry", maintenanceOperationId: "maintenance", project: "demo", taskId: "retained", sessionId: session.id,
    expectedDeadlineAt: grant.deadlineAt, expectedRunCount: failed.row.run_count, expectedIncarnation: failed.row.lease_incarnation, reason: "Reviewed ranking refreshed after zero-dispatch startup refusal" };
  const fresh = () => { sy.projectContext("demo").supervisor.routing.ranking_evidence[0]!.expires_at = new Date(now + 86400000).toISOString(); };
  return { sy, client, input, claim, runClaim, oldMemory, oldSpec, grant, fresh, advance: (ms: number) => { now += ms; }, now: () => now };
}

it("retries the real expired-ranking startup once, preserves its maintenance window/history, and dispatches linked retained memory", async () => {
  const f = await fixture(), { sy, input, client } = f;
  expect(() => sy.retryTaskStartup(input)).toThrow(/currently eligible/);
  f.fresh();
  const accounting = () => JSON.stringify(["model_requests", "request_charges", "paid_spend", "budget_requests", "task_request_grants", "project_request_protocol", "project_request_holds", "project_request_spend"].map(t => sy.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before = accounting(), originalGrant = sy.tasks.events("retained").find(e => e.type === "execution_time_continued");
  const retry = sy.retryTaskStartup(input);
  expect(retry).toMatchObject({ disposition: "fresh", deadlineAt: f.grant.deadlineAt, failedClaim: { run: 2 } });
  expect(sy.retryTaskStartup(input)).toEqual({ ...retry, disposition: "replayed" });
  expect(() => sy.retryTaskStartup({ ...input, reason: "changed replay" })).toThrow(/replay changed/);
  expect(() => sy.retryTaskStartup({ ...input, operationId: "stack" })).toThrow();
  expect(sy.tasks.get("retained")!.row).toMatchObject({ state: "queued", run_count: 2, deadline_at: f.grant.deadlineAt });
  expect(sy.tasks.get("retained")!.spec).toEqual(f.oldSpec);
  expect(accounting()).toBe(before);
  expect(sy.tasks.events("retained").find(e => e.type === "execution_time_continued")).toEqual(originalGrant);
  f.advance(1);
  await f.runClaim(f.claim());
  expect(client.requests).toHaveLength(1);
  expect(client.requests[0]!.messages).toEqual([{ role: "user", content: "Original retained goal" }, { role: "assistant", content: "Retained plan" }]);
  expect(sy.tasks.get("retained")!.row).toMatchObject({ state: "completed", run_count: 3, deadline_at: f.grant.deadlineAt });
  expect(sy.sessions.forTask("retained")).toHaveLength(2);
  expect(sy.sessions.forTask("retained").at(-1)).toMatchObject({ previousSessionId: input.sessionId, status: "completed" });
  expect(sy.sessions.events(input.sessionId, { limit: 10000 })).toEqual(f.oldMemory);
});

it.each(["foreign_failure", "changed_spec", "changed_deadline", "wrong_run", "wrong_project", "active_owner", "new_session", "execution", "split_preparation", "expired"] as const)("refuses unsafe startup retry: %s", async kind => {
  const f = await fixture(), { sy, input } = f; f.fresh();
  if (kind === "foreign_failure") sy.db.prepare("UPDATE tasks SET state_reason='other failure' WHERE id='retained'").run();
  if (kind === "changed_spec") sy.db.prepare("UPDATE tasks SET spec_json=json_set(spec_json,'$.goal','changed') WHERE id='retained'").run();
  if (kind === "changed_deadline") input.expectedDeadlineAt++;
  if (kind === "wrong_run") input.expectedRunCount++;
  if (kind === "wrong_project") input.project = "other";
  if (kind === "active_owner") sy.db.prepare("UPDATE tasks SET lease_owner='foreign',lease_expires_at=? WHERE id='retained'").run(f.now() + 10000);
  if (kind === "new_session") sy.sessions.create({ taskId: "retained", role: "supervisor", agentLabel: "other", profile: "supervise" }).end("failed", "not a startup refusal");
  if (kind === "execution") sy.admission.createExecution("task", "supervise", [{ taskId: "retained", itemId: "retained" }]);
  if (kind === "split_preparation") sy.db.prepare("INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at) VALUES('prepared','demo','{}','fingerprint',?,'{}','{}','retired',?,?)")
    .run(JSON.stringify({ participants: [{ taskId: "retained" }] }), f.now(), f.now());
  if (kind === "expired") f.advance(7200001);
  const before = sy.tasks.get("retained")!.row;
  expect(() => sy.retryTaskStartup(input)).toThrow();
  expect(sy.tasks.get("retained")!.row).toEqual(before);
  expect(sy.tasks.events("retained").filter(e => e.type === "maintenance_startup_retried")).toHaveLength(0);
});

it.each(["missing", "changed", "generation"] as const)("rejects %s retry authority before opening a linked session", async kind => {
  const f = await fixture(), { sy, input } = f; f.fresh(); sy.retryTaskStartup(input);
  if (kind === "missing") sy.db.prepare("DELETE FROM events WHERE type='maintenance_startup_retried'").run();
  if (kind === "changed") sy.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.maintenanceDigest',?) WHERE type='maintenance_startup_retried'").run("a".repeat(64));
  const task = f.claim();
  if (kind === "generation") { sy.db.prepare("UPDATE tasks SET run_count=run_count+1 WHERE id='retained'").run(); task.row.run_count++; }
  expect(() => resumeFor({ cfg: sy.projectContext("demo"), tasks: sy.tasks, sessions: sy.sessions }, task)).toThrow();
  expect(sy.sessions.forTask("retained")).toHaveLength(1);
  expect(sy.tasks.get("retained")!.row.deadline_at).toBe(f.grant.deadlineAt);
  expect(f.client.requests).toHaveLength(0);
});
