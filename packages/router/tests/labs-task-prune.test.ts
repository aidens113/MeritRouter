import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { baseConfig, makeEnv, commitAll, type Env } from "./helpers.js";
import { openDatabase, newId, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import type { TaskAttemptHandle, RegisterTaskAttempt } from "../src/labs/task-attempt-schema.js";
let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (manager) {
    for (const request of manager.taskAttempts.store.all())
      if (request.phase !== "pruned") await manager.taskAttempts.runner.stop(manager.taskAttempts.store.get(request.attemptId));
    await manager.close();
  }
  db?.close(); env?.cleanup(); manager = undefined; db = undefined; env = undefined;
});
const NODE = JSON.stringify(process.execPath);
function setup() {
  const project = { repositories: { app: { path: 'repo' } }, labs: { ephemeral: { enabled: true, checks: ['health'] } }, lab: { checks: { health: `${NODE} -e "process.exit(0)"` } } };
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: 'brain', project: 'alpha' }, labs: { port_range: [57000, 57500], max_active: 2, check_timeout_seconds: 3, keep_task_worktrees_days: 7 }, projects: { alpha: project, beta: structuredClone(project) } }), files: { 'value.txt': 'initial' } });
  db = openDatabase(env.cfg.storageDir);
  const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: s => registry.require(s), monitor: false });
  return manager;
}
async function prepare(id: string, value = id, project = 'alpha'): Promise<{
  handle: TaskAttemptHandle;
  input: RegisterTaskAttempt;
  worktree: string;
  commit: string;
  tree: string;
  digest: string;
}> {
  const spec = WorkerTaskSchema.parse({ id, profile: 'implement', goal: 'change fixture value', repositoryAliases: ['app'], writableRepository: 'app', constraints: { allowedPaths: ['value.txt'], acceptanceCriteria: ['works'] } });
  new TaskStore(db!).submit([spec], { project });
  db!.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,run_count=1,deadline_at=? WHERE id=?").run(Date.now() + 120000, Date.now() + 120000, id);
  const base = (await git(env!.repo, ['rev-parse', 'HEAD'])).trim(), workspace = await new Worktrees(db!, path.join(env!.cfg.storageDir, 'worktrees')).prepare({ taskId: id, run: 1, alias: 'app', sourcePath: env!.repo, baseCommit: base });
  writeFileSync(path.join(workspace.worktreePath, 'value.txt'), value);
  commitAll(workspace.worktreePath, `fixture change\n\nAgent: fixture\nModel: fake/model\nTask: ${id}`);
  const commit = (await git(workspace.worktreePath, ['rev-parse', 'HEAD'])).trim(), tree = (await git(workspace.worktreePath, ['rev-parse', 'HEAD^{tree}'])).trim(), executionId = 'execution-' + id, sessionId = 'session-' + id;
  db!.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'task','implement','running',?)").run(executionId, Date.now());
  db!.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,?,?)").run(executionId, id, id);
  db!.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at) VALUES(?,?,'implementer','fixture','implement','running','fixture',?,?,?)").run(sessionId, id, JSON.stringify({ repos: [{ alias: 'app', worktree: workspace.worktreePath, branch: null, baseCommit: base, head: commit }] }), Date.now(), Date.now());
  const input: RegisterTaskAttempt = { taskId: id, project, runCount: 1, leaseOwner: 'worker', executionId, sessionId, sourceWorktree: workspace.worktreePath, writableAlias: 'app', repositories: [{ alias: 'app', sourcePath: env!.repo, baseCommit: base, head: commit }] };
  const handle = await manager!.taskAttempts.register(input), digest = createHash('sha256').update(await git(workspace.worktreePath, ['diff', '--binary', base, commit])).digest('hex');
  await manager!.taskAttempts.submit(handle, { commit, tree, patchDigest: digest });
  return { handle, input, worktree: workspace.worktreePath, commit, tree, digest };
}

async function retained(id: string, project = 'alpha') {
  const a = await prepare(id, id, project), m = manager!;
  const op = m.taskAttempts.requestCheck(a.handle, { checks: ['health'] });
  await m.processControls();
  const result = await m.taskAttempts.wait(a.handle, op.id);
  expect(result.cleanup).toBe('complete');
  expect(result.status).toBe('passed');
  db!.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(id);
  return { ...a, lab: m.store.byId(result.labId)! };
}
it('prunes only the requested terminal project immediately, preserving seven-day retention and live sibling source/branches', async () => {
  const m = setup();
  const a = await retained('prune-alpha'), b = await retained('keep-beta', 'beta');
  db!.prepare("UPDATE tasks SET state='running' WHERE id=?").run(b.handle.taskId);
  expect(await m.taskAttempts.prune()).toEqual([]);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
  expect(existsSync(a.lab.root)).toBe(false);
  expect(existsSync(a.worktree)).toBe(true);
  expect(existsSync(b.lab.root)).toBe(true);
  expect(existsSync(b.worktree)).toBe(true);
  expect((await git(env!.repo, ['show-ref', '--verify', `refs/heads/${a.lab.repositories[0]!.branch}`])).trim()).toContain(a.commit);
  expect(await m.taskAttempts.pruneProject('beta')).toEqual({ removed: [], blocked: 1 });
}, 120000);
it('retains dirty Lab worktrees and unknown process ownership without touching the process', async () => {
  const m = setup(), a = await retained('dirty-prune'), file = path.join(a.lab.repositories[0]!.worktree, 'value.txt');
  writeFileSync(file, 'uncommitted data');
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(readFileSync(file, 'utf8')).toBe('uncommitted data');
  writeFileSync(file, a.handle.taskId);
  db!.prepare("INSERT INTO lab_attempt_processes(id,lab_id,attempt_id,kind,logical_name,token,pid,directory,state,created_at,updated_at) VALUES(?,?,?,'check','foreign',?,?,?,'registered',?,?)").run(newId('tap'), a.lab.id, a.handle.id, 'a'.repeat(48), process.pid, path.join(a.lab.root, 'foreign'), Date.now(), Date.now());
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(existsSync(a.lab.root)).toBe(true);
  // This row is deliberately foreign: fixture removes its own forged metadata, never the PID.
  db!.prepare("DELETE FROM lab_attempt_processes WHERE lab_id=? AND logical_name='foreign'").run(a.lab.id);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
}, 60000);
it('refuses foreign roots and branch identities and keeps original resources', async () => {
  const m = setup(), a = await retained('foreign-prune');
  const original = a.lab.root;
  db!.prepare('UPDATE labs SET root=? WHERE id=?').run(env!.repo, a.lab.id);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  db!.prepare('UPDATE labs SET root=? WHERE id=?').run(original, a.lab.id);
  await git(a.lab.repositories[0]!.worktree, ['switch', '-c', 'foreign-task-branch']);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(existsSync(a.lab.root)).toBe(true);
  await git(a.lab.repositories[0]!.worktree, ['switch', a.lab.repositories[0]!.branch]);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
}, 60000);
it('serializes automatic and project prune with durable cleanup generations and refuses pending operations', async () => {
  const m = setup(), a = await retained('concurrent-prune');
  const pending = newId('tlo');
  db!.prepare("INSERT INTO task_lab_operations(id,attempt_id,kind,state,created_at,updated_at) VALUES(?,?,'cleanup','pending',?,?)").run(pending, a.handle.id, Date.now(), Date.now());
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  db!.prepare('DELETE FROM task_lab_operations WHERE id=?').run(pending);
  let release!: () => void, started!: () => void;
  const pause = new Promise<void>(r => release = r), ready = new Promise<void>(r => started = r);
  const original = m.taskAttempts.runner.prune.bind(m.taskAttempts.runner);
  const spy = vi.spyOn(m.taskAttempts.runner, 'prune').mockImplementation(async (...args) => { started(); await pause; return original(...args); });
  const first = m.taskAttempts.pruneProject('alpha');
  await ready;
  expect(await m.taskAttempts.prune(Date.now() + 8 * 86400000)).toEqual([]);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  await m.taskAttempts.recover();
  expect(existsSync(a.lab.root)).toBe(true);
  release();
  expect(await first).toEqual({ removed: [a.lab.id], blocked: 0 });
  expect(spy).toHaveBeenCalledTimes(1);
}, 60000);
it('fences lease loss before removal and permits retry from retained verified intent', async () => {
  const m = setup(), a = await retained('lease-prune'), original = m.taskAttempts.runner.prune.bind(m.taskAttempts.runner);
  vi.spyOn(m.taskAttempts.runner, 'prune').mockImplementationOnce((request, attempt, fence) => original(request, attempt, { ...fence, verified() {
    fence.verified();
    db!.prepare("UPDATE task_lab_operations SET lease_until=0 WHERE attempt_id=? AND state='running'").run(a.handle.id);
  } }));
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(existsSync(a.lab.repositories[0]!.worktree)).toBe(true);
  await m.taskAttempts.recover();
  expect(m.taskAttempts.store.lab(a.handle.id)!.phase).toBe('retained');
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
}, 60000);
it('recovers partial Git removal after lost authority without adopting a new foreign path', async () => {
  const m = setup(), a = await retained('partial-prune'), original = m.taskAttempts.runner.prune.bind(m.taskAttempts.runner);
  let interrupted = false;
  vi.spyOn(m.taskAttempts.runner, 'prune').mockImplementationOnce((request, attempt, fence) => original(request, attempt, { ...fence, assert() {
    if (!interrupted && !existsSync(a.lab.repositories[0]!.worktree)) {
      interrupted = true;
      db!.prepare("UPDATE task_lab_operations SET lease_until=0 WHERE attempt_id=? AND state='running'").run(a.handle.id);
    }
    fence.assert();
  } }));
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(interrupted).toBe(true);
  expect(existsSync(a.lab.root)).toBe(true);
  await m.taskAttempts.recover();
  expect(m.taskAttempts.store.lab(a.handle.id)!.phase).toBe('retained');
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
  expect(existsSync(a.worktree)).toBe(true);
}, 60000);

it('retains foreign nested registered Git resources and provides an actionable refusal', async () => {
  const m = setup(), a = await retained('nested-prune');
  const nested = path.join(a.lab.root, 'data', 'foreign-worktree');
  await git(env!.repo, ['worktree', 'add', '-b', 'foreign-nested', nested, a.commit]);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(m.taskAttempts.store.lab(a.handle.id)!.cleanupError).toMatch(/unexpected nested registered Git worktree/);
  expect(existsSync(nested)).toBe(true);
  const marker = readFileSync(path.join(nested, '.git'));
  unlinkSync(path.join(nested, '.git'));
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(existsSync(nested)).toBe(true);
  writeFileSync(path.join(nested, '.git'), marker);
  expect((await git(env!.repo, ['worktree', 'list', '--porcelain'])).replaceAll('\\', '/')).toContain(nested.replaceAll('\\', '/'));
  // Only the fixture owner removes its foreign resource; product cleanup never adopts it.
  await git(env!.repo, ['worktree', 'remove', nested]);
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
}, 60000);
it('does not revive an expired prune lease while waiting, and close drains the fenced work', async () => {
  const m = setup(), a = await retained('heartbeat-prune');
  let release!: () => void, started!: () => void;
  const pause = new Promise<void>(r => release = r), ready = new Promise<void>(r => started = r);
  const original = m.taskAttempts.runner.prune.bind(m.taskAttempts.runner);
  vi.spyOn(m.taskAttempts.runner, 'prune').mockImplementationOnce(async (...args) => { started(); await pause; return original(...args); });
  const prune = m.taskAttempts.pruneProject('alpha');
  await ready;
  db!.prepare("UPDATE task_lab_operations SET lease_until=0 WHERE attempt_id=? AND state='running'").run(a.handle.id);
  await new Promise(r => setTimeout(r, 350));
  expect((db!.prepare("SELECT lease_until FROM task_lab_operations WHERE attempt_id=? AND state='running'").get(a.handle.id) as {lease_until:number}).lease_until).toBe(0);
  let closed = false;
  const close = m.taskAttempts.close().then(() => closed = true);
  await new Promise(r => setTimeout(r, 30));
  expect(closed).toBe(false);
  release();
  expect(await prune).toEqual({ removed: [], blocked: 1 });
  await close;
  expect(existsSync(a.lab.root)).toBe(true);
}, 60000);

it('unlinks owned dependency junctions without following or deleting the foreign destination', async () => {
  const m = setup(), a = await retained('junction-prune'), foreign = path.join(env!.dir, 'foreign-dependency');
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, 'sentinel.txt'), 'foreign retained');
  const dependencies = path.join(a.lab.root, 'node_modules');
  mkdirSync(dependencies);
  symlinkSync(foreign, path.join(dependencies, 'package'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [a.lab.id], blocked: 0 });
  expect(readFileSync(path.join(foreign, 'sentinel.txt'), 'utf8')).toBe('foreign retained');
  expect(existsSync(a.lab.root)).toBe(false);
}, 60000);

it('refuses an unknown standalone Git repository nested inside owned data', async () => {
  const m = setup(), a = await retained('unknown-git-prune'), foreign = path.join(a.lab.root, 'data', 'foreign-repository');
  mkdirSync(foreign, { recursive: true });
  await git(foreign, ['init', '-b', 'main']);
  writeFileSync(path.join(foreign, 'sentinel.txt'), 'foreign Git retained');
  commitAll(foreign, 'independently owned nested repository');
  expect(await m.taskAttempts.pruneProject('alpha')).toEqual({ removed: [], blocked: 1 });
  expect(m.taskAttempts.store.lab(a.handle.id)!.cleanupError).toMatch(/unexpected nested Git metadata/);
  expect(readFileSync(path.join(foreign, 'sentinel.txt'), 'utf8')).toBe('foreign Git retained');
  expect(existsSync(a.lab.repositories[0]!.worktree)).toBe(true);
}, 60000);

it('rejects explicit project prune when closed while automatic retention remains a no-op', async () => {
  const m = setup();
  await m.taskAttempts.close();
  await expect(m.taskAttempts.pruneProject('alpha')).rejects.toMatchObject({ code: 'unavailable' });
  expect(await m.taskAttempts.prune()).toEqual([]);
  expect(db!.prepare('SELECT id FROM task_lab_operations').all()).toEqual([]);
});
