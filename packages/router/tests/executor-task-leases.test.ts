import { GatewayError } from "../src/core/errors.js";
import { afterEach, expect, it, vi } from "vitest";
import { Executor, type CodingRunner } from "../src/core/executor.js";
import { TaskRunLeases } from "../src/core/task-run-leases.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, recoveryOperationId, leaseOperationId, type TaskLeases, type LeaseReceipt } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseResult } from "../src/runners/types.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, goodOutput, summarizeTask, ScriptedClient, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined, executor: Executor | undefined;
let now: number;
const releases: Array<() => void> = [];
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  releases.push(release);
  return {
    release, promise
  };
}
afterEach(async () => {
  for (const release of releases.splice(0))
    release();
  vi.useRealTimers();
  await executor?.flush();
  await sy?.close();
  executor = undefined;
  sy = undefined;
  env?.cleanup();
  env = undefined;
});
function setup(overrides: Partial<TaskLeases> = {}, coding: CodingRunner | null = null) {
  now = Date.now();
  env = makeEnv({ config: baseConfig({
      execution: { lease_seconds: 10 }, profiles: {
        ...baseConfig().profiles, implement: {
          ...baseConfig().profiles.implement, classify: 'never'
        }
      }
    }) });
  const client = new ScriptedClient(req => {
    const text = req.messages.map(message => String(message.content)).join('\n');
    const ids = [...text.matchAll(/<item id="(i[0-9]+)">/g)].map(match => match[1]!);
    return reply(JSON.stringify(ids.length ? { items: ids.map(id => ({
        id, result: goodOutput()
      })) } : goodOutput()));
  });
  sy = open(env, client, { now: () => now });
  const real = new SqliteTaskLeases(env.cfg, sy.tasks, () => now);
  const port: TaskLeases = {
    renew: input => real.renew(input), finish: input => real.finish(input), interrupt: input => real.interrupt(input), defer: input => real.defer(input), recover: input => real.recover(input), cancel: input => real.cancel(input), drain: () => real.drain(), ...overrides
  };
  const settled = vi.fn();
  executor = new Executor({
    cfg: env.cfg, db: sy.db, gate: sy.gate, catalog: sy.catalog, router: sy.router, tasks: sy.tasks, artifacts: sy.artifacts, owner: 'same-owner', now: () => now, coding, brain: sy.brain, access: sy.brainAccess, services: null, supervisor: null, sessions: null, contracts: sy.contracts, onSettled: settled, taskLeases: port
  });
  const reports = vi.spyOn(sy.brain, 'writeReport');
  return {
    real, port, client, settled, reports
  };
}
function submit(id = 'fixture', coding = false) {
  sy!.tasks.submit([WorkerTaskSchema.parse(coding ? {
      id, profile: 'implement', goal: 'fixture', repositoryAliases: ['core'], writableRepository: 'core', hints: { difficulty: 'T2' }, constraints: {
        acceptanceCriteria: ['fixture'], allowedPaths: ['src/**']
      }
    } : summarizeTask({
      id, hints: { difficulty: 'T1' }
    }))], { project: 'demo' });
}
function claim() {
  return sy!.tasks.claim('same-owner', {
    maxConcurrent: 10, maxWritersPerRepo: 1, leaseMs: 10000, defaultTimeoutMs: 1000000
  });
}
it('reconciles a committed lost finish acknowledgement without repeating provider work or settled/report hooks', async () => {
  let calls = 0;
  const fixture = setup({ finish: async (input) => {
      const receipt = await fixture.real.finish(input);
      if (++calls === 1)
        throw new Error('ack lost after commit');
      return receipt;
    } });
  submit();
  const task = claim()[0]!;
  await executor!.runSingle(task);
  await executor!.flush();
  expect(calls).toBe(2);
  expect(fixture.client.requests).toHaveLength(1);
  expect(fixture.settled).toHaveBeenCalledTimes(1);
  expect(fixture.reports).toHaveBeenCalledTimes(1);
  expect(sy!.tasks.events(task.row.id).filter(event => event.type === 'completed')).toHaveLength(1);
});
it('a delayed old finish cannot settle or report over same-owner takeover', async () => {
  const entered = barrier(), blocked = barrier();
  const fixture = setup({ finish: async (input) => {
      entered.release();
      await blocked.promise;
      return fixture.real.finish(input);
    } });
  submit();
  const old = claim()[0]!, running = executor!.runSingle(old);
  await entered.promise;
  now += 10001;
  await fixture.real.recover({
    operationId: recoveryOperationId(now), mode: 'startup'
  });
  const current = claim()[0]!;
  blocked.release();
  await running;
  await executor!.flush();
  expect(current.row.run_count).toBe(2);
  expect(sy!.tasks.get(current.row.id)!.row.state).toBe('running');
  expect(fixture.settled).not.toHaveBeenCalled();
  expect(fixture.reports).not.toHaveBeenCalled();
  expect(fixture.client.requests).toHaveLength(1);
});
it('historical successful finish replay cannot publish into a deleted/recreated task incarnation', async () => {
  const entered = barrier(), blocked = barrier();
  const coding = { run: async () => ({
      state: 'completed' as const, result: baseResult({
        executionStatus: 'completed', summary: 'fixture'
      })
    }) };
  let first: LeaseReceipt | undefined;
  const fixture = setup({ finish: async (input) => {
      first = await fixture.real.finish(input);
      entered.release();
      await blocked.promise;
      return fixture.real.finish(input);
    } }, coding);
  submit('fixture', true);
  sy!.db.prepare("UPDATE tasks SET purpose='qualification' WHERE id='fixture'").run();
  const old = claim()[0]!, running = executor!.runSingle(old);
  await entered.promise;
  expect(first?.disposition).toBe('applied');
  for (const table of ['file_leases', 'events', 'task_contracts'])
    sy!.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(old.row.id);
  sy!.db.prepare('DELETE FROM tasks WHERE id=?').run(old.row.id);
  submit('fixture', true);
  const current = claim()[0]!;
  expect(current.row.lease_incarnation).not.toBe(old.row.lease_incarnation);
  blocked.release();
  await running;
  await executor!.flush();
  expect(sy!.tasks.get('fixture')!.row.state).toBe('running');
  expect(fixture.settled).not.toHaveBeenCalled();
  expect(fixture.reports).not.toHaveBeenCalled();
});
it('serializes delayed renewals and drains the in-flight receipt before removing its own controller', async () => {
  const entered = barrier(), blocked = barrier();
  let active = 0, peak = 0, calls = 0;
  const fixture = setup({ renew: async (input) => {
      calls++;
      peak = Math.max(peak, ++active);
      entered.release();
      await blocked.promise;
      try {
        return await fixture.real.renew(input);
      }
      finally {
        active--;
      }
    } });
  submit();
  const task = claim()[0]!, coordinator = new TaskRunLeases({
    cfg: env!.cfg, tasks: sy!.tasks, now: () => now, onSettled: fixture.settled, taskLeases: fixture.port
  });
  const controller = new AbortController();
  coordinator.controllers.set(task.row.id, controller);
  vi.useFakeTimers();
  const stop = coordinator.supervise(task, controller);
  await vi.advanceTimersByTimeAsync(2500);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10000);
  expect(calls).toBe(1);
  expect(peak).toBe(1);
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  now += 10001;
  blocked.release();
  await stopping;
  await coordinator.drain();
  expect(controller.signal.aborted).toBe(true);
  expect(coordinator.controllers.size).toBe(0);
});
it('a delayed logical cancellation and old renewal cannot abort the newer local controller', async () => {
  const entered = barrier(), blocked = barrier();
  const fixture = setup({ cancel: async (input) => {
      entered.release();
      await blocked.promise;
      return fixture.real.cancel(input);
    } });
  submit();
  const old = claim()[0]!, coordinator = new TaskRunLeases({
    cfg: env!.cfg, tasks: sy!.tasks, now: () => now, onSettled: fixture.settled, taskLeases: fixture.port
  });
  const oldController = new AbortController();
  coordinator.controllers.set(old.row.id, oldController);
  const stopOld = coordinator.supervise(old, oldController);
  const cancelling = coordinator.cancelTasksAsync([old.row.id], 'demo');
  await entered.promise;
  now += 10001;
  await fixture.real.recover({
    operationId: recoveryOperationId(now), mode: 'startup'
  });
  const newer = claim()[0]!;
  const newController = new AbortController();
  coordinator.controllers.set(newer.row.id, newController);
  const stopNew = coordinator.supervise(newer, newController);
  blocked.release();
  await cancelling;
  coordinator.abortLease(capturedLease(old), 'cancel');
  await stopOld();
  expect(newController.signal.aborted).toBe(false);
  expect(coordinator.controllers.get(newer.row.id)).toBe(newController);
  expect(sy!.tasks.get(newer.row.id)!.row.state).toBe('running');
  await stopNew();
  await coordinator.drain();
});
it('awaits one durable finish per actual batch member', async () => {
  let finishes = 0;
  const fixture = setup({ finish: async (input) => {
      finishes++;
      return fixture.real.finish(input);
    } });
  submit('one');
  submit('two');
  const members = claim();
  await executor!.runBatch(members);
  await executor!.flush();
  expect(finishes).toBe(2);
  expect(fixture.settled).toHaveBeenCalledTimes(2);
  for (const member of members)
    expect(sy!.tasks.get(member.row.id)!.row.state).toBe('completed');
});
it('default service close drains an awaited cancellation receipt before closing SQLite', async () => {
  setup();
  submit();
  claim();
  const serviceExecutor = (sy! as unknown as {
    executor: Executor;
  }).executor;
  const original = serviceExecutor.taskLeases.cancel.bind(serviceExecutor.taskLeases), entered = barrier(), blocked = barrier();
  vi.spyOn(serviceExecutor.taskLeases, 'cancel').mockImplementation(async (input) => {
    entered.release();
    await blocked.promise;
    return original(input);
  });
  const cancel = sy!.cancelTasksAsync(['fixture']);
  await entered.promise;
  let closed = false;
  const close = sy!.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(sy!.db.open).toBe(true);
  blocked.release();
  await cancel;
  await close;
  expect(sy!.db.open).toBe(false);
  sy = undefined;
});
it('default close drains explicit delayed recovery and rejects new async controls after close begins', async () => {
  setup();
  const serviceExecutor = (sy! as unknown as {
    executor: Executor;
  }).executor;
  const original = serviceExecutor.taskLeases.recover.bind(serviceExecutor.taskLeases), entered = barrier(), blocked = barrier();
  vi.spyOn(serviceExecutor.taskLeases, 'recover').mockImplementation(async (input) => {
    entered.release();
    await blocked.promise;
    return original(input);
  });
  const recovery = sy!.recoverAsync();
  await entered.promise;
  let closed = false;
  const close = sy!.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(sy!.db.open).toBe(true);
  await expect(sy!.recoverAsync()).rejects.toThrow(/closing/);
  await expect(sy!.cancelTasksAsync([])).rejects.toThrow(/closing/);
  blocked.release();
  await recovery;
  await close;
  expect(sy!.db.open).toBe(false);
  sy = undefined;
});
it.each(['kind', 'operationId'] as const)('refuses delayed recovery receipt with mismatched %s before session/recovery hooks', async (field) => {
  setup();
  const serviceExecutor = (sy! as unknown as {
    executor: Executor;
  }).executor;
  const original = serviceExecutor.taskLeases.recover.bind(serviceExecutor.taskLeases), entered = barrier(), blocked = barrier();
  const deadSessions = vi.spyOn(sy!.sessions, 'markDeadRunning');
  vi.spyOn(serviceExecutor.taskLeases, 'recover').mockImplementation(async (input) => {
    const receipt = await original(input);
    entered.release();
    await blocked.promise;
    return { ...receipt, ...(field === 'kind' ? { kind: 'renew' as const } : { operationId: recoveryOperationId(now) }) };
  });
  const pending = sy!.recoverAsync();
  await entered.promise;
  const refused = expect(pending).rejects.toThrow(field === 'kind' ? /receipt key must match its operation kind/ : /recovery receipt identity mismatch/);
  blocked.release();
  await refused;
  expect(deadSessions).not.toHaveBeenCalled();
});
it('refuses a foreign defer receipt without settled/report hooks', async () => {
  const fixture = setup({ defer: async (input) => ({ operationId: input.operationId, kind: 'finish', disposition: 'applied', original: 'applied', serverNow: now, lease: input.lease, affected: [] }) }, { run: async () => {
      throw new GatewayError('pool_exhausted', 'fixture', 503, 1);
    } });
  submit('fixture', true);
  sy!.db.prepare("UPDATE tasks SET purpose='qualification' WHERE id='fixture'").run();
  const task = claim()[0]!;
  await expect(executor!.runSingle(task)).rejects.toThrow(/defer receipt identity mismatch/);
  expect(fixture.settled).not.toHaveBeenCalled();
  expect(fixture.reports).not.toHaveBeenCalled();
});
it('refuses an unrelated interrupt operation receipt without settled/report hooks', async () => {
  const entered = barrier(), blocked = barrier();
  const fixture = setup({ interrupt: async (input) => ({ operationId: leaseOperationId(now), kind: 'interrupt', disposition: 'applied', original: 'applied', serverNow: now, lease: input.lease, affected: [] }) }, { run: async () => {
      entered.release();
      await blocked.promise;
      throw new GatewayError('aborted', 'fixture');
    } });
  submit('fixture', true);
  sy!.db.prepare("UPDATE tasks SET purpose='qualification' WHERE id='fixture'").run();
  const task = claim()[0]!, pending = executor!.runSingle(task);
  await entered.promise;
  executor!.abortAll('shutdown');
  const refused = expect(pending).rejects.toThrow(/interrupt receipt identity mismatch/);
  blocked.release();
  await refused;
  expect(fixture.settled).not.toHaveBeenCalled();
  expect(fixture.reports).not.toHaveBeenCalled();
});
