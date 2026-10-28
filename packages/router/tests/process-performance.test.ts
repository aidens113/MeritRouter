import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import YAML from 'yaml';
import Database from 'better-sqlite3';
import { WorkerTaskSchema } from '../src/core/task.js';
import { liveChanges, liveCursor } from '../src/admin/live.js';
import { archiveProject, deleteProject } from '../src/admin/projects.js';
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask } from './helpers.js';

const percentile = (samples: number[], q: number) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * q) - 1]!;
const measure = (run: () => void) => { const start = performance.now(); run(); return performance.now() - start; };
const projectsConfig = () => baseConfig({ repositories: {}, brain: { path: 'brain', project: 'alpha' }, projects: {
  alpha: { repositories: { core: { path: 'repo' } } }, beta: { repositories: {} },
} });

it('measures bounded task throughput at concurrency 1 and 4 without lost or double work', async () => {
  const metrics: Array<Record<string, number>> = [];
  for (const concurrency of [1, 4]) {
    const count = 24;
    let active = 0, peak = 0;
    const responseMs: number[] = [];
    const client = new ScriptedClient(async () => {
      const start = performance.now();
      active++; peak = Math.max(peak, active);
      try { await new Promise(r => setTimeout(r, 25)); return reply(JSON.stringify({ summary: 'done', findings: [], criteria: [{ index: 0, status: 'met', evidenceRefs: ['inline'] }] })); }
      finally { active--; responseMs.push(performance.now() - start); }
    });
    const env = makeEnv({ config: baseConfig({
      execution: { max_concurrent_tasks: concurrency, lease_seconds: 30 },
      team: { provider_concurrency_start: concurrency, provider_concurrency_max: concurrency },
      profiles: { summarize: { mode: 'completion', min_total_parameters_b: 30, max_model_requests: 2, classify: 'never', batching: { enabled: false } } },
    }) });
    const sy = open(env, client, { worker: true });
    try {
      const start = performance.now();
      const tasks = await sy.submitTasks(Array.from({ length: count }, (_, i) => summarizeTask({ label: `load-${concurrency}-${i}` })));
      const completedAt = new Map<string, number>();
      const deadline = Date.now() + 30000;
      while (completedAt.size < count) {
        for (const row of sy.getStatus(tasks.map(t => t.taskId))) {
          if (row.state === 'completed' && !completedAt.has(row.taskId)) completedAt.set(row.taskId, performance.now() - start);
          expect(['failed', 'cancelled', 'budget_exhausted']).not.toContain(row.state);
        }
        if (Date.now() > deadline) throw new Error('bounded throughput fixture timed out');
        if (completedAt.size < count) await new Promise(r => setTimeout(r, 5));
      }
      const elapsed = performance.now() - start;
      const claims = sy.db.prepare("SELECT task_id, COUNT(*) AS n FROM events WHERE type='claimed' GROUP BY task_id").all() as Array<{ task_id: string; n: number }>;
      expect(claims).toHaveLength(count);
      expect(claims.every(row => row.n === 1)).toBe(true);
      expect(client.requests).toHaveLength(count);
      expect(peak).toBe(concurrency);
      expect(sy.db.prepare('SELECT COUNT(*) AS n FROM request_charges').get()).toEqual({ n: count });
      metrics.push({ tasks: count, concurrency, elapsedMs: elapsed, tasksPerSecond: count / elapsed * 1000,
        taskLatencyP50Ms: percentile([...completedAt.values()], .5), taskLatencyP95Ms: percentile([...completedAt.values()], .95),
        fakeResponseP50Ms: percentile(responseMs, .5), fakeResponseP95Ms: percentile(responseMs, .95), providerPeak: peak });
    } finally {
      // close() drains every pending worker report into the Brain: one selected commit per task.
      const closing = performance.now();
      await sy.close(); env.cleanup();
      const measured = metrics.find(m => m.concurrency === concurrency);
      if (measured) measured.closeDrainMs = performance.now() - closing;
    }
  }
  console.log('PROCESS_PERFORMANCE_THROUGHPUT', JSON.stringify(metrics));
  // Budget. Task throughput itself is about 6 s per round (24 tasks). Each round's close() then
  // drains 24 serialized Brain report commits of about 50 Git child processes each, measured at
  // 1.5-1.9 s per commit on Windows (tests/brain-commit-performance.test.ts budgets that cost).
  // Measured alone on a loaded host: about 41 s of drain per round, about 95 s for the test.
}, 180_000);

it('measures quiet and write watcher ticks on a 61000-row historical store with scoped invalidation', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  const writer = new Database(sy.db.name);
  try {
    const insert = sy.db.prepare("INSERT INTO tasks(id,profile,spec_json,spec_hash,state,created_at,updated_at,run_count,cancel_requested,project_id) VALUES (?,'summarize',?,'fixture','completed',?,?,0,0,?)");
    const spec = JSON.stringify(WorkerTaskSchema.parse(summarizeTask()));
    const session = sy.db.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,created_at,updated_at,ended_at,project_id) VALUES (?,?,'worker','fixture','summarize','completed',?,?,?,?,?)");
    const event = sy.db.prepare("INSERT INTO events(task_id,ts,type,data_json,project_id) VALUES (?,?,'completed','{}',?)");
    const request = sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,finished_at,est_input_tokens,reserved_output_tokens,input_tokens,output_tokens,project_id) VALUES (?,'bench_execution','runner','fixture/model','succeeded',?,?,100,50,100,50,?)");
    const charge = sy.db.prepare('INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact) VALUES (?,?,100,50,1)');
    const budget = sy.db.prepare("INSERT INTO budget_requests(task_id,project_id,role,requests,reason,used,cap,approver,status,granted,created_at,decided_at) VALUES (?,?,'worker',2,'historical fixture',1,2,'human','approved',2,?,?)");
    sy.db.transaction(() => {
      sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at,finished_at) VALUES ('bench_execution','task','summarize','completed',1000,20000)").run();
      for (let i = 0; i < 10000; i++) {
        const id = `bench_${i}`, project = i % 2 ? 'alpha' : 'beta', at = 1000 + i;
        insert.run(id, spec, at, at, project);
        session.run(`bench_session_${i}`, id, `sessions/bench_session_${i}.jsonl`, at, at, at, project);
        event.run(id, at, project); event.run(id, at + 1, project);
        request.run(`bench_request_${i}`, at, at + 1, project);
        charge.run(`bench_request_${i}`, id);
        if (i < 1000) budget.run(id, project, at, at + 1);
      }
    })();
    const setup = performance.now();
    let alpha = liveCursor(sy, 'alpha', 50000);
    let beta = liveCursor(sy, 'beta', 50000);
    const initialMs = performance.now() - setup;
    const quiet: number[] = [], writes: number[] = [];
    for (let i = 0; i < 50; i++) quiet.push(measure(() => {
      const checked = liveChanges(sy, alpha, 50000); expect(checked.topics).toEqual([]); alpha = checked.cursor;
    }));
    for (let i = 0; i < 10; i++) {
      writer.prepare("UPDATE tasks SET state_reason=? WHERE id='bench_9999'").run(`external-write-${i}`);
      writes.push(measure(() => { const checked = liveChanges(sy, alpha, 50000); expect(checked.topics).toContain('tasks:*'); alpha = checked.cursor; }));
      const other = liveChanges(sy, beta, 50000);
      expect(other.topics).not.toContain('tasks'); expect(other.topics).not.toContain('tasks:*'); beta = other.cursor;
    }
    console.log('PROCESS_PERFORMANCE_WATCHER', JSON.stringify({ tasks: 10000, sessions: 10000, events: 20000, requests: 10000, charges: 10000, budgetRequests: 1000, projects: 2, quietTicks: 50, writeTicks: 10, initialTwoCursorsMs: initialMs,
      quietP50Ms: percentile(quiet, .5), quietP95Ms: percentile(quiet, .95), writeP50Ms: percentile(writes, .5), writeP95Ms: percentile(writes, .95) }));
  } finally { writer.close(); await sy.close(); env.cleanup(); }
}, 30000);

it('revalidates a concurrent queued submission before deleting project rows', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  const other = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    const deleting = deleteProject(sy, 'beta', { confirm: 'beta' });
    const [submitted] = other.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: 'concurrent_submission' }))], { project: 'beta' });
    await expect(deleting).rejects.toThrow(/running.*queued/);
    expect(sy.tasks.get(submitted!.taskId)!.row.state).toBe('queued');
    expect(YAML.parse(readFileSync(env.cfg.configPath, 'utf8')).projects).toHaveProperty('beta');
  } finally { await other.close(); await sy.close(); env.cleanup(); }
});

it('revalidates the remaining live project after concurrent archive', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  const other = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    const deleting = deleteProject(sy, 'beta', { confirm: 'beta' });
    archiveProject(other, 'alpha');
    await expect(deleting).rejects.toThrow(/last project|only project/);
    expect(YAML.parse(readFileSync(env.cfg.configPath, 'utf8')).projects).toHaveProperty('beta');
  } finally { await other.close(); await sy.close(); env.cleanup(); }
});

it('refuses one of two concurrent deletions so a live project remains', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  const other = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    const results = await Promise.allSettled([
      deleteProject(sy, 'alpha', { confirm: 'alpha' }),
      deleteProject(other, 'beta', { confirm: 'beta' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const configured = Object.keys(YAML.parse(readFileSync(env.cfg.configPath, 'utf8')).projects);
    expect(configured).toHaveLength(1);
    const live = sy.db.prepare('SELECT id FROM projects WHERE archived_at IS NULL').all() as Array<{ id: string }>;
    expect(live.map(p => p.id)).toEqual(configured);
  } finally { await other.close(); await sy.close(); env.cleanup(); }
});

it('preserves project rows and settings when the config backup write fails', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: 'retained_on_config_failure' }))], { project: 'beta' });
    sy.db.prepare("UPDATE tasks SET state='completed' WHERE id='retained_on_config_failure'").run();
    const before = readFileSync(env.cfg.configPath, 'utf8');
    mkdirSync(`${env.cfg.configPath}.bak`);
    await expect(deleteProject(sy, 'beta', { confirm: 'beta' })).rejects.toThrow();
    expect(sy.tasks.get('retained_on_config_failure')).toBeDefined();
    expect(readFileSync(env.cfg.configPath, 'utf8')).toBe(before);
  } finally { await sy.close(); env.cleanup(); }
});

it('refuses a stale deletion snapshot when the config changes during footprint discovery', async () => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    const deleting = deleteProject(sy, 'beta', { confirm: 'beta' });
    const changed = `${readFileSync(env.cfg.configPath, 'utf8')}\n# Concurrent external editor change\n`;
    writeFileSync(env.cfg.configPath, changed);
    await expect(deleting).rejects.toThrow(/config.*changed/i);
    expect(readFileSync(env.cfg.configPath, 'utf8')).toBe(changed);
    expect(sy.db.prepare("SELECT id FROM projects WHERE id='beta'").get()).toEqual({ id: 'beta' });
  } finally { await sy.close(); env.cleanup(); }
});

it.each([false, true])('rolls back a failed purge and preserves a newer editor change: %s', async externalEdit => {
  const env = makeEnv({ config: projectsConfig() });
  const sy = open(env, new ScriptedClient(() => reply('unused')), { worker: false });
  try {
    sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: 'retained_on_purge_failure' }))], { project: 'beta' });
    sy.db.prepare("UPDATE tasks SET state='completed' WHERE id='retained_on_purge_failure'").run();
    const original = readFileSync(env.cfg.configPath, 'utf8');
    const edited = `${original}\n# Newer editor text survives failed purge\n`;
    sy.db.function('fixture_purge_failure', () => {
      if (externalEdit) writeFileSync(env.cfg.configPath, edited);
      throw new Error('fixture purge failure');
    });
    sy.db.exec("CREATE TRIGGER fixture_fail_purge BEFORE DELETE ON tasks WHEN OLD.id='retained_on_purge_failure' BEGIN SELECT fixture_purge_failure(); END");
    await expect(deleteProject(sy, 'beta', { confirm: 'beta' })).rejects.toThrow();
    expect(sy.tasks.get('retained_on_purge_failure')!.row.state).toBe('completed');
    expect(readFileSync(env.cfg.configPath, 'utf8')).toBe(externalEdit ? edited : original);
    expect(sy.db.prepare("SELECT id FROM projects WHERE id='beta'").get()).toEqual({ id: 'beta' });
  } finally { await sy.close(); env.cleanup(); }
});
