import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config/load.js";
import { openDatabase } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { Admission, effectiveBudget } from "../src/admission/admission.js";
import { SqliteRequestLedger } from "../src/admission/sqlite-request-ledger.js";
import { requestAttemptId, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { requestLifecycle } from "../src/admin/request-lifecycle.js";
import { requestLog } from "../src/admin/insights.js";
import { requestDetail } from "../src/admin/entities.js";
import { liveChanges, liveCursor } from "../src/admin/live.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeStore } from "../src/projects/runtime-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });
const NOW = Date.now();
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-request-lifecycle-"));
  const configPath = path.join(dir, "config.yaml"); writeFileSync(configPath, "fixture");
  const cfg = parseConfig({ version: 1, storage: { directory: "db" }, brain: { project: "alpha", path: "brain" },
    projects: { alpha: {}, beta: {} }, profiles: { summarize: { mode: "completion", classify: "never" } } }, configPath);
  const db = openDatabase(path.join(dir, "db")), tasks = new TaskStore(db, () => NOW), admission = new Admission(db, tasks, cfg, () => NOW);
  const spend = new PaidSpend(db, cfg, new KeyVault(db, path.join(dir, "keys")), () => NOW), ledger = new SqliteRequestLedger(admission, spend);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = (project: string) => ({ project, db, tasks, sessions: null } as unknown as ProjectRuntimeStore);
  const sy = { db, cfg, layout: "legacy", tasks, projectStores: (project: string) => {
    if (!["alpha", "beta"].includes(project)) throw new Error("unknown project"); return store(project);
  }, projects: { slugs: () => ["alpha", "beta"], context: (project: string) => ["alpha", "beta"].includes(project) ? { project: { slug: project } } : undefined },
    catalog: { version: () => "fixture" }, brain: { root: dir }, brainFor: () => ({ root: dir }),
    projectContext: () => cfg, gate: { captures: { read: () => null } } } as unknown as MeritRouter;
  function task(id: string, project = "alpha") {
    tasks.submit([WorkerTaskSchema.parse({ id, profile: "summarize", goal: "Synthetic task", constraints: { acceptanceCriteria: ["done"] } })], { project });
    db.prepare("UPDATE tasks SET state='running',lease_owner='owner',lease_expires_at=?,run_count=1 WHERE id=?").run(NOW + 60000, id);
  }
  async function request(ids = ["one"], project = "alpha") {
    for (const id of ids) if (!tasks.get(id)) task(id, project);
    const executionId = admission.createExecution(ids.length > 1 ? "batch" : "task", "summarize", ids.map(taskId => ({ taskId, itemId: taskId })));
    const input: ReserveRequestDTO = { requestId: requestAttemptId(NOW), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null,
      executionId, profile: "summarize", purpose: "completion", gatewayModel: "fixture", endpointId: "fixture", tier: "T1", estInputTokens: 1, reservedOutputTokens: 1,
      participants: ids.map(taskId => ({ taskId, leaseOwner: "owner", lease: capturedLease(tasks.get(taskId)!),
        budget: effectiveBudget(cfg, tasks.get(taskId)!.spec), estInputTokens: 1, reservedOutputTokens: 1 })) };
    const reservation = await ledger.reserve(input);
    const row = () => db.prepare("SELECT * FROM model_requests WHERE id=?").get(reservation.requestId);
    return { input, reservation, row };
  }
  return { db, sy, cfg, tasks, admission, ledger, request, task, dir };
}

describe("request owner lifecycle separate from financial status", () => {
  it("recognizes only the exact captured active owner and leaves accounting untouched", async () => {
    const f = fixture(), r = await f.request();
    const before = JSON.stringify({ rows: f.db.prepare("SELECT * FROM model_requests").all(), charges: f.db.prepare("SELECT * FROM request_charges").all() });
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "active_owner" });
    expect(requestLifecycle(f.db, r.row(), NOW)).toEqual(requestLifecycle(f.db, r.row(), NOW));
    expect(requestLog(f.sy, { project: "alpha" })[0]).toMatchObject({ activity: "active_owner", status: "reserved", finishedAt: null });
    expect(requestDetail(f.sy, r.reservation.requestId, "alpha")).toMatchObject({ activity: "active_owner", status: "reserved", finishedAt: null });
    expect(JSON.stringify({ rows: f.db.prepare("SELECT * FROM model_requests").all(), charges: f.db.prepare("SELECT * FROM request_charges").all() })).toBe(before);
  });

  it.each(["cancelled", "expired", "owner", "run", "incarnation"])("identifies captured owner loss after %s without inventing an outcome", async reason => {
    const f = fixture(), r = await f.request();
    if (reason === "cancelled") f.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL WHERE id='one'").run();
    else if (reason === "expired") f.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW);
    else if (reason === "owner") f.db.prepare("UPDATE tasks SET lease_owner='another-owner' WHERE id='one'").run();
    else if (reason === "run") f.db.prepare("UPDATE tasks SET run_count=2 WHERE id='one'").run();
    else f.db.prepare("UPDATE tasks SET lease_incarnation=? WHERE id='one'").run("b".repeat(32));
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "owner_lost" });
    expect(requestLifecycle(f.db, r.row(), NOW).activityReason).toContain("remote outcome remains unknown");
    expect(r.row()).toMatchObject({ status: "reserved", finished_at: null });
  });

  it("does not use request age or another participant's later attempt as active proof", async () => {
    const f = fixture(), r = await f.request(["one", "two"]);
    f.db.prepare("UPDATE model_requests SET reserved_at=1").run();
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "active_owner" });
    f.db.prepare("UPDATE tasks SET run_count=2,lease_owner='new-process',lease_expires_at=?").run(NOW + 120000);
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "owner_lost" });
  });

  it("keeps one genuinely current captured batch owner active while another participant expires", async () => {
    const f = fixture(), r = await f.request(["one", "two"]);
    f.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW);
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "active_owner" });
  });

  it.each(["missing", "malformed", "fingerprint", "charges", "foreign"])("returns unknown for %s request-owner evidence", async kind => {
    const f = fixture(), r = await f.request();
    if (kind === "missing") f.db.prepare("DELETE FROM request_protocol WHERE request_id=?").run(r.reservation.requestId);
    else if (kind === "malformed") f.db.prepare("UPDATE request_protocol SET binding_json='{}'").run();
    else if (kind === "fingerprint") f.db.prepare("UPDATE request_protocol SET fingerprint=?").run("0".repeat(64));
    else if (kind === "charges") f.db.prepare("UPDATE request_charges SET run_count=2").run();
    else f.db.prepare("UPDATE tasks SET project_id='beta' WHERE id='one'").run();
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "unknown" });
    expect(r.row()).toMatchObject({ status: "reserved", finished_at: null });
  });

  it("supports the private project protocol namespace without treating financial uncertainty as execution", async () => {
    const f = fixture(), r = await f.request();
    const legacy = f.db.prepare("SELECT binding_json,fingerprint,reservation_json FROM request_protocol WHERE request_id=?").get(r.reservation.requestId) as { binding_json: string; fingerprint: string; reservation_json: string };
    f.db.prepare(`INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at)
      VALUES(?,'alpha','{}',?,?,?,?,'dispatch_intent',?,?)`).run(r.reservation.requestId, legacy.fingerprint, legacy.binding_json, "{}", legacy.reservation_json, NOW, NOW);
    f.db.prepare("DELETE FROM request_protocol WHERE request_id=?").run(r.reservation.requestId);
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "active_owner" });
    f.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL WHERE id='one'").run();
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "owner_lost" });
    f.db.prepare("UPDATE model_requests SET status='uncertain',finished_at=?").run(NOW);
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "unknown" });
    expect(requestLifecycle(f.db, r.row(), NOW).activityReason).toContain("recorded request outcome");
  });

  it("does not advertise taskless global requests as an active task owner", async () => {
    const f = fixture(), r = await f.request([]);
    expect(requestLifecycle(f.db, r.row(), NOW)).toMatchObject({ activity: "unknown" });
    expect(requestLifecycle(f.db, r.row(), NOW).activityReason).toContain("taskless");
  });

  it("invalidates request subscribers on cancellation and exact-generation lease expiry without financial writes", async () => {
    const f = fixture(), r = await f.request();
    let cursor = liveCursor(f.sy, "alpha", NOW);
    expect(liveChanges(f.sy, cursor, NOW + 100).topics).not.toContain("requests");
    const expired = liveChanges(f.sy, cursor, NOW + 60001);
    expect(expired.topics).toContain("requests");
    expect(r.row()).toMatchObject({ status: "reserved", finished_at: null });
    cursor = liveCursor(f.sy, "alpha", NOW);
    f.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL,updated_at=updated_at+1 WHERE id='one'").run();
    expect(liveChanges(f.sy, cursor, NOW + 1).topics).toContain("requests");
    expect(requestLog(f.sy, { project: "alpha" })[0]).toMatchObject({ activity: "owner_lost", status: "reserved" });
  });

  it("keeps ownership invalidation and request reads scoped to the selected project", async () => {
    const f = fixture(); await f.request(["one"]); await f.request(["foreign"], "beta");
    const alpha = liveCursor(f.sy, "alpha", NOW), all = liveCursor(f.sy, "all", NOW);
    f.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL,updated_at=updated_at+1 WHERE id='foreign'").run();
    expect(liveChanges(f.sy, alpha, NOW + 1).topics).not.toContain("requests");
    expect(liveChanges(f.sy, all, NOW + 1).topics).toContain("requests");
    expect(requestLog(f.sy, { project: "alpha" })).toHaveLength(1);
    expect(requestLog(f.sy, { project: "alpha" })[0]).toMatchObject({ activity: "active_owner", project: "alpha" });
  });

  it("does not query ownership tables on quiet ticks and preserves each cursor's expiry invalidation", async () => {
    const f = fixture(); await f.request();
    const first = liveCursor(f.sy, "all", NOW), second = liveCursor(f.sy, "all", NOW);
    const prepared: string[] = [], original = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => { prepared.push(sql); return original(sql); }) as typeof f.db.prepare;
    try {
      expect(liveChanges(f.sy, first, NOW + 1).topics).toEqual([]);
      expect(prepared.filter(sql => !/total_changes|FROM meta/.test(sql))).toEqual([]);
      prepared.length = 0;
      const expired = liveChanges(f.sy, first, NOW + 60001);
      expect(expired.topics).toContain("requests");
      expect(prepared.some(sql => sql.includes("nextExpiry"))).toBe(true);
      expect(liveChanges(f.sy, second, NOW + 60001).topics).toContain("requests");
      prepared.length = 0;
      expect(liveChanges(f.sy, expired.cursor, NOW + 120000).topics).toEqual([]);
      expect(prepared.filter(sql => !/total_changes|FROM meta/.test(sql))).toEqual([]);
    } finally { f.db.prepare = original; }
  });

  it("reschedules a renewed captured lease without querying at its superseded deadline", async () => {
    const f = fixture(); await f.request(); const before = liveCursor(f.sy, "all", NOW);
    f.db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id='one'").run(NOW + 120000);
    const renewed = liveChanges(f.sy, before, NOW + 1);
    const prepared: string[] = [], original = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => { prepared.push(sql); return original(sql); }) as typeof f.db.prepare;
    try {
      expect(liveChanges(f.sy, renewed.cursor, NOW + 60001).topics).toEqual([]);
      expect(prepared.filter(sql => !/total_changes|FROM meta/.test(sql))).toEqual([]);
      expect(liveChanges(f.sy, renewed.cursor, NOW + 120001).topics).toContain("requests");
    } finally { f.db.prepare = original; }
  });

  it("detects private project writes without a coordination write and never provisions qualification for a watcher", async () => {
    const f = fixture(); await f.request();
    const global = openDatabase(path.join(f.dir, "coordination")); cleanup.push(() => global.close());
    Object.assign(f.sy, { db: global, layout: "split" });
    const opened: string[] = [], original = f.sy.projectStores.bind(f.sy);
    f.sy.projectStores = project => { opened.push(project); return original(project); };
    const cursor = liveCursor(f.sy, "all", NOW);
    const changes = global.prepare("SELECT total_changes() n").get();
    expect(opened).not.toContain("_qualification");
    f.db.prepare("UPDATE tasks SET state='cancelled',lease_owner=NULL WHERE id='one'").run();
    expect(liveChanges(f.sy, cursor, NOW + 1).topics).toContain("requests");
    expect(global.prepare("SELECT total_changes() n").get()).toEqual(changes);
    expect(opened).not.toContain("_qualification");
    expect(global.prepare("SELECT COUNT(*) n FROM project_store_registrations").get()).toEqual({ n: 0 });
  });
});
