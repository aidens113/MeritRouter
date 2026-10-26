import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole, assertStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore, retireProjectStoreRegistration } from "../src/projects/store-identity.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { requestAttemptId } from "../src/admission/request-ledger.js";
import { accountingIdentityDigest, accountingOwnerDigest, type GlobalEndpointAuthority, type ReserveGlobalRequest, type SettleGlobalRequest } from "../src/admission/accounting-broker.js";
import { SqliteRequestAccountingBroker } from "../src/admission/sqlite-accounting-broker.js";
import { physicalRequestCount } from "../src/admission/accounting-usage.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

const databases: Db[] = [], environments: Env[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const env of environments.splice(0)) env.cleanup(); });
function setup(options: { paid?: boolean; config?: Record<string, unknown> } = {}) {
  const env = makeEnv({ config: baseConfig({ repositories: {}, projects: { alpha: {}, beta: {} }, ...options.config }) }); environments.push(env);
  const now = 1_800_000_000_000, globalDir = path.join(env.dir, "global"), db = openDatabase(globalDir, { durability: "full" }); databases.push(db);
  const installation = createCoordinationStoreIdentity(); initializeStoreRole(db, installation);
  const alpha = createProjectStoreIdentity(installation.installationId, "alpha"), beta = createProjectStoreIdentity(installation.installationId, "beta");
  registerProjectStore(db, alpha, path.join(env.dir, "alpha")); registerProjectStore(db, beta, path.join(env.dir, "beta"));
  const local = openDatabase(path.join(env.dir, "alpha-state"), { durability: "full" }); databases.push(local); initializeStoreRole(local, alpha);
  const spend = new PaidSpend(db, env.cfg, new KeyVault(db, globalDir), () => now);
  const authority: GlobalEndpointAuthority = { endpointId: "fixture-model", keyRef: options.paid ? "config:fixture" : null,
    provider: "fixture", platform: "fixture", enabled: true,
    providerUsageScopes: options.paid ? ["provider:fixture", "key:config:fixture"] : [],
    paid: options.paid ? { price: { in: 1, out: 1 }, maxSearches: 0, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null } : null };
  const broker = new SqliteRequestAccountingBroker(db, { cfg: env.cfg, spend, authorize: () => authority, now: () => now });
  function request(project = alpha): ReserveGlobalRequest {
    const requestId = requestAttemptId(now), slotId = `slot_${randomUUID()}`, nonce = `nonce_${randomUUID()}`;
    const lease = { taskId: `task-${project.slug}`, project: project.slug, owner: "worker-fixture", runCount: 1, incarnation: "c".repeat(32) };
    db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,project_uuid,store_uuid,store_generation) VALUES(?,'fixture','request','holder',?,'worker-fixture',0,?,?,?,?,?,?,?)")
      .run(slotId, lease.taskId, now, now, JSON.stringify([lease]), nonce, project.projectId, project.storeId, project.generation);
    const providerReservationId = authority.providerUsageScopes.length ? `pu_${randomUUID()}` : null;
    for (const scope of authority.providerUsageScopes) db.prepare("INSERT INTO provider_usage(scope,at,tokens,reservation) VALUES(?,?,150,?)").run(scope, now, providerReservationId);
    return { requestId, owner: { installationId: project.installationId, projectId: project.projectId, storeId: project.storeId, generation: project.generation },
      endpointId: authority.endpointId, keyRef: authority.keyRef, providerReservationId, slot: { id: slotId, nonce },
      estimatedInputTokens: 100, reservedOutputTokens: 50, dispatchNotAfter: now + 60_000, payloadDigest: "a".repeat(64), bindingDigest: "b".repeat(64),
      participants: [{ taskDigest: accountingIdentityDigest(project.projectId, lease.taskId), ownerDigest: accountingOwnerDigest(lease.owner), incarnation: lease.incarnation, runCount: lease.runCount }] };
  }
  return { env, db, local, alpha, beta, installation, globalDir, now, spend, authority, broker, request };
}
const ref = (receipt: { requestId: string; fingerprint: string }) => ({ requestId: receipt.requestId, fingerprint: receipt.fingerprint });
function settle(reference: { requestId: string; fingerprint: string }, patch: Partial<SettleGlobalRequest> = {}): SettleGlobalRequest {
  return { ...ref(reference), outcomeDigest: "d".repeat(64), outcome: "succeeded", inputTokens: 80, outputTokens: 20,
    actualUsd: 0.0001, costBasis: "computed", errorCode: "none", ...patch };
}

describe("minimal synchronous global accounting broker", () => {
  it("reserves exactly once and rejects same-ID changed ownership or binding without modifying private stores", () => {
    const f = setup(), input = f.request(), first = f.broker.reserveGlobal(input);
    expect(first.disposition).toBe("fresh"); expect(f.broker.reserveGlobal(input)).toEqual({ disposition: "replayed", receipt: first.receipt });
    expect(() => f.broker.reserveGlobal({ ...input, bindingDigest: "e".repeat(64) })).toThrow(/conflict/);
    expect(() => f.broker.reserveGlobal({ ...input, owner: { ...input.owner, generation: 2 } })).toThrow(/conflict/);
    expect(physicalRequestCount(f.db, 0)).toBe(1);
    expect(f.local.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 }); assertStoreRole(f.local, f.alpha);
  });
  it("keeps durable intent replay from granting a second fake transport after store connection reopen", () => {
    const f = setup(), first = f.broker.reserveGlobal(f.request()).receipt;
    let fakeCalls = 0;
    if (f.broker.beginDispatchGlobal(ref(first), "dispatch-fixture").disposition === "fresh") fakeCalls++;
    f.db.close(); const reopened = openDatabase(f.globalDir, { durability: "full" }); databases.push(reopened);
    const spend = new PaidSpend(reopened, f.env.cfg, new KeyVault(reopened, f.globalDir), () => f.now);
    const broker = new SqliteRequestAccountingBroker(reopened, { cfg: f.env.cfg, spend, authorize: () => f.authority, now: () => f.now });
    if (broker.beginDispatchGlobal(ref(first), "dispatch-fixture").disposition === "fresh") fakeCalls++;
    expect(fakeCalls).toBe(1); expect(() => broker.beginDispatchGlobal(ref(first), "other-dispatch")).toThrow(/conflict/);
    expect(() => broker.retireDefinitelyUnsent(ref(first))).toThrow(/state/);
  });
  it("retains request admission counts while retiring definitely-unsent paid exposure", () => {
    const f = setup({ paid: true }), input = f.request(), receipt = f.broker.reserveGlobal(input).receipt;
    expect(f.spend.windowSpend(0)).toBe(0.0002);
    expect(f.broker.retireDefinitelyUnsent(ref(receipt))).toMatchObject({ state: "retired", actualUsd: 0 });
    expect(f.spend.windowSpend(0)).toBe(0); expect(physicalRequestCount(f.db, 0)).toBe(1);
    expect(f.broker.reserveGlobal(input).disposition).toBe("replayed");
    expect(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/state/);
  });
  it("settles once with exact outcome CAS and retains uncertainty even above original exposure", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch");
    const outcome = settle(receipt, { outcome: "uncertain", actualUsd: 0.5, costBasis: "uncertain", errorCode: "timeout" });
    const result = f.broker.settleGlobal(outcome);
    expect(result).toMatchObject({ state: "settled", actualUsd: null, reservedUsd: 0.0002, liabilityUsd: 0.5 });
    expect(f.spend.windowSpend(0)).toBe(0.5); expect(f.broker.settleGlobal(outcome)).toEqual(result);
    expect(() => f.broker.settleGlobal({ ...outcome, actualUsd: 0.1 })).toThrow(/conflict/);
    expect(f.broker.listUnresolved()).toEqual([result]);
  });
  it("applies known actual spend once and preserves its authoritative result on conflicting replay", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    expect(() => f.broker.settleGlobal(settle(receipt))).toThrow(/state/);
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch"); const result = f.broker.settleGlobal(settle(receipt));
    expect(result.actualUsd).toBe(0.0001); expect(f.spend.windowSpend(0)).toBe(0.0001); expect(f.broker.listUnresolved()).toEqual([]);
    expect(() => f.broker.settleGlobal(settle(receipt, { outcomeDigest: "e".repeat(64) }))).toThrow(/conflict/);
    expect(f.spend.windowSpend(0)).toBe(0.0001);
  });
  it("serializes independent project reservations at the final global quota using separate coordination connections", () => {
    const f = setup({ config: { allocation: { max_model_requests_per_hour: 1 } } });
    f.broker.reserveGlobal(f.request());
    const other = openDatabase(f.globalDir, { durability: "full" }); databases.push(other);
    const otherBroker = new SqliteRequestAccountingBroker(other, { cfg: f.env.cfg, spend: new PaidSpend(other, f.env.cfg, new KeyVault(other, f.globalDir), () => f.now), authorize: () => f.authority, now: () => f.now });
    expect(() => otherBroker.reserveGlobal(f.request(f.beta))).toThrow(/quota/);
    expect(physicalRequestCount(f.db, 0)).toBe(1);
  });
  it.each(["global", "project", "key", "balance"])("enforces trusted %s paid headroom without accepting limits from the request", which => {
    const config = which === "global" ? { paid: { budgets: { per_week_usd: 0.0003 } } }
      : which === "project" ? { projects: { alpha: { paid_budgets: { per_week_usd: 0.0003 } }, beta: {} } } : {};
    const f = setup({ paid: true, config });
    if (which === "key") f.authority.paid!.monthlyCapUsd = 0.0003;
    if (which === "balance") { f.authority.paid!.prepaidBalanceUsd = 0.0003; f.authority.paid!.balanceCheckedAt = 0; }
    f.broker.reserveGlobal(f.request());
    expect(() => f.broker.reserveGlobal(f.request())).toThrow(/paid_budget/);
    expect(physicalRequestCount(f.db, 0)).toBe(1);
    expect(() => f.broker.reserveGlobal({ ...f.request(), maxPaidUsd: 1000 } as never)).toThrow();
  });
  it("rejects disabled keys, missing provider quota reservation, nonce loss and participant substitution before dispatch", () => {
    const f = setup({ paid: true }), input = f.request(); f.authority.enabled = false;
    expect(() => f.broker.reserveGlobal(input)).toThrow(/authority/); f.authority.enabled = true;
    expect(() => f.broker.reserveGlobal({ ...input, providerReservationId: null })).toThrow(/quota/);
    const receipt = f.broker.reserveGlobal(input).receipt;
    f.db.prepare("UPDATE provider_slots SET nonce='changed' WHERE id=?").run(input.slot!.id);
    expect(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/slot/);
    f.db.prepare("UPDATE provider_slots SET nonce=?,lease_json='[]' WHERE id=?").run(input.slot!.nonce, input.slot!.id);
    expect(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/slot/);
    expect(f.broker.readReceipt(input.requestId)?.state).toBe("reserved");
  });
  it("does not reuse one physical slot or key quota reservation for another request ID", () => {
    const f = setup({ paid: true }), input = f.request(); f.broker.reserveGlobal(input);
    expect(() => f.broker.reserveGlobal({ ...f.request(), providerReservationId: input.providerReservationId })).toThrow(/conflict/);
    expect(() => f.broker.reserveGlobal({ ...f.request(), slot: input.slot })).toThrow(/conflict/);
  });
  it("does not inherit deleted-project authority by reusing its slug, but still accepts original late settlement", () => {
    const f = setup({ paid: true }), original = f.request(), receipt = f.broker.reserveGlobal(original).receipt;
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch"); retireProjectStoreRegistration(f.db, f.alpha);
    const fresh = createProjectStoreIdentity(f.installation.installationId, "alpha"); registerProjectStore(f.db, fresh, path.join(f.env.dir, "fresh-alpha"));
    expect(() => f.broker.reserveGlobal(f.request(f.alpha))).toThrow(/authority/);
    expect(() => f.broker.reserveGlobal({ ...original, owner: { ...original.owner, projectId: fresh.projectId, storeId: fresh.storeId } })).toThrow(/conflict/);
    f.broker.settleGlobal(settle(receipt)); expect(f.spend.windowSpend(0)).toBe(0.0001);
    f.broker.reserveGlobal(f.request(fresh)); expect(physicalRequestCount(f.db, 0)).toBe(2);
  });
  it("deduplicates overlapping import IDs conservatively and rejects conflicting paid identity", () => {
    const f = setup({ paid: true }), input = f.request(); f.broker.reserveGlobal(input);
    f.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('exec','task','fixture','running',1)").run();
    f.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES(?,'exec','fixture','fixture','reserved',?,100,50,'alpha')").run(input.requestId, f.now);
    f.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,created_at) VALUES(?,'config:fixture','fixture','fixture-model',0.0002,?)").run(input.requestId, f.now);
    expect(physicalRequestCount(f.db, 0)).toBe(1); expect(f.spend.windowSpend(0)).toBe(0.0002);
    f.db.prepare("UPDATE paid_spend SET reserved_usd=0.5 WHERE request_id=?").run(input.requestId);
    expect(f.spend.windowSpend(0)).toBe(0.5);
    f.db.prepare("UPDATE paid_spend SET key_ref='other-key'").run(); expect(() => f.spend.windowSpend(0)).toThrow(/identities disagree/);
  });
  it("counts unmapped legacy history without guessing its owner from a fresh reused slug", () => {
    const f = setup({ config: { allocation: { max_model_requests_per_hour: 1 } } });
    f.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('legacy-exec','task','fixture','running',1)").run();
    f.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES('legacy','legacy-exec','fixture','fixture','reserved',?,1,1,'alpha')").run(f.now);
    expect(physicalRequestCount(f.db, 0, f.beta.projectId)).toBe(1);
    expect(() => f.broker.reserveGlobal(f.request(f.beta))).toThrow(/quota/);
  });
  it("rejects private request/diagnostic fields, mismatched wiring, outer transactions and tampered durable state", () => {
    const f = setup(), input = f.request();
    expect(() => f.broker.reserveGlobal({ ...input, payload: "private-canary" } as never)).toThrow();
    const receipt = f.broker.reserveGlobal(input).receipt;
    expect(JSON.stringify(f.db.prepare("SELECT * FROM physical_requests").all())).not.toContain("task-alpha");
    expect(() => f.db.transaction(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch"))()).toThrow(/state/);
    expect(() => new SqliteRequestAccountingBroker(f.local, { cfg: f.env.cfg, spend: f.spend, authorize: () => f.authority })).toThrow(/authority/);
    f.db.prepare("UPDATE physical_requests SET accounting_json='{}'").run(); expect(() => f.broker.readReceipt(input.requestId)).toThrow();
  });
  it("retains paid authority on malformed storage rather than quietly treating it as free", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.db.prepare("DELETE FROM broker_paid_spend WHERE request_id=?").run(receipt.requestId);
    expect(() => f.broker.readReceipt(receipt.requestId)).toThrow(/conflict/);
    expect(() => f.spend.windowSpend(0)).toThrow(/incomplete or inconsistent/);
  });
  it("rechecks disabled paid routing and store generations before the dispatch commit", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.env.cfg.paid.enabled = false;
    expect(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/paid_budget/);
    f.env.cfg.paid.enabled = true;
    f.db.prepare("UPDATE project_store_registrations SET generation=2 WHERE project_uuid=?").run(f.alpha.projectId);
    expect(() => f.broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/authority/);
    expect(f.broker.readReceipt(receipt.requestId)?.state).toBe("reserved");
  });
  it("rechecks the bound dispatch deadline inside the acquired transaction before intent publication", () => {
    const f = setup(), input = f.request();
    expect(() => f.broker.reserveGlobal({ ...input, dispatchNotAfter: f.now })).toThrow(/deadline/);
    const receipt = f.broker.reserveGlobal(input).receipt;
    let reads = 0;
    const broker = new SqliteRequestAccountingBroker(f.db, { cfg: f.env.cfg, spend: f.spend,
      authorize: () => f.authority, now: () => ++reads >= 2 ? input.dispatchNotAfter : f.now });
    expect(() => broker.beginDispatchGlobal(ref(receipt), "dispatch")).toThrow(/deadline/);
    expect(f.broker.readReceipt(input.requestId)?.state).toBe("reserved");
  });
  it("refuses native search with unknown trusted pricing before paid admission", () => {
    const f = setup({ paid: true }); f.authority.paid!.maxSearches = 1;
    expect(() => f.broker.reserveGlobal(f.request())).toThrow(/paid_budget/);
    expect(physicalRequestCount(f.db, 0)).toBe(0);
  });
  it("does not silently discard positive reported cost from an authority classified as free", () => {
    const f = setup(), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch");
    expect(() => f.broker.settleGlobal(settle(receipt))).toThrow(/cost_quarantine/);
    expect(f.broker.readReceipt(receipt.requestId)).toMatchObject({ state: "dispatch_intent", reservedUsd: null, actualUsd: null,
      liabilityUsd: 0.0001, unexpectedLiabilityUsd: 0.0001, costQuarantined: true });
    expect(f.broker.listUnresolved()).toHaveLength(1);
    expect(f.spend.windowSpend(0)).toBe(0.0001);
    expect(f.spend.globalDenial(0)).toMatch(/unexpected provider cost/);
    expect(() => f.broker.reserveGlobal(f.request())).toThrow(/cost_quarantine/);
    expect(() => f.broker.settleGlobal(settle(receipt, { actualUsd: 0, costBasis: "not_billed" }))).toThrow(/cost_quarantine/);
    expect(f.spend.windowSpend(0)).toBe(0.0001);
    expect(() => f.broker.settleGlobal(settle(receipt, { actualUsd: 0.5, outcomeDigest: "e".repeat(64) }))).toThrow(/cost_quarantine/);
    expect(f.spend.windowSpend(0)).toBe(0.5);
    expect(f.broker.readReceipt(receipt.requestId)?.quarantineConflict).toBe(true);
    expect(f.broker.readReceipt(receipt.requestId)?.quarantineOutcomeDigest).toBe("d".repeat(64));
  });
  it("rolls back physical reservation if the same transaction cannot record paid authority", () => {
    const f = setup({ paid: true }), input = f.request();
    f.db.exec("CREATE TRIGGER fixture_paid_insert_fault BEFORE INSERT ON broker_paid_spend BEGIN SELECT RAISE(ABORT,'fixture paid commit fault'); END");
    expect(() => f.broker.reserveGlobal(input)).toThrow(/fixture paid commit fault/);
    expect(physicalRequestCount(f.db, 0)).toBe(0); expect(f.broker.readReceipt(input.requestId)).toBeNull();
    f.db.exec("DROP TRIGGER fixture_paid_insert_fault");
    expect(f.broker.reserveGlobal(input).disposition).toBe("fresh"); expect(physicalRequestCount(f.db, 0)).toBe(1);
  });
  it("preserves dispatch intent and conservative paid exposure when settlement commit aborts", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch");
    f.db.exec("CREATE TRIGGER fixture_paid_settle_fault BEFORE UPDATE ON broker_paid_spend BEGIN SELECT RAISE(ABORT,'fixture settlement fault'); END");
    expect(() => f.broker.settleGlobal(settle(receipt))).toThrow(/fixture settlement fault/);
    expect(f.broker.readReceipt(receipt.requestId)).toMatchObject({ state: "dispatch_intent", outcomeDigest: null, actualUsd: null });
    expect(f.spend.windowSpend(0)).toBe(0.0002);
    f.db.exec("DROP TRIGGER fixture_paid_settle_fault");
    expect(f.broker.settleGlobal(settle(receipt)).actualUsd).toBe(0.0001);
  });
  it("refuses legacy/null or stale immutable slot ownership even when its slug and nonce match", () => {
    const f = setup(), input = f.request();
    f.db.prepare("UPDATE provider_slots SET project_uuid=NULL WHERE id=?").run(input.slot!.id);
    expect(() => f.broker.reserveGlobal(input)).toThrow(/slot/);
    f.db.prepare("UPDATE provider_slots SET project_uuid=?,store_generation=2 WHERE id=?").run(f.alpha.projectId, input.slot!.id);
    expect(() => f.broker.reserveGlobal(input)).toThrow(/slot/);
    f.db.prepare("UPDATE provider_slots SET store_generation=1,project_uuid=? WHERE id=?").run(f.beta.projectId, input.slot!.id);
    expect(() => f.broker.reserveGlobal(input)).toThrow(/slot/);
    expect(physicalRequestCount(f.db, 0)).toBe(0);
  });
  it("does not reuse a key quota reservation already bound by the legacy request protocol", () => {
    const f = setup({ paid: true }), input = f.request(), legacy = requestAttemptId(f.now);
    f.db.prepare("INSERT INTO request_protocol_keys(id,expires_at) VALUES(?,?)").run(legacy, f.now + 1000);
    f.db.prepare("INSERT INTO request_protocol(request_id,fingerprint,binding_json,reservation_json,state,created_at,expires_at) VALUES(?,'fingerprint',?,'{}','reserved',?,?)")
      .run(legacy, JSON.stringify({ providerReservationId: input.providerReservationId }), f.now, f.now + 1000);
    expect(() => f.broker.reserveGlobal(input)).toThrow(/conflict/);
    expect(physicalRequestCount(f.db, 0)).toBe(0);
  });
  it("keeps unpriceable paid liability globally fenced across reopen and counts its minimum once", () => {
    const f = setup({ paid: true }), receipt = f.broker.reserveGlobal(f.request()).receipt;
    f.broker.beginDispatchGlobal(ref(receipt), "dispatch");
    const incident = { ...ref(receipt), outcomeDigest: "f".repeat(64), minimumUsd: 0.5, code: "cache_write_price_unknown" as const };
    expect(f.broker.quarantineUnboundedCost(incident)).toMatchObject({ state: "dispatch_intent", unboundedCost: true,
      costQuarantined: true, liabilityUsd: 0.5, actualUsd: null, quarantineOutcomeDigest: incident.outcomeDigest });
    expect(f.broker.quarantineUnboundedCost(incident).quarantineConflict).toBe(false);
    expect(f.spend.windowSpend(0)).toBe(0.5);
    expect(f.spend.summary().byEndpoint[0]).toMatchObject({ requests: 1, usd: 0.5 });
    expect(() => f.broker.settleGlobal(settle(receipt, { actualUsd: 0, costBasis: "not_billed" }))).toThrow(/cost_quarantine/);
    f.db.close(); const reopened = openDatabase(f.globalDir, { durability: "full" }); databases.push(reopened);
    const spend = new PaidSpend(reopened, f.env.cfg, new KeyVault(reopened, f.globalDir), () => f.now);
    const broker = new SqliteRequestAccountingBroker(reopened, { cfg: f.env.cfg, spend, authorize: () => f.authority, now: () => f.now });
    expect(broker.readReceipt(receipt.requestId)?.unboundedCost).toBe(true);
    expect(spend.globalDenial(0)).toMatch(/unexpected provider cost/); expect(spend.windowSpend(0)).toBe(0.5);
  });
});
