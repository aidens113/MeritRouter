import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import type { GateRequest } from "../src/gateway/gate.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { RequestPersistenceError, type ReserveRequestDTO, type ReservationDTO, type RequestOutcomeDTO } from "../src/admission/request-ledger.js";
import { RequestReceipts } from "../src/admission/request-receipts.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
const releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await sy?.close(); vi.restoreAllMocks(); env?.cleanup(); sy = undefined; env = undefined; });
function barrier() { let release!: () => void; const promise = new Promise<void>(r => release = r); releases.push(release); return { promise, release }; }
function setup(handler?: ScriptedClient['handler']) {
  const client = new ScriptedClient(handler ?? (req => reply('ok', { model: req.model, provider: req.provider })));
  env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ team: { provider_concurrency_start: 1, provider_concurrency_max: 1 } }) });
  sy = open(env, client, { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: 'protocol-task' }))]);
  sy.tasks.claim('same-owner', { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const lease = capturedLease(sy.tasks.get('protocol-task')!);
  const request: GateRequest = { plan: sy.router.plan('summarize', 'T1', ['text']), executionId: sy.admission.createExecution('task', 'summarize', [{ taskId: lease.taskId, itemId: '1' }]), purpose: 'fixture', participants: [{ taskId: lease.taskId, leaseOwner: lease.owner, lease, budget: { maxModelRequests: 8, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null } }], chat: { messages: [{ role: 'user', content: 'private fixture' }], max_tokens: 100 } };
  return { client, request, lease };
}
it('requires captured identity on task participants while preserving explicit taskless package accounting', async () => {
  const { client, request } = setup();
  await expect(sy!.gate.request({ ...request, participants: request.participants.map(({ lease, ...p }) => p) as unknown as GateRequest["participants"] })).rejects.toThrow();
  expect(client.requests).toHaveLength(0);
  const result = await sy!.gate.request({ ...request, participants: [] });
  expect(result.requestId).toBeTruthy(); expect(client.requests).toHaveLength(1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM model_requests').pluck().get()).toBe(1);
});
it.each(['reserve', 'beginDispatch'])('retains committed %s with lost acknowledgement and never dispatches or retries', async stage => {
  const { client, request } = setup();
  let input: ReserveRequestDTO | undefined, reserved: ReservationDTO | undefined;
  const ledger = sy!.gate.ledger, reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementation(async value => { input = value; reserved = await reserve(value); if (stage === 'reserve') throw new Error('lost reserve ACK'); return reserved; });
  if (stage === 'beginDispatch') {
    const begin = ledger.beginDispatch.bind(ledger);
    vi.spyOn(ledger, 'beginDispatch').mockImplementation(async (...args) => { await begin(...args); throw new Error('lost intent ACK'); });
  }
  const error = await sy!.gate.request(request).catch(e => e);
  expect(error).toBeInstanceOf(RequestPersistenceError); expect(error.requestId).toBe(input!.requestId);
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM model_requests').pluck().get()).toBe(1);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM request_charges').pluck().get()).toBe(1);
  expect((await reserve(input!)).disposition).toBe('replayed');
  await expect(reserve({ ...input!, payloadDigest: 'f'.repeat(64) })).rejects.toThrow(/different payload/);
  expect(sy!.db.prepare('SELECT uncertain FROM provider_slots').pluck().get()).toBe(1);
  expect(new RequestReceipts(sy!.db).blockers(request.participants[0]!.lease!.project).requests).toBe(1);
});
it.each(['reserve', 'beginDispatch', 'capture'])('revalidates same-owner generation after awaited %s without AbortSignal', async stage => {
  const { client, request } = setup(), gate = sy!.gate;
  if (stage === 'capture') {
    const begin = gate.captures.begin.bind(gate.captures);
    vi.spyOn(gate.captures, 'begin').mockImplementation(async (...args) => { await begin(...args); sy!.db.prepare('UPDATE tasks SET run_count=run_count+1').run(); });
  } else if (stage === 'reserve') {
    const reserve = gate.ledger.reserve.bind(gate.ledger);
    vi.spyOn(gate.ledger, 'reserve').mockImplementation(async input => { const result = await reserve(input); sy!.db.prepare('UPDATE tasks SET run_count=run_count+1').run(); return result; });
  } else {
    const begin = gate.ledger.beginDispatch.bind(gate.ledger);
    vi.spyOn(gate.ledger, 'beginDispatch').mockImplementation(async (...args) => { const result = await begin(...args); sy!.db.prepare('UPDATE tasks SET run_count=run_count+1').run(); return result; });
  }
  await expect(gate.request(request)).rejects.toMatchObject({ reason: 'lease_lost' });
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare('SELECT status FROM model_requests').pluck().get()).toBe('failed');
  expect(sy!.db.prepare('SELECT COUNT(*) FROM provider_slots').pluck().get()).toBe(0);
});
it('replays committed settlement once, retains uncertain hold, and rejects conflicting outcome', async () => {
  const { client, request } = setup(), ledger = sy!.gate.ledger;
  let reserved!: ReservationDTO, outcome!: RequestOutcomeDTO;
  const reconcile = ledger.reconcile.bind(ledger);
  vi.spyOn(ledger, 'reconcile').mockImplementation(async (r, o) => { reserved = r; outcome = o; await reconcile(r, o); throw new Error('lost settle ACK'); });
  await expect(sy!.gate.request(request)).rejects.toBeInstanceOf(RequestPersistenceError);
  expect(client.requests).toHaveLength(1);
  await reconcile(reserved, outcome);
  await expect(reconcile(reserved, { kind: 'failed', errorKind: 'fake', errorMessage: 'changed' })).rejects.toThrow(/conflicting/);
  expect(sy!.db.prepare('SELECT status FROM model_requests').pluck().get()).toBe('succeeded');
  expect(sy!.db.prepare('SELECT COUNT(*) FROM request_charges').pluck().get()).toBe(1);
  expect(sy!.db.prepare('SELECT uncertain FROM provider_slots').pluck().get()).toBe(1);
});
it('keeps local HTTP capacity across takeover and records late usage against original request', async () => {
  const entered = barrier(), release = barrier();
  const { client, request, lease } = setup(async req => { entered.release(); await release.promise; return reply('late', { model: req.model, provider: req.provider, usage: { inputTokens: 41, outputTokens: 17 } }); });
  const result = sy!.gate.request(request);
  await entered.promise;
  const cap = sy!.gate.health.capacity, platform = request.plan.candidates[0]!.providerId;
  sy!.db.prepare("UPDATE tasks SET lease_expires_at=0").run();
  expect(cap.usage(platform).requests).toBe(1);
  sy!.db.prepare("UPDATE tasks SET run_count=run_count+1,lease_expires_at=?,result_json=NULL").run(Date.now() + 60000);
  const next = capturedLease(sy!.tasks.get(lease.taskId)!);
  cap.recordClaim(next.taskId, next.owner, platform, next);
  expect(cap.usage(platform).requests).toBe(1);
  const remote = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/request-capacity-process.mjs', import.meta.url)), sy!.cfg.storageDir, platform, JSON.stringify(next), JSON.stringify(sy!.cfg.team)], { encoding: 'utf8', windowsHide: true }));
  expect(remote).toMatchObject({ full: true, held: 1 });
  expect(cap.tryAcquire({ id: 'new-holder', leases: [next], taskIds: [next.taskId], leaseOwner: next.owner, priority: 0, since: null }, platform)).toMatchObject({ full: true });
  release.release(); await result;
  expect(client.requests).toHaveLength(1);
  expect(cap.usage(platform).requests).toBe(0);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM provider_slots WHERE kind='claim'").pluck().get()).toBe(1);
  expect(sy!.tasks.get(lease.taskId)!.row.run_count).toBe(next.runCount);
  expect(sy!.tasks.get(lease.taskId)!.row.result_json).toBeNull();
  expect(sy!.db.prepare('SELECT input_tokens,output_tokens,run_count FROM request_charges').get()).toEqual({ input_tokens: 41, output_tokens: 17, run_count: lease.runCount });
});
it('purges private settled bindings but never resurrects a consumed request ID', async () => {
  const { request } = setup(), ledger = sy!.gate.ledger;
  let input!: ReserveRequestDTO, reserved!: ReservationDTO;
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementation(async value => { input = value; reserved = await reserve(value); return reserved; });
  await sy!.gate.request(request);
  const receipts = new RequestReceipts(sy!.db), project = request.participants[0]!.lease!.project;
  expect(receipts.blockers(project)).toEqual({ requests: 0, slots: 0 });
  expect(receipts.purgeProject(project)).toEqual({ receipts: 1 });
  expect(sy!.db.prepare('SELECT COUNT(*) FROM request_protocol').pluck().get()).toBe(0);
  await expect(reserve(input)).rejects.toThrow(/purged/);
  await expect(ledger.reconcile(reserved, { kind: 'failed', errorKind: 'late', errorMessage: 'private' })).rejects.toThrow(/purged/);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM request_protocol').pluck().get()).toBe(0);
});

it('refuses an old captured incarnation after actual explicit task-ID reuse', async () => {
  const { request, client, lease } = setup();
  sy!.db.prepare('DELETE FROM execution_members WHERE task_id=?').run(lease.taskId);
  sy!.db.prepare('DELETE FROM tasks WHERE id=?').run(lease.taskId);
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: lease.taskId }))]);
  sy!.tasks.claim(lease.owner, { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  sy!.db.prepare('INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,?,?)').run(request.executionId, lease.taskId, '1');
  expect(sy!.tasks.get(lease.taskId)!.row.lease_incarnation).not.toBe(lease.incarnation);
  await expect(sy!.gate.request(request)).rejects.toMatchObject({ reason: 'lease_lost' });
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare('SELECT COUNT(*) FROM request_charges').pluck().get()).toBe(0);
});
it('detaches normalized body before reserve awaits and drains pending dispatch intent on close', async () => {
  const { request, client } = setup(), entered = barrier(), release = barrier();
  const begin = sy!.gate.ledger.beginDispatch.bind(sy!.gate.ledger);
  vi.spyOn(sy!.gate.ledger, 'beginDispatch').mockImplementation(async (...args) => { const receipt = await begin(...args); entered.release(); await release.promise; return receipt; });
  const pending = sy!.gate.request(request);
  await entered.promise;
  request.chat.messages[0]!.content = 'late caller mutation';
  let closed = false;
  const closing = sy!.gate.close().then(() => closed = true);
  await new Promise(r => setTimeout(r, 20));
  expect(closed).toBe(false); expect(sy!.db.open).toBe(true); expect(client.requests).toHaveLength(0);
  release.release(); await pending; await closing;
  expect(client.requests[0]!.messages[0]!.content).toBe('private fixture');
  expect(closed).toBe(true);
});

it('retains strict transport proof with a corrupted nonce rather than adopting legacy expiry', async () => {
  const entered = barrier(), release = barrier();
  const { request, lease } = setup(async req => { entered.release(); await release.promise; return reply('done', { model: req.model, provider: req.provider }); });
  const pending = sy!.gate.request(request); await entered.promise;
  sy!.db.prepare("UPDATE provider_slots SET nonce=NULL WHERE kind='request'").run();
  sy!.db.prepare('UPDATE tasks SET lease_expires_at=0').run();
  const cap = sy!.gate.health.capacity, platform = request.plan.candidates[0]!.providerId;
  expect(cap.usage(platform).requests).toBe(1);
  expect(new RequestReceipts(sy!.db).blockers(lease.project).slots).toBe(1);
  release.release(); await pending;
  expect(cap.usage(platform).requests).toBe(1);
  expect(() => new RequestReceipts(sy!.db).purgeProject(lease.project)).toThrow(/unresolved/);
});
