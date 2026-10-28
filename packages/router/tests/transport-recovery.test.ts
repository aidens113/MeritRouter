import { afterEach, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MeritRouter } from "../src/core/service.js";
import { TransportRecovery, localProcessState } from "../src/operations/transport-recovery.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { ProviderLimits } from "../src/providers/limits.js";
import { requestAttemptId, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { RequestReceipts } from "../src/admission/request-receipts.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const exec = promisify(execFile);
const ownerFor = (pid = 2147483000) => `${hostname()}:${pid}:abcdef`;
const reason = "Reviewed exact dead local transport; preserve unknown provider billing";
async function fixture(options: { paid?: boolean; owner?: string; active?: boolean } = {}) {
  env = makeEnv({ config: baseConfig({ team: { provider_concurrency_start: 4, provider_concurrency_max: 4 }, paid: { enabled: true, budgets: { per_week_usd: 5 } } }) });
  const client = new ScriptedClient(() => reply("unused"));
  sy = open(env, client, { worker: false });
  const owner = options.owner ?? ownerFor();
  const [submitted] = await sy.submitTasks([summarizeTask()]);
  const id = submitted!.taskId;
  sy.tasks.claim(owner, { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60_000, defaultTimeoutMs: 60_000 });
  const lease = capturedLease(sy.tasks.get(id)!);
  const slot = sy.health.capacity.tryAcquire({ id: "fixture-holder", taskIds: [id], leaseOwner: owner, priority: 1, since: null, leases: [lease] }, options.paid ? "paid:openrouter" : "openrouter");
  if ("full" in slot) throw new Error("fixture capacity unexpectedly full");
  const quota = new ProviderLimits(sy.db).reserve([{ id: "provider:openrouter", limits: { rpm: 10 } }, { id: "key:fixture", limits: { tpm: 10000 } }], 150);
  if (!quota.ok) throw new Error("fixture quota unexpectedly full");
  const binding: ReserveRequestDTO = { requestId: requestAttemptId(), payloadDigest: "a".repeat(64), keyRef: "fixture-key", providerReservationId: quota.reservation.id, slot: { id: slot.id, nonce: slot.nonce! }, executionId: sy.admission.createExecution("task", "summarize", [{ taskId: id, itemId: "1" }]), profile: "summarize", purpose: "fixture", gatewayModel: "direct:openrouter/fixture", endpointId: "openrouter/fixture", tier: "T1", estInputTokens: 50, reservedOutputTokens: 100, participants: [{ taskId: id, leaseOwner: owner, lease, budget: { maxModelRequests: 8, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 50, reservedOutputTokens: 100 }], ...(options.paid ? { paid: { key: { ref: "fixture-key", label: "fake", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null }, provider: "openrouter", worstCaseUsd: 0.25, price: { in: 1, out: 2 } } } : {}) };
  const reservation = await sy.gate.ledger.reserve(binding);
  await sy.gate.ledger.beginDispatch(reservation, "fixture-dispatch");
  if (!options.active) sy.tasks.finish(id, owner, syntheticResult(id, "failed", "fixture owner stopped"), "failed");
  for (const n of [1, 2]) sy.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,uncertain) VALUES(?,'openrouter','request','','',NULL,0,1,1,'[]',?,1)").run(`anonymous-${n}`, `anonymous-nonce-${n}`);
  const recovery = new TransportRecovery(sy.db, sy.admission, sy.spend, () => "absent");
  return { id, binding, reservation, slot, recovery, client };
}
function dump() {
  return Object.fromEntries(["model_requests", "request_charges", "paid_spend", "provider_usage", "provider_slots", "request_protocol", "tasks", "events"].map(table => [table, sy!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

it.each([false, true])("atomically retains uncertain accounting and releases exactly one dead-owner slot (paid=%s)", async paid => {
  const { id, binding, slot, recovery, client } = await fixture({ paid });
  const originalTask = sy!.tasks.get(id), charges = sy!.db.prepare("SELECT * FROM request_charges").all(), quota = sy!.db.prepare("SELECT * FROM provider_usage").all(), totals = sy!.admission.taskTotals(id), beforePaid = sy!.spend.taskSpend(id);
  const anonymous = sy!.db.prepare("SELECT * FROM provider_slots WHERE uncertain=1 ORDER BY id").all();
  const inspection = recovery.inspect(binding.requestId, "demo");
  expect(inspection.eligible).toBe(true);
  expect(JSON.stringify(inspection)).not.toContain("fixture-key");
  const receipt = recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason }, "demo");
  expect(receipt).toMatchObject({ disposition: "fresh", outcomeDigest: expect.any(String), proof: { basis: "ESRCH" }, project: "demo" });
  expect(sy!.db.prepare("SELECT status,input_tokens,output_tokens,error_kind FROM model_requests WHERE id=?").get(binding.requestId)).toEqual({ status: "uncertain", input_tokens: null, output_tokens: null, error_kind: "operator_transport_owner_absent" });
  expect(sy!.db.prepare("SELECT state FROM request_protocol WHERE request_id=?").pluck().get(binding.requestId)).toBe("settled");
  expect(sy!.db.prepare("SELECT * FROM provider_slots WHERE id=?").get(slot.id)).toBeUndefined();
  expect(sy!.db.prepare("SELECT * FROM provider_slots WHERE uncertain=1 ORDER BY id").all()).toEqual(anonymous);
  expect(sy!.db.prepare("SELECT * FROM request_charges").all()).toEqual(charges);
  expect(sy!.db.prepare("SELECT * FROM provider_usage").all()).toEqual(quota);
  expect(sy!.admission.taskTotals(id)).toEqual(totals); expect(totals.requests).toBe(1);
  expect(sy!.spend.taskSpend(id)).toBe(beforePaid);
  if (paid) expect(sy!.db.prepare("SELECT reserved_usd,actual_usd,cost_basis FROM paid_spend").get()).toEqual({ reserved_usd: 0.25, actual_usd: 0.25, cost_basis: "uncertain" });
  expect(sy!.tasks.get(id)).toEqual(originalTask);
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT task_id,project_id FROM events WHERE type='transport_owner_reconciled'").get()).toEqual({ task_id: null, project_id: "demo" });
});

it("idempotently returns the committed receipt after lost acknowledgment without probing a reused PID or modifying accounting", async () => {
  const { binding, recovery } = await fixture({ paid: true });
  const inspection = recovery.inspect(binding.requestId);
  const input = { requestId: binding.requestId, expected: inspection.snapshotDigest, reason };
  const first = recovery.reconcile(input), after = dump();
  const replay = new TransportRecovery(sy!.db, sy!.admission, sy!.spend, () => "live").reconcile(input);
  expect(replay).toEqual({ ...first, disposition: "replayed" });
  expect(dump()).toEqual(after);
  expect(() => recovery.reconcile({ ...input, expected: "0".repeat(64) })).toThrow(/retry differs/);
  expect(() => recovery.reconcile(input, "foreign")).toThrow(/project/);
});

it.each(["live", "unknown"] as const)("refuses owner probe state %s", async state => {
  const { binding } = await fixture();
  const recovery = new TransportRecovery(sy!.db, sy!.admission, sy!.spend, () => state);
  const inspection = recovery.inspect(binding.requestId), before = dump();
  expect(inspection.eligible).toBe(false);
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow(/live or absence is unknown/);
  expect(dump()).toEqual(before);
});
it("refuses a still-live captured lease even if its local PID is absent", async () => {
  const { binding, recovery } = await fixture({ active: true });
  const inspection = recovery.inspect(binding.requestId), before = dump();
  expect(inspection.activeCapturedLease).toBe(true);
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow(/lease remains live/);
  expect(dump()).toEqual(before);
});
it.each([`${hostname()}-foreign:1234:abcdef`, "owner-without-process-identity"])("refuses foreign or unrecognized owner %s", async owner => {
  const { binding, recovery } = await fixture({ owner }); const before = dump();
  expect(() => recovery.inspect(binding.requestId)).toThrow(/foreign|recognized/);
  expect(dump()).toEqual(before);
});

it.each(["nonce", "holder", "lease", "uncertain", "legacy", "missing-slot", "missing-protocol", "known-result", "project"])("refuses stale, anonymous or mismatched immutable state: %s", async mutation => {
  const { binding, slot, recovery } = await fixture();
  const inspection = recovery.inspect(binding.requestId);
  if (mutation === "nonce") sy!.db.prepare("UPDATE provider_slots SET nonce='changed' WHERE id=?").run(slot.id);
  if (mutation === "holder") sy!.db.prepare("UPDATE provider_slots SET holder='changed' WHERE id=?").run(slot.id);
  if (mutation === "lease") sy!.db.prepare("UPDATE provider_slots SET lease_json='[]' WHERE id=?").run(slot.id);
  if (mutation === "uncertain") sy!.db.prepare("UPDATE provider_slots SET uncertain=1 WHERE id=?").run(slot.id);
  if (mutation === "legacy") sy!.db.prepare("UPDATE provider_slots SET nonce=NULL,lease_json=NULL WHERE id=?").run(slot.id);
  if (mutation === "missing-slot") sy!.db.prepare("DELETE FROM provider_slots WHERE id=?").run(slot.id);
  if (mutation === "missing-protocol") sy!.db.prepare("DELETE FROM request_protocol WHERE request_id=?").run(binding.requestId);
  if (mutation === "known-result") sy!.db.prepare("UPDATE model_requests SET status='succeeded' WHERE id=?").run(binding.requestId);
  const before = dump();
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason }, mutation === "project" ? "foreign" : "demo")).toThrow();
  expect(dump()).toEqual(before);
});

// A slot carrying split-store project/grant authority is released only by the coordination broker's receipt.
it.each([
  ["project_uuid", "11111111-1111-4111-8111-111111111111"],
  ["store_uuid", "22222222-2222-4222-8222-222222222222"],
  ["store_generation", 1],
  ["execution_grants_json", JSON.stringify([{ grantId: "33333333-3333-4333-8333-333333333333", nonce: "44444444-4444-4444-8444-444444444444" }])],
] as const)("refuses a transport slot carrying split-store authority (%s) without releasing it", async (column, value) => {
  const { binding, slot, recovery } = await fixture();
  const inspection = recovery.inspect(binding.requestId, "demo");
  expect(inspection.eligible).toBe(true);
  sy!.db.prepare(`UPDATE provider_slots SET ${column}=? WHERE id=?`).run(value, slot.id);
  const before = dump();
  expect(() => recovery.inspect(binding.requestId, "demo")).toThrow(/split-store coordination authority/);
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason }, "demo")).toThrow(/split-store coordination authority/);
  expect(sy!.db.prepare("SELECT status FROM model_requests WHERE id=?").pluck().get(binding.requestId)).toBe("reserved");
  expect(dump()).toEqual(before);
});

it.each(["accounting", "protocol", "delete-abort", "delete-ignore", "audit"])("rolls back accounting, protocol and slot atomically when %s fails", async stage => {
  const { binding, recovery } = await fixture({ paid: true });
  const inspection = recovery.inspect(binding.requestId), before = dump();
  if (stage === "accounting") {
    const original = sy!.admission.reconcile.bind(sy!.admission);
    vi.spyOn(sy!.admission, "reconcile").mockImplementation((...args) => { original(...args); throw new Error("injected after accounting"); });
  }
  if (stage === "protocol") sy!.db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON request_protocol WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'injected protocol'); END");
  if (stage === "delete-abort") sy!.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON provider_slots BEGIN SELECT RAISE(ABORT,'injected delete'); END");
  if (stage === "delete-ignore") sy!.db.exec("CREATE TRIGGER ignore_delete BEFORE DELETE ON provider_slots BEGIN SELECT RAISE(IGNORE); END");
  if (stage === "audit") sy!.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON events WHEN NEW.type='transport_owner_reconciled' BEGIN SELECT RAISE(ABORT,'injected audit'); END");
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow();
  expect(dump()).toEqual(before);
});

it("refuses a valid second reservation substituted into another request receipt", async () => {
  const { id, binding, recovery } = await fixture({ active: true });
  const lease = binding.participants[0]!.lease;
  const secondSlot = sy!.health.capacity.tryAcquire({ id: "second-holder", taskIds: [id], leaseOwner: lease.owner, priority: 1, since: null, leases: [lease] }, "openrouter");
  if ("full" in secondSlot) throw new Error("fixture second capacity unexpectedly full");
  const secondBinding = { ...binding, requestId: requestAttemptId(), slot: { id: secondSlot.id, nonce: secondSlot.nonce! } };
  const second = await sy!.gate.ledger.reserve(secondBinding);
  await sy!.gate.ledger.beginDispatch(second, "second-dispatch");
  sy!.tasks.finish(id, lease.owner, syntheticResult(id, "failed", "fixture owner stopped"), "failed");
  const inspection = recovery.inspect(binding.requestId);
  sy!.db.prepare("UPDATE request_protocol SET reservation_json=? WHERE request_id=?").run(JSON.stringify(second), binding.requestId);
  const before = dump();
  expect(() => recovery.inspect(binding.requestId)).toThrow(/reservation identity/);
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow(/reservation identity/);
  expect(sy!.db.prepare("SELECT status FROM model_requests WHERE id=?").pluck().get(second.requestId)).toBe("reserved");
  expect(dump()).toEqual(before);
});

it("rechecks process absence and captured lease after an earlier eligible inspection", async () => {
  const { binding, recovery } = await fixture();
  const inspection = recovery.inspect(binding.requestId), before = dump();
  const changedOwner = new TransportRecovery(sy!.db, sy!.admission, sy!.spend, () => "live");
  expect(() => changedOwner.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow(/live or absence is unknown/);
  expect(dump()).toEqual(before);
  const lease = binding.participants[0]!.lease;
  sy!.db.prepare("UPDATE tasks SET lease_owner=?,lease_expires_at=? WHERE id=?").run(lease.owner, Date.now() + 60_000, lease.taskId);
  const activeBefore = dump();
  expect(() => recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason })).toThrow(/lease remains live/);
  expect(dump()).toEqual(activeBefore);
});

it("fences old dispatch and late conflicting provider settlement after reconciliation", async () => {
  const { binding, reservation, recovery } = await fixture();
  const inspection = recovery.inspect(binding.requestId);
  recovery.reconcile({ requestId: binding.requestId, expected: inspection.snapshotDigest, reason });
  const after = dump();
  expect(() => new RequestReceipts(sy!.db).assertDispatch(reservation, "fixture-dispatch")).toThrow(/generation lost/);
  await expect(sy!.gate.ledger.reconcile(reservation, { kind: "failed", errorKind: "late callback", errorMessage: "cannot replace unknown accounting" })).rejects.toThrow(/conflicting/);
  expect(dump()).toEqual(after);
});

it("uses only ESRCH as trusted local process absence proof", () => {
  expect(localProcessState(process.pid)).toBe("live");
  const probe = vi.spyOn(process, "kill");
  for (const code of ["EPERM", "EACCES", "UNKNOWN"]) { probe.mockImplementation(() => { throw Object.assign(new Error(code), { code }); }); expect(localProcessState(1234)).toBe("unknown"); }
  probe.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  expect(localProcessState(1234)).toBe("absent");
});

it("actual CLI inspects and reconciles an exact stopped local child without any provider calls", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const { binding, client } = await fixture({ owner: ownerFor(pid), paid: true });
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const args = [cli, "--config", env!.cfg.configPath, "--project", "demo", "transport"];
  const inspection = JSON.parse((await exec(process.execPath, [...args, "inspect", binding.requestId, "--json"])).stdout);
  expect(inspection.eligible).toBe(true);
  const decisions = await Promise.all([1, 2].map(() => exec(process.execPath, [...args, "reconcile", binding.requestId, "--expected", inspection.snapshotDigest, "--reason", reason, "--json"])));
  const results = decisions.map(result => JSON.parse(result.stdout));
  expect(results.map(result => result.disposition).sort()).toEqual(["fresh", "replayed"]);
  expect(results[0].eventId).toBe(results[1].eventId);
  const receipt = results.find(result => result.disposition === "fresh")!;
  const repeated = JSON.parse((await exec(process.execPath, [...args, "reconcile", binding.requestId, "--expected", inspection.snapshotDigest, "--reason", reason, "--json"])).stdout);
  expect(repeated).toEqual({ ...receipt, disposition: "replayed" });
  await expect(exec(process.execPath, [...args, "reconcile", binding.requestId, "--expected", inspection.snapshotDigest, "--reason", reason, "--force"])).rejects.toThrow();
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM model_requests").pluck().get()).toBe(1);
  expect(sy!.db.prepare("SELECT id FROM provider_slots ORDER BY id").all()).toEqual([{ id: "anonymous-1" }, { id: "anonymous-2" }]);
}, 30_000);
