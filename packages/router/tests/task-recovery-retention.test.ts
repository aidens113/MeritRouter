import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import {
  capturedLease, recoveryOperationId, leaseOperationId, LeaseReceiptSchema,
  LEASE_RECEIPT_WINDOW_MS, RECOVERY_RECEIPT_WINDOW_MS,
  LEASE_RECEIPT_CAPACITY, RECOVERY_RECEIPT_CAPACITY, RECOVERY_TOTAL_THRESHOLD,
} from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: Db | undefined;
let now: number, tasks: TaskStore, leases: SqliteTaskLeases;
afterEach(() => { db?.close(); db = undefined; env?.cleanup(); env = undefined; });
function setup() {
  env = makeEnv();
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration);
  now = 1_800_000_000_000;
  tasks = new TaskStore(db, () => now);
  leases = new SqliteTaskLeases(env.cfg, tasks, () => now);
}
function submit(id = "fixture") {
  tasks.submit([WorkerTaskSchema.parse({ id, profile: "summarize", goal: "fixture", repositoryAliases: ["core"],
    constraints: { acceptanceCriteria: ["fixture"] } })], { project: "demo" });
  return capturedLease(tasks.claim("owner", { maxConcurrent: 10, maxWritersPerRepo: 1,
    leaseMs: 30_000, defaultTimeoutMs: 1_000_000 })[0]!);
}
const recover = (operationId = recoveryOperationId(now)) => leases.recover({ operationId, mode: "expired_only" });
const count = () => (db!.prepare("SELECT COUNT(*) n FROM task_lease_operation_keys").get() as { n: number }).n;
function seed(total: number, prefix: "tlease" | "trecover", expiresAt = now + LEASE_RECEIPT_WINDOW_MS, offset = 0) {
  const insert = db!.prepare("INSERT INTO task_lease_operation_keys(id,request_digest,expires_at) VALUES(?,?,?)");
  db!.transaction(() => {
    for (let i = offset; i < total + offset; i++) insert.run(`${prefix}_${now.toString(36)}_${i.toString(16).padStart(24, "0")}`, "0".repeat(64), expiresAt);
  })();
}

it("bounds two full days of one-second empty recovery cadence without losing durable replays", async () => {
  setup();
  const start = now;
  for (let second = 0; second <= 2 * 24 * 60 * 60; second++) {
    now = start + second * 1000;
    const receipt = await recover();
    // Let Vitest flush progress RPC and cancellation timers during the long deterministic loop.
    if (second % 1000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    if (second % 3600 === 0) {
      expect(receipt.affected).toEqual([]);
      expect(count()).toBeLessThanOrEqual(301);
    }
  }
  expect(count()).toBe(301);
  expect(db!.prepare("SELECT COUNT(*) n FROM task_lease_operations").get()).toEqual({ n: 301 });
}, 120_000);

it("replays an empty original receipt when a newly expired task appears", async () => {
  setup();
  const operationId = recoveryOperationId(now), first = await recover(operationId);
  const lease = submit();
  now += 30_001;
  expect(await recover(operationId)).toEqual({ ...first, disposition: "replayed" });
  expect(tasks.get(lease.taskId)!.row.state).toBe("running");
  expect((await recover()).affected).toHaveLength(1);
});

it("replays applied recovery exactly and never touches a same-owner newer generation", async () => {
  setup();
  const lease = submit(); now += 30_001;
  const input = { operationId: recoveryOperationId(now), mode: "startup" as const };
  const first = await leases.recover(input);
  expect(first.affected.map(item => item.state)).toEqual(["interrupted", "queued"]);
  expect(first.affected.every(item => item.target.taskId === lease.taskId && item.target.runCount === lease.runCount)).toBe(true);
  const newer = tasks.claim("owner", { maxConcurrent: 10, maxWritersPerRepo: 1,
    leaseMs: 30_000, defaultTimeoutMs: 1_000_000 })[0]!;
  expect(newer.row.run_count).toBe(lease.runCount + 1);
  now += 30_001;
  expect(await leases.recover(input)).toEqual({ ...first, disposition: "replayed" });
  expect(tasks.get(lease.taskId)!.row.state).toBe("running");
  await expect(leases.recover({ ...input, mode: "expired_only" })).rejects.toThrow(/different payload/);
});

it("honors the inclusive five-minute boundary and rejects expired keys after cascade pruning", async () => {
  setup();
  const operationId = recoveryOperationId(now), first = await recover(operationId);
  now += RECOVERY_RECEIPT_WINDOW_MS;
  expect(await recover(operationId)).toEqual({ ...first, disposition: "replayed" });
  now++;
  await recover();
  expect(db!.prepare("SELECT id FROM task_lease_operation_keys WHERE id=?").get(operationId)).toBeUndefined();
  await expect(recover(operationId)).rejects.toThrow(/retry window/);
  expect(count()).toBe(1);
});

it("binds request and receipt prefixes to kind and never turns expired recovery into seven-day renewal", async () => {
  setup();
  const lease = submit(), operationId = recoveryOperationId(now);
  const receipt = await recover(operationId);
  expect(LeaseReceiptSchema.safeParse({ ...receipt, kind: "renew", lease }).success).toBe(false);
  expect(LeaseReceiptSchema.safeParse({ ...receipt, operationId: leaseOperationId(now) }).success).toBe(false);
  await expect(recover(leaseOperationId(now))).rejects.toThrow();
  await expect(leases.renew({ lease, operationId })).rejects.toThrow();
  now += RECOVERY_RECEIPT_WINDOW_MS + 1;
  await recover();
  await expect(leases.renew({ lease, operationId })).rejects.toThrow();
  await expect(recover(operationId)).rejects.toThrow(/retry window/);
});

it("preserves seven-day ordinary replay and legacy recovery tombstones after payload purge", async () => {
  setup();
  const lease = submit(), operationId = leaseOperationId(now);
  const first = await leases.renew({ lease, operationId });
  const legacy = leaseOperationId(now);
  db!.prepare("INSERT INTO task_lease_operation_keys(id,request_digest,expires_at) VALUES(?,?,?)")
    .run(legacy, "f".repeat(64), now + LEASE_RECEIPT_WINDOW_MS);
  // A purged legacy recovery has no kind/payload left; its original tombstone is preserved.
  now += RECOVERY_RECEIPT_WINDOW_MS + 1;
  await recover();
  expect(db!.prepare("SELECT id FROM task_lease_operation_keys WHERE id=?").get(legacy)).toEqual({ id: legacy });
  await expect(recover(legacy)).rejects.toThrow();
  await expect(leases.renew({ lease, operationId: legacy })).rejects.toThrow(/different payload/);
  now = first.serverNow + LEASE_RECEIPT_WINDOW_MS;
  expect(await leases.renew({ lease, operationId })).toEqual({ ...first, disposition: "replayed" });
  now++;
  await expect(leases.renew({ lease, operationId })).rejects.toThrow(/retry window/);
});

it("reserves ordinary mutation headroom at recovery20k and permits replays at total100k", async () => {
  setup();
  const operationId = recoveryOperationId(now), first = await recover(operationId);
  seed(RECOVERY_RECEIPT_CAPACITY - 1, "trecover");
  await expect(recover()).rejects.toThrow(/recovery receipt capacity/);
  const lease = submit();
  const renewalId = leaseOperationId(now), renewal = await leases.renew({ lease, operationId: renewalId });
  seed(LEASE_RECEIPT_CAPACITY - count(), "tlease", now + LEASE_RECEIPT_WINDOW_MS, 100_000);
  expect(count()).toBe(100_000);
  expect(await recover(operationId)).toEqual({ ...first, disposition: "replayed" });
  expect(await leases.renew({ lease, operationId: renewalId })).toEqual({ ...renewal, disposition: "replayed" });
  await expect(leases.renew({ lease, operationId: leaseOperationId(now) })).rejects.toThrow(/capacity/);
});

it("refuses new recovery at total80k while an ordinary mutation still succeeds", async () => {
  setup(); seed(RECOVERY_TOTAL_THRESHOLD, "tlease");
  await expect(recover()).rejects.toThrow(/recovery receipt capacity/);
  const lease = submit();
  expect((await leases.renew({ lease, operationId: leaseOperationId(now) })).disposition).toBe("applied");
  expect(count()).toBe(RECOVERY_TOTAL_THRESHOLD + 1);
});

it("commits at most500 expired-key cascades despite subsequent maintenance quota refusal", async () => {
  setup(); seed(RECOVERY_RECEIPT_CAPACITY, "trecover"); seed(1500, "tlease", now - 1);
  const expired = db!.prepare("SELECT id FROM task_lease_operation_keys WHERE expires_at<? ORDER BY id LIMIT 1").get(now) as { id: string };
  db!.prepare("INSERT INTO task_lease_operations(id,kind,request_digest,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(expired.id, "renew", "0".repeat(64), "{}", now - 1000, now - 1);
  db!.prepare("INSERT INTO task_lease_operation_projects(operation_id,project_id) VALUES(?,?)").run(expired.id, "demo");
  for (const remaining of [1000, 500, 0]) {
    await expect(recover()).rejects.toThrow(/recovery receipt capacity/);
    expect(count()).toBe(RECOVERY_RECEIPT_CAPACITY + remaining);
  }
  expect(db!.prepare("SELECT COUNT(*) n FROM task_lease_operations").get()).toEqual({ n: 0 });
  expect(db!.prepare("SELECT COUNT(*) n FROM task_lease_operation_projects").get()).toEqual({ n: 0 });
});

it("rejects nested authority transactions rather than claiming independently committed cleanup", async () => {
  setup(); seed(1, "tlease", now - 1);
  db!.exec("BEGIN IMMEDIATE");
  await expect(recover()).rejects.toThrow(/independent transaction/);
  db!.exec("ROLLBACK");
  expect(count()).toBe(1);
});
