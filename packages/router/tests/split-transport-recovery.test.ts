import path from "node:path";
import { hostname, tmpdir } from "node:os";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { releaseOwnerAbsentSlot, SplitRequestSlotSchema } from "../src/gateway/capacity.js";
import { SplitTransportRecovery, type LocalProcessState } from "../src/operations/transport-recovery.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

const dbs: Db[] = [], envs: Env[] = [], services: MeritRouter[] = [], repos: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(sy => sy.close()));
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const env of envs.splice(0)) env.cleanup();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
}, 60_000);
const NOW = 1800000000000, ownerFor = (pid = 2147483000) => `${hostname()}:${pid}:abcdef`;
const reason = "Reviewed exact dead local split transport; preserve unknown provider billing";
const GRANTS = JSON.stringify([{ grantId: "33333333-3333-4333-8333-333333333333", nonce: "44444444-4444-4444-8444-444444444444" }]);

/** A split installation fixture: a coordination store, one project store, and one request left in dispatch intent by a dead local owner. */
async function setup(options: { paid?: boolean; owner?: string; active?: boolean } = {}) {
  const env = makeEnv({ config: baseConfig({ repositories: {}, paid: { enabled: true, budgets: { per_week_usd: 5 } }, brain: { path: "brain", project: "alpha" }, projects: { alpha: {} } }) }); envs.push(env);
  const globalDir = path.join(env.dir, "global"), global = openDatabase(globalDir, { durability: "full" }), local = openDatabase(path.join(env.dir, "local"), { durability: "full" }); dbs.push(global, local);
  const coordination = createCoordinationStoreIdentity(), identity = createProjectStoreIdentity(coordination.installationId, "alpha");
  initializeStoreRole(global, coordination); initializeStoreRole(local, identity); registerProjectStore(global, identity, path.join(env.dir, "project"));
  const owner = options.owner ?? ownerFor(), paid = options.paid === true;
  const tasks = new TaskStore(local, () => NOW); tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "one" }))], { project: "alpha" });
  local.prepare("UPDATE tasks SET state='running',lease_owner=?,lease_expires_at=?,deadline_at=?,run_count=1 WHERE id='one'").run(owner, NOW + 60000, NOW + 60000);
  const admission = new Admission(local, tasks, env.cfg, () => NOW), executionId = admission.createExecution("task", "summarize", [{ taskId: "one", itemId: "one" }]);
  const spend = new PaidSpend(global, env.cfg, new KeyVault(global, globalDir), () => NOW);
  const broker = new SqliteRequestAccountingBroker(global, { cfg: env.cfg, spend, now: () => NOW, authorize: () => ({ endpointId: "fixture/model", keyRef: paid ? "fixture-key" : null, provider: "fixture", platform: "fixture", enabled: true, providerUsageScopes: paid ? ["provider:fixture"] : [], paid: paid ? { price: { in: 2, out: 8, cacheWriteIn: null }, maxSearches: 0, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null } : null }) });
  const lease = capturedLease(tasks.get("one")!);
  const input: ReserveRequestDTO = { requestId: requestAttemptId(NOW), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null, executionId, profile: "summarize", purpose: "test", gatewayModel: "fixture/model", endpointId: "fixture/model", tier: "T1", estInputTokens: 100, reservedOutputTokens: 30, slot: { id: "fixture-slot", nonce: "fixture-nonce" },
    participants: [{ taskId: "one", leaseOwner: owner, lease, budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 100, reservedOutputTokens: 30 }] };
  if (paid) {
    input.providerReservationId = "fixture-quota"; input.keyRef = "fixture-key";
    global.prepare("INSERT INTO provider_usage(scope,at,tokens,reservation) VALUES(?,?,?,?)").run("provider:fixture", NOW, 130, "fixture-quota");
    input.paid = { key: { ref: "fixture-key", label: "fixture", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null }, provider: "fixture", worstCaseUsd: .1, price: { in: 2, out: 8, cacheWriteIn: null } };
  }
  const slotSql = "INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,uncertain,project_uuid,store_uuid,store_generation,execution_grants_json) VALUES(?,'fixture','request','split_holder','one',?,0,?,?,?,?,?,?,?,?,?)";
  global.prepare(slotSql).run("fixture-slot", owner, NOW, NOW, JSON.stringify([lease]), "fixture-nonce", 0, identity.projectId, identity.storeId, identity.generation, GRANTS);
  // Unrelated holds: another live split request and an anonymous uncertain hold. Neither may move.
  global.prepare(slotSql).run("other-slot", owner, NOW, NOW, JSON.stringify([lease]), "other-nonce", 0, identity.projectId, identity.storeId, identity.generation, GRANTS);
  global.prepare(slotSql).run("anonymous-slot", owner, NOW, NOW, "[]", "anonymous-nonce", 1, identity.projectId, identity.storeId, identity.generation, GRANTS);
  global.prepare(`INSERT INTO project_execution_grants(id,nonce,binding_json,project_uuid,store_uuid,store_generation,role,repositories_json,state,expires_at,created_at,updated_at,authority_expires_at)
    VALUES('33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','{}',?,?,?,'worker','[]','active',?,?,?,?)`).run(identity.projectId, identity.storeId, identity.generation, NOW + 60000, NOW, NOW, NOW + 60000);
  const ledger = new ProjectRequestLedger(admission, { identity, cfg: env.cfg, broker });
  const reservation = await ledger.reserve(input);
  await ledger.beginDispatch(reservation, "fixture-dispatch"); ledger.assertDispatch(reservation, "fixture-dispatch");
  if (!options.active) local.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW - 1);
  const project = { identity, db: local, now: () => NOW, recover: (id: string) => new ProjectRequestLedger(admission, { identity, cfg: env.cfg, broker }).recover(id) };
  const recovery = (probe: (pid: number) => LocalProcessState = () => "absent") => new SplitTransportRecovery(global, broker, slug => { if (slug !== "alpha") throw new Error("unknown project"); return project; }, probe);
  const dump = () => ({
    global: Object.fromEntries(["physical_requests", "broker_paid_spend", "provider_slots", "provider_usage", "project_execution_grants", "meta"].map(table => [table, global.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    local: Object.fromEntries(["project_request_protocol", "project_request_holds", "project_request_spend", "model_requests", "request_charges", "tasks", "events"].map(table => [table, local.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  });
  return { global, local, identity, broker, spend, input, recovery, dump, requestId: input.requestId };
}

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
