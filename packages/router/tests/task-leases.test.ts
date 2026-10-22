import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore, syntheticResult } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId, LEASE_RECEIPT_WINDOW_MS, type LeaseRef } from "../src/storage/task-leases.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";
let env: Env | undefined, db: Db | undefined, child: ChildProcess | undefined;
let now: number, tasks: TaskStore, leases: SqliteTaskLeases;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit');
    child.kill();
    await ended;
  }
  child = undefined;
  db?.close();
  db = undefined;
  env?.cleanup();
  env = undefined;
});
function setup() {
  env = makeEnv();
  db = openDatabase(env.cfg.storageDir);
  now = Date.now();
  tasks = new TaskStore(db, () => now);
  leases = new SqliteTaskLeases(env.cfg, tasks, () => now);
}
const key = () => leaseOperationId(now);
function submit(id = 'fixture', extra: Record<string, unknown> = {}) {
  tasks.submit([WorkerTaskSchema.parse({
      id, profile: 'summarize', goal: 'fixture', repositoryAliases: ['core'], constraints: { acceptanceCriteria: ['fixture'] }, ...extra
    })], { project: 'demo' });
}
function claim(owner = 'same-owner') {
  return tasks.claim(owner, {
    maxConcurrent: 10, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 1000000
  });
}
const finish = (lease: LeaseRef, operationId = key()) => leases.finish({
  lease, operationId, state: 'completed', result: syntheticResult(lease.taskId, 'completed', 'fixture')
});
it('fences every mutation from same-owner older generation and does not resurrect expiry', async () => {
  setup();
  submit();
  const a = capturedLease(claim()[0]!);
  now += 30001;
  expect((await leases.renew({
    lease: a, operationId: key()
  })).disposition).toBe('expired');
  expect((await finish(a)).disposition).toBe('expired');
  await leases.recover({
    operationId: key(), mode: 'startup'
  });
  const b = capturedLease(claim()[0]!), before = tasks.get(b.taskId)!;
  expect(b.owner).toBe(a.owner);
  expect(b.runCount).toBe(2);
  for (const receipt of [await leases.renew({
      lease: a, operationId: key()
    }), await finish(a), await leases.defer({
      lease: a, operationId: key(), nextAttemptAt: now + 5000, reason: 'old'
    }), await leases.interrupt({
      lease: a, operationId: key(), reason: 'old', resume: true
    })])
    expect(receipt.disposition).toBe('stale');
  expect(tasks.get(b.taskId)).toEqual(before);
  expect((await finish(b)).disposition).toBe('applied');
  expect(tasks.events(b.taskId).filter(event => event.type === 'completed')).toHaveLength(1);
});
it('atomically replays committed operations, rejects conflicting keys, and retains original renewal expiry', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!), operationId = key();
  const first = await leases.renew({
    lease, operationId
  });
  now += 1000;
  const replay = await leases.renew({
    lease, operationId
  });
  expect(replay).toMatchObject({
    disposition: 'replayed', original: 'applied', leaseExpiresAt: first.leaseExpiresAt, serverNow: first.serverNow
  });
  await expect(leases.interrupt({
    lease, operationId, reason: 'different'
  })).rejects.toThrow(/different payload/);
  const completion = key();
  await finish(lease, completion);
  expect((await finish(lease, completion)).disposition).toBe('replayed');
  expect(tasks.events(lease.taskId).filter(event => event.type === 'completed')).toHaveLength(1);
  expect(db!.prepare('SELECT COUNT(*) n FROM task_lease_operations').get()).toEqual({ n: 2 });
});
it('uses insertion incarnation to protect recreated IDs and expires keys even after receipt purge', async () => {
  setup();
  submit();
  const a = capturedLease(claim()[0]!), operationId = key();
  await finish(a, operationId);
  db!.prepare('DELETE FROM events WHERE task_id=?').run(a.taskId);
  db!.prepare('DELETE FROM tasks WHERE id=?').run(a.taskId);
  submit();
  const b = capturedLease(claim()[0]!);
  expect(b.runCount).toBe(a.runCount);
  expect(b.incarnation).not.toBe(a.incarnation);
  expect((await finish(a, operationId)).disposition).toBe('replayed');
  expect((await finish(a)).disposition).toBe('stale');
  db!.prepare('DELETE FROM task_lease_operations').run();
  now += LEASE_RECEIPT_WINDOW_MS + 1;
  await expect(finish(a, operationId)).rejects.toThrow(/retry window/);
  expect(tasks.get(b.taskId)!.row).toMatchObject({
    state: 'running', lease_incarnation: b.incarnation
  });
});
it('logical cancellation observes its generation, cancellation wins valid late outcome, and startup differs from tick', async () => {
  setup();
  submit();
  const a = capturedLease(claim()[0]!);
  const target = {
    taskId: a.taskId, runCount: a.runCount, incarnation: a.incarnation
  };
  await leases.cancel({
    operationId: key(), project: 'demo', actor: 'control', targets: [target]
  });
  expect((await finish(a)).state).toBe('cancelled');
  expect(tasks.get(a.taskId)!.result?.executionStatus).toBe('cancelled');
  submit('resume');
  const old = capturedLease(claim()[0]!);
  now += 30001;
  await leases.recover({
    operationId: key(), mode: 'expired_only'
  });
  expect(tasks.get('resume')!.row.state).toBe('interrupted');
  await leases.recover({
    operationId: key(), mode: 'startup'
  });
  const current = capturedLease(claim()[0]!);
  const stale = await leases.cancel({
    operationId: key(), project: 'demo', actor: 'control', targets: [{
        taskId: old.taskId, incarnation: old.incarnation, runCount: old.runCount
      }]
  });
  expect(stale.affected[0]!.state).toBe('unknown');
  expect(tasks.get(current.taskId)!.row.state).toBe('running');
});
it('validates live supervisor project and ancestry within the cancellation transaction', async () => {
  setup();
  // Use the actual resolved profile map; no authority is gained merely from a role string.
  env!.cfg.profiles.supervise = {
    ...env!.cfg.profiles.implement!, mode: 'supervisor'
  };
  submit('parent', { profile: 'supervise' });
  submit('own', { parentTaskId: 'parent' });
  submit('foreign');
  const owned = claim();
  const actor = capturedLease(owned.find(task => task.row.id === 'parent')!);
  const own = tasks.get('own')!.row, foreign = tasks.get('foreign')!.row;
  const observed = (row: typeof own) => ({
    taskId: row.id, incarnation: row.lease_incarnation, runCount: row.run_count
  });
  await expect(leases.cancel({
    operationId: key(), project: 'demo', actor: 'supervisor', actorLease: actor, targets: [observed(foreign)]
  })).rejects.toThrow(/ancestry/);
  expect((await leases.cancel({
    operationId: key(), project: 'demo', actor: 'supervisor', actorLease: actor, targets: [observed(own)]
  })).disposition).toBe('applied');
  now += 30001;
  await expect(leases.cancel({
    operationId: key(), project: 'demo', actor: 'supervisor', actorLease: actor, targets: [observed(own)]
  })).rejects.toThrow(/authority/);
});
it('recovers a real killed fixture owner and refuses its stale DTOs after same-owner takeover', async () => {
  setup();
  submit();
  const barrier = path.join(env!.dir, 'lease-owner.json');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'task-lease-owner.mjs');
  child = spawn(process.execPath, [fixture, env!.cfg.storageDir, barrier], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const errors: string[] = [];
  child.stderr?.on('data', data => errors.push(String(data)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([once(child, 'message'), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('fixture barrier timeout: ' + errors.join(''))), 15000);
        timeout.unref();
      })]);
  }
  finally {
    if (timeout)
      clearTimeout(timeout);
  }
  const old = JSON.parse(readFileSync(barrier, 'utf8')) as LeaseRef;
  const exited = once(child, 'exit');
  expect(child.kill()).toBe(true);
  await exited;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  db!.prepare('UPDATE tasks SET lease_expires_at=? WHERE id=?').run(now - 1, old.taskId);
  await leases.recover({
    operationId: key(), mode: 'startup'
  });
  const current = capturedLease(claim(old.owner)[0]!);
  expect(current.runCount).toBe(old.runCount + 1);
  expect((await finish(old)).disposition).toBe('stale');
  expect((await leases.interrupt({
    lease: old, operationId: key(), reason: 'dead owner'
  })).disposition).toBe('stale');
  expect(tasks.get(current.taskId)!.row.state).toBe('running');
  await finish(current);
  expect(tasks.events(current.taskId).filter(event => event.type === 'completed')).toHaveLength(1);
}, 30000);
it.each(['completed', 'failed', 'cancelled', 'budget_exhausted', 'interrupted'] as const)('persists valid %s finish exactly once', async (state) => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!), operationId = key(), result = syntheticResult(lease.taskId, state, 'fixture');
  expect((await leases.finish({
    lease, operationId, result, state
  })).state).toBe(state);
  expect((await leases.finish({
    lease, operationId, result, state
  })).disposition).toBe('replayed');
  expect(tasks.events(lease.taskId).filter(event => event.type === state)).toHaveLength(1);
});
it('rolls back task/result/events when durable receipt insertion fails', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!), operationId = key();
  db!.exec("CREATE TRIGGER fixture_fail_receipt BEFORE INSERT ON task_lease_operations BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END");
  await expect(finish(lease, operationId)).rejects.toThrow(/fixture receipt failure/);
  expect(tasks.get(lease.taskId)!.row.state).toBe('running');
  expect(tasks.events(lease.taskId).filter(event => event.type === 'completed')).toHaveLength(0);
  expect(db!.prepare('SELECT id FROM task_lease_operation_keys').all()).toEqual([]);
  db!.exec('DROP TRIGGER fixture_fail_receipt');
  expect((await finish(lease, operationId)).disposition).toBe('applied');
});
it('keeps expired recovery atomic with renewal and cancellation', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!);
  now += 1000;
  await leases.renew({
    lease, operationId: key()
  });
  expect((await leases.recover({
    operationId: key(), mode: 'expired_only'
  })).affected).toHaveLength(0);
  await leases.cancel({
    operationId: key(), project: 'demo', actor: 'control', targets: [{
        taskId: lease.taskId, incarnation: lease.incarnation, runCount: lease.runCount
      }]
  });
  now += 30001;
  await Promise.all([leases.recover({
      operationId: key(), mode: 'expired_only'
    }), leases.recover({
      operationId: key(), mode: 'expired_only'
    })]);
  expect(tasks.get(lease.taskId)!.row.state).toBe('cancelled');
  expect(tasks.events(lease.taskId).filter(event => event.type === 'cancelled')).toHaveLength(1);
});
it('does not resurrect purged private receipts or mutate a recreated task through a delayed operation', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!), operationId = key();
  await finish(lease, operationId);
  db!.prepare("DELETE FROM task_lease_operations WHERE id IN (SELECT operation_id FROM task_lease_operation_projects WHERE project_id=?)").run('demo');
  expect(db!.prepare('SELECT id FROM task_lease_operations').all()).toEqual([]);
  for (const table of ['events', 'file_leases'])
    db!.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(lease.taskId);
  db!.prepare('DELETE FROM tasks WHERE id=?').run(lease.taskId);
  const historical = await finish(lease, operationId);
  expect(historical).toMatchObject({
    disposition: 'replayed', original: 'stale'
  });
  const delayedId = key();
  expect((await finish(lease, delayedId)).disposition).toBe('stale');
  expect(db!.prepare('SELECT id FROM task_lease_operations').all()).toEqual([]);
  expect(db!.prepare('SELECT operation_id FROM task_lease_operation_projects').all()).toEqual([]);
  submit();
  const current = capturedLease(claim()[0]!);
  await expect(finish(current, delayedId)).rejects.toThrow(/different payload/);
  expect(tasks.get(current.taskId)!.row.state).toBe('running');
});
it('rejects non-JSON finish data and invalid stored task inputs before mutation', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!), result = syntheticResult(lease.taskId, 'completed', 'fixture');
  await expect(leases.finish({ lease, operationId: key(), state: 'completed', result: { ...result, data: () => 'not data' } })).rejects.toThrow(/JSON data/);
  const task = tasks.get(lease.taskId)!;
  db!.prepare('UPDATE tasks SET spec_json=? WHERE id=?').run(JSON.stringify({ ...task.spec, goal: 17 }), lease.taskId);
  await expect(finish(lease)).rejects.toThrow();
  expect(tasks.get(lease.taskId)!.row.state).toBe('running');
  expect(db!.prepare('SELECT id FROM task_lease_operation_keys').all()).toEqual([]);
});
it('refuses supervisor cancellation after its deadline even while its lease remains live', async () => {
  setup();
  env!.cfg.profiles.supervise = { ...env!.cfg.profiles.implement!, mode: 'supervisor' };
  submit('parent', { profile: 'supervise' });
  submit('own', { parentTaskId: 'parent' });
  const actor = capturedLease(claim().find(task => task.row.id === 'parent')!), target = tasks.get('own')!.row;
  db!.prepare('UPDATE tasks SET deadline_at=? WHERE id=?').run(now, actor.taskId);
  await expect(leases.cancel({ operationId: key(), project: 'demo', actor: 'supervisor', actorLease: actor, targets: [{ taskId: target.id, incarnation: target.lease_incarnation, runCount: target.run_count }] })).rejects.toThrow(/authority/);
  expect(tasks.get('own')!.row.cancel_requested).toBe(0);
});
it('rejects a cross-project intermediate even when target and supervisor share a project', async () => {
  setup();
  env!.cfg.profiles.supervise = { ...env!.cfg.profiles.implement!, mode: 'supervisor' };
  submit('parent', { profile: 'supervise' });
  submit('bridge', { parentTaskId: 'parent' });
  submit('own', { parentTaskId: 'bridge' });
  const actor = capturedLease(claim().find(task => task.row.id === 'parent')!), target = tasks.get('own')!.row;
  db!.prepare("UPDATE tasks SET project_id='another-project' WHERE id='bridge'").run();
  await expect(leases.cancel({ operationId: key(), project: 'demo', actor: 'supervisor', actorLease: actor, targets: [{ taskId: target.id, incarnation: target.lease_incarnation, runCount: target.run_count }] })).rejects.toThrow(/project ancestry bridge/);
  expect(tasks.get('own')!.row.cancel_requested).toBe(0);
});
it('rejects successful finish after deadline but preserves truthful timeout and pending cancellation settlement', async () => {
  setup();
  submit();
  const lease = capturedLease(claim()[0]!);
  db!.prepare('UPDATE tasks SET deadline_at=? WHERE id=?').run(now, lease.taskId);
  expect((await finish(lease)).disposition).toBe('deadline_exceeded');
  expect(tasks.get(lease.taskId)!.row.state).toBe('running');
  const failed = await leases.finish({ lease, operationId: key(), state: 'failed', result: syntheticResult(lease.taskId, 'failed', 'deadline_exceeded') });
  expect(failed.state).toBe('failed');
  submit('cancel-deadline');
  const cancelled = capturedLease(claim()[0]!);
  db!.prepare('UPDATE tasks SET deadline_at=? WHERE id=?').run(now, cancelled.taskId);
  await leases.cancel({ operationId: key(), project: 'demo', actor: 'control', targets: [{ taskId: cancelled.taskId, incarnation: cancelled.incarnation, runCount: cancelled.runCount }] });
  expect((await finish(cancelled)).state).toBe('cancelled');
});
