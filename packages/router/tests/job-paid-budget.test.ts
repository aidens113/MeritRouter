import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { Admission, effectiveBudget } from "../src/admission/admission.js";
import { SqliteRequestLedger } from "../src/admission/sqlite-request-ledger.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { requestAttemptId, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { assertProjectRequestAuthority } from "../src/admission/project-request-authority.js";
import { ProjectRequestStore } from "../src/admission/project-request-store.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity } from "../src/projects/store-identity.js";
import { assertJobPaidBudget } from "../src/admission/job-paid-budget.js";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
const now = Date.now();
function setup(cap = 5, layout: "legacy" | "project" = "legacy") {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-job-paid-"));
  const cfg = parseConfig({ version: 1, storage: { directory: "store" }, brain: { project: "alpha", path: "brain" },
    projects: { alpha: {}, beta: {} }, panel: { auto_start: false, port: 9 }, paid: { enabled: true, budgets: { per_week_usd: 10000 } },
    profiles: { supervise: { mode: "supervisor", tools: "supervisor", classify: "never" }, summarize: { mode: "completion", classify: "never", max_model_requests: 16 } } }, path.join(dir, "config.yaml"));
  const db = openDatabase(path.join(dir, "db"), { durability: "full" });
  const identity = createProjectStoreIdentity(createCoordinationStoreIdentity().installationId, "alpha");
  if (layout === "project") initializeStoreRole(db, identity);
  const tasks = new TaskStore(db, () => now);
  disposals.push(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const admission = new Admission(db, tasks, cfg, () => now);
  const spend = new PaidSpend(db, cfg, new KeyVault(db, path.join(dir, "keys")), () => now);
  const ledger = new SqliteRequestLedger(admission, spend);
  function task(id: string, parent?: string, paidCap?: number, profile = "summarize", project = "alpha") {
    tasks.submit([WorkerTaskSchema.parse({ id, profile, parentTaskId: parent, goal: "Synthetic budget test", constraints: { acceptanceCriteria: ["done"] },
      ...(paidCap === undefined ? {} : { budget: { maxPaidUsd: paidCap } }) })], { project });
    db.prepare("UPDATE tasks SET state='running',lease_owner='owner',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(now + 60000, now + 60000, id);
  }
  function input(ids: string[], usd: number, paid = true): ReserveRequestDTO {
    const executionId = admission.createExecution(ids.length > 1 ? "batch" : "task", "summarize", ids.map(taskId => ({ taskId, itemId: taskId })));
    return { requestId: requestAttemptId(now), payloadDigest: "a".repeat(64), keyRef: paid ? "fixture" : "", providerReservationId: null,
      executionId, profile: "summarize", purpose: "execution", gatewayModel: "fixture", endpointId: "fixture", tier: "T1", estInputTokens: 1, reservedOutputTokens: 1,
      participants: ids.map(taskId => ({ taskId, leaseOwner: "owner", lease: capturedLease(tasks.get(taskId)!), budget: effectiveBudget(cfg, tasks.get(taskId)!.spec), estInputTokens: 1, reservedOutputTokens: 1 })),
      ...(paid ? { paid: { key: { ref: "fixture", label: "fixture", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null },
        provider: "fixture", worstCaseUsd: usd, price: { in: 1, out: 1 } } } : {}) };
  }
  task("root", undefined, cap, "supervise"); task("one", "root"); task("two", "root");
  return { db, cfg, tasks, admission, spend, ledger, task, input, dir, identity };
}

describe("shared job paid ceilings", () => {
  it("preserves genuine legacy taskless paid accounting without inventing a job cap", async () => {
    const f = setup(0), input = f.input([], 1);
    const reservation = await f.ledger.reserve(input);
    await expect(f.ledger.beginDispatch(reservation, "global")).resolves.toEqual({ disposition: "fresh" });
    expect(() => f.ledger.assertDispatch(reservation, "global")).not.toThrow();
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 0 });
    await expect(f.ledger.reserve(input)).resolves.toMatchObject({ disposition: "replayed" });
  });

  it("keeps global and key ceilings on genuine taskless paid requests", async () => {
    const f = setup(); f.cfg.paid.budgets.per_week_usd = 1;
    await f.ledger.reserve(f.input([], 1));
    await expect(f.ledger.reserve(f.input([], 0.1))).rejects.toThrow(/weekly paid budget/);
    const g = setup(), capped = g.input([], 1); capped.paid!.key.monthlyCapUsd = 0;
    await expect(g.ledger.reserve(capped)).rejects.toThrow(/key fixture.*worst case/);
    const noBalance = g.input([], 1); noBalance.paid!.key.prepaidBalanceUsd = 0;
    await expect(g.ledger.reserve(noBalance)).rejects.toThrow(/key fixture.*worst case/);
  });

  it("rejects missing, finished or task-owned executions masquerading as taskless", async () => {
    const f = setup(0), owned = f.input(["one"], 1); owned.participants = [];
    await expect(f.ledger.reserve(owned)).rejects.toThrow(/job paid budget accounting cannot validate/);
    const missing = f.input([], 1); missing.executionId = "missing";
    await expect(f.ledger.reserve(missing)).rejects.toThrow(/job paid budget accounting cannot validate/);
    const finished = f.input([], 1); f.db.prepare("UPDATE executions SET status='completed' WHERE id=?").run(finished.executionId);
    await expect(f.ledger.reserve(finished)).rejects.toThrow(/job paid budget accounting cannot validate/);
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  });

  it("rechecks taskless execution membership before dispatch without rejecting nonempty batch subsets", async () => {
    const f = setup(), input = f.input([], 1), reservation = await f.ledger.reserve(input);
    f.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,'one','one')").run(input.executionId);
    await expect(f.ledger.beginDispatch(reservation, "omitted-member")).rejects.toThrow(/job paid budget accounting cannot validate/);
    const subset = f.input(["one", "two"], 1); subset.participants = [subset.participants[0]!];
    await expect(f.ledger.reserve(subset)).resolves.toMatchObject({ disposition: "fresh" });
    const fresh = f.input([], 1), freshReservation = await f.ledger.reserve(fresh);
    await f.ledger.beginDispatch(freshReservation, "fresh");
    f.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,'two','two')").run(fresh.executionId);
    expect(() => f.ledger.assertDispatch(freshReservation, "fresh")).toThrow(/job paid budget accounting cannot validate/);
    expect(() => assertJobPaidBudget(f.db, "alpha", [], 1, false, "project", fresh.executionId)).toThrow(/job paid budget accounting cannot validate/);
  });

  it("refuses combined sibling reservations above the submitted root ceiling", async () => {
    const f = setup(); await f.ledger.reserve(f.input(["one"], 3));
    await expect(f.ledger.reserve(f.input(["two"], 3))).rejects.toThrow(/job.*paid budget/i);
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 1 });
  });

  it("preserves an explicit zero job ceiling for paid descendants", async () => {
    const f = setup(0);
    await expect(f.ledger.reserve(f.input(["one"], 0.1))).rejects.toThrow(/job.*paid budget/i);
    expect(f.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  });

  it.each(["", "old-project", "beta"])("retains owned charge liability despite stale request project label %j", async label => {
    const f = setup(3), reserved = await f.ledger.reserve(f.input(["one"], 3));
    f.db.prepare("UPDATE model_requests SET project_id=? WHERE id=?").run(label, reserved.requestId);
    await expect(f.ledger.reserve(f.input(["two"], 0.1))).rejects.toThrow(/job root shared paid budget/);
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 1 });
  });

  it("combines root, nested supervisor and worker spend while honoring a lower nested ceiling", async () => {
    const f = setup(10); f.task("sub", "root", 2, "supervise"); f.task("nested", "sub");
    await f.ledger.reserve(f.input(["root"], 3)); await f.ledger.reserve(f.input(["nested"], 2));
    await expect(f.ledger.reserve(f.input(["sub"], 0.1))).rejects.toThrow(/job sub shared paid budget/);
    await f.ledger.reserve(f.input(["one"], 5));
    await expect(f.ledger.reserve(f.input(["two"], 0.1))).rejects.toThrow(/job root shared paid budget/);
  });

  it("allocates one physical batch once and splits batches across sibling job ceilings", async () => {
    const f = setup(5); f.task("sibling", undefined, 2, "supervise"); f.task("outside", "sibling");
    await f.ledger.reserve(f.input(["one", "two"], 3));
    await f.ledger.reserve(f.input(["one", "outside"], 4));
    await expect(f.ledger.reserve(f.input(["two"], 0.1))).rejects.toThrow(/job root shared paid budget/);
    await expect(f.ledger.reserve(f.input(["outside"], 0.1))).rejects.toThrow(/job sibling shared paid budget/);
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 2 });
  });

  it("serializes two competing child reservations for the last job dollars", async () => {
    const f = setup(3);
    const other = openDatabase(path.join(f.dir, "db"), { durability: "full" }); disposals.push(() => other.close());
    const otherAdmission = new Admission(other, new TaskStore(other, () => now), f.cfg, () => now);
    const otherLedger = new SqliteRequestLedger(otherAdmission, new PaidSpend(other, f.cfg, new KeyVault(other, path.join(f.dir, "keys")), () => now));
    const results = await Promise.allSettled([f.ledger.reserve(f.input(["one"], 3)), otherLedger.reserve(f.input(["two"], 3))]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.db.prepare("SELECT SUM(reserved_usd) usd FROM paid_spend").get()).toEqual({ usd: 3 });
  });

  it("preserves uncertain spend on replay and reopening the ledger", async () => {
    const f = setup(3), input = f.input(["one"], 3), reserved = await f.ledger.reserve(input);
    await f.ledger.beginDispatch(reserved, "first"); f.ledger.assertDispatch(reserved, "first");
    await f.ledger.reconcile(reserved, { kind: "uncertain", errorKind: "timeout", errorMessage: "Synthetic timeout" });
    expect((await f.ledger.reserve(input)).disposition).toBe("replayed");
    const reopened = openDatabase(path.join(f.dir, "db"), { durability: "full" });
    disposals.push(() => reopened.close());
    const tasks = new TaskStore(reopened, () => now), admission = new Admission(reopened, tasks, f.cfg, () => now);
    const ledger = new SqliteRequestLedger(admission, new PaidSpend(reopened, f.cfg, new KeyVault(reopened, path.join(f.dir, "keys")), () => now));
    await expect(ledger.reserve(f.input(["two"], 0.1))).rejects.toThrow(/job root shared paid budget/);
    expect(reopened.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 1 });
  });

  it("rechecks shared exposure before transport and still allows free control work", async () => {
    const f = setup(3), paid = await f.ledger.reserve(f.input(["one"], 2));
    await f.ledger.beginDispatch(paid, "paid");
    // A previously admitted request can later report a higher actual bill.
    f.db.prepare("UPDATE paid_spend SET actual_usd=4,cost_basis='provider_reported'").run();
    let transports = 0;
    expect(() => { f.ledger.assertDispatch(paid, "paid"); transports++; }).toThrow(/job root shared paid budget/);
    expect(transports).toBe(0);
    const free = await f.ledger.reserve(f.input(["two"], 0, false));
    await expect(f.ledger.beginDispatch(free, "free")).resolves.toEqual({ disposition: "fresh" });
    expect(() => f.ledger.assertDispatch(free, "free")).not.toThrow();
  });

  it("does not erase submitted ancestry caps when profile mode changes", async () => {
    const f = setup(0); f.cfg.profiles.supervise!.mode = "completion";
    await expect(f.ledger.reserve(f.input(["one"], 1))).rejects.toThrow(/job root shared paid budget/);
  });

  it("fails closed on missing, foreign or cyclic ancestry without reading foreign content", async () => {
    const f = setup(); f.task("foreign", undefined, 500, "supervise", "beta");
    for (const parent of ["missing", "foreign", "one"]) {
      const spec = f.tasks.get("one")!.spec;
      f.db.prepare("UPDATE tasks SET spec_json=? WHERE id='one'").run(JSON.stringify({ ...spec, parentTaskId: parent }));
      await expect(f.ledger.reserve(f.input(["one"], 1))).rejects.toThrow(/cannot validate same-project ancestry/);
    }
    expect(f.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 0 });
  });

  it("leaves ordinary unparented task caps unchanged and excludes other projects' costs", async () => {
    const f = setup(3); f.task("standalone", undefined, 1); f.task("foreign", undefined, 0, "supervise", "beta");
    await f.ledger.reserve(f.input(["standalone"], 1));
    await expect(f.ledger.reserve(f.input(["standalone"], 0.1))).rejects.toThrow(/paid budget/);
    await f.ledger.reserve(f.input(["one"], 3));
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 2 });
  });

  it("counts split active preparations atomically before global reservation and on replay", async () => {
    const f = setup(3, "project"), store = new ProjectRequestStore(f.db, f.identity, () => now);
    const other = openDatabase(path.join(f.dir, "db"), { durability: "full" }); disposals.push(() => other.close());
    const otherStore = new ProjectRequestStore(other, f.identity, () => now);
    const otherAdmission = new Admission(other, new TaskStore(other, () => now), f.cfg, () => now);
    const first = f.input(["one"], 3), second = f.input(["two"], 3);
    const prepare = (input: ReserveRequestDTO, target = store, authority = f.admission) => target.transaction(() => {
      const deadline = assertProjectRequestAuthority(authority, f.cfg, f.identity, input, false);
      return target.insert(input, deadline);
    });
    const results = await Promise.allSettled([Promise.resolve().then(() => prepare(first)), Promise.resolve().then(() => prepare(second, otherStore, otherAdmission))]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.db.prepare("SELECT SUM(paid_usd) usd FROM project_request_holds WHERE active=1").get()).toEqual({ usd: 3 });
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, first, true))).not.toThrow();
    expect(f.db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  });

  it("retains split projected liabilities and only unprojected participant holds", () => {
    const f = setup(5, "project"), store = new ProjectRequestStore(f.db, f.identity, () => now);
    const batch = f.input(["one", "two"], 4);
    store.transaction(() => { const deadline = assertProjectRequestAuthority(f.admission, f.cfg, f.identity, batch, false); store.insert(batch, deadline); });
    f.db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
      VALUES(?,?,'execution','fixture','uncertain',?,1,1,'alpha')`).run(batch.requestId, batch.executionId, now);
    f.db.prepare(`INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd,actual_usd)
      VALUES(?,'one','alpha',?,1,2,2,NULL)`).run(batch.requestId, f.tasks.get("one")!.row.lease_incarnation);
    const another = f.input(["root"], 2);
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, another, false))).toThrow(/job root shared paid budget/);
    const fitting = f.input(["root"], 1);
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, fitting, false))).not.toThrow();
    f.db.prepare("UPDATE project_request_spend SET actual_usd=6 WHERE task_id='one'").run();
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, batch, true))).toThrow(/job root shared paid budget/);
  });

  it("permits split free control requests after the root's prior paid charge exceeded its cap", () => {
    const f = setup(3, "project"), store = new ProjectRequestStore(f.db, f.identity, () => now);
    const paid = f.input(["root"], 2);
    store.transaction(() => { const deadline = assertProjectRequestAuthority(f.admission, f.cfg, f.identity, paid, false); store.insert(paid, deadline); });
    f.db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
      VALUES(?,?,'execution','fixture','succeeded',?,1,1,'alpha')`).run(paid.requestId, paid.executionId, now);
    f.db.prepare(`INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd,actual_usd)
      VALUES(?,'root','alpha',?,1,2,2,4)`).run(paid.requestId, f.tasks.get("root")!.row.lease_incarnation);
    const free = f.input(["root"], 0, false);
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, free, false))).not.toThrow();
    const anotherPaid = f.input(["root"], 0.1);
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, anotherPaid, false))).toThrow(/job root shared paid budget/);
  });

  it.each(["hold", "projection"])("retains owned split %s liability despite a stale descriptive project label", source => {
    const f = setup(3, "project"), store = new ProjectRequestStore(f.db, f.identity, () => now);
    const first = f.input(["one"], 3);
    store.transaction(() => { const deadline = assertProjectRequestAuthority(f.admission, f.cfg, f.identity, first, false); store.insert(first, deadline); });
    if (source === "hold") f.db.prepare("UPDATE project_request_holds SET project_id='beta'").run();
    else {
      f.db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id)
        VALUES(?,?,'execution','fixture','uncertain',?,1,1,'alpha')`).run(first.requestId, first.executionId, now);
      f.db.prepare(`INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd,actual_usd)
        VALUES(?,'one','beta',?,1,3,3,NULL)`).run(first.requestId, f.tasks.get("one")!.row.lease_incarnation);
      f.db.prepare("UPDATE project_request_holds SET active=0").run();
    }
    const next = f.input(["two"], 0.1);
    expect(() => store.transaction(() => assertProjectRequestAuthority(f.admission, f.cfg, f.identity, next, false))).toThrow(/foreign or unowned project data/);
    expect(() => assertJobPaidBudget(f.db, "alpha", next.participants, 0.1, false, "project")).toThrow(/job root shared paid budget/);
  });
});
