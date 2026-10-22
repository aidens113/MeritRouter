import { afterEach, expect, it } from 'vitest';
import type { StoredTask } from '../src/storage/tasks.js';
import { TaskArgumentSchema } from '../src/mcp/schemas.js';
import { WorkerTaskSchema } from '../src/core/task.js';
import { recordAcceptanceDecision } from '../src/core/acceptance.js';
import { baseResult } from '../src/runners/types.js';
import { ContractStore, compileContract } from '../src/verification/contract.js';
import { runNamedChecks } from '../src/verification/checks.js';
import { reevaluateOnResult } from '../src/verification/policy.js';
import { decide } from '../src/verification/decide.js';
import { makeEnv, open, ScriptedClient, reply, type Env } from './helpers.js';
import type { Switchyard } from '../src/core/service.js';
let env: Env | undefined, sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  env?.cleanup();
  sy = undefined;
  env = undefined;
});
it('keeps missing required Lab evidence a deterministic failure despite a passing reviewer or lower policy level', () => {
  env = makeEnv();
  const spec = WorkerTaskSchema.parse({
    id: 'lab-required', profile: 'implement', goal: 'fixture', repositoryAliases: ['core'], writableRepository: 'core', context: { baseCommits: { core: 'a'.repeat(40) } }, constraints: {
      acceptanceCriteria: ['fixture works'], allowedPaths: ['src/**'], labChecks: ['health']
    }
  });
  const compiled = compileContract({
    taskId: spec.id!, spec, tier: 'T1', tags: null, rulebookFingerprint: null, policy: env.cfg.verification, budget: {
      total: 16, tierExecution: 4, nextTierExecution: 8, classificationUsed: 0
    }, now: Date.now()
  });
  if (!compiled.ok)
    throw new Error(compiled.message);
  const contract = compiled.contract;
  expect(contract.verification.requiredChecks).toContain('ephemeral_lab_checks');
  const result = baseResult({
    executionStatus: 'completed', acceptanceStatus: 'met', summary: 'model claims success', changedPaths: ['src/app.ts']
  });
  const report = runNamedChecks({
    contract, mode: 'coding', result, revision: 'b'.repeat(40), review: [{
        id: contract.criteria[0]!.id, outcome: 'pass'
      }]
  });
  expect(report.checks.find(c => c.name === 'ephemeral_lab_checks')).toMatchObject({
    required: true, outcome: 'failed'
  });
  expect(decide({
    policy: env.cfg.verification, contract, report, executionStatus: 'completed', qualityRetriesUsed: 1, review: { verdict: 'pass' }
  })).toMatchObject({
    acceptanceStatus: 'unmet', action: 'none'
  });
  expect(reevaluateOnResult(env.cfg.verification, contract, {
    protectedPathsChanged: [], changedPaths: ['src/app.ts']
  }).checks).toContain('ephemeral_lab_checks');
});
it('runs the synchronous acceptance snapshot fence inside the result transaction and rolls back on loss', () => {
  env = makeEnv();
  sy = open(env, new ScriptedClient(() => reply('{}')));
  const id = sy.tasks.submit([WorkerTaskSchema.parse({
      profile: 'summarize', goal: 'fixture', repositoryAliases: ['core'], constraints: { acceptanceCriteria: ['fixture'] }
    })])[0]!.taskId;
  sy.db.prepare("UPDATE tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify(baseResult({
    executionStatus: 'completed', acceptanceStatus: 'needs_supervisor', summary: 'fixture'
  })), id);
  const before = sy.tasks.get(id)!.result;
  let calls = 0;
  const deps = {
    cfg: env.cfg, tasks: sy.tasks, contracts: new ContractStore(sy.db), now: Date.now, beforeAccept: (task: StoredTask) => {
      calls++;
      expect(sy!.db.inTransaction).toBe(true);
      expect(task.row.id).toBe(id);
      throw new Error('snapshot changed');
    }
  };
  expect(() => recordAcceptanceDecision(deps, id, 'accept', {
    by: {
      kind: 'human', id: 'fixture'
    }, reason: 'reviewed'
  })).toThrow('snapshot changed');
  expect(calls).toBe(1);
  expect(sy.tasks.get(id)!.result).toEqual(before);
  expect(sy.tasks.events(id).some(e => e.type === 'result_accepted')).toBe(false);
  recordAcceptanceDecision(deps, id, 'reject', {
    by: {
      kind: 'human', id: 'fixture'
    }, reason: 'refused'
  });
  expect(calls).toBe(1);
});
it('keeps the MCP task Lab selection intact for the runtime task validator', () => {
  const input = {
    profile: 'implement', goal: 'fixture', repositoryAliases: ['core'], writableRepository: 'core', constraints: {
      acceptanceCriteria: ['fixture'], allowedPaths: ['src/**'], labChecks: ['health']
    }
  };
  expect(WorkerTaskSchema.parse(TaskArgumentSchema.parse(input)).constraints.labChecks).toEqual(['health']);
  expect(() => WorkerTaskSchema.parse(TaskArgumentSchema.parse({
    ...input, constraints: {
      ...input.constraints, labChecks: ['health', 'health']
    }
  }))).toThrow();
});
