import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { MeritRouter } from '../src/core/service.js';
import type { RunContext } from '../src/runners/types.js';
import { prepareWorkspace } from '../src/runners/coding/finish.js';
import { createCodingRunner } from '../src/runners/coding/index.js';
import { taskLabAuthority, taskLabEvidenceProblem } from '../src/runners/coding/task-lab.js';
import { WorkerTaskSchema } from '../src/core/task.js';
import { capturedLease } from '../src/storage/task-leases.js';
import { WorkerActionRequests, type WorkerActionRequest } from '../src/harness/worker-actions.js';
import { LabSupervisorLease } from '../src/operations/lab-supervisor.js';
import { baseConfig, makeEnv, open, openWithTestSupervisor, reply, goodOutput, servedFor, ScriptedClient, type Env } from './helpers.js';

let env: Env | undefined, sy: MeritRouter | undefined;
let captured: RunContext | undefined;
afterEach(async () => {
  // These worker tests never start an engine or dedicated Lab daemon. Closing cancels pending waits.
  await sy?.close();
  sy = undefined; env?.cleanup(); env = undefined; captured = undefined;
});
const NODE = JSON.stringify(process.execPath);
const source = 'export function add(a: number, b: number) { return a + b; }\n';
const subtract = source + 'export function subtract(a: number, b: number) { return a - b; }\n';
const ordinary = `${NODE} -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const call = (name: string, args: unknown) => [{ id: name, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }];
function setup(mode: 'native' | 'command' = 'native', operator = false) {
  env = makeEnv({ config: baseConfig({
    repositories: {}, brain: { path: 'brain', project: 'alpha' }, execution: { max_concurrent_tasks: 1, lease_seconds: 30 },
    coding: mode === 'native' ? { runner: 'native' } : { runner: 'command', command: `${NODE} -e "throw new Error('must never launch')"` },
    projects: { alpha: { repositories: { core: { path: 'repo' } }, labs: { ephemeral: { enabled: true, checks: ['health'] } }, lab: { checks: { health: `${NODE} -e "console.log('not worker proof')"` } } } },
  }), files: { 'src/app.ts': source } });
  const client = new ScriptedClient(req => reply(null, {
    ...servedFor(sy!, req), toolCalls: req.messages.some(message => message.role === 'tool')
      ? call('submit_result', goodOutput(1, 'core:src/app.ts#L1-L2'))
      : call('write_file', { path: 'src/app.ts', content: subtract }),
  }));
  let ensures = 0;
  const coding = createCodingRunner(env.cfg);
  sy = (operator ? openWithTestSupervisor : open)(env, client, { worker: true, coding: { run: context => {
    captured = context;
    return coding.run({ ...context, ensureLabsSupervisor: async () => { ensures++; } });
  } } });
  return { client, ensures: () => ensures };
}
async function submit(options: { checks?: string[]; labChecks?: string[]; dependsOn?: string[]; base?: string } = {}) {
  const [task] = await sy!.submitTasks([{
    profile: 'implement', goal: 'Add subtract to src/app.ts', repositoryAliases: ['core'], writableRepository: 'core',
    hints: { difficulty: 'T2' }, dependsOn: options.dependsOn ?? [],
    ...(options.base ? { context: { baseCommits: { core: options.base } } } : {}),
    constraints: { acceptanceCriteria: ['subtract exists'], allowedPaths: ['src/**'], checks: options.checks ?? [], ...((options.labChecks ?? ['health']).length ? { labChecks: options.labChecks ?? ['health'] } : {}) },
  }]);
  return task!.taskId;
}
async function pendingAction(id: string): Promise<WorkerActionRequest> {
  const store = new WorkerActionRequests(sy!.db);
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const action = store.list({ project: 'alpha', taskId: id, status: 'pending' })[0];
    if (action) return action;
    const task = sy!.tasks.get(id)!;
    if (!['queued', 'running'].includes(task.row.state)) throw new Error(`task ended before action: ${JSON.stringify(task.result)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('worker did not request supervisor action');
}
// A full native coding task runs two attempts here (the missing Lab proof earns one repair), each
// spending a few hundred fenced Git child processes since the 2026-10-26 repository-mutation
// fences: about 18 s on a quiet Windows host and over 50 s beside a parallel suite. Prompt
// refusals and cancellations keep the short window; complete coding runs get RUN_SECONDS.
const RUN_SECONDS = 120, RUN_TIMEOUT = (RUN_SECONDS + 30) * 1000;
async function completed(id: string, timeoutSeconds = 10) {
  const outcome = await sy!.awaitResults([id], { timeoutSeconds });
  expect(outcome.pending).toHaveLength(0);
  return outcome.completed[0]!;
}

it('keeps worker Lab execution pending and refuses a supervisor report as immutable Lab proof', async () => {
  const fixture = setup();
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env!.repo, encoding: 'utf8' }).trim();
  const id = await submit();
  const action = await pendingAction(id);
  expect(action.action.operation).toMatchObject({ name: 'lab_check', args: { taskId: id, checks: ['health'] } });
  expect(action.action.lease).toEqual(captured!.taskLease);
  expect(sy!.tasks.get(id)!.row.state).toBe('running');
  expect(captured!.spec.context.baseCommits).toEqual({ core: before });
  expect(sy!.labs.taskAttempts.store.all()).toHaveLength(0);
  expect(sy!.labs.store.list()).toHaveLength(0);
  expect(fixture.ensures()).toBe(0);
  expect(new LabSupervisorLease(sy!.db, sy!.cfg.configPath).read()).toBeNull();
  expect(readFileSync(path.join(env!.repo, 'src/app.ts'), 'utf8')).toBe(source);
  await new WorkerActionRequests(sy!.db).decide({ project: 'alpha', id: action.id, decision: 'approve', reason: 'Explicit fixture operator supplies an observation only', response: 'The health check looked successful.', actor: { kind: 'operator' }, config: env!.cfg });
  const result = await completed(id, RUN_SECONDS);
  expect(result.taskLab).toBeUndefined();
  expect(result.acceptanceStatus).toBe('unmet');
  expect(result.findings.some(finding => finding.description.includes('Required task Lab checks did not complete'))).toBe(true);
  expect(taskLabAuthority(sy!.labs, id, result.taskLab)).toBeNull();
  expect(taskLabEvidenceProblem(sy!.tasks.get(id)!.spec, result.taskLab, null)).not.toBeNull();
  expect(() => sy!.acceptTask(id, { by: { kind: 'human', id: 'fixture' }, reason: 'A report cannot waive missing Lab proof' })).toThrow(/Lab|unmet/);
}, RUN_TIMEOUT);
it('cancels a pending worker Lab request promptly without waiting for a dedicated daemon', async () => {
  const fixture = setup(); const id = await submit(); const action = await pendingAction(id);
  sy!.cancelTasks([id]);
  expect((await completed(id)).executionStatus).toBe('cancelled');
  expect(new WorkerActionRequests(sy!.db).get('alpha', action.id)?.status).toBe('cancelled');
  expect(fixture.ensures()).toBe(0);
  expect(sy!.labs.taskAttempts.store.all()).toHaveLength(0);
}, 20000);
it('refuses an external coding worker before models, workspaces or Lab execution', async () => {
  const fixture = setup('command'); const id = await submit(); const result = await completed(id);
  expect(result.stopReason).toBe('worker_sandbox_unavailable');
  expect(result.taskLab).toBeUndefined(); expect(fixture.client.requests).toHaveLength(0); expect(fixture.ensures()).toBe(0);
  expect(sy!.db.prepare('SELECT * FROM workspaces WHERE task_id=?').get(id)).toBeUndefined();
  expect(sy!.labs.taskAttempts.store.all()).toHaveLength(0);
}, 20000);
it('does not accept passing operator-run ordinary checks when required Lab execution is refused', async () => {
  const fixture = setup('native', true); const id = await submit({ checks: [ordinary] }); const result = await completed(id, RUN_SECONDS);
  expect(result.checks[0]?.exitCode).toBe(0);
  expect(result.taskLab).toBeUndefined(); expect(result.acceptanceStatus).toBe('unmet'); expect(fixture.ensures()).toBe(0);
  expect(sy!.labs.taskAttempts.store.all()).toHaveLength(0);
  expect(readFileSync(path.join(env!.repo, 'src/app.ts'), 'utf8')).toBe(source);
}, RUN_TIMEOUT);
// Since 7e49ad3 workspace preparation rechecks the captured task lease (assertRunAuthority), so a
// claim whose generation the task row has moved past is refused rather than prepared under its old
// generation; the context therefore carries a real claim, lease and signal.
it('uses the immutable claimed generation and refuses preparation once task state advances', async () => {
  env = makeEnv(); sy = open(env, new ScriptedClient(() => reply('{}')));
  const spec = WorkerTaskSchema.parse({ profile: 'implement', goal: 'fixture', repositoryAliases: ['core'], writableRepository: 'core', constraints: { acceptanceCriteria: ['fixture'], allowedPaths: ['src/**'], labChecks: ['health'] } });
  const id = sy.tasks.submit([spec])[0]!.taskId;
  const task = sy.tasks.claim('fixture-owner', { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 })[0]!;
  expect(task.row.id).toBe(id);
  const context = { taskId: id, spec, cfg: env.cfg, tasks: sy.tasks, taskLease: capturedLease(task), leaseOwner: 'fixture-owner', claimedRunCount: task.row.run_count, signal: new AbortController().signal, now: Date.now, retry: null } as unknown as RunContext;
  const { ws } = await prepareWorkspace(context);
  expect(path.basename(ws.worktreePath)).toContain(`${id}-r${task.row.run_count}-`);
  await expect(prepareWorkspace({ ...context, claimedRunCount: undefined })).rejects.toThrow(/captured claim generation/);
  sy.db.prepare('UPDATE tasks SET run_count=run_count+1 WHERE id=?').run(id);
  await expect(prepareWorkspace(context)).rejects.toThrow(/lease/);
  expect(sy.tasks.get(id)!.row.run_count).toBe(task.row.run_count + 1);
  // The refused attempt created no worktree and did not replace the claimed one's record.
  expect(sy.db.prepare('SELECT worktree_path FROM workspaces WHERE task_id=?').get(id)).toEqual({ worktree_path: ws.worktreePath });
});
it('retains explicit authorized source pins and dependency artifacts with native coding', async () => {
  setup('native', true);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env!.repo, encoding: 'utf8' }).trim();
  const upstream = await submit({ checks: [ordinary], labChecks: [] });
  expect((await completed(upstream, RUN_SECONDS)).acceptanceStatus).toBe('met');
  const downstream = await submit({ checks: [ordinary], dependsOn: [upstream], base });
  const result = await completed(downstream, RUN_SECONDS);
  expect(captured!.spec.context.baseCommits).toEqual({ core: base });
  expect(captured!.spec.context.artifactRefs?.some(ref => sy!.artifacts.readScoped(ref, 'alpha').content.toString().includes(upstream))).toBe(true);
  expect(result.checks[0]?.exitCode).toBe(0); expect(result.taskLab).toBeUndefined(); expect(result.acceptanceStatus).toBe('unmet');
}, (2 * RUN_SECONDS + 30) * 1000);
