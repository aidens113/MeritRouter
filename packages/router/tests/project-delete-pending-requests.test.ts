import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { RequestReceipts } from "../src/admission/request-receipts.js";
import { requestAttemptId, type ReservationDTO, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { deleteProject, previewProjectDeletion } from "../src/admin/insights.js";
import { purgeProjectRows } from "../src/projects/deletion.js";
import { baseConfig, endpoint, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await sy?.close(); vi.restoreAllMocks(); env?.cleanup(); sy = undefined; env = undefined; });
function barrier() { let release!: () => void; const promise = new Promise<void>(r => release = r); releases.push(release); return { promise, release }; }
function setup(handler?: ScriptedClient["handler"]) {
  env = makeEnv({ endpoints: [endpoint()], config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" }, projects: {
    alpha: { repositories: { app: { path: "repo" } } }, beta: { repositories: { app: { path: "repo" } } },
  } }) });
  const client = new ScriptedClient(handler ?? (req => reply("private response", { model: req.model, provider: req.provider })));
  sy = open(env, client, { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "pending-delete" }))], { project: "beta" });
  sy.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const lease = capturedLease(sy.tasks.get("pending-delete")!);
  return { client, request: { plan: sy.router.plan("summarize", "T1", ["text"]), executionId: sy.admission.createExecution("task", "summarize", [{ taskId: lease.taskId, itemId: "1" }]), purpose: "fixture",
    participants: [{ taskId: lease.taskId, leaseOwner: lease.owner, lease, budget: { maxModelRequests: 8, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null } }],
    chat: { messages: [{ role: "user" as const, content: "private pending prompt" }], max_tokens: 100 } } };
}
function terminal() { sy!.db.prepare("UPDATE tasks SET state='failed' WHERE id='pending-delete'").run(); }

it.each(["reserve", "beginDispatch"] as const)("deletion fences a live old-process callback paused after %s", async stage => {
  const { request, client } = setup(), entered = barrier(), resume = barrier(), ledger = sy!.gate.ledger;
  let reservation!: ReservationDTO, input!: ReserveRequestDTO;
  const reserve = ledger.reserve.bind(ledger), begin = ledger.beginDispatch.bind(ledger);
  vi.spyOn(ledger, "reserve").mockImplementation(async value => {
    // A genuine paid ledger reservation with fake credentials, not a manually added spend row.
    input = { ...value, paid: { key: { ref: "fixture-paid-key", label: "Fixture", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null }, provider: "openrouter", worstCaseUsd: 0.7, price: { in: 1, out: 2 } } };
    reservation = await reserve(input);
    if (stage === "reserve") { entered.release(); await resume.promise; }
    return reservation;
  });
  if (stage === "beginDispatch") vi.spyOn(ledger, "beginDispatch").mockImplementation(async (...args) => { const result = await begin(...args); entered.release(); await resume.promise; return result; });
  const pending = sy!.gate.request(request).catch(error => error);
  await entered.promise;
  // Separate projects' strict holds must survive byte-for-byte unchanged.
  sy!.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,priority,since,seen_at,lease_json,nonce,uncertain) VALUES('foreign','foreign','request','foreign-holder','foreign-task',0,1,1,?,'foreign-nonce',1)").run(JSON.stringify([{ project: "alpha" }]));
  const foreign = sy!.db.prepare("SELECT * FROM provider_slots WHERE id='foreign'").get();
  terminal();
  expect((await previewProjectDeletion(sy!, "beta")).retainedRequests).toEqual({ pendingRequests: 1, retainedTransportHolds: 1 });
  const deleted = await deleteProject(sy!, "beta", { confirm: "beta" });
  expect(deleted.problems).toEqual([]);
  expect(deleted.retainedRequests).toEqual({ pendingRequests: 1, retainedTransportHolds: 1 });
  expect(sy!.db.prepare("SELECT status,project_id FROM model_requests").get()).toEqual({ status: stage === "reserve" ? "failed" : "uncertain", project_id: "" });
  expect(reservation.paid?.worstCaseUsd).toBe(0.7);
  expect(sy!.db.prepare("SELECT actual_usd,cost_basis FROM paid_spend").get()).toEqual({ actual_usd: stage === "reserve" ? 0 : 0.7, cost_basis: stage === "reserve" ? "not_billed" : "uncertain" });
  expect(sy!.db.prepare("SELECT estimated_cost_usd FROM model_requests").pluck().get()).toBe(stage === "reserve" ? 0 : 0.7);
  expect(sy!.db.prepare("SELECT * FROM provider_slots WHERE id='foreign'").get()).toEqual(foreign);
  expect(sy!.health.capacity.usage("openrouter").requests).toBe(1);
  expect(() => new RequestReceipts(sy!.db).assertDispatch(reservation, "old-dispatch")).toThrow(/purged/);
  await expect(begin(reservation, "late-dispatch")).rejects.toThrow(/purged/);
  await expect(reserve(input)).rejects.toThrow(/purged/);
  resume.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(client.requests).toHaveLength(0);
  await expect(ledger.reconcile(reservation, { kind: "failed", errorKind: "late", errorMessage: "private late error" })).rejects.toThrow(/purged/);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_protocol").pluck().get()).toBe(0);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_captures WHERE payload_json IS NOT NULL").pluck().get()).toBe(0);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_deletion_tombstones").pluck().get()).toBe(1);
  // An old binary's expired-key GC must not fail because a new quarantine tombstone exists.
  sy!.db.prepare("UPDATE request_protocol_keys SET expires_at=0 WHERE id=?").run(input.requestId);
  expect(() => sy!.db.prepare("DELETE FROM request_protocol_keys WHERE id IN (SELECT k.id FROM request_protocol_keys k LEFT JOIN request_protocol p ON p.request_id=k.id WHERE k.expires_at<? AND p.request_id IS NULL LIMIT 64)").run(Date.now())).not.toThrow();
  expect(sy!.db.prepare("SELECT 1 FROM request_protocol_keys WHERE id=?").get(input.requestId)).toBeUndefined();
  await expect(reserve(input)).rejects.toThrow(/purged/);
  const fresh = await reserve({ ...input, requestId: requestAttemptId(), participants: [], slot: undefined });
  expect(fresh.disposition).toBe("fresh");
  expect(new RequestReceipts(sy!.db).purgeProject("beta")).toEqual({ receipts: 0 });
  expect(sy!.db.pragma("foreign_key_check")).toEqual([]);
});

it("late dispatched provider response cannot overwrite conservative accounting or restore private captures", async () => {
  const entered = barrier(), resume = barrier();
  const { request } = setup(async req => { entered.release(); await resume.promise; return reply("private late response", { model: req.model, provider: req.provider, usage: { inputTokens: 1, outputTokens: 2 } }); });
  const pending = sy!.gate.request(request).catch(error => error);
  await entered.promise;
  const requestId = sy!.db.prepare("SELECT id FROM model_requests").pluck().get() as string;
  sy!.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,created_at) VALUES(?,'fixture','openrouter','fixture',0.7,1)").run(requestId);
  terminal();
  await deleteProject(sy!, "beta", { confirm: "beta" });
  const accounting = sy!.db.prepare("SELECT * FROM model_requests WHERE id=?").get(requestId);
  expect(sy!.db.prepare("SELECT actual_usd,cost_basis FROM paid_spend WHERE request_id=?").get(requestId)).toEqual({ actual_usd: 0.7, cost_basis: "uncertain" });
  resume.release();
  expect(await pending).toBeInstanceOf(Error);
  expect(sy!.db.prepare("SELECT * FROM model_requests WHERE id=?").get(requestId)).toEqual(accounting);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_captures").pluck().get()).toBe(0);
  expect(sy!.health.capacity.usage("openrouter").requests).toBe(1);
});

it("deletion failure rolls back retirement and keeps private data/config intact", async () => {
  const { request } = setup(), ledger = sy!.gate.ledger, original = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, "reserve").mockImplementation(async input => { await original(input); throw Error("lost acknowledgement"); });
  await expect(sy!.gate.request(request)).rejects.toThrow(/lost acknowledgement/);
  terminal();
  const config = readFileSync(env!.cfg.configPath, "utf8"), before = sy!.db.prepare("SELECT * FROM request_protocol").get();
  sy!.db.exec("CREATE TRIGGER reject_deletion BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'fixture deletion refused'); END;");
  await expect(deleteProject(sy!, "beta", { confirm: "beta" })).rejects.toThrow(/fixture deletion refused/);
  expect(readFileSync(env!.cfg.configPath, "utf8")).toBe(config);
  expect(sy!.db.prepare("SELECT * FROM request_protocol").get()).toEqual(before);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_deletion_tombstones").pluck().get()).toBe(0);
  expect(sy!.tasks.get("pending-delete")).toBeDefined();
});

it("already settled successful usage and spend remain authoritative with a retained hold", async () => {
  const { request } = setup(), ledger = sy!.gate.ledger;
  let reservation!: ReservationDTO;
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, "reserve").mockImplementation(async value => { reservation = await reserve(value); return reservation; });
  const result = await sy!.gate.request(request);
  sy!.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,actual_usd,cost_basis,created_at,settled_at) VALUES(?,'fixture','openrouter','fixture',0.7,0.2,'provider_reported',1,2)").run(result.requestId);
  sy!.db.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,uncertain) VALUES('settled-hold','openrouter','request','holder','pending-delete','owner',0,1,1,?,'nonce',1)").run(JSON.stringify([request.participants[0]!.lease]));
  const before = sy!.db.prepare("SELECT status,input_tokens,output_tokens,finished_at FROM model_requests WHERE id=?").get(result.requestId);
  terminal();
  expect((await deleteProject(sy!, "beta", { confirm: "beta" })).retainedRequests).toEqual({ pendingRequests: 0, retainedTransportHolds: 1 });
  await expect(ledger.reconcile(reservation, { kind: "uncertain", errorKind: "late", errorMessage: "private" })).rejects.toThrow(/purged/);
  expect(sy!.db.prepare("SELECT status,input_tokens,output_tokens,finished_at FROM model_requests WHERE id=?").get(result.requestId)).toEqual(before);
  expect(sy!.db.prepare("SELECT actual_usd,cost_basis,settled_at FROM paid_spend WHERE request_id=?").get(result.requestId)).toEqual({ actual_usd: 0.2, cost_basis: "provider_reported", settled_at: 2 });
  expect(sy!.health.capacity.usage("openrouter").requests).toBe(1);
});

it("active tasks and mixed-project request authority still refuse before lifecycle mutations", async () => {
  const { request } = setup(), ledger = sy!.gate.ledger, original = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, "reserve").mockImplementation(async input => { await original(input); throw Error("lost acknowledgement"); });
  await expect(sy!.gate.request(request)).rejects.toThrow();
  expect(() => purgeProjectRows(sy!.db, "beta", ["running"])).toThrow(/running or queued/);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_deletion_tombstones").pluck().get()).toBe(0);
  terminal();
  sy!.db.prepare("INSERT INTO request_protocol_projects(request_id,project_id) SELECT request_id,'alpha' FROM request_protocol").run();
  expect((await previewProjectDeletion(sy!, "beta")).blockers.join(" ")).toContain("exclusive project ownership");
  await expect(deleteProject(sy!, "beta", { confirm: "beta" })).rejects.toThrow(/exclusive project ownership/);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM request_protocol").pluck().get()).toBe(1);
});
