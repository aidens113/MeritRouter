import { expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/storage/db.js';
import { MergeQueue } from '../src/workspaces/merge-queue.js';
import { TaskStore } from '../src/storage/tasks.js';
import { WorkerTaskSchema } from '../src/core/task.js';
import { makeEnv, summarizeTask } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(test: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('process fixture timed out');
    await pause(25);
  }
}

it.each([
  { killFirst: false, secondAlias: 'same-physical-repository' },
  { killFirst: true, secondAlias: 'core' },
])('serializes integrations across processes and aliases (hard-kill: $killFirst)', async ({ killFirst, secondAlias }) => {
  const env = makeEnv();
  const db = openDatabase(env.cfg.storageDir);
  const children: ChildProcess[] = [];
  const output: string[] = [];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: env.repo }).toString().trim();
  const start = (id: string, owner: string) => {
    const child = spawn(process.execPath, [path.join(here, 'fixtures/process-acceptance/merge-owner.mjs'), dist, env.cfg.storageDir, id, owner, env.dir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const index = children.push(child) - 1;
    output[index] = '';
    child.stdout!.on('data', data => { output[index] += String(data); });
    child.stderr!.on('data', data => { output[index] += String(data); });
    return child;
  };
  try {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'source');
    writeFileSync(path.join(env.repo, 'first.txt'), 'first');
    git('add', '.'); git('commit', '-qm', 'first');
    const one = git('rev-parse', 'HEAD');
    writeFileSync(path.join(env.repo, 'second.txt'), 'second');
    git('add', '.'); git('commit', '-qm', 'second');
    const two = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'integration', base);
    const queue = new MergeQueue(db, { event() {} }, 'setup');
    new TaskStore(db).submit(['first-task', 'second-task', 'throwing-task'].map(id => WorkerTaskSchema.parse(summarizeTask({ id }))));
    const input = { jobId: 'fixture-job', kind: 'task' as const, repo: 'core', branch: 'integration', integrationWorktree: env.repo, sourceWorktree: null, sourceBase: base, acceptance: null };
    const first = queue.enqueue({ ...input, taskId: 'first-task', sourceHead: one, commits: [one] });
    const second = queue.enqueue({ ...input, repo: secondAlias, taskId: 'second-task', sourceHead: two, commits: [two] });
    const firstChild = start(first.id, 'first');
    await until(() => existsSync(path.join(env.dir, 'first-held')));
    if (killFirst) {
      const exited = new Promise<void>(r => firstChild.once('exit', () => r()));
      firstChild.kill('SIGKILL');
      await exited;
      expect(queue.get(first.id)!.state).toBe('picked');
      // The kill landed in the database-only `integrated` callback, outside the Git fence, so it
      // leaves no crash-leftover fence lock (which would block until operator recovery).
      expect(existsSync(path.join(env.repo, '.git', 'meritrouter-mutation.lock'))).toBe(false);
    }
    start(second.id, 'second');
    await until(() => existsSync(path.join(env.dir, 'second-started')));
    await pause(750);
    const beforeRelease = readFileSync(path.join(env.dir, 'integrations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    writeFileSync(path.join(env.dir, 'release-first'), 'release');
    await until(() => children.every(c => c.exitCode !== null || c.signalCode !== null));
    expect(children[1]!.exitCode, output[1]).toBe(0);
    if (!killFirst) {
      expect(children[0]!.exitCode, output[0]).toBe(0);
      expect(beforeRelease).toEqual([{ owner: 'first', id: first.id }]);
    }
    const events = readFileSync(path.join(env.dir, 'integrations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(e => e.id)).toEqual(killFirst ? [first.id, first.id, second.id] : [first.id, second.id]);
    expect(queue.get(first.id)!.state).toBe('integrated');
    expect(queue.get(second.id)!.state).toBe('integrated');
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'merge-branch:%'").get()).toEqual({ n: 0 });
    expect(git('log', '--format=%s', `${base}..HEAD`).split('\n')).toHaveLength(2);
    const throwing = queue.enqueue({ ...input, taskId: 'throwing-task', sourceHead: two, commits: [] });
    const failed = await queue.run(throwing.id, { committer: { name: 'Fixture', email: 'fixture@example.test' }, integrated() {}, checks: async () => { throw new Error('fixture check failure'); } });
    expect(failed.state).toBe('failed');
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'merge-branch:%'").get()).toEqual({ n: 0 });
    if (!killFirst) {
      const common = realpathSync(path.resolve(env.repo, git('rev-parse', '--git-common-dir')));
      const canonical = process.platform === 'win32' ? common.toLowerCase() : common;
      const key = `merge-branch:${createHash('sha256').update(JSON.stringify([canonical, input.branch])).digest('hex')}`;
      const remote = JSON.stringify({ nonce: randomUUID(), host: 'unknown-remote-host', pid: process.pid, instance: randomUUID(), owner: 'remote', heartbeat: 0, jobId: input.jobId, leaseOwner: null, runCount: null });
      for (const value of [remote, '{malformed']) {
        db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
        let clock = Date.now();
        const now = vi.spyOn(Date, 'now').mockImplementation(() => clock += 31_000);
        try { await expect(queue.run(second.id, { committer: { name: 'Fixture', email: 'fixture@example.test' }, integrated() {} })).rejects.toThrow('integration branch busy'); }
        finally { now.mockRestore(); }
        expect(db.prepare('SELECT value FROM meta WHERE key=?').get(key)).toEqual({ value });
      }
      db.prepare('DELETE FROM meta WHERE key=?').run(key);
    }
  } finally {
    writeFileSync(path.join(env.dir, 'release-first'), 'release');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(r => child.once('exit', () => r()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    db.close();
    env.cleanup();
  }
}, 30000);
