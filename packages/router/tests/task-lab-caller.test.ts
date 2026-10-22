import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { z } from 'zod';
import type { Switchyard } from '../src/core/service.js';
import type { RunContext } from '../src/runners/types.js';
import type { HarnessEnv } from '../src/harness/tools.js';
import type { SupervisorState, IntegrationRepo } from '../src/harness/supervisor-tools.js';
import { integrationTools } from '../src/harness/integration-tools.js';
import { commitAll } from './helpers.js';
import { prepareWorkspace } from '../src/runners/coding/finish.js';
import { createCodingRunner } from '../src/runners/coding/index.js';
import { taskLabAuthority, taskLabEvidenceProblem } from '../src/runners/coding/task-lab.js';
import { WorkerTaskSchema } from '../src/core/task.js';
import { LabSupervisorLease } from '../src/operations/lab-supervisor.js';
import { baseConfig, makeEnv, open, reply, goodOutput, servedFor, ScriptedClient, type Env } from './helpers.js';
let env: Env | undefined, sy: Switchyard | undefined;
let timer: ReturnType<typeof setInterval> | undefined, draining: Promise<void> | undefined;
let supervisorError: unknown;
let captured: RunContext | undefined;
afterEach(async () => {
  if (timer)
    clearInterval(timer);
  timer = undefined;
  await draining;
  if (sy) {
    const lease = new LabSupervisorLease(sy.db, sy.cfg.configPath);
    if (lease.read()) {
      lease.requestStop();
      const deadline = Date.now() + 45000;
      while (lease.read() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      expect(lease.read(), 'owned dedicated Labs supervisor must stop before fixture removal').toBeNull();
    }
    for (const request of sy.labs.taskAttempts.store.all()) {
      if (request.phase !== 'pruned')
        await sy.labs.taskAttempts.runner.stop(sy.labs.taskAttempts.store.get(request.attemptId));
    }
    await sy.close();
  }
  sy = undefined;
  env?.cleanup();
  env = undefined;
  draining = undefined;
  supervisorError = undefined;
});
const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');
const NODE = JSON.stringify(process.execPath);
const source = 'export function add(a: number, b: number) { return a + b; }\n';
const subtract = source + 'export function subtract(a: number, b: number) { return a - b; }\n';
const ordinary = `${NODE} -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`;
const call = (name: string, args: unknown) => [{
    id: name, type: 'function' as const, function: {
      name, arguments: JSON.stringify(args)
    }
  }];
function setup(mode: 'native' | 'command', dedicated = false) {
  env = makeEnv({
    config: baseConfig({
      repositories: {}, brain: {
        path: 'brain', project: 'alpha'
      },
      execution: {
        max_concurrent_tasks: 1, lease_seconds: 30
      },
      coding: mode === 'native' ? { runner: 'native' } : {
        runner: 'command', command: `${NODE} "${agent}" good`
      },
      labs: {
        port_range: [58600, 58900], max_active: 4, service_ready_timeout_seconds: 10, check_timeout_seconds: 5
      },
      projects: { alpha: {
          repositories: { core: { path: 'repo' } }, labs: { ephemeral: {
              enabled: true, checks: ['health', 'failure']
            } }, lab: {
            ports: ['web'], env: { PORT: '{port.web}' },
            services: { web: {
                repo: 'core', command: `${NODE} server.cjs`, ready: { http: 'http://127.0.0.1:{port.web}/' }
              } },
            checks: {
              health: `${NODE} health.cjs`, failure: `${NODE} -e "process.exit(7)"`
            },
          }
        } },
    }), files: {
      'src/app.ts': source,
      'server.cjs': `const fs=require('node:fs');require('node:http').createServer((q,r)=>r.end(fs.readFileSync('src/app.ts','utf8').includes('subtract')?'ready':'old')).listen(Number(process.env.PORT),'127.0.0.1');`,
      'health.cjs': `fetch('http://127.0.0.1:'+process.env.PORT).then(r=>r.text()).then(t=>{console.log(t);process.exit(t==='ready'?0:3)}).catch(()=>process.exit(4));`,
    }
  });
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (mode === 'command')
      return reply(JSON.stringify(goodOutput()), served);
    const edited = req.messages.some(m => m.role === 'tool');
    return reply(null, {
      ...served, toolCalls: edited ? call('submit_result', goodOutput(1, 'core:src/app.ts#L1-L2')) : call('write_file', {
        path: 'src/app.ts', content: subtract
      })
    });
  });
  let ensures = 0;
  const coding = createCodingRunner(env.cfg);
  sy = open(env, client, {
    worker: true, coding: { run: ctx => {
        captured = ctx;
        return coding.run(dedicated ? ctx : {
          ...ctx, ensureLabsSupervisor: async () => {
            ensures++;
          }
        });
      } }
  });
  // Only this explicit fixture supervisor drains the durable queue. Runner startup merely signals readiness.
  if (!dedicated) timer = setInterval(() => {
    if (!draining)
      draining = sy!.labs.processControls().catch(error => {
        supervisorError = error;
      }).finally(() => {
        draining = undefined;
      });
  }, 50);
  return {
    ensures: () => ensures, client
  };
}
async function run(checks = ['health'], dependsOn: string[] = []) {
  const submitted = await sy!.submitTasks([{
      dependsOn, profile: 'implement', goal: 'Add subtract to src/app.ts', repositoryAliases: ['core'], writableRepository: 'core', hints: { difficulty: 'T2' }, constraints: {
        acceptanceCriteria: ['subtract exists'], allowedPaths: ['src/**'], checks: [ordinary], labChecks: checks
      }
    }]);
  const id = submitted[0]!.taskId;
  const result = (await sy!.awaitResults([id], { timeoutSeconds: 90 })).completed[0]!;
  expect(supervisorError).toBeUndefined();
  return {
    id, result, spec: sy!.tasks.get(id)!.spec
  };
}
it('starts the dedicated service supervisor through the public coding service without runner queue draining', async () => {
  setup('native', true);
  const { id, result } = await run();
  expect(timer).toBeUndefined();
  expect(result.taskLab?.status, JSON.stringify(result.findings)).toBe('passed');
  expect(result.taskLab?.cleanup).toBe('complete');
  expect(new LabSupervisorLease(sy!.db, sy!.cfg.configPath).read()).toMatchObject({ ready: true, stopRequested: false });
  expect(sy!.acceptTask(id, { by: { kind: 'human', id: 'fixture' }, reason: 'Dedicated supervisor result verified' }).acceptanceStatus).toBe('met');
}, 120000);
it.each(['native', 'command'] as const)('runs %s coding through immutable queued Lab checks and fresh durable acceptance', async (mode) => {
  const fixture = setup(mode), before = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: env!.repo, encoding: 'utf8'
  }).trim();
  const { id, result, spec } = await run();
  expect(result.taskLab, JSON.stringify(result.findings)).toBeDefined();
  expect(result.taskLab!.status).toBe('passed');
  expect(result.taskLab!.cleanup).toBe('complete');
  expect(result.acceptanceStatus, JSON.stringify(result)).toBe('met');
  expect(fixture.ensures()).toBe(1);
  expect(result.checks[0]!.revision).not.toBe(result.taskLab!.submittedCommit);
  expect(result.taskLab!.checks[0]!.revision).toBe(result.taskLab!.submittedCommit);
  expect(result.taskLab!.checks[0]!.stdout).toContain('ready');
  expect(spec.context.baseCommits).toEqual({ core: before });
  expect(readFileSync(path.join(env!.repo, 'src/app.ts'), 'utf8')).toBe(source);
  const authority = taskLabAuthority(sy!.labs, id, result.taskLab);
  expect(authority).not.toBeNull();
  expect(taskLabEvidenceProblem(spec, result.taskLab, authority)).toBeNull();
  for (const change of [{ taskId: 'wrong' }, { project: 'wrong' }, { runCount: 2 }, { sourceHead: before }, { sourceClean: false }, { labClean: false }, { activeServices: 1 }, { activeProcesses: 1 }, { reservedPorts: 1 }, { activeOperations: 1 }, { currentHeads: { core: before } }, { policyEnabled: false }, { allowedCheckNames: [] }]) {
    expect(taskLabEvidenceProblem(spec, result.taskLab, {
      ...authority!, ...change
    }), JSON.stringify(change)).not.toBeNull();
  }
  expect(taskLabEvidenceProblem(spec, {
    ...result.taskLab!, patchDigest: 'a'.repeat(64)
  }, authority)).not.toBeNull();
  expect(taskLabEvidenceProblem(spec, result.taskLab, null)).not.toBeNull();
  // The public human acceptance path must revalidate evidence and fence its write.
  expect(sy!.acceptTask(id, { by: { kind: 'human', id: 'fixture' }, reason: 'Independent fixture review' }).acceptanceStatus).toBe('met');
  const stored = sy!.tasks.get(id)!;
  sy!.db.prepare('UPDATE tasks SET result_json=? WHERE id=?').run(JSON.stringify({ ...stored.result!, taskLab: { ...stored.result!.taskLab!, patchDigest: 'f'.repeat(64) } }), id);
  expect(() => sy!.acceptTask(id, { by: { kind: 'human', id: 'fixture' }, reason: 'Cannot waive forged proof' })).toThrow(/Lab/);
  sy!.db.prepare('UPDATE tasks SET result_json=? WHERE id=?').run(JSON.stringify(stored.result), id);
  const updateResult = sy!.tasks.updateResult.bind(sy!.tasks);
  const raced = vi.spyOn(sy!.tasks, 'updateResult').mockImplementationOnce((taskId, update) => {
    const now = Date.now();
    sy!.db.prepare("INSERT INTO task_lab_operations(id,attempt_id,kind,state,created_at,updated_at) VALUES('accept-race',?,'cleanup','pending',?,?)").run(authority!.attempt.id, now, now);
    return updateResult(taskId, update);
  });
  try {
    expect(() => sy!.acceptTask(id, { by: { kind: 'human', id: 'fixture' }, reason: 'Must fence cleanup queued after inspection' })).toThrow(/Lab/);
    expect(sy!.tasks.get(id)!.result).toEqual(stored.result);
  } finally {
    raced.mockRestore();
    sy!.db.prepare("DELETE FROM task_lab_operations WHERE id='accept-race'").run();
  }
  expect(taskLabEvidenceProblem(WorkerTaskSchema.parse({
    ...spec, constraints: {
      ...spec.constraints, labChecks: undefined
    }
  }), undefined, null)).toBeNull();
  if (mode === 'native') {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, encoding: 'utf8'
    }).trim();
    // A misleading mutable workspace pointer must not select a different source/winner.
    sy!.db.prepare('UPDATE workspaces SET worktree_path=? WHERE task_id=?').run(env!.repo, id);
    let delegated: Record<string, unknown> | undefined;
    const integrate = async (name: string, conflict: boolean) => {
      const wt = path.join(env!.dir, name);
      git(env!.repo, 'worktree', 'add', '-q', '-b', name, wt, before);
      if (conflict) {
        writeFileSync(path.join(wt, 'src/app.ts'), 'export const conflict = true;\n');
        commitAll(wt, 'independent conflicting change');
      }
      const targetHead = git(wt, 'rev-parse', 'HEAD');
      const jobId = sy!.tasks.submit([WorkerTaskSchema.parse({
          profile: 'summarize', goal: name, repositoryAliases: ['core'], constraints: { acceptanceCriteria: ['fixture'] }
        })], { project: 'alpha' })[0]!.taskId;
      sy!.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(jobId);
      const repo: IntegrationRepo = {
        alias: 'core', worktree: wt, branch: name, baseSha: before
      };
      const state: SupervisorState = {
        ctx: {
          ...captured!, taskId: jobId
        }, db: sy!.db, actor: {
          agent: 'supervisor:fixture', role: 'supervisor'
        }, repos: new Map([['core', repo]]), briefChecks: new Set(), children: new Map()
      };
      const tools = integrationTools(state, {
        ownTask: () => id, repoFor: () => repo, identity: () => ({
          kind: 'supervisor', id
        }), redelegate: async (_name, brief) => {
          delegated = brief('redo');
          return 'redo-task';
        }
      });
      const output = await tools[0]!.run({ task_id: id }, { ctx: captured! } as HarnessEnv);
      const item = state.queue!.latest(jobId, id, 'core')!;
      expect(item.sourceWorktree).toBe(authority!.attempt.sourceWorktree);
      expect(item.sourceHead).toBe(result.taskLab!.submittedCommit);
      expect(item.rebased).toBe(false);
      if (conflict) {
        expect(item.state).toBe('redelegated');
        expect(delegated?.lab_checks).toEqual(['health']);
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(targetHead);
        expect(git(authority!.attempt.sourceWorktree, 'rev-parse', 'HEAD')).toBe(result.taskLab!.submittedCommit);
      }
      else {
        expect(output).toContain('integrated');
        expect(item.state).toBe('integrated');
        expect(readFileSync(path.join(wt, 'src/app.ts'), 'utf8')).toContain('subtract');
      }
      return {
        tools, state
      };
    };
    await integrate('job-exact', false);
    await integrate('job-conflict', true);
  }
  // Human revocation is observed from file content even when filesystem mtime is preserved.
  const configPath = env!.cfg.configPath, contents = readFileSync(configPath, 'utf8'), times = statSync(configPath), config = z.record(z.string(), z.any()).parse(YAML.parse(contents));
  config.projects.alpha.labs.ephemeral.enabled = false;
  writeFileSync(configPath, YAML.stringify(config));
  utimesSync(configPath, times.atime, times.mtime);
  expect(taskLabEvidenceProblem(spec, result.taskLab, taskLabAuthority(sy!.labs, id, result.taskLab))).not.toBeNull();
  writeFileSync(configPath, contents);
  // A later source edit invalidates the completed immutable evidence.
  writeFileSync(path.join(authority!.attempt.sourceWorktree, 'src/app.ts'), subtract + '// changed after checks\n');
  expect(taskLabEvidenceProblem(spec, result.taskLab, taskLabAuthority(sy!.labs, id, result.taskLab))).not.toBeNull();
}, 120000);
it('cannot accept passing ordinary checks when the required Lab command fails', async () => {
  setup('native');
  const { id, result, spec } = await run(['failure']);
  expect(result.checks[0]!.exitCode).toBe(0);
  expect(result.taskLab?.status).toBe('failed');
  expect(result.taskLab?.cleanup).toBe('complete');
  expect(result.acceptanceStatus).not.toBe('met');
  expect(taskLabEvidenceProblem(spec, result.taskLab, taskLabAuthority(sy!.labs, id, result.taskLab))).not.toBeNull();
}, 120000);
it('uses the immutable claimed generation even when the task row has advanced before workspace preparation', async () => {
  env = makeEnv();
  sy = open(env, new ScriptedClient(() => reply('{}')));
  const spec = WorkerTaskSchema.parse({
    profile: 'implement', goal: 'fixture', repositoryAliases: ['core'], writableRepository: 'core', constraints: {
      acceptanceCriteria: ['fixture'], allowedPaths: ['src/**'], labChecks: ['health']
    }
  });
  const id = sy.tasks.submit([spec])[0]!.taskId;
  sy.db.prepare('UPDATE tasks SET run_count=2 WHERE id=?').run(id);
  const context = {
    taskId: id, spec, cfg: env.cfg, tasks: sy.tasks, claimedRunCount: 1, now: Date.now, retry: null
  } as RunContext;
  const { ws } = await prepareWorkspace(context);
  expect(path.basename(ws.worktreePath)).toContain(id + '-r1-');
  expect(sy.tasks.get(id)!.row.run_count).toBe(2);
  await expect(prepareWorkspace({
    ...context, claimedRunCount: undefined
  })).rejects.toThrow(/captured claim generation/);
});
it('keeps explicit authorized pins while retaining dependency artifacts in the coding context', async () => {
  setup('command');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: env!.repo, encoding: 'utf8'
  }).trim();
  const [upstream] = await sy!.submitTasks([{
      profile: 'implement', goal: 'upstream subtract', repositoryAliases: ['core'], writableRepository: 'core', hints: { difficulty: 'T2' }, constraints: {
        acceptanceCriteria: ['subtract exists'], allowedPaths: ['src/**'], checks: [ordinary]
      }
    }]);
  const first = (await sy!.awaitResults([upstream!.taskId], { timeoutSeconds: 60 })).completed[0]!;
  expect(first.acceptanceStatus).toBe('met');
  const { result } = await run(['health'], [upstream!.taskId]);
  expect(captured!.spec.context.baseCommits).toEqual({ core: base });
  expect(captured!.spec.context.artifactRefs?.some(ref => sy!.artifacts.read(ref)?.content.toString().includes(upstream!.taskId))).toBe(true);
  expect(result.taskLab?.status).toBe('passed');
  expect(result.acceptanceStatus).toBe('met');
}, 120000);
