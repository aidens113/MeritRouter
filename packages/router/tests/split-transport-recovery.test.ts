import path from "node:path";
import { hostname, tmpdir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Admission } from "../src/admission/admission.js";
import { ProjectRequestLedger } from "../src/admission/project-request-ledger.js";
import { requestAttemptId, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { SqliteRequestAccountingBroker } from "../src/admission/sqlite-accounting-broker.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { ProjectExecutionGrants } from "../src/storage/project-execution-grants.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { releaseOwnerAbsentSlot, SplitRequestSlotSchema } from "../src/gateway/capacity.js";
import { SplitTransportRecovery, type LocalProcessState } from "../src/operations/transport-recovery.js";
import { recoverProjectSettlements } from "../src/admission/project-request-recovery.js";
import { ProjectRequestStore } from "../src/admission/project-request-store.js";
import { RequestReceipts } from "../src/admission/request-receipts.js";
import { deleteProject } from "../src/admin/projects.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

const dbs: Db[] = [], envs: Env[] = [], services: MeritRouter[] = [], repos: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(services.splice(0).map(sy => sy.close()));
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const env of envs.splice(0)) env.cleanup();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  // The large synchronous SQLite matrix must let pending Vitest RPC notifications drain.
  await new Promise<void>(resolve => setImmediate(resolve));
}, 60_000);
const NOW = 1800000000000, ownerFor = (pid = 2147483000) => `${hostname()}:${pid}:abcdef`;
const reason = "Reviewed exact dead local split transport; preserve unknown provider billing";
const GRANTS = JSON.stringify([{ grantId: "33333333-3333-4333-8333-333333333333", nonce: "44444444-4444-4444-8444-444444444444" }]);

/** A split installation fixture: a coordination store, one project store, and one request left in dispatch intent by a dead local owner. */
async function setup(options: { paid?: boolean; owner?: string; active?: boolean; neverAdmitted?: boolean; batched?: boolean } = {}) {
  const env = makeEnv({ config: baseConfig({ repositories: {}, paid: { enabled: true, budgets: { per_week_usd: 5 } }, brain: { path: "brain", project: "alpha" }, projects: { alpha: {} } }) }); envs.push(env);
  const globalDir = path.join(env.dir, "global"), global = openDatabase(globalDir, { durability: "full" }), local = openDatabase(path.join(env.dir, "local"), { durability: "full" }); dbs.push(global, local);
  const coordination = createCoordinationStoreIdentity(), identity = createProjectStoreIdentity(coordination.installationId, "alpha");
  initializeStoreRole(global, coordination); initializeStoreRole(local, identity); registerProjectStore(global, identity, path.join(env.dir, "project"));
  const owner = options.owner ?? ownerFor(), paid = options.paid === true;
  const ids = options.batched ? ["one", "two", "three"] : ["one"];
  const tasks = new TaskStore(local, () => NOW); tasks.submit(ids.map(id => WorkerTaskSchema.parse(summarizeTask({ id }))), { project: "alpha" });
  local.prepare("UPDATE tasks SET state='running',lease_owner=?,lease_expires_at=?,deadline_at=?,run_count=1").run(owner, NOW + 60000, NOW + 60000);
  const admission = new Admission(local, tasks, env.cfg, () => NOW), executionId = admission.createExecution("task", "summarize", ids.map(id => ({ taskId: id, itemId: id })));
  const spend = new PaidSpend(global, env.cfg, new KeyVault(global, globalDir), () => NOW);
  let enabled = !options.neverAdmitted;
  const brokerOptions = { cfg: env.cfg, spend, now: () => NOW, authorize: () => ({ endpointId: "fixture/model", keyRef: paid ? "fixture-key" : null, provider: "fixture", platform: "fixture", enabled, providerUsageScopes: paid ? ["provider:fixture"] : [], paid: paid ? { price: { in: 2, out: 8, cacheWriteIn: null }, maxSearches: 0, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null } : null }) };
  const broker = new SqliteRequestAccountingBroker(global, brokerOptions);
  const leases = ids.map(id => capturedLease(tasks.get(id)!)), lease = leases[0]!;
  const input: ReserveRequestDTO = { requestId: requestAttemptId(NOW), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null, executionId, profile: "summarize", purpose: "test", gatewayModel: options.neverAdmitted ? "direct:fixture/model" : "fixture/model", endpointId: "fixture/model", tier: "T1", estInputTokens: 100, reservedOutputTokens: 30, slot: { id: "fixture-slot", nonce: "fixture-nonce" },
    participants: leases.map(lease => ({ taskId: lease.taskId, leaseOwner: owner, lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 100, reservedOutputTokens: 30 })) };
  if (paid) {
    input.providerReservationId = "fixture-quota"; input.keyRef = "fixture-key";
    global.prepare("INSERT INTO provider_usage(scope,at,tokens,reservation) VALUES(?,?,?,?)").run("provider:fixture", NOW, 130, "fixture-quota");
    input.paid = { key: { ref: "fixture-key", label: "fixture", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null }, provider: "fixture", worstCaseUsd: .1, price: { in: 2, out: 8, cacheWriteIn: null } };
  }
  const grants = new ProjectExecutionGrants(global, () => ({ maxTasks: 4, maxSupervisors: 1, maxWritersPerRepository: 1, projectMaxTasks: 4 }), () => NOW);
  const grant = options.neverAdmitted ? grants.reserve({ grantId: "33333333-3333-4333-8333-333333333333", project: identity, leases, role: "worker", ...(options.batched ? { executionUnit: "completion_batch" as const } : {}), repositoryDigests: [], expiresAt: NOW + 60000 }).grant : null;
  if (grant) grants.consume(grant.ref);
  const slotGrants = grant ? JSON.stringify([grant.ref]) : GRANTS;
  const slotSql = "INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,uncertain,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES(?,'fixture','request','split_holder','one',?,0,?,?,?,?,?,?,?,?,?)";
  global.prepare(slotSql).run("fixture-slot", owner, NOW, NOW, JSON.stringify(leases), "fixture-nonce", 0, identity.projectId, identity.storeId, identity.generation, slotGrants);
  // Unrelated holds: another live split request and an anonymous uncertain hold. Neither may move.
  global.prepare(slotSql).run("other-slot", owner, NOW, NOW, JSON.stringify([lease]), "other-nonce", 0, identity.projectId, identity.storeId, identity.generation, GRANTS);
  global.prepare(slotSql).run("anonymous-slot", owner, NOW, NOW, "[]", "anonymous-nonce", 1, identity.projectId, identity.storeId, identity.generation, GRANTS);
  if (!options.neverAdmitted) global.prepare(`INSERT INTO project_execution_grants(id,nonce,binding_json,project_uuid,store_uuid,store_generation,role,repositories_json,state,expires_at,created_at,updated_at,authority_expires_at)
    VALUES('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','{}',?,?,?,'worker','[]','active',?,?,?,?)`).run(identity.projectId, identity.storeId, identity.generation, NOW + 60000, NOW, NOW, NOW + 60000);
  const ledger = new ProjectRequestLedger(admission, { identity, cfg: env.cfg, broker });
  let reservation;
  if (options.neverAdmitted) {
    // Real pre-admission denial and retirement; never manufacture absence by deleting a physical request.
    await expect(ledger.reserve(input)).rejects.toThrow(); enabled = true;
    const record = new ProjectRequestStore(local, identity, () => NOW).read(input.requestId)!;
    expect(record.row).toMatchObject({ phase: "retired", reason_code: "never_globally_admitted", dispatch_id: null, transport_consumed: 0 });
    expect(broker.readReceipt(input.requestId)).toBeNull(); reservation = record.reservation;
    // Retained historical quarantine caused by the old denial wrapper, preceding its prevention fix.
    global.prepare("UPDATE provider_slots SET uncertain=1 WHERE id='fixture-slot'").run();
    local.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL").run();
    grants.revoke(grant!.ref);
  } else {
    reservation = await ledger.reserve(input);
    await ledger.beginDispatch(reservation, "fixture-dispatch"); ledger.assertDispatch(reservation, "fixture-dispatch");
    if (!options.active) local.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW - 1);
  }
  const project = { identity, db: local, now: () => NOW, recover: (id: string) => new ProjectRequestLedger(admission, { identity, cfg: env.cfg, broker }).recover(id) };
  const recovery = (probe: (pid: number) => LocalProcessState = () => "absent") => new SplitTransportRecovery(global, broker, slug => { if (slug !== "alpha") throw new Error("unknown project"); return project; }, probe);
  const dump = () => ({
    global: Object.fromEntries(["physical_requests", "broker_paid_spend", "provider_slots", "provider_usage", "project_execution_grants", "meta", "events"].map(table => [table, global.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    local: Object.fromEntries(["project_request_protocol", "project_request_holds", "project_request_spend", "model_requests", "request_charges", "tasks", "events"].map(table => [table, local.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  });
  return { global, local, identity, broker, brokerOptions, spend, input, recovery, dump, requestId: input.requestId, project, reservation };
}

it.each([false, true])("releases only a proved never-admitted slot without any accounting or local writes (paid=%s)", async paid => {
  const f = await setup({ neverAdmitted: true, paid }), before = f.dump();
  const inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  expect(inspection).toMatchObject({ eligible: true, action: "release_never_admitted_slot", slotId: "fixture-slot", process: { state: "absent" } });
  const localWrites = f.local.prepare("SELECT total_changes()").pluck().get() as number, globalWrites = f.global.prepare("SELECT total_changes()").pluck().get() as number;
  const receipt = f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha");
  expect(receipt).toMatchObject({ disposition: "fresh", conclusion: "never_globally_admitted", project: "alpha", proof: { basis: "ESRCH" } });
  const after = f.dump();
  expect(after.local).toEqual(before.local);
  expect(after.global).toEqual({ ...before.global, provider_slots: (before.global.provider_slots as Array<{ id: string }>).filter(slot => slot.id !== "fixture-slot"), events: [expect.objectContaining({ task_id: null, project_id: "alpha", type: "never_admitted_slot_released" })] });
  expect(f.broker.readReceipt(f.requestId)).toBeNull();
  expect(f.local.prepare("SELECT total_changes()").pluck().get()).toBe(localWrites);
  expect(f.global.prepare("SELECT total_changes()").pluck().get()).toBe(globalWrites + 2);
  const audit = JSON.parse((after.global.events as Array<{ data_json: string }>)[0]!.data_json);
  for (const privateKey of ["binding_json", "reservation_json", "leases", "participants", "keyRef", "paid", "outcome", "payloadDigest"]) expect(audit).not.toHaveProperty(privateKey);
});

it("replays a committed never-admitted release without reproving a reused PID", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  const input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  const first = f.recovery().releaseNeverAdmitted(input, "alpha"), before = f.dump();
  const probe = vi.spyOn(process, "kill").mockReturnValue(true);
  expect(f.recovery().releaseNeverAdmitted({ ...input, reason: "Another retry reason" }, "alpha")).toEqual({ ...first, disposition: "replayed" });
  expect(probe).not.toHaveBeenCalled(); expect(f.dump()).toEqual(before);
  expect(() => f.recovery().releaseNeverAdmitted({ ...input, expected: "0".repeat(64) }, "alpha")).toThrow(/retry differs/);
  expect(() => f.recovery().releaseNeverAdmitted(input, "foreign")).toThrow(/project/);
});

type Fixture = Awaited<ReturnType<typeof setup>>;
function onImmediate(db: Db, before?: () => void, after?: () => void) {
  const factory = db.transaction.bind(db);
  return vi.spyOn(db, "transaction").mockImplementation(work => {
    const transaction = factory(work);
    return Object.assign((...args: unknown[]) => Reflect.apply(transaction, db, args), {
      default: transaction.default, deferred: transaction.deferred, exclusive: transaction.exclusive,
      immediate: (...args: unknown[]) => { before?.(); const result = Reflect.apply(transaction.immediate, db, args); after?.(); return result; },
    });
  });
}
const neverMutations: Array<[string, (f: Fixture) => void]> = [
  ["preparation phase", f => f.local.prepare("UPDATE project_request_protocol SET phase='prepared'").run()],
  ["retirement reason", f => f.local.prepare("UPDATE project_request_protocol SET reason_code='unknown'").run()],
  ["local dispatch", f => f.local.prepare("UPDATE project_request_protocol SET dispatch_id='prior-dispatch'").run()],
  ["transport consumed", f => f.local.prepare("UPDATE project_request_protocol SET transport_consumed=1").run()],
  ["local receipt", f => f.local.prepare("UPDATE project_request_protocol SET global_receipt_json='{}'").run()],
  ["local outcome", f => f.local.prepare("UPDATE project_request_protocol SET outcome_json='{}',outcome_digest=?").run("a".repeat(64))],
  ["unreadable preparation", f => f.local.prepare("UPDATE project_request_protocol SET binding_json='{'").run()],
  ["changed reservation", f => f.local.prepare("UPDATE project_request_protocol SET reservation_json='{}'").run()],
  ["changed global binding", f => f.local.prepare("UPDATE project_request_protocol SET global_json='{}'").run()],
  ["missing preparation", f => { f.local.prepare("DELETE FROM project_request_holds").run(); f.local.prepare("DELETE FROM project_request_protocol").run(); }],
  ["active preparation hold", f => f.local.prepare("UPDATE project_request_holds SET active=1").run()],
  ["changed preparation hold", f => f.local.prepare("UPDATE project_request_holds SET input_tokens=input_tokens+1").run()],
  ["missing preparation hold", f => f.local.prepare("DELETE FROM project_request_holds").run()],
  ["live task state", f => f.local.prepare("UPDATE tasks SET state='running'").run()],
  ["interrupted task state", f => f.local.prepare("UPDATE tasks SET state='interrupted'").run()],
  ["captured owner retained", f => f.local.prepare("UPDATE tasks SET lease_owner=?").run(f.input.participants[0]!.leaseOwner)],
  ["captured lease retained", f => f.local.prepare("UPDATE tasks SET lease_expires_at=?").run(NOW - 1)],
  ["new task run", f => f.local.prepare("UPDATE tasks SET run_count=run_count+1").run()],
  ["new task incarnation", f => f.local.prepare("UPDATE tasks SET lease_incarnation=?").run("e".repeat(32))],
  ["running session", f => f.local.prepare("INSERT INTO sessions(id,task_id,role,agent_label,status,log_path,created_at,updated_at) VALUES('live','one','worker','fixture','running','unused',?,?)").run(NOW, NOW)],
  ["active grant", f => f.global.prepare("UPDATE project_execution_grants SET state='active'").run()],
  ["reserved grant", f => f.global.prepare("UPDATE project_execution_grants SET state='reserved'").run()],
  ["completed grant", f => f.global.prepare("UPDATE project_execution_grants SET state='completed'").run()],
  ["missing grant", f => f.global.prepare("DELETE FROM project_execution_grants").run()],
  ["changed grant nonce", f => f.global.prepare("UPDATE project_execution_grants SET nonce='55555555-5555-4555-8555-555555555555'").run()],
  ["unreadable grant", f => f.global.prepare("UPDATE project_execution_grants SET binding_json='{}'").run()],
  ["changed grant participant", f => f.global.prepare("UPDATE project_execution_grants SET binding_json=json_set(binding_json,'$.leases[0].runCount',2)").run()],
  ["duplicate grant", f => f.global.prepare("UPDATE provider_slots SET execution_grants_json=json_insert(execution_grants_json,'$[#]',json_extract(execution_grants_json,'$[0]')) WHERE id='fixture-slot'").run()],
  ["changed slot nonce", f => f.global.prepare("UPDATE provider_slots SET nonce='changed' WHERE id='fixture-slot'").run()],
  ["duplicate slot nonce", f => f.global.prepare("UPDATE provider_slots SET nonce='fixture-nonce' WHERE id='other-slot'").run()],
  ["changed slot lease", f => f.global.prepare("UPDATE provider_slots SET lease_json='[]' WHERE id='fixture-slot'").run()],
  ["changed slot participant", f => f.global.prepare("UPDATE provider_slots SET task_id='other' WHERE id='fixture-slot'").run()],
  ["changed direct provider", f => f.global.prepare("UPDATE provider_slots SET platform='other' WHERE id='fixture-slot'").run()],
  ["changed slot project", f => f.global.prepare("UPDATE provider_slots SET project_uuid='other' WHERE id='fixture-slot'").run()],
  ["changed slot store", f => f.global.prepare("UPDATE provider_slots SET store_uuid='other' WHERE id='fixture-slot'").run()],
  ["changed slot generation", f => f.global.prepare("UPDATE provider_slots SET store_generation=2 WHERE id='fixture-slot'").run()],
  ["changed slot uncertainty", f => f.global.prepare("UPDATE provider_slots SET uncertain=0 WHERE id='fixture-slot'").run()],
  ["missing slot", f => f.global.prepare("DELETE FROM provider_slots WHERE id='fixture-slot'").run()],
  ["legacy request key", f => f.global.prepare("INSERT INTO request_protocol_keys(id,expires_at) VALUES(?,?)").run(f.requestId, NOW + 60000)],
  ["local request key", f => f.local.prepare("INSERT INTO request_protocol_keys(id,expires_at) VALUES(?,?)").run(f.requestId, NOW + 60000)],
  ["deletion tombstone", f => f.global.prepare("INSERT INTO request_deletion_tombstones VALUES(?,?,?,'fixture-slot','fixture-nonce',?,?)").run(f.requestId, "a".repeat(64), "b".repeat(64), NOW, NOW + 1)],
  ["foreign tombstone sharing nonce", f => f.global.prepare("INSERT INTO request_deletion_tombstones VALUES(?,?,?,'other-id','fixture-nonce',?,?)").run(requestAttemptId(), "a".repeat(64), "b".repeat(64), NOW, NOW + 1)],
  ["duplicate private preparation", f => { const store = new ProjectRequestStore(f.local, f.identity, () => NOW); store.transaction(() => store.insert({ ...f.input, requestId: requestAttemptId() }, NOW + 60000)); }],
  ["unreadable other preparation", f => { const store = new ProjectRequestStore(f.local, f.identity, () => NOW); store.transaction(() => store.insert({ ...f.input, requestId: requestAttemptId(), slot: { id: "other", nonce: "other" } }, NOW + 60000)); f.local.prepare("UPDATE project_request_protocol SET global_json='{' WHERE request_id!=?").run(f.requestId); }],
  ["retired registration", f => f.global.prepare("UPDATE project_store_registrations SET state='retired',retired_at=?").run(NOW)],
  ["migrating registration", f => f.global.prepare("UPDATE project_store_registrations SET state='migrating'").run()],
  ["changed registered generation", f => f.global.prepare("UPDATE project_store_registrations SET generation=2").run()],
  ["wrong local store manifest", f => f.local.prepare("UPDATE store_identity SET manifest_json=json_set(manifest_json,'$.generation',2)").run()],
  ["unknown slot column", f => f.global.exec("ALTER TABLE provider_slots ADD COLUMN unrecognized_authority TEXT")],
];

it.each(neverMutations)("refuses changed never-admitted proof without writes: %s", async (_name, mutate) => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  mutate(f); const before = f.dump();
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow();
  expect(f.dump()).toEqual(before);
});

it.each(["empty outcome", "schema-invalid private binding", "schema-invalid legacy binding"])("refuses unreadable fresh never-admitted proof: %s", async corruption => {
  const f = await setup({ neverAdmitted: true });
  if (corruption === "empty outcome") f.local.prepare("UPDATE project_request_protocol SET outcome_json='' WHERE request_id=?").run(f.requestId);
  else if (corruption === "schema-invalid private binding") {
    const store = new ProjectRequestStore(f.local, f.identity, () => NOW);
    store.transaction(() => store.insert({ ...f.input, requestId: requestAttemptId() }, NOW + 60000));
    f.local.prepare("UPDATE project_request_protocol SET binding_json='{}',global_json='{}' WHERE request_id!=?").run(f.requestId);
  } else {
    const id = requestAttemptId();
    f.global.prepare("INSERT INTO request_protocol_keys(id,expires_at) VALUES(?,?)").run(id, NOW + 60000);
    f.global.prepare("INSERT INTO request_protocol(request_id,fingerprint,binding_json,reservation_json,state,created_at,expires_at) VALUES(?,?,'{}','{}','reserved',?,?)").run(id, "a".repeat(64), NOW, NOW + 60000);
  }
  const before = f.dump();
  // A stale expected digest would hide this bug: the fresh inspection itself must refuse.
  expect(() => f.recovery().inspectNeverAdmitted(f.requestId, "alpha")).toThrow();
  expect(f.dump()).toEqual(before);
});

it.each(["local model", "global model", "local charge", "global charge", "local project spend", "global project spend", "paid spend", "broker spend"])("refuses fresh never-admitted proof with accounting-only authority: %s", async evidence => {
  const f = await setup({ neverAdmitted: true }), db = evidence.startsWith("local") ? f.local : f.global;
  if (evidence.endsWith("model")) {
    if (db === f.global) db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'task','summarize','completed',?)").run(f.input.executionId, NOW);
    db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES(?,?,? ,?,'reserved',?,100,30,'alpha')")
      .run(f.requestId, f.input.executionId, "test", f.input.gatewayModel, NOW);
  } else {
    // This deliberately inconsistent retained history has a well-formed accounting row but no
    // physical/model parent. Disable FKs only while seeding that anomaly; normal APIs cannot create it.
    db.pragma("foreign_keys=OFF");
    try {
      if (evidence.endsWith("charge")) db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact,lease_incarnation,run_count) VALUES(?,'one',100,30,0,?,1)").run(f.requestId, f.input.participants[0]!.lease.incarnation);
      else if (evidence.endsWith("project spend")) db.prepare("INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd) VALUES(?,'one','alpha',?,1,.1,.1)").run(f.requestId, f.input.participants[0]!.lease.incarnation);
      else if (evidence === "paid spend") db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,created_at) VALUES(?,'fixture-key','fixture','fixture/model',.1,?)").run(f.requestId, NOW);
      else db.prepare("INSERT INTO broker_paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,liability_usd,created_at) VALUES(?,'fixture-key','fixture','fixture/model',.1,.1,?)").run(f.requestId, NOW);
    } finally { db.pragma("foreign_keys=ON"); }
  }
  expect(f.global.prepare("SELECT COUNT(*) FROM physical_requests").pluck().get()).toBe(0);
  const before = f.dump();
  expect(() => f.recovery().inspectNeverAdmitted(f.requestId, "alpha")).toThrow(/authority/);
  expect(f.dump()).toEqual(before);
});

it.each(["live", "EPERM", "EINVAL"])("refuses actual never-admitted owner state %s despite the legacy injected probe", async state => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), before = f.dump();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { if (state === "live") return true; throw Object.assign(new Error(state), { code: state }); });
  expect(f.recovery(() => "absent").inspectNeverAdmitted(f.requestId, "alpha")).toMatchObject({ eligible: false });
  expect(() => f.recovery(() => "absent").releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/live or absence is unknown/);
  expect(kill).toHaveBeenCalled(); expect(f.dump()).toEqual(before);
});

it.each([`${hostname()}-foreign:1234:abcdef`, "unrecognized-owner"])("refuses never-admitted owner %s", async owner => {
  const f = await setup({ neverAdmitted: true, owner }), before = f.dump();
  expect(() => f.recovery().inspectNeverAdmitted(f.requestId, "alpha")).toThrow(/foreign|recognized/);
  expect(f.dump()).toEqual(before);
});

it.each(["receipt", "release", "CAS"])("rolls back never-admitted capacity release and audit when %s fails", async stage => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), before = f.dump();
  if (stage === "receipt") f.global.exec("CREATE TRIGGER fail_never_receipt BEFORE INSERT ON events WHEN NEW.type='never_admitted_slot_released' BEGIN SELECT RAISE(ABORT,'injected audit'); END");
  if (stage === "release") f.global.exec("CREATE TRIGGER ignore_never_release BEFORE DELETE ON provider_slots BEGIN SELECT RAISE(IGNORE); END");
  if (stage === "CAS") vi.spyOn(process, "kill").mockImplementation(() => { f.global.prepare("UPDATE provider_slots SET seen_at=seen_at+1 WHERE id='fixture-slot'").run(); throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(stage === "receipt" ? /injected audit/ : /compare-and-swap/);
  expect(f.dump()).toEqual(before);
});

it.each(["local", "coordination"])("refuses a caller-owned %s transaction", async scope => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), before = f.dump();
  (scope === "local" ? f.local : f.global).transaction(() => {
    expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/top-level/);
  }).immediate();
  expect(f.dump()).toEqual(before);
});

it("rejects caller-supplied proof or force arguments", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), before = f.dump();
  for (const extra of [{ proof: "absent" }, { force: true }]) expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason, ...extra }, "alpha")).toThrow();
  expect(f.dump()).toEqual(before);
});

it("preserves exact inactive paid preparation allocations for a genuine completion batch", async () => {
  const f = await setup({ neverAdmitted: true, paid: true, batched: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), before = f.dump();
  expect(f.local.prepare("SELECT paid_usd FROM project_request_holds").pluck().all()).toEqual([.1 / 3, .1 / 3, .1 / 3]);
  f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha");
  expect(f.dump().local).toEqual(before.local); expect(f.dump().global.provider_usage).toEqual(before.global.provider_usage);
});

function admit(f: Fixture, options: { id?: string; slot?: { id: string; nonce: string }; state?: "reserved" | "dispatch_intent" | "settled" | "retired" | "quarantined" } = {}, broker = f.broker) {
  const record = new ProjectRequestStore(f.local, f.identity, () => NOW).read(f.requestId)!;
  const request = { ...record.global, requestId: options.id ?? f.requestId, slot: options.slot ?? record.global.slot };
  f.global.prepare("UPDATE provider_slots SET uncertain=0,nonce=? WHERE id=?").run(request.slot!.nonce, request.slot!.id);
  const reserved = broker.reserveGlobal(request).receipt, reference = { requestId: request.requestId, fingerprint: reserved.fingerprint };
  if (["dispatch_intent", "settled", "quarantined"].includes(options.state ?? "reserved")) broker.beginDispatchGlobal(reference, "raced-dispatch");
  if (options.state === "settled") broker.settleGlobal({ ...reference, outcomeDigest: "a".repeat(64), outcome: "uncertain", inputTokens: null, outputTokens: null, actualUsd: null, costBasis: "uncertain", errorCode: "unknown" });
  if (options.state === "retired") broker.retireDefinitelyUnsent(reference);
  if (options.state === "quarantined") broker.quarantineUnboundedCost({ ...reference, outcomeDigest: "a".repeat(64), minimumUsd: 0, code: "provider_cost_unknown" });
  f.global.prepare("UPDATE provider_slots SET uncertain=1,nonce='fixture-nonce' WHERE id='fixture-slot'").run();
  return request;
}

it.each(["reserved", "dispatch_intent", "settled", "retired", "quarantined"] as const)("refuses actual physical authority in state %s", async state => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  admit(f, { state }); const before = f.dump();
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/authority/);
  expect(f.dump()).toEqual(before);
});

it.each(["id", "nonce", "provider reservation"])("refuses another admitted request sharing the original slot %s", async collision => {
  const f = await setup({ neverAdmitted: true, paid: collision === "provider reservation" }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  const slot = collision === "id" ? { id: "fixture-slot", nonce: "different" } : { id: "other-slot", nonce: collision === "nonce" ? "fixture-nonce" : "other-nonce" };
  admit(f, { id: requestAttemptId(), slot });
  if (collision === "nonce") f.global.prepare("UPDATE provider_slots SET nonce='other-nonce' WHERE id='other-slot'").run();
  const before = f.dump();
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/authority/);
  expect(f.dump()).toEqual(before);
});

it.each(["missing", "malformed", "duplicate", "tampered", "new slot", "physical conflict"])("refuses never-admitted replay after %s audit/authority", async mutation => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  f.recovery().releaseNeverAdmitted(input, "alpha");
  if (mutation === "missing") f.global.prepare("DELETE FROM events WHERE type='never_admitted_slot_released'").run();
  if (mutation === "malformed") f.global.prepare("UPDATE events SET data_json='{' WHERE type='never_admitted_slot_released'").run();
  if (mutation === "duplicate") f.global.prepare("INSERT INTO events(task_id,project_id,ts,type,data_json) SELECT task_id,project_id,ts,type,data_json FROM events WHERE type='never_admitted_slot_released'").run();
  if (mutation === "tampered") f.global.prepare("UPDATE events SET data_json=json_set(data_json,'$.slotDigest',?) WHERE type='never_admitted_slot_released'").run("0".repeat(64));
  if (mutation === "new slot") f.global.prepare("UPDATE provider_slots SET nonce='fixture-nonce' WHERE id='other-slot'").run();
  if (mutation === "physical conflict") admit(f, { id: requestAttemptId(), slot: { id: "other-slot", nonce: "fixture-nonce" } });
  const before = f.dump();
  expect(() => f.recovery().releaseNeverAdmitted(input, "alpha")).toThrow(); expect(f.dump()).toEqual(before);
});

it.each([null, 7, "invalid"])("refuses schema-invalid never-admitted audit ID %s before release and replay", async requestId => {
  for (const alreadyCommitted of [false, true]) {
    const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
    if (alreadyCommitted) f.recovery().releaseNeverAdmitted(input, "alpha");
    f.global.prepare("INSERT INTO events(task_id,project_id,ts,type,data_json) VALUES(NULL,'alpha',?,'never_admitted_slot_released',?)").run(NOW, JSON.stringify({ requestId }));
    const before = f.dump();
    expect(() => f.recovery().releaseNeverAdmitted(input, "alpha")).toThrow(); expect(f.dump()).toEqual(before);
  }
});

it("does not depend on another project's unrelated private audit during never-admitted release or replay", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  f.global.prepare("INSERT INTO events(task_id,project_id,ts,type,data_json) VALUES(NULL,'foreign',?,'never_admitted_slot_released','{')").run(NOW);
  const first = f.recovery().releaseNeverAdmitted(input, "alpha");
  expect(f.recovery().releaseNeverAdmitted(input, "alpha")).toEqual({ ...first, disposition: "replayed" });
});

it.each([false, true])("validates a real legacy request binding before proving never-admission (collision=%s)", async collision => {
  const f = await setup({ neverAdmitted: true }), input = { ...f.input, requestId: requestAttemptId(NOW), ...(collision ? {} : { slot: { id: "unrelated", nonce: "unrelated" } }) };
  new RequestReceipts(f.local, () => NOW).reserve(input, () => ({ ...f.reservation, requestId: input.requestId }));
  const before = f.dump(), inspect = () => f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  if (collision) expect(inspect).toThrow(/legacy request authority/);
  else expect(inspect()).toMatchObject({ eligible: true });
  expect(f.dump()).toEqual(before);
});

it("proves a genuinely exited never-admitted owner absent with the OS despite an injected live legacy probe", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" }), pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const f = await setup({ neverAdmitted: true, owner: ownerFor(pid) }), recovery = f.recovery(() => "live");
  const inspection = recovery.inspectNeverAdmitted(f.requestId, "alpha");
  expect(inspection).toMatchObject({ eligible: true, process: { pid, state: "absent" } });
  expect(recovery.releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toMatchObject({ disposition: "fresh", proof: { pid, basis: "ESRCH" } });
});

it("takes local then coordination locks and blocks real peer admission and local mutation through commit", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  const peerGlobal = openDatabase(path.dirname(f.global.name), { fileMustExist: true, durability: "full" }), peerLocal = openDatabase(path.dirname(f.local.name), { fileMustExist: true, durability: "full" }); dbs.push(peerGlobal, peerLocal);
  peerGlobal.pragma("busy_timeout=0"); peerLocal.pragma("busy_timeout=0");
  const peerBroker = new SqliteRequestAccountingBroker(peerGlobal, { ...f.brokerOptions, spend: new PaidSpend(peerGlobal, f.brokerOptions.cfg, new KeyVault(peerGlobal, path.dirname(peerGlobal.name)), () => NOW) });
  const record = new ProjectRequestStore(f.local, f.identity, () => NOW).read(f.requestId)!;
  let lockObserved = false;
  vi.spyOn(process, "kill").mockImplementation(() => {
    expect(f.local.inTransaction).toBe(true); expect(f.global.inTransaction).toBe(true);
    expect(() => peerBroker.reserveGlobal(record.global)).toThrow(/locked/);
    expect(() => peerLocal.prepare("UPDATE tasks SET run_count=2 WHERE id='one'").run()).toThrow(/locked/);
    lockObserved = true; throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
  const result = f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha");
  expect(lockObserved).toBe(true); expect(result.disposition).toBe("fresh");
  expect(() => peerBroker.reserveGlobal(record.global)).toThrow(/slot/);
  expect(peerBroker.readReceipt(f.requestId)).toBeNull();
});

it("returns a replay when an identical recovery wins before capability resolution completes", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  let first: ReturnType<SplitTransportRecovery["releaseNeverAdmitted"]> | undefined;
  const competing = new SplitTransportRecovery(f.global, f.broker, () => { first = f.recovery().releaseNeverAdmitted(input, "alpha"); return f.project; });
  expect(competing.releaseNeverAdmitted(input, "alpha")).toEqual({ ...first, disposition: "replayed" });
  expect(f.global.prepare("SELECT COUNT(*) FROM events WHERE type='never_admitted_slot_released'").pluck().get()).toBe(1);
});

it("rechecks authoritative absence when real peer broker admission wins before the coordination lock", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  const peer = openDatabase(path.dirname(f.global.name), { fileMustExist: true, durability: "full" }); dbs.push(peer);
  const broker = new SqliteRequestAccountingBroker(peer, { ...f.brokerOptions, spend: new PaidSpend(peer, f.brokerOptions.cfg, new KeyVault(peer, path.dirname(peer.name)), () => NOW) });
  let raced = false;
  onImmediate(f.global, () => { if (raced) return; raced = true; expect(f.local.inTransaction).toBe(true); admit(f, { id: requestAttemptId(), state: "dispatch_intent" }, broker); });
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/authority/);
  expect(f.global.prepare("SELECT status FROM physical_requests").pluck().all()).toEqual(["dispatch_intent"]);
  expect(f.global.prepare("SELECT uncertain FROM provider_slots WHERE id='fixture-slot'").pluck().get()).toBe(1);
  expect(f.global.prepare("SELECT COUNT(*) FROM events WHERE type='never_admitted_slot_released'").pluck().get()).toBe(0);
});

it("serializes a second recovery at the local lock and lets its retry replay the sole committed audit", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  const peerGlobal = openDatabase(path.dirname(f.global.name), { fileMustExist: true, durability: "full" }), peerLocal = openDatabase(path.dirname(f.local.name), { fileMustExist: true, durability: "full" }); dbs.push(peerGlobal, peerLocal);
  peerGlobal.pragma("busy_timeout=0"); peerLocal.pragma("busy_timeout=0");
  const second = new SplitTransportRecovery(peerGlobal, f.broker, () => ({ ...f.project, db: peerLocal }));
  onImmediate(f.global, () => { expect(f.local.inTransaction).toBe(true); expect(f.global.inTransaction).toBe(false); expect(() => second.releaseNeverAdmitted(input, "alpha")).toThrow(/locked/); });
  const first = f.recovery().releaseNeverAdmitted(input, "alpha");
  expect(second.releaseNeverAdmitted(input, "alpha")).toEqual({ ...first, disposition: "replayed" });
  expect(f.global.prepare("SELECT COUNT(*) FROM events WHERE type='never_admitted_slot_released'").pluck().get()).toBe(1);
});

it("refuses stale local authority acquired before the local lock", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha");
  const peer = openDatabase(path.dirname(f.local.name), { fileMustExist: true, durability: "full" }); dbs.push(peer);
  onImmediate(f.local, () => { peer.prepare("UPDATE tasks SET run_count=2 WHERE id='one'").run(); });
  expect(() => f.recovery().releaseNeverAdmitted({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toThrow(/authority/);
  expect(f.global.prepare("SELECT uncertain FROM provider_slots WHERE id='fixture-slot'").pluck().get()).toBe(1);
});

it("replays a never-admitted commit after the final local lock acknowledgment is lost", async () => {
  const f = await setup({ neverAdmitted: true }), inspection = f.recovery().inspectNeverAdmitted(f.requestId, "alpha"), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason }, before = f.dump();
  const fault = onImmediate(f.local, undefined, () => { throw new Error("lost final ACK"); });
  expect(() => f.recovery().releaseNeverAdmitted(input, "alpha")).toThrow(/lost final ACK/); fault.mockRestore();
  expect(f.dump().local).toEqual(before.local);
  expect(f.recovery().releaseNeverAdmitted(input, "alpha")).toMatchObject({ disposition: "replayed" });
  expect(f.global.prepare("SELECT COUNT(*) FROM events WHERE type='never_admitted_slot_released'").pluck().get()).toBe(1);
});

it("purges the actual never-admitted recovery audit through split project deletion and cannot recreate it", async () => {
  const alpha = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-"))), beta = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-"))); repos.push(alpha, beta);
  const env = makeEnv({ config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" },
    projects: { alpha: { directory: alpha, repositories: {} }, beta: { directory: beta, repositories: {} } } }) }); envs.push(env);
  const client = new ScriptedClient(() => reply("unused")), sy = open(env, client, { worker: false }); services.push(sy);
  await sy.createSplitProject({ slug: "alpha", directory: alpha }); await sy.createSplitProject({ slug: "beta", directory: beta });
  const bundle = sy.projectStores("beta") as ProjectRuntimeBundle, now = Date.now(), owner = ownerFor();
  const [submitted] = await sy.submitTasks([summarizeTask()], { project: "beta" }), taskId = submitted!.taskId;
  bundle.db.prepare("UPDATE tasks SET state='running',lease_owner=?,lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(owner, now + 60000, now + 60000, taskId);
  const lease = capturedLease(bundle.tasks.get(taskId)!), executionId = bundle.admission.createExecution("task", "summarize", [{ taskId, itemId: "one" }]);
  const grants = new ProjectExecutionGrants(sy.db, () => ({ maxTasks: 4, maxSupervisors: 1, maxWritersPerRepository: 1, projectMaxTasks: 4 }));
  const grant = grants.reserve({ grantId: "33333333-3333-4333-8333-333333333333", project: bundle.identity, leases: [lease], role: "worker", repositoryDigests: [], expiresAt: now + 60000 }).grant; grants.consume(grant.ref);
  sy.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES('delete-slot','fixture','request','fixture',?,?,0,?,?,?,'delete-nonce',?,?,?,?)")
    .run(taskId, owner, now, now, JSON.stringify([lease]), bundle.identity.projectId, bundle.identity.storeId, bundle.identity.generation, JSON.stringify([grant.ref]));
  const broker = new SqliteRequestAccountingBroker(sy.db, { cfg: env.cfg, spend: new PaidSpend(sy.db, env.cfg, new KeyVault(sy.db, env.cfg.storageDir)), authorize: () => ({ endpointId: "fixture/model", keyRef: null, provider: "fixture", platform: "fixture", enabled: false, providerUsageScopes: [], paid: null }) });
  const ledger = new ProjectRequestLedger(bundle.admission, { identity: bundle.identity, cfg: bundle.cfg, broker }), requestId = requestAttemptId();
  await expect(ledger.reserve({ requestId, payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null, executionId, profile: "summarize", purpose: "test", gatewayModel: "direct:fixture/model", endpointId: "fixture/model", tier: "T1", estInputTokens: 100, reservedOutputTokens: 30,
    slot: { id: "delete-slot", nonce: "delete-nonce" }, participants: [{ taskId, leaseOwner: owner, lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 100, reservedOutputTokens: 30 }] })).rejects.toThrow();
  sy.db.prepare("UPDATE provider_slots SET uncertain=1 WHERE id='delete-slot'").run(); bundle.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(taskId); grants.revoke(grant.ref);
  const recovery = new SplitTransportRecovery(sy.db, broker, slug => { const b = sy.projectStores(slug) as ProjectRuntimeBundle; return { identity: b.identity, db: b.db, now: () => b.admission.serverNow(), recover: id => b.ledger.recover(id) }; });
  const inspection = recovery.inspectNeverAdmitted(requestId, "beta"), input = { requestId, expected: inspection.snapshotDigest, reason: "private deletion audit reason" };
  recovery.releaseNeverAdmitted(input, "beta");
  sy.db.prepare("INSERT INTO events(task_id,project_id,ts,type,data_json) VALUES(NULL,'alpha',?,'unrelated_audit','{}')").run(now);
  const unrelated = sy.db.prepare("SELECT * FROM events WHERE project_id='alpha'").all();
  expect(sy.db.prepare("SELECT data_json FROM events WHERE type='never_admitted_slot_released'").pluck().get()).toContain(input.reason);
  expect((await deleteProject(sy, "beta", { confirm: "beta" })).problems).toEqual([]);
  expect(sy.db.prepare("SELECT * FROM events WHERE project_id='alpha'").all()).toEqual(unrelated);
  expect(sy.db.prepare("SELECT 1 FROM events WHERE project_id='beta' OR data_json LIKE ?").get(`%${input.reason}%`)).toBeUndefined();
  expect(existsSync(path.join(beta, ".MeritRouter"))).toBe(false);
  expect(() => recovery.releaseNeverAdmitted(input, "beta")).toThrow(); expect(() => recovery.inspectNeverAdmitted(requestId, "beta")).toThrow();
  expect(existsSync(path.join(beta, ".MeritRouter"))).toBe(false); expect(client.requests).toHaveLength(0);
}, 60_000);

it.each([false, true])("settles a dead owner's physical request uncertain, retains accounting and frees its slot exactly once (paid=%s)", async paid => {
  const f = await setup({ paid });
  const before = f.dump(), spendBefore = f.spend.projectAccountingSpendSince(f.identity.projectId, 0);
  const inspection = f.recovery().inspect(f.requestId, "alpha");
  expect(inspection).toMatchObject({ eligible: true, project: "alpha", slotId: "fixture-slot", dispatchId: "fixture-dispatch", process: { state: "absent" } });
  const receipt = await f.recovery().reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha");
  expect(receipt).toMatchObject({ disposition: "fresh", projection: "applied", layout: "split", project: "alpha", slotId: "fixture-slot", proof: { basis: "ESRCH" } });
  expect(f.broker.readReceipt(f.requestId)).toMatchObject({ state: "settled", outcome: "uncertain", inputTokens: null, outputTokens: null, actualUsd: null, costQuarantined: false });
  expect(f.global.prepare("SELECT error_code FROM physical_requests").pluck().get()).toBe("unknown");
  // Exactly the recovered slot is gone; the other live hold, the uncertain hold and every execution grant are untouched.
  expect(f.global.prepare("SELECT id FROM provider_slots ORDER BY id").pluck().all()).toEqual(["anonymous-slot", "other-slot"]);
  const after = f.dump();
  expect(after.global.provider_slots).toEqual((before.global.provider_slots as Array<{ id: string }>).filter(slot => slot.id !== "fixture-slot"));
  expect(after.global.project_execution_grants).toEqual(before.global.project_execution_grants);
  expect(after.global.provider_usage).toEqual(before.global.provider_usage);
  expect(after.local.request_charges).toEqual(before.local.request_charges);
  expect(after.local.tasks).toEqual(before.local.tasks);
  expect(f.local.prepare("SELECT phase FROM project_request_protocol").pluck().get()).toBe("settled");
  expect(f.local.prepare("SELECT status,input_tokens,output_tokens FROM model_requests").get()).toEqual({ status: "uncertain", input_tokens: null, output_tokens: null });
  // Paid: never refunded or reset. The reservation stays counted as liability with an uncertain basis.
  if (paid) {
    const spent = f.global.prepare("SELECT reserved_usd,liability_usd,actual_usd,cost_basis FROM broker_paid_spend").get() as { reserved_usd: number; liability_usd: number; actual_usd: number | null; cost_basis: string };
    expect(spent).toMatchObject({ actual_usd: null, cost_basis: "uncertain" });
    expect(spent.liability_usd).toBeGreaterThanOrEqual(spent.reserved_usd); expect(spent.reserved_usd).toBeGreaterThan(0);
    expect(f.local.prepare("SELECT actual_usd FROM project_request_spend").pluck().get()).toBeNull();
  }
  expect(f.spend.projectAccountingSpendSince(f.identity.projectId, 0)).toBe(spendBefore);
  // Exactly once: a second release of the same slot loses its compare-and-swap; an identical retry replays.
  const slot = SplitRequestSlotSchema.parse((before.global.provider_slots as Array<{ id: string }>).find(row => row.id === "fixture-slot"));
  expect(() => f.global.transaction(() => releaseOwnerAbsentSlot(f.global, slot, receipt.outcomeDigest)).immediate()).toThrow(/compare-and-swap/);
  const settled = f.dump();
  expect(await f.recovery().reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, "alpha")).toEqual({ ...receipt, disposition: "replayed" });
  expect(f.dump()).toEqual(settled);
});

it("replays the committed receipt idempotently without probing a reused PID", async () => {
  const f = await setup();
  const inspection = f.recovery().inspect(f.requestId), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  const first = await f.recovery().reconcile(input), after = f.dump();
  expect(await f.recovery(() => "live").reconcile(input)).toEqual({ ...first, disposition: "replayed" });
  expect(f.dump()).toEqual(after);
  await expect(f.recovery().reconcile({ ...input, expected: "0".repeat(64) })).rejects.toThrow(/retry differs/);
  await expect(f.recovery().reconcile(input, "foreign")).rejects.toThrow(/project/);
  expect(f.dump()).toEqual(after);
});

it.each(["live", "unknown"] as const)("refuses owner probe state %s", async state => {
  const f = await setup();
  const recovery = f.recovery(() => state), inspection = recovery.inspect(f.requestId), before = f.dump();
  expect(inspection).toMatchObject({ eligible: false, refusals: [`local owner process is ${state}`] });
  await expect(recovery.reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason })).rejects.toThrow(/live or absence is unknown/);
  expect(f.dump()).toEqual(before);
});

it("refuses a PID reused after an eligible inspection, and a still-live captured lease", async () => {
  const f = await setup();
  let state: LocalProcessState = "absent";
  const recovery = f.recovery(() => state), inspection = recovery.inspect(f.requestId), before = f.dump();
  expect(inspection.eligible).toBe(true);
  state = "live";
  await expect(recovery.reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason })).rejects.toThrow(/live or absence is unknown/);
  expect(f.dump()).toEqual(before);
  const live = await setup({ active: true }), liveInspection = live.recovery().inspect(live.requestId), liveBefore = live.dump();
  expect(liveInspection).toMatchObject({ eligible: false, activeCapturedLease: true });
  await expect(live.recovery().reconcile({ requestId: live.requestId, expected: liveInspection.snapshotDigest, reason })).rejects.toThrow(/lease remains live/);
  expect(live.dump()).toEqual(liveBefore);
});

it.each([`${hostname()}-foreign:1234:abcdef`, "owner-without-process-identity"])("refuses foreign or unrecognized owner %s", async owner => {
  const f = await setup({ owner }), before = f.dump();
  expect(() => f.recovery().inspect(f.requestId)).toThrow(/foreign|recognized/);
  expect(f.dump()).toEqual(before);
});

it.each(["nonce", "grants", "uncertain", "lease", "missing-slot", "physical-quarantine", "project-outcome", "project-scope"])("refuses stale or mismatched state after inspection: %s", async mutation => {
  const f = await setup();
  const inspection = f.recovery().inspect(f.requestId);
  if (mutation === "nonce") f.global.prepare("UPDATE provider_slots SET nonce='changed' WHERE id='fixture-slot'").run();
  if (mutation === "grants") f.global.prepare("UPDATE provider_slots SET execution_grants_json='[]' WHERE id='fixture-slot'").run();
  if (mutation === "uncertain") f.global.prepare("UPDATE provider_slots SET uncertain=1 WHERE id='fixture-slot'").run();
  if (mutation === "lease") f.global.prepare("UPDATE provider_slots SET lease_json='[]' WHERE id='fixture-slot'").run();
  if (mutation === "missing-slot") f.global.prepare("DELETE FROM provider_slots WHERE id='fixture-slot'").run();
  if (mutation === "physical-quarantine") f.global.prepare("UPDATE physical_requests SET cost_quarantined=1,unexpected_liability_usd=1,quarantine_outcome_sha256=?,accounting_outcome_sha256=?").run("b".repeat(64), "c".repeat(64));
  if (mutation === "project-outcome") f.local.prepare("UPDATE project_request_protocol SET outcome_json=?,outcome_digest=?").run("{}", "d".repeat(64));
  const before = f.dump();
  await expect(f.recovery().reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason }, mutation === "project-scope" ? "foreign" : "alpha")).rejects.toThrow();
  expect(f.dump()).toEqual(before);
});

it.each(["receipt", "release"])("rolls back settlement, release and receipt together when the %s write fails", async stage => {
  const f = await setup({ paid: true });
  const inspection = f.recovery().inspect(f.requestId), before = f.dump();
  if (stage === "receipt") f.global.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON meta WHEN NEW.key LIKE 'transport_owner_reconciled:%' BEGIN SELECT RAISE(ABORT,'injected receipt'); END");
  else f.global.exec("CREATE TRIGGER ignore_release BEFORE DELETE ON provider_slots BEGIN SELECT RAISE(IGNORE); END");
  await expect(f.recovery().reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason })).rejects.toThrow(stage === "receipt" ? /injected receipt/ : /compare-and-swap/);
  expect(f.dump()).toEqual(before);
  expect(f.broker.readReceipt(f.requestId)?.state).toBe("dispatch_intent");
});

it("commits the coordination settlement first and retries a failed project projection on replay", async () => {
  const f = await setup();
  const inspection = f.recovery().inspect(f.requestId), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  f.local.exec("CREATE TRIGGER fail_projection BEFORE UPDATE OF phase ON project_request_protocol BEGIN SELECT RAISE(ABORT,'project store unavailable'); END");
  const first = await f.recovery().reconcile(input);
  expect(first).toMatchObject({ disposition: "fresh", projection: "pending", projectionError: expect.stringContaining("project store unavailable") });
  expect(f.broker.readReceipt(f.requestId)?.state).toBe("settled");
  expect(f.global.prepare("SELECT 1 FROM provider_slots WHERE id='fixture-slot'").get()).toBeUndefined();
  expect(f.local.prepare("SELECT phase FROM project_request_protocol").pluck().get()).toBe("dispatch_intent");
  f.local.exec("DROP TRIGGER fail_projection");
  const { projectionError: _unused, ...committed } = first;
  expect(await f.recovery().reconcile(input)).toEqual({ ...committed, disposition: "replayed", projection: "applied" });
  expect(f.local.prepare("SELECT phase FROM project_request_protocol").pluck().get()).toBe("settled");
});

it("actual CLI inspects and reconciles a split project's dead local transport without any provider calls", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "meritrouter-test-project-"))); repos.push(repo);
  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
  const env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ storage: { directory: ".meritrouter", layout: "split" }, repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: repo, repositories: { app: { path: repo } } } } }) }); envs.push(env);
  const client = new ScriptedClient(() => reply("unused"));
  const sy = open(env, client, { worker: false }); services.push(sy);
  expect(sy.layout).toBe("split");
  await sy.createSplitProject({ slug: "alpha", directory: repo });
  const bundle = sy.projectStores("alpha") as ProjectRuntimeBundle, owner = ownerFor(pid), now = Date.now();
  const [submitted] = await sy.submitTasks([summarizeTask()], { project: "alpha" }), id = submitted!.taskId;
  bundle.db.prepare("UPDATE tasks SET state='running',lease_owner=?,lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(owner, now + 600000, now + 600000, id);
  const lease = capturedLease(bundle.tasks.get(id)!), executionId = bundle.admission.createExecution("task", "summarize", [{ taskId: id, itemId: "1" }]);
  sy.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES('cli-slot','openrouter','request','split_holder',?,?,0,?,?,?,'cli-nonce',?,?,?,?)")
    .run(id, owner, now, now, JSON.stringify([lease]), bundle.identity.projectId, bundle.identity.storeId, bundle.identity.generation, GRANTS);
  const reservation = await bundle.ledger.reserve({ requestId: requestAttemptId(), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null, executionId, profile: "summarize", purpose: "test", gatewayModel: `direct:${endpoint().id}`, endpointId: endpoint().id, tier: "T1", estInputTokens: 100, reservedOutputTokens: 30, slot: { id: "cli-slot", nonce: "cli-nonce" },
    participants: [{ taskId: id, leaseOwner: owner, lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 100, reservedOutputTokens: 30 }] });
  await bundle.ledger.beginDispatch(reservation, "cli-dispatch");
  bundle.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=?").run(now - 1, id);
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const args = [cli, "--config", env.cfg.configPath, "--project", "alpha", "transport"];
  const inspection = JSON.parse((await exec(process.execPath, [...args, "inspect", reservation.requestId, "--json"])).stdout);
  expect(inspection).toMatchObject({ eligible: true, project: "alpha", slotId: "cli-slot", process: { pid, state: "absent" } });
  const decisions = await Promise.all([1, 2].map(() => exec(process.execPath, [...args, "reconcile", reservation.requestId, "--expected", inspection.snapshotDigest, "--reason", reason, "--json"])));
  const results = decisions.map(result => JSON.parse(result.stdout));
  expect(results.map(result => result.disposition).sort()).toEqual(["fresh", "replayed"]);
  expect(results.every(result => result.projection === "applied")).toBe(true);
  const fresh = results.find(result => result.disposition === "fresh")!;
  const repeated = JSON.parse((await exec(process.execPath, [...args, "reconcile", reservation.requestId, "--expected", inspection.snapshotDigest, "--reason", reason, "--json"])).stdout);
  expect(repeated).toEqual({ ...fresh, disposition: "replayed" });
  expect(sy.db.prepare("SELECT status,outcome FROM physical_requests WHERE id=?").get(reservation.requestId)).toEqual({ status: "settled", outcome: "uncertain" });
  expect(sy.db.prepare("SELECT COUNT(*) FROM provider_slots WHERE id='cli-slot'").pluck().get()).toBe(0);
  expect(bundle.db.prepare("SELECT phase FROM project_request_protocol WHERE request_id=?").pluck().get(reservation.requestId)).toBe("settled");
  expect(bundle.db.prepare("SELECT status FROM model_requests WHERE id=?").pluck().get(reservation.requestId)).toBe("uncertain");
  expect(client.requests).toHaveLength(0);
}, 60_000);

it.each(["before its candidate read", "while it waits for the coordination lock"])("returns a replay, not a failure, when an identical recovery commits %s", async point => {
  const f = await setup();
  const inspection = f.recovery().inspect(f.requestId), input = { requestId: f.requestId, expected: inspection.snapshotDigest, reason };
  let winner: Awaited<ReturnType<SplitTransportRecovery["reconcile"]>> | undefined, raced = false;
  // The competing operator's recovery runs its synchronous coordination commit at the injected point.
  const compete = () => { if (raced) return; raced = true; void f.recovery().reconcile(input).then(result => { winner = result; }); };
  const broker = {
    readReceipt: (id: string) => { if (point.startsWith("before")) compete(); return f.broker.readReceipt(id); },
    settleAbsentTransportOwner: (...args: Parameters<typeof f.broker.settleAbsentTransportOwner>) => { compete(); return f.broker.settleAbsentTransportOwner(...args); },
  };
  const project = { identity: f.identity, db: f.local, now: () => NOW, recover: async () => null };
  const loser = await new SplitTransportRecovery(f.global, broker, () => project, () => "absent").reconcile(input);
  await new Promise(resolve => setImmediate(resolve));
  expect(winner).toMatchObject({ disposition: "fresh" });
  expect(loser).toMatchObject({ disposition: "replayed", slotId: "fixture-slot", reason });
  expect(f.global.prepare("SELECT COUNT(*) FROM meta WHERE key LIKE 'transport_owner_reconciled:%'").pluck().get()).toBe(1);
});

// ---------- startup settlement recovery (recoverProjectSettlements) ----------

const settlement = (f: Awaited<ReturnType<typeof setup>>) => recoverProjectSettlements({ db: f.local, identity: f.identity, ledger: { recover: id => f.project.recover(id) }, broker: f.broker, now: () => NOW });
function saveOutcome(f: Awaited<ReturnType<typeof setup>>) {
  const store = new ProjectRequestStore(f.local, f.identity, () => NOW);
  store.transaction(() => store.saveOutcome(store.bound(f.reservation), { kind: "failed", errorKind: "timeout", errorMessage: "durable provider timeout" }));
}

it("settles a durable local outcome once its captured lease is gone, exactly once", async () => {
  const f = await setup({ active: true });
  saveOutcome(f);
  const live = f.dump();
  expect(await settlement(f)).toEqual([]);
  expect(f.dump()).toEqual(live);
  f.local.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW - 1);
  expect(await settlement(f)).toEqual([f.requestId]);
  expect(f.broker.readReceipt(f.requestId)).toMatchObject({ state: "settled", outcome: "failed" });
  expect(f.local.prepare("SELECT phase FROM project_request_protocol").pluck().get()).toBe("settled");
  const settled = f.dump();
  expect(await settlement(f)).toEqual([]);
  expect(f.dump()).toEqual(settled);
});

it("leaves dispatch intent without an outcome, and cost-quarantined requests, to their explicit paths", async () => {
  const f = await setup(), before = f.dump();
  expect(await settlement(f)).toEqual([]);
  expect(f.dump()).toEqual(before);
  saveOutcome(f);
  f.global.prepare("UPDATE physical_requests SET cost_quarantined=1,unexpected_liability_usd=1,quarantine_outcome_sha256=?,accounting_outcome_sha256=?").run("b".repeat(64), "c".repeat(64));
  const quarantined = f.dump();
  expect(await settlement(f)).toEqual([]);
  expect(f.dump()).toEqual(quarantined);
});

it("projects an operator-settled receipt whose project projection was interrupted", async () => {
  const f = await setup();
  const inspection = f.recovery().inspect(f.requestId);
  f.local.exec("CREATE TRIGGER fail_projection BEFORE UPDATE OF phase ON project_request_protocol BEGIN SELECT RAISE(ABORT,'project store unavailable'); END");
  expect(await f.recovery().reconcile({ requestId: f.requestId, expected: inspection.snapshotDigest, reason })).toMatchObject({ projection: "pending" });
  f.local.exec("DROP TRIGGER fail_projection");
  expect(await settlement(f)).toEqual([f.requestId]);
  expect(f.local.prepare("SELECT phase FROM project_request_protocol").pluck().get()).toBe("settled");
});
