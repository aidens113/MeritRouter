import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { makeEnv, open, ScriptedClient, reply, type Env } from './helpers.js';
import type { MeritRouter } from '../src/core/service.js';
import { WorkerTaskSchema } from '../src/core/task.js';
import { Worktrees } from '../src/workspaces/worktree.js';
import { git } from '../src/workspaces/git.js';
import { commitAs } from '../src/attribution/index.js';
import { recoveredEditActor, verifyRecoveredEditAttestation } from '../src/attribution/recovered-edit-provenance.js';
import * as provenance from '../src/attribution/recovered-edit-provenance.js';
import * as mutation from '../src/workspaces/repository-mutation.js';
import { syntheticResult } from '../src/storage/tasks.js';
import { capturedLease } from '../src/storage/task-leases.js';
import { WorkspacePointer } from '../src/runners/session-workspace.js';
import { applyResume } from '../src/harness/resume.js';
import { editTools } from '../src/harness/tools.js';
import { journaled } from '../src/harness/journal.js';
import { FAULT_ENV, isSimulatedCrash, resetFaults } from '../src/core/faults.js';
import { evidenceUniverse } from '../src/core/worker-output.js';
import type { RunContext } from '../src/runners/types.js';
import type { HarnessEnv } from '../src/harness/tools.js';
import type { ModelEndpoint } from '../src/models/catalog.js';
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
interface LegacyEditFixture {
  args: (target: string, content: string) => Record<string, unknown>;
  existing?: boolean;
  missingOutcome?: boolean;
}
async function fixture(options: { linked?: boolean; historical?: boolean; content?: string; fileBytes?: Buffer; endpointId?: string; legacyEdit?: LegacyEditFixture } = {}) {
  env = makeEnv(); const client = new ScriptedClient(() => { throw new Error('No live model transport allowed'); }); sy = open(env, client);
  sy.tasks.submit([WorkerTaskSchema.parse({ id: 'source', profile: 'implement', goal: 'Origin fixture', repositoryAliases: ['core'], writableRepository: 'core', constraints: { allowedPaths: ['src/**'], acceptanceCriteria: ['fixture'] } })], { project: env.cfg.brain.project });
  const task = sy.tasks.claim('owner', { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 600000, defaultTimeoutMs: 600000 })[0]!;
  const worktrees = new Worktrees(sy.db, path.join(env.cfg.storageDir, 'worktrees')), ws = await worktrees.prepare({ taskId: 'source', run: 1, alias: 'core', sourcePath: env.repo });
  const base = (await git(ws.worktreePath, ['rev-parse', 'HEAD'])).trim();
  const filename = options.legacyEdit?.existing ? 'src/app.ts' : 'src/recovered.ts';
  const content = options.legacyEdit?.existing ? readFileSync(path.join(ws.worktreePath, filename), 'utf8') : options.content ?? 'export const retained = true;\n';
  const actor = { agent: 'implementer:source', role: 'implementer', task: 'source', tier: 'T2' };
  const original = sy.sessions.create({ taskId: 'source', role: 'implementer', agentLabel: actor.agent, profile: 'implement', tier: 'T2' });
  const workspace = { repos: [{ alias: 'core', worktree: ws.worktreePath, baseCommit: base, head: base, branch: null }] };
  original.setWorkspace(workspace);
  const args = options.legacyEdit?.args(filename, content) ?? { path: filename, content }, call = { id: 'origin-write', type: 'function' as const, function: { name: 'write_file', arguments: JSON.stringify(args) } };
  const executionId = sy.admission.createExecution('task', 'implement', [{ taskId: 'source', itemId: 'source' }]), requestId = 'request-origin';
  const messages = [{ role: 'user' as const, content: 'Original goal' }]; original.syncMessages(messages);
  original.modelRequest({ executionId, purpose: 'coding', chat: { messages, max_tokens: 1000 } });
  original.modelResponse({ requestId, endpoint: { id: options.endpointId ?? 'fixture/actual-origin' } as ModelEndpoint, estimatedInputTokens: 10, attempts: [], response: reply(null, { model: 'actual-origin', provider: 'fixture', toolCalls: [call] }) });
  const originalEdit = { result: null as { ok: boolean; output: string } | null, interrupted: false };
  if (options.legacyEdit) {
    const ctx = { cfg: env.cfg, taskId: 'source', spec: task.spec, tasks: sy.tasks, taskLease: capturedLease(task), claimedRunCount: 1, taskProject: task.row.project_id, signal: new AbortController().signal, session: original, attempts: [], now: Date.now } as unknown as RunContext;
    const harness: HarnessEnv = { ctx, role: 'implementer', readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: 'core', root: ws.worktreePath, allowedPaths: ['src/**'] }, edits: new Set(), toolInvocationId: `${original.id}:${call.id}` };
    const tool = editTools().find(value => value.def.function.name === 'write_file')!;
    const previousFault = process.env[FAULT_ENV];
    try {
      resetFaults();
      if (options.legacyEdit.missingOutcome) process.env[FAULT_ENV] = 'after_tool_run:1:write_file';
      else delete process.env[FAULT_ENV];
      await journaled(original, call, args, tool, async () => {
        try { originalEdit.result = { ok: true, output: await tool.run(args, harness) }; }
        catch (error) { originalEdit.result = { ok: false, output: `error: ${(error as Error).message}` }; }
        return originalEdit.result;
      });
    } catch (error) {
      if (!isSimulatedCrash(error)) throw error;
      originalEdit.interrupted = true;
    } finally {
      if (previousFault === undefined) delete process.env[FAULT_ENV];
      else process.env[FAULT_ENV] = previousFault;
      resetFaults();
    }
  } else {
    const intentSeq = original.toolIntent({ callId: call.id, name: 'write_file', args, sideEffect: 'edit' });
    writeFileSync(path.join(ws.worktreePath, filename), options.fileBytes ?? content);
    original.toolOutcome(intentSeq, { ok: true, output: 'wrote exact original file' });
  }
  sy.db.prepare('INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,endpoint_id,served_model,served_provider,project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(requestId, executionId, 'coding', 'fixture/actual-origin', 'succeeded', Date.now(), 10, 1000, options.endpointId ?? 'fixture/actual-origin', 'actual-origin', 'fixture', task.row.project_id);
  sy.db.prepare('INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,run_count,lease_incarnation) VALUES(?,?,?,?,?,?)').run(requestId, 'source', 10, 20, 1, task.row.lease_incarnation);
  original.end('interrupted', 'user_paused');
  const current = options.linked ? sy.sessions.create({ taskId: 'source', previousSessionId: original.id, role: 'implementer', agentLabel: actor.agent, profile: 'implement', tier: 'T2' }) : sy.sessions.reopen(original.id);
  if (options.linked) { current.syncMessages(sy.sessions.transcript(original.id)!); current.setWorkspace(workspace); }
  let commit: string | null = null;
  if (options.historical !== false) {
    if (options.fileBytes) {
      execFileSync('git', ['add', '--', filename], { cwd: ws.worktreePath });
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@test', 'commit', '-qm', 'implementer: recovered edits after interruption', '--trailer', `Agent: ${actor.agent}`, '--trailer', 'Role: implementer', '--trailer', 'Task: source', '--trailer', 'Tier: T2'], { cwd: ws.worktreePath });
      commit = (await git(ws.worktreePath, ['rev-parse', 'HEAD'])).trim();
    } else commit = await commitAs(ws.worktreePath, actor, 'implementer: recovered edits after interruption');
    current.setWorkspace({ repos: [{ ...workspace.repos[0]!, head: commit }] });
    current.end('failed', 'deadline_exceeded');
    sy.tasks.finish('source', 'owner', syntheticResult('source', 'failed', 'deadline_exceeded'), 'failed');
  } else if (!options.legacyEdit) await git(ws.worktreePath, ['add', '--', filename]);
  const inspection = { project: task.row.project_id, taskId: 'source', alias: 'core', commit: commit! };
  return { client, task, ws, base, filename, content, actor, original, current, workspace, inspection, requestId, originalEdit, ctx: { tasks: sy.tasks, cfg: env.cfg, now: Date.now } };
}
it.each([false, true])('proves and attests exact historical origin with linked=%s without rewriting Git or provider history', async linked => {
  const f = await fixture({ linked }), before = await git(f.ws.worktreePath, ['cat-file', 'commit', f.inspection.commit]);
  const count = sy!.db.prepare('SELECT COUNT(*) n FROM model_requests').get();
  const inspection = await sy!.inspectRecoveredEditProvenance(f.inspection);
  expect(inspection.proof.files[0]?.origin).toMatchObject({ sessionId: f.original.id, endpointId: 'fixture/actual-origin', requestId: f.requestId, servedModel: 'actual-origin' });
  await expect(verifyRecoveredEditAttestation(f.ctx, f.inspection)).rejects.toThrow(/missing.*receipt/);
  const input = { ...f.inspection, operationId: 'attest-1', expectedDigest: inspection.digest, reason: 'Exact original model write and immutable recovered delta independently checked' };
  const receipt = await sy!.attestRecoveredEditProvenance(input);
  expect(receipt.disposition).toBe('fresh');
  expect((await sy!.attestRecoveredEditProvenance(input)).disposition).toBe('replayed');
  await expect(sy!.attestRecoveredEditProvenance({ ...input, reason: 'changed replay' })).rejects.toThrow(/replay/);
  await expect(verifyRecoveredEditAttestation(f.ctx, f.inspection)).resolves.toEqual(inspection.proof);
  expect(await git(f.ws.worktreePath, ['cat-file', 'commit', f.inspection.commit])).toBe(before);
  expect(sy!.db.prepare('SELECT COUNT(*) n FROM model_requests').get()).toEqual(count);
  expect(f.client.calls).toHaveLength(0);
});
it.each([false, true])('future ordinary/linked resume commits preserve original model and request despite a different selected route (linked=%s)', async linked => {
  const f = await fixture({ linked, historical: false });
  const plan = sy!.sessions.planResume(f.original.id)!;
  const ctx = { cfg: env!.cfg, taskId: 'source', spec: f.task.spec, tasks: sy!.tasks, taskLease: capturedLease(f.task), claimedRunCount: 1, taskProject: f.task.row.project_id, signal: new AbortController().signal, session: f.current, attempts: [], now: Date.now } as unknown as RunContext;
  const harness: HarnessEnv = { ctx, role: 'implementer', readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: 'core', root: f.ws.worktreePath, allowedPaths: ['src/**'] }, edits: new Set() };
  await applyResume({ env: harness, messages: plan.messages, tools: [], terminal: { def: { type: 'function', function: { name: 'submit_result', description: 'fixture', parameters: {} } }, accept: async () => ({ ok: false, errors: ['not submitted'] }) } }, { plan, actor: { ...f.actor, model: 'unrelated/new-route' }, pointer: new WorkspacePointer(f.current, f.workspace.repos) });
  const message = await git(f.ws.worktreePath, ['show', '-s', '--format=%B', 'HEAD']);
  expect(message).toContain('Model: fixture/actual-origin'); expect(message).toContain('Request: request-origin'); expect(message).not.toContain('unrelated/new-route');
  expect(f.client.calls).toHaveLength(0);
});
it.each(['ledger', 'blob', 'extra_path', 'foreign', 'scope', 'digest', 'receipt', 'actor', 'pointer', 'active'] as const)('refuses changed %s evidence or stale attestation', async variant => {
  const f = await fixture({ linked: true });
  const inspected = await sy!.inspectRecoveredEditProvenance(f.inspection);
  const input = { ...f.inspection, operationId: 'attest-1', expectedDigest: inspected.digest, reason: 'independent exact proof' };
  if (variant === 'digest') { await expect(sy!.attestRecoveredEditProvenance({ ...input, expectedDigest: '0'.repeat(64) })).rejects.toThrow(/digest/); return; }
  if (variant === 'receipt') { await sy!.attestRecoveredEditProvenance(input); sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.proof.files[0].origin.endpointId','forged') WHERE type='recovered_edit_provenance_attested'").run(); await expect(verifyRecoveredEditAttestation(f.ctx, f.inspection)).rejects.toThrow(/changed/); return; }
  if (variant === 'ledger') sy!.db.prepare("UPDATE model_requests SET served_model='forged' WHERE id=?").run(f.requestId);
  if (variant === 'foreign') { f.inspection.project = 'foreign'; input.project = 'foreign'; }
  if (variant === 'active') sy!.db.prepare("UPDATE tasks SET state='running',lease_owner='live' WHERE id='source'").run();
  if (variant === 'blob' || variant === 'extra_path') writeFileSync(path.join(f.ws.worktreePath, variant === 'blob' ? f.filename : 'src/extra.ts'), 'unproven bytes');
  if (variant === 'scope') { const task = sy!.tasks.get('source')!.spec; task.constraints.allowedPaths = ['other/**']; sy!.db.prepare("UPDATE tasks SET spec_json=? WHERE id='source'").run(JSON.stringify(task)); }
  if (variant === 'actor') sy!.db.prepare("UPDATE sessions SET agent_label='forged' WHERE id=?").run(f.original.id);
  if (variant === 'pointer') sy!.db.prepare("UPDATE sessions SET workspace_json=json_set(workspace_json,'$.repos[0].head',?) WHERE id=?").run(f.base, f.current.id);
  await expect(Promise.resolve().then(() => sy!.inspectRecoveredEditProvenance(f.inspection))).rejects.toThrow();
  await expect(Promise.resolve().then(() => sy!.attestRecoveredEditProvenance(input))).rejects.toThrow();
});
it('refuses unsupported future bytes before committing rather than inventing provenance', async () => {
  const f = await fixture({ historical: false }); writeFileSync(path.join(f.ws.worktreePath, f.filename), 'different content'); await git(f.ws.worktreePath, ['add', '--', f.filename]);
  await expect(recoveredEditActor(f.ctx, { taskId: 'source', sessionId: f.current.id, alias: 'core', worktree: f.ws.worktreePath, actor: f.actor })).rejects.toThrow(/differs/);
  expect((await git(f.ws.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
});



it('refuses byte-distinct invalid UTF8 even when Git text decoding matches original replacement-character content', async () => {
  const f = await fixture({ content: '\uFFFD', fileBytes: Buffer.from([255]) });
  await expect(sy!.inspectRecoveredEditProvenance(f.inspection)).rejects.toThrow(/exact Git blob bytes/);
});
it('refuses executable-bit changes that the original write_file never authorized', async () => {
  const f = await fixture({ historical: false });
  execFileSync('git', ['update-index', '--chmod=+x', '--', f.filename], { cwd: f.ws.worktreePath });
  await expect(recoveredEditActor(f.ctx, { taskId: 'source', sessionId: f.current.id, alias: 'core', worktree: f.ws.worktreePath, actor: f.actor })).rejects.toThrow(/mode change/);
});
it('rejects foreign stored worktree ownership before attempting any filesystem mutation lock', async () => {
  const f = await fixture(), inspected = await sy!.inspectRecoveredEditProvenance(f.inspection);
  sy!.db.prepare("UPDATE workspaces SET worktree_path=? WHERE task_id='source'").run(env!.repo);
  const lock = vi.spyOn(mutation, 'withRepositoryMutation');
  await expect(sy!.attestRecoveredEditProvenance({ ...f.inspection, operationId: 'foreign-path', expectedDigest: inspected.digest, reason: 'must refuse' })).rejects.toThrow();
  expect(lock).not.toHaveBeenCalled();
});
it('does not restage changed or extra source bytes after proving the recovered tree', async () => {
  const f = await fixture({ historical: false });
  const original = provenance.recoveredEditActor;
  vi.spyOn(provenance, 'recoveredEditActor').mockImplementation(async (...args) => {
    const proof = await original(...args);
    writeFileSync(path.join(f.ws.worktreePath, f.filename), 'changed after proof');
    writeFileSync(path.join(f.ws.worktreePath, 'src/extra.ts'), 'unproven addition');
    return proof;
  });
  const plan = sy!.sessions.planResume(f.original.id)!;
  const ctx = { cfg: env!.cfg, taskId: 'source', spec: f.task.spec, tasks: sy!.tasks, taskLease: capturedLease(f.task), claimedRunCount: 1, taskProject: f.task.row.project_id, signal: new AbortController().signal, session: f.current, attempts: [], now: Date.now } as unknown as RunContext;
  const harness: HarnessEnv = { ctx, role: 'implementer', readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: 'core', root: f.ws.worktreePath, allowedPaths: ['src/**'] }, edits: new Set() };
  await expect(applyResume({ env: harness, messages: plan.messages, tools: [], terminal: { def: { type: 'function', function: { name: 'submit_result', description: 'fixture', parameters: {} } }, accept: async () => ({ ok: false, errors: ['not submitted'] }) } }, { plan, actor: f.actor, pointer: new WorkspacePointer(f.current, f.workspace.repos) })).rejects.toThrow(/unsealed source changes/);
  expect((await git(f.ws.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
});
it('refuses a forged in-root Git pointer to a foreign common owner before acquiring mutation locks', async () => {
  const f = await fixture(), inspected = await sy!.inspectRecoveredEditProvenance(f.inspection);
  const foreign = path.join(env!.dir, 'foreign-owner'); mkdirSync(foreign);
  execFileSync('git', ['init', '-q'], { cwd: foreign });
  const forged = path.join(path.dirname(f.ws.worktreePath), 'forged-root'); mkdirSync(forged);
  writeFileSync(path.join(forged, '.git'), `gitdir: ${path.join(foreign, '.git').replace(/\\/g, '/')}\n`);
  sy!.db.prepare("UPDATE workspaces SET worktree_path=? WHERE task_id='source'").run(forged);
  const lock = vi.spyOn(mutation, 'withRepositoryMutation');
  await expect(sy!.attestRecoveredEditProvenance({ ...f.inspection, operationId: 'foreign-common', expectedDigest: inspected.digest, reason: 'must refuse' })).rejects.toThrow(/different configured repository/);
  expect(lock).not.toHaveBeenCalled();
});
it('rejects a planned endpoint alias that differs from the actual served model instead of stamping the route as authorship', async () => {
  const f = await fixture({ endpointId: 'fixture/planned-alias' });
  await expect(sy!.inspectRecoveredEditProvenance(f.inspection)).rejects.toThrow(/planned alias differs/);
});
it('refuses a committed clean mismatching blob rather than relying on worktree dirtiness', async () => {
  const f = await fixture({ content: 'original text', fileBytes: Buffer.from('different committed text') });
  expect((await git(f.ws.worktreePath, ['status', '--porcelain=v1'])).trim()).toBe('');
  await expect(sy!.inspectRecoveredEditProvenance(f.inspection)).rejects.toThrow(/recovered blob differs/);
});
it('rejects ancestor history appended after its linked continuation began', async () => {
  const f = await fixture({ linked: true });
  const reopened = sy!.sessions.reopen(f.original.id); reopened.note('later ancestor event'); reopened.end('interrupted', 'user_paused');
  await expect(sy!.inspectRecoveredEditProvenance(f.inspection)).rejects.toThrow(/ancestor session changed/);
});

async function resumeLegacyFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = sy!.sessions.planResume(f.original.id)!;
  expect(plan.actions.some(action => action.kind === 'reconcile_edits')).toBe(true);
  const ctx = { cfg: env!.cfg, taskId: 'source', spec: f.task.spec, tasks: sy!.tasks, taskLease: capturedLease(f.task), claimedRunCount: 1, taskProject: f.task.row.project_id, signal: new AbortController().signal, session: f.current, attempts: [], now: Date.now } as unknown as RunContext;
  const harness: HarnessEnv = { ctx, role: 'implementer', readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: 'core', root: f.ws.worktreePath, allowedPaths: ['src/**'] }, edits: new Set() };
  return applyResume({ env: harness, messages: plan.messages, tools: [], terminal: { def: { type: 'function', function: { name: 'submit_result', description: 'fixture', parameters: {} } }, accept: async () => ({ ok: false, errors: ['not submitted'] }) } }, { plan, actor: { ...f.actor, model: 'unrelated/resume-route' }, pointer: new WorkspacePointer(f.current, f.workspace.repos) });
}
function originalProofHistory(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    requests: sy!.db.prepare('SELECT * FROM model_requests ORDER BY id').all(),
    charges: sy!.db.prepare('SELECT * FROM request_charges ORDER BY request_id,task_id').all(),
    outcomes: sy!.sessions.events(f.original.id, { limit: 10000 })!.events.filter(event => event.type === 'tool_outcome'),
  };
}
const legacyAliasCases: Array<{ name: string; args: LegacyEditFixture['args'] }> = [
  { name: 'canonical path', args: (target, content) => ({ path: target, content }) },
  { name: 'filename only', args: (target, content) => ({ filename: target, content }) },
  { name: 'empty primary', args: (target, content) => ({ path: '', file_path: target, content }) },
  { name: 'blank primary', args: (target, content) => ({ path: ' \t', filename: target, content }) },
  { name: 'nonstring primary', args: (target, content) => ({ path: 17, file_path: target, content }) },
  { name: 'equivalent slash aliases', args: (target, content) => ({ path: target.replace(/\//g, '\\'), filename: target, content }) },
];
it.each(legacyAliasCases.flatMap(value => [false, true].map(missingOutcome => ({ ...value, missingOutcome }))))('recovers the actual legacy $name target with missingOutcome=$missingOutcome', async ({ args, missingOutcome }) => {
  const f = await fixture({ historical: false, legacyEdit: { args, missingOutcome } });
  expect(f.originalEdit.result?.ok).toBe(true); expect(f.originalEdit.interrupted).toBe(missingOutcome);
  const before = originalProofHistory(f);
  await resumeLegacyFixture(f);
  const message = await git(f.ws.worktreePath, ['show', '-s', '--format=%B', 'HEAD']);
  expect(message).toContain('Model: fixture/actual-origin'); expect(message).toContain('Request: request-origin');
  expect(message).not.toContain('unrelated/resume-route');
  expect((await git(f.ws.worktreePath, ['diff', '--name-only', f.base, 'HEAD'])).trim()).toBe(f.filename);
  expect(readFileSync(path.join(f.ws.worktreePath, f.filename), 'utf8')).toBe(f.content);
  expect((await git(f.ws.worktreePath, ['status', '--porcelain=v1'])).trim()).toBe('');
  expect(originalProofHistory(f)).toEqual(before); expect(f.client.calls).toHaveLength(0);
});
it.each([false, true])('refuses wrong-file attribution from ignored filePath with missingOutcome=%s', async missingOutcome => {
  const injected = 'src/injected.ts';
  const f = await fixture({ historical: false, legacyEdit: { existing: true, missingOutcome, args: (target, content) => ({ file_path: target, filePath: injected, content }) } });
  expect(f.originalEdit.result?.ok).toBe(true); expect(f.originalEdit.interrupted).toBe(missingOutcome);
  expect(readFileSync(path.join(f.ws.worktreePath, f.filename), 'utf8')).toBe(f.content);
  expect((await git(f.ws.worktreePath, ['status', '--porcelain=v1'])).trim()).toBe('');
  writeFileSync(path.join(f.ws.worktreePath, injected), f.content);
  const before = originalProofHistory(f);
  await expect(resumeLegacyFixture(f)).rejects.toThrow(/recovered_edit_provenance_refused/);
  expect((await git(f.ws.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
  expect(readFileSync(path.join(f.ws.worktreePath, injected), 'utf8')).toBe(f.content);
  expect(readFileSync(path.join(f.ws.worktreePath, f.filename), 'utf8')).toBe(f.content);
  expect((await git(f.ws.worktreePath, ['diff', '--cached', '--name-only', 'HEAD'])).trim()).toBe(injected);
  expect(originalProofHistory(f)).toEqual(before); expect(f.client.calls).toHaveLength(0);
});
const refusedAliasCases: Array<{ name: string; args: LegacyEditFixture['args']; diagnostic: RegExp }> = [
  { name: 'conflicting supported aliases', args: (target, content) => ({ path: target, file_path: 'src/different.ts', content }), diagnostic: /conflicting path fields/ },
  { name: 'unsupported filePath only', args: (target, content) => ({ filePath: target, content }), diagnostic: /needs path/ },
];
it.each(refusedAliasCases.flatMap(value => [false, true].map(missingOutcome => ({ ...value, missingOutcome }))))('retains refusal of legacy $name with missingOutcome=$missingOutcome', async ({ args, diagnostic, missingOutcome }) => {
  const f = await fixture({ historical: false, legacyEdit: { args, missingOutcome } });
  expect(f.originalEdit.result?.ok).toBe(false); expect(f.originalEdit.result?.output).toMatch(diagnostic);
  expect(f.originalEdit.interrupted).toBe(missingOutcome);
  expect((await git(f.ws.worktreePath, ['status', '--porcelain=v1'])).trim()).toBe('');
  writeFileSync(path.join(f.ws.worktreePath, f.filename), f.content);
  const before = originalProofHistory(f);
  await expect(resumeLegacyFixture(f)).rejects.toThrow(diagnostic);
  expect((await git(f.ws.worktreePath, ['rev-parse', 'HEAD'])).trim()).toBe(f.base);
  expect(readFileSync(path.join(f.ws.worktreePath, f.filename), 'utf8')).toBe(f.content);
  expect((await git(f.ws.worktreePath, ['diff', '--cached', '--name-only', 'HEAD'])).trim()).toBe(f.filename);
  expect(originalProofHistory(f)).toEqual(before); expect(f.client.calls).toHaveLength(0);
});
