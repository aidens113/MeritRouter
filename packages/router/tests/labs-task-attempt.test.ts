import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { baseConfig, makeEnv, commitAll, type Env } from "./helpers.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { ProjectConfigSchema } from "../src/projects/schema.js";
import { LabRecipeSchema } from "../src/labs/recipe.js";
import { TaskLabLifecycle } from "../src/labs/task-attempt.js";
import { processAlive, processOwnership, stopOwnedProcess } from "../src/labs/process-ownership.js";
import { portAvailable } from "../src/labs/ports.js";
import type { TaskAttemptHandle, RegisterTaskAttempt } from "../src/labs/task-attempt-schema.js";
let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined;
afterEach(async () => {
  if (manager) {
    for (const request of manager.taskAttempts.store.all()) {
      if (request.phase !== "pruned")
        await manager.taskAttempts.runner.stop(manager.taskAttempts.store.get(request.attemptId));
    }
    await manager.close();
  }
  db?.close();
  env?.cleanup();
  manager = undefined;
  db = undefined;
  env = undefined;
});
const NODE = JSON.stringify(process.execPath);
const SERVER = `const fs=require('node:fs'),http=require('node:http');fs.writeFileSync(process.env.DATA_DIR+'/identity',process.env.LAB_NAME);http.createServer((q,r)=>r.end(fs.readFileSync('value.txt','utf8'))).listen(Number(process.env.PORT),'127.0.0.1');`;
const CHECK = `const fs=require('node:fs');fetch('http://127.0.0.1:'+process.env.PORT).then(r=>r.text()).then(t=>{if(t!==fs.readFileSync('value.txt','utf8'))process.exit(2);console.log(t)}).catch(()=>process.exit(3));`;
function setup(over: Record<string, unknown> = {}) {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: 'brain', project: 'alpha' }, labs: { port_range: [58000, 58500], max_active: 2, service_ready_timeout_seconds: 10, check_timeout_seconds: 3, keep_task_worktrees_days: 0 }, projects: { alpha: { repositories: { app: { path: 'repo' } }, labs: { ephemeral: { enabled: true, checks: ['health', 'failure', 'slow'] } }, lab: { ports: ['web'], data: ['db'], env: { PORT: '{port.web}', DATA_DIR: '{lab.data.db}' }, services: { web: { repo: 'app', command: `${NODE} server.cjs`, ready: { http: 'http://127.0.0.1:{port.web}/' } } }, checks: { health: `${NODE} check.cjs`, failure: `${NODE} -e "process.exit(2)"`, slow: `${NODE} -e "require('node:fs').writeFileSync(process.env.DATA_DIR+'/check-started','running');setTimeout(()=>{},30000)"` } } }, ...over } }), files: { 'server.cjs': SERVER, 'check.cjs': CHECK, 'value.txt': 'initial' } });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: s => registry.require(s), monitor: false });
  return manager;
}
async function prepare(id: string, value = id): Promise<{
  handle: TaskAttemptHandle;
  input: RegisterTaskAttempt;
  worktree: string;
  commit: string;
  tree: string;
  digest: string;
}> {
  const spec = WorkerTaskSchema.parse({ id, profile: 'implement', goal: 'change fixture value', repositoryAliases: ['app'], writableRepository: 'app', constraints: { allowedPaths: ['value.txt'], acceptanceCriteria: ['works'] } });
  new TaskStore(db!).submit([spec], { project: 'alpha' });
  db!.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,run_count=1,deadline_at=? WHERE id=?").run(Date.now() + 120000, Date.now() + 120000, id);
  const base = (await git(env!.repo, ['rev-parse', 'HEAD'])).trim(), workspace = await new Worktrees(db!, path.join(env!.cfg.storageDir, 'worktrees')).prepare({ taskId: id, run: 1, alias: 'app', sourcePath: env!.repo, baseCommit: base });
  writeFileSync(path.join(workspace.worktreePath, 'value.txt'), value);
  commitAll(workspace.worktreePath, `fixture change\n\nAgent: fixture\nModel: fake/model\nTask: ${id}`);
  const commit = (await git(workspace.worktreePath, ['rev-parse', 'HEAD'])).trim(), tree = (await git(workspace.worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim(), executionId = 'execution-' + id, sessionId = 'session-' + id;
  db!.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'task','implement','running',?)").run(executionId, Date.now());
  db!.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,?,?)").run(executionId, id, id);
  db!.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at) VALUES(?,?,'implementer','fixture','implement','running','fixture',?,?,?)").run(sessionId, id, JSON.stringify({ repos: [{ alias: 'app', worktree: workspace.worktreePath, branch: null, baseCommit: base, head: commit }] }), Date.now(), Date.now());
  const input: RegisterTaskAttempt = { taskId: id, project: 'alpha', runCount: 1, leaseOwner: 'worker', executionId, sessionId, sourceWorktree: workspace.worktreePath, writableAlias: 'app', repositories: [{ alias: 'app', sourcePath: env!.repo, baseCommit: base, head: commit }] };
  const handle = await manager!.taskAttempts.register(input), digest = createHash('sha256').update(await git(workspace.worktreePath, ['diff', '--binary', base, commit])).digest('hex');
  await manager!.taskAttempts.submit(handle, { commit, tree, patchDigest: digest });
  return { handle, input, worktree: workspace.worktreePath, commit, tree, digest };
}
it('runs two real isolated attempts with exact source heads, distinct resources and retained evidence, without mutating source or target', async () => {
  const m = setup(), a = await prepare('first'), b = await prepare('second'), target = (await git(env!.repo, ['rev-parse', 'HEAD'])).trim();
  const oa = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] }), ob = m.taskAttempts.requestCheck(b.handle, { checks: ['health'] });
  expect(m.store.list()).toHaveLength(0);
  await m.processControls();
  const [ra, rb] = await Promise.all([m.taskAttempts.wait(a.handle, oa.id), m.taskAttempts.wait(b.handle, ob.id)]);
  expect(ra.status, JSON.stringify(db!.prepare("SELECT * FROM lab_events WHERE type='task_attempt_failed'").all())).toBe('passed');
  expect(rb.status).toBe('passed');
  expect(ra.cleanup).toBe('complete');
  expect(ra.heads.app).toBe(a.commit);
  expect(ra.submittedTree).toBe(a.tree);
  expect(ra.checks[0]!.stdout).toContain('first');
  expect(rb.checks[0]!.stdout).toContain('second');
  const la = m.store.byId(ra.labId)!, lb = m.store.byId(rb.labId)!;
  expect(la.root).not.toBe(lb.root);
  expect(readFileSync(path.join(la.root, 'data', 'db', 'identity'), 'utf8')).toBe(la.name);
  expect(la.repositories[0]!.branch).not.toBe(lb.repositories[0]!.branch);
  expect(await portAvailable(la.ports.web!)).toBe(true);
  expect(db!.prepare('SELECT 1 FROM lab_ports').get()).toBeUndefined();
  expect((await git(env!.repo, ['rev-parse', 'HEAD'])).trim()).toBe(target);
  expect((await git(a.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(a.commit);
  expect(existsSync(la.repositories[0]!.worktree)).toBe(true);
  expect(m.taskAttempts.processes.rows(la.id)).toHaveLength(0);
  await expect(m.start('alpha', la.name)).rejects.toThrow(/task Labs/);
  await expect(m.promote('alpha', la.name, { by: 'human' })).rejects.toThrow(/task Labs/);
  expect(() => m.requestControl('alpha', la.name, { kind: 'destroy' })).toThrow(/task-owned/);
}, 120000);
it('requires persisted execution/session, exact physical source, generation and attributed immutable tree', async () => {
  const m = setup(), a = await prepare('scoped');
  await expect(m.taskAttempts.register({ ...a.input, executionId: 'forged' })).rejects.toThrow(/membership/);
  await expect(m.taskAttempts.register({ ...a.input, sourceWorktree: env!.repo })).rejects.toThrow(/session/);
  await expect(m.taskAttempts.register({ ...a.input, project: 'other' })).rejects.toThrow(/generation/);
  await expect(m.taskAttempts.submit({ ...a.handle, runCount: 2 }, { commit: a.commit, tree: a.tree, patchDigest: a.digest })).rejects.toThrow(/identity/);
  expect(() => m.taskAttempts.requestCheck(a.handle, { checks: ['undeclared'] })).toThrow(/allowlist/);
  db!.prepare("UPDATE tasks SET run_count=2 WHERE id=?").run(a.handle.taskId);
  expect(() => m.taskAttempts.requestCheck(a.handle, { checks: ['health'] })).toThrow(/generation/);
}, 30000);
it('fails commands and times out auxiliary checks, then stops every owned process and releases reservations', async () => {
  const m = setup(), a = await prepare('bad'), op = m.taskAttempts.requestCheck(a.handle, { checks: ['failure', 'slow'] });
  await m.processControls();
  const result = await m.taskAttempts.wait(a.handle, op.id);
  expect(result.status).toBe('failed');
  expect(result.checks.map(r => r.exitCode)).toEqual([2, null]);
  expect(result.checks[1]!.killed).toBe('timeout');
  expect(result.cleanup).toBe('complete');
  expect(m.taskAttempts.processes.rows(result.labId)).toHaveLength(0);
  expect(db!.prepare('SELECT 1 FROM lab_ports').get()).toBeUndefined();
}, 90000);
it('cancels an operation through persisted task intent and never restarts retained task services', async () => {
  const m = setup(), a = await prepare('cancel'), op = m.taskAttempts.requestCheck(a.handle, { checks: ['slow'] });
  const work = m.processControls();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && m.taskAttempts.store.lab(a.handle.id)?.phase !== 'checking')
    await new Promise(r => setTimeout(r, 40));
  db!.prepare("UPDATE tasks SET state='cancel_requested',cancel_requested=1 WHERE id=?").run(a.handle.taskId);
  await work;
  const result = await m.taskAttempts.wait(a.handle, op.id);
  expect(result.cleanup).toBe('complete');
  expect(result.status).not.toBe('passed');
  await m.recover();
  expect(m.taskAttempts.processes.rows(result.labId)).toHaveLength(0);
}, 90000);
it('retains branches and evidence until terminal safe pruning, without deleting the coding source worktree', async () => {
  const m = setup(), a = await prepare('prune'), op = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] });
  await m.processControls();
  const result = await m.taskAttempts.wait(a.handle, op.id), lab = m.store.byId(result.labId)!;
  expect(await m.taskAttempts.prune()).toEqual([]);
  db!.prepare("UPDATE tasks SET state='completed',finished_at=? WHERE id=?").run(Date.now(), a.handle.taskId);
  expect(await m.taskAttempts.prune(Date.now() + 1000)).toEqual([lab.id]);
  expect(existsSync(lab.root)).toBe(false);
  expect(existsSync(a.worktree)).toBe(true);
  expect((await git(env!.repo, ['rev-parse', 'refs/heads/' + lab.repositories[0]!.branch])).trim()).toBe(a.commit);
  expect(m.taskAttempts.store.lab(a.handle.id)!.result!.checks).toHaveLength(1);
}, 90000);
for (const phase of ['spawn_before_registration', 'granted'])
  it('recovers an actually killed owner at ' + phase + ' and preserves foreign listeners, source and durable evidence', async () => {
    const m = setup(), a = await prepare('killed-' + phase.replaceAll('_', '-')), op = m.taskAttempts.requestCheck(a.handle, { checks: ['slow'] });
    const barrier = path.join(env!.dir, 'kill-barrier.json'), token = randomBytes(24).toString('hex');
    const foreign = createServer((_q, r) => r.end('foreign'));
    await new Promise<void>(r => foreign.listen(0, '127.0.0.1', r));
    const foreignAddress = foreign.address();
    if (!foreignAddress || typeof foreignAddress === 'string')
      throw new Error('fixture failed');
    const fixture = fileURLToPath(new URL('./fixtures/task-lab-owner.mjs', import.meta.url));
    const child = spawn(process.execPath, [fixture, env!.cfg.configPath, phase, barrier, 'SWITCHYARD_LAB_HOST_V1', `--sy-lab-token=${token}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', b => diagnostics += b);
    let killed = false;
    try {
      const deadline = Date.now() + 30000;
      while (!existsSync(barrier) && Date.now() < deadline && child.exitCode === null)
        await new Promise(r => setTimeout(r, 50));
      expect(existsSync(barrier), diagnostics).toBe(true);
      expect(await processOwnership(child.pid!, token)).toBe('owned');
      child.kill();
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      killed = true;
      const request = m.taskAttempts.store.lab(a.handle.id)!, lab = m.store.byId(request.labId!)!, before = m.taskAttempts.processes.rows(lab.id);
      expect(before.some(r => r.kind === 'check')).toBe(true);
      if (phase === 'spawn_before_registration')
        expect(before.find(r => r.kind === 'check')!.pid).toBeNull();
      // The fixture clock changes only its isolated operation lease, never user/global state.
      db!.prepare("UPDATE task_lab_operations SET lease_until=0 WHERE id=?").run(op.id);
      await m.recover();
      await m.recover();
      const result = await m.taskAttempts.wait(a.handle, op.id);
      expect(result.status).not.toBe('passed');
      expect(result.cleanup).toBe('complete');
      expect(m.taskAttempts.processes.rows(lab.id)).toHaveLength(0);
      expect(await portAvailable(lab.ports.web!)).toBe(true);
      expect(db!.prepare('SELECT 1 FROM lab_ports').get()).toBeUndefined();
      expect(await (await fetch('http://127.0.0.1:' + foreignAddress.port)).text()).toBe('foreign');
      expect(existsSync(a.worktree)).toBe(true);
      expect(existsSync(lab.root)).toBe(true);
      expect((await git(a.worktree, ['rev-parse', 'HEAD'])).trim()).toBe(a.commit);
    }
    finally {
      if (!killed && child.exitCode === null) {
        if (await processOwnership(child.pid!, token) === 'owned') {
          child.kill();
          await new Promise<void>(r => child.once('exit', () => r()));
        }
      }
      await new Promise<void>(r => foreign.close(() => r()));
      db!.prepare('UPDATE task_lab_operations SET lease_until=0 WHERE id=?').run(op.id);
      await m.recover();
    }
  }, 120000);
it('enforces the human allowlist and explicitly refuses browser attempts, forged foreign Git sources and task-team binding', async () => {
  const m = setup(), a = await prepare('policy'), project = ProjectConfigSchema.parse(env!.cfg.projects.alpha);
  env!.cfg.projects.alpha = project;
  project.labs.ephemeral.enabled = false;
  expect(() => m.taskAttempts.requestCheck(a.handle, { checks: ['health'] })).toThrow(/allowlist/);
  project.labs.ephemeral.enabled = true;
  project.labs.ephemeral.checks.push('browser');
  project.lab = LabRecipeSchema.parse({ ...project.lab, checks: { ...project.lab!.checks, browser: { kind: 'browser', mode: 'static', service: 'web', executable: process.execPath, assertions: [{ kind: 'exists', selector: 'h1' }] } } });
  expect(() => m.taskAttempts.requestCheck(a.handle, { checks: ['browser'] })).toThrow(/durable browser recovery/);
  const foreign = makeEnv();
  try {
    await expect(m.taskAttempts.register({ ...a.input, repositories: [{ ...a.input.repositories[0]!, sourcePath: foreign.repo }] })).rejects.toThrow(/physical Git/);
  }
  finally {
    foreign.cleanup();
  }
  expect(db!.prepare('SELECT 1 FROM task_lab_operations').get()).toBeUndefined();
}, 30000);
it('keeps two attempt UUIDs of one claimed task independent even after the latest workspace pointer changes', async () => {
  const m = setup(), a = await prepare('twins');
  const base = a.input.repositories[0]!.baseCommit;
  const ws = await new Worktrees(db!, path.join(env!.cfg.storageDir, 'worktrees')).prepare({ taskId: 'twins', run: 1, alias: 'app', sourcePath: env!.repo, baseCommit: base });
  writeFileSync(path.join(ws.worktreePath, 'value.txt'), 'second-attempt');
  commitAll(ws.worktreePath, 'second attempt\n\nAgent: fixture\nModel: fake/model\nTask: twins');
  const commit = (await git(ws.worktreePath, ['rev-parse', 'HEAD'])).trim(), tree = (await git(ws.worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim();
  db!.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES('second-execution','task','implement','running',?)").run(Date.now());
  db!.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES('second-execution','twins','twins')").run();
  db!.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at) VALUES('second-session','twins','implementer','fixture','implement','running','fixture',?,?,?)").run(JSON.stringify({ repos: [{ alias: 'app', worktree: ws.worktreePath, branch: null, baseCommit: base, head: commit }] }), Date.now(), Date.now());
  const handle = await m.taskAttempts.register({ ...a.input, executionId: 'second-execution', sessionId: 'second-session', sourceWorktree: ws.worktreePath, repositories: [{ ...a.input.repositories[0]!, head: commit }] });
  await m.taskAttempts.submit(handle, { commit, tree, patchDigest: createHash('sha256').update(await git(ws.worktreePath, ['diff', '--binary', base, commit])).digest('hex') });
  const first = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] }), second = m.taskAttempts.requestCheck(handle, { checks: ['health'] });
  await m.processControls();
  const [ra, rb] = await Promise.all([m.taskAttempts.wait(a.handle, first.id), m.taskAttempts.wait(handle, second.id)]);
  expect(ra.status).toBe('passed');
  expect(rb.status).toBe('passed');
  expect(ra.attemptId).not.toBe(rb.attemptId);
  expect(ra.heads.app).toBe(a.commit);
  expect(rb.heads.app).toBe(commit);
  expect(existsSync(a.worktree)).toBe(true);
  expect(existsSync(ws.worktreePath)).toBe(true);
}, 90000);
it('retains reservations and refuses success when foreign recorded process ownership makes cleanup ambiguous', async () => {
  const m = setup(), a = await prepare('foreign-proof'), op = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] });
  await m.processControls();
  const initial = await m.taskAttempts.wait(a.handle, op.id), lab = m.store.byId(initial.labId)!;
  db!.prepare("INSERT INTO lab_attempt_processes(id,lab_id,attempt_id,kind,logical_name,token,pid,directory,state,created_at,updated_at) VALUES('tap_foreign',?,?,'check','foreign',?,?,?,'running',?,?)").run(lab.id, a.handle.id, 'a'.repeat(48), process.pid, path.join(lab.root, 'processes', 'tap_foreign'), Date.now(), Date.now());
  db!.prepare("INSERT INTO lab_ports(port,lab_id,name) VALUES(?,?,?)").run(lab.ports.web!, lab.id, 'web');
  const cleanup = m.taskAttempts.cleanup(a.handle);
  await m.processControls();
  const blocked = await m.taskAttempts.wait(a.handle, cleanup.id);
  expect(blocked.cleanup).toBe('blocked');
  expect(blocked.status).not.toBe('passed');
  expect(processAlive(process.pid)).toBe(true);
  expect(db!.prepare('SELECT 1 FROM lab_ports WHERE lab_id=?').get(lab.id)).toBeDefined();
  expect(await m.taskAttempts.prune(Date.now() + 86400000)).toEqual([]);
  db!.prepare("DELETE FROM lab_attempt_processes WHERE id='tap_foreign'").run();
  await m.taskAttempts.recover();
  expect(m.taskAttempts.store.lab(a.handle.id)!.phase).toBe('retained');
  expect(db!.prepare('SELECT 1 FROM lab_ports WHERE lab_id=?').get(lab.id)).toBeUndefined();
}, 90000);
it('never resurrects an expired operation lease or settles success without takeover, then recovers under a newly acquired cleanup lease', async () => {
  const m = setup(), a = await prepare('expired-operation'), op = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] });
  let observedLease = Infinity;
  const expiring = new TaskLabLifecycle(m, async (phase, row) => {
    if (phase === 'registered_before_grant' && row.kind === 'check') {
      db!.prepare('UPDATE task_lab_operations SET lease_until=0 WHERE id=?').run(op.id);
      await new Promise(r => setTimeout(r, 400));
      observedLease = (db!.prepare('SELECT lease_until FROM task_lab_operations WHERE id=?').get(op.id) as {
        lease_until: number;
      }).lease_until;
    }
  });
  await expiring.process();
  expect(observedLease).toBe(0);
  const unsettled = db!.prepare('SELECT state,result_json,lease_until FROM task_lab_operations WHERE id=?').get(op.id) as {
    state: string;
    result_json: string | null;
    lease_until: number;
  };
  expect(unsettled.state).toBe('running');
  expect(unsettled.result_json).toBeNull();
  expect(unsettled.lease_until).toBe(0);
  expect(m.taskAttempts.store.lab(a.handle.id)!.result!.status).not.toBe('passed');
  expect(m.taskAttempts.store.lab(a.handle.id)!.phase).toBe('cleanup_blocked');
  await m.recover();
  const result = await m.taskAttempts.wait(a.handle, op.id);
  expect(result.status).not.toBe('passed');
  expect(result.cleanup).toBe('complete');
  await expiring.close();
}, 90000);
it('refuses forged cross-attempt repository paths during prune and preserves both attempts and coding sources', async () => {
  const m = setup(), a = await prepare('prune-owner'), b = await prepare('prune-other'), oa = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] }), ob = m.taskAttempts.requestCheck(b.handle, { checks: ['health'] });
  await m.processControls();
  const [ra, rb] = await Promise.all([m.taskAttempts.wait(a.handle, oa.id), m.taskAttempts.wait(b.handle, ob.id)]), la = m.store.byId(ra.labId)!, lb = m.store.byId(rb.labId)!, original = la.repositories;
  db!.prepare("UPDATE tasks SET state='completed',finished_at=? WHERE id=?").run(Date.now(), a.handle.taskId);
  m.store.save({ ...la, repositories: [{ ...original[0]!, worktree: lb.repositories[0]!.worktree }] });
  expect(await m.taskAttempts.prune(Date.now() + 1000)).toEqual([]);
  expect(existsSync(lb.repositories[0]!.worktree)).toBe(true);
  expect(existsSync(la.root)).toBe(true);
  expect(existsSync(a.worktree)).toBe(true);
  expect(existsSync(b.worktree)).toBe(true);
  m.store.save({ ...la, repositories: original });
}, 90000);
