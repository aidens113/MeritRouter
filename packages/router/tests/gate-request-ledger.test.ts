import { capturedLease } from "../src/storage/task-leases.js";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { MeritRouter } from "../src/core/service.js";
import type { GateRequest } from "../src/gateway/gate.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { AdmissionDenied, GatewayError } from "../src/core/errors.js";
import { RequestPersistenceError } from "../src/admission/request-ledger.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env, type ScriptedRequest } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await sy?.close(); sy = undefined; vi.restoreAllMocks(); env?.cleanup(); env = undefined; });
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); releases.push(release); return { promise, release }; }
function setup(opts: { paid?: boolean; worker?: boolean; respond?: (req: ScriptedRequest, n: number) => ReturnType<typeof reply> } = {}) {
  const client = new ScriptedClient((req, n) => opts.respond?.(req, n) ?? reply(JSON.stringify(goodOutput()), { model: req.model, provider: req.provider }));
  env = makeEnv({ endpoints: [endpoint(), endpoint({ providerId: "groq", gatewayModelId: "vendor/second:free" })], config: baseConfig(opts.paid ? {
    paid: { enabled: true, budgets: { per_week_usd: 5 }, tiers: { T1: "preferred", T2: "preferred", T3: "preferred" }, providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } }, models: [{ provider: "acme", model: "fixture-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }] },
  } : {}) });
  sy = open(env, client, { worker: opts.worker ?? false });
  if (opts.paid) sy.vault.add({ provider: "acme", label: "fixture", secret: "fake-no-quota-key" });
  const request: GateRequest = {
    plan: sy.router.plan("summarize", "T1", ["text"], undefined, false, opts.paid ? "preferred" : undefined),
    executionId: sy.admission.createExecution("task", "summarize", []), purpose: "completion", participants: [], chat: { messages: [{ role: "user", content: "fixture input" }], max_tokens: 100 },
  };
  return { client, request };
}

it("does not invoke a provider until the async reservation commits", async () => {
  const { client, request } = setup({ respond: req => {
    const observer = new Database(sy!.db.name, { readonly: true });
    try { expect(observer.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "reserved" }); }
    finally { observer.close(); }
    expect(sy!.db.inTransaction).toBe(false);
    return reply("ok", { model: req.model, provider: req.provider });
  } });
  const entered = barrier(), blocked = barrier();
  const reserve = sy!.gate.ledger.reserve.bind(sy!.gate.ledger);
  vi.spyOn(sy!.gate.ledger, "reserve").mockImplementation(async input => { entered.release(); await blocked.promise; return reserve(input); });
  const result = sy!.gate.request(request).catch(error => error);
  await entered.promise;
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 0 });
  blocked.release();
  expect(await result).toHaveProperty("requestId");
  expect(client.requests).toHaveLength(1);
  expect(sy!.db.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "succeeded" });
});

it("treats reservation rejection as persistence failure without dispatch or provider fallback", async () => {
  const { client, request } = setup();
  vi.spyOn(sy!.gate.ledger, "reserve").mockRejectedValue(new GatewayError("transport", "ledger transport failure"));
  const error = await sy!.gate.request(request).catch(error => error);
  expect(error).toBeInstanceOf(RequestPersistenceError);
  expect(error.stage).toBe("reserve");
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 0 });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM provider_usage").get()).toEqual({ n: 0 });
});

it("waits for settlement before returning and drains outstanding accounting before service close", async () => {
  const { client, request } = setup();
  const entered = barrier(), blocked = barrier();
  const reconcile = sy!.gate.ledger.reconcile.bind(sy!.gate.ledger);
  vi.spyOn(sy!.gate.ledger, "reconcile").mockImplementation(async (reserved, outcome) => { entered.release(); await blocked.promise; await reconcile(reserved, outcome); });
  let returned = false, closed = false;
  const result = sy!.gate.request(request).then(r => { returned = true; return r; }, error => error);
  await entered.promise;
  expect(client.requests).toHaveLength(1); expect(returned).toBe(false);
  expect(sy!.db.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "reserved" });
  const closing = sy!.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 20));
  expect(closed).toBe(false); expect(sy!.db.open).toBe(true);
  await expect(sy!.gate.request(request)).rejects.toThrow("gate is closed");
  blocked.release();
  expect(await result).toHaveProperty("requestId");
  await closing;
  expect(returned).toBe(true); expect(sy!.db.open).toBe(false);
  sy = undefined;
});

it("an abort while a paid reservation is pending never dispatches and records definitely-unsent billing", async () => {
  const { client, request } = setup({ paid: true });
  const entered = barrier(), blocked = barrier();
  const reserve = sy!.gate.ledger.reserve.bind(sy!.gate.ledger);
  vi.spyOn(sy!.gate.ledger, "reserve").mockImplementation(async input => { const committed = await reserve(input); entered.release(); await blocked.promise; return committed; });
  const controller = new AbortController();
  const result = sy!.gate.request({ ...request, signal: controller.signal }).catch(error => error);
  await entered.promise;
  expect(sy!.db.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "reserved" });
  controller.abort("fixture cancelled"); blocked.release();
  expect(await result).toMatchObject({ kind: "aborted" });
  expect(client.requests).toHaveLength(0);
  expect(sy!.db.prepare("SELECT status,error_kind FROM model_requests").get()).toEqual({ status: "failed", error_kind: "aborted" });
  expect(sy!.db.prepare("SELECT actual_usd,cost_basis FROM paid_spend").get()).toEqual({ actual_usd: 0, cost_basis: "not_billed" });
});

it("waits for a failed provider attempt's settlement before calling the next endpoint", async () => {
  const order: string[] = [];
  const { client, request } = setup({ respond: (req, n) => {
    order.push(`provider-${n}`);
    if (n === 1) throw new GatewayError("server", "fixture 502", 502);
    return reply("ok", { model: req.model, provider: req.provider });
  } });
  const entered = barrier(), blocked = barrier();
  const reconcile = sy!.gate.ledger.reconcile.bind(sy!.gate.ledger);
  vi.spyOn(sy!.gate.ledger, "reconcile").mockImplementation(async (reserved, outcome) => {
    if (outcome.kind !== "succeeded") { order.push("settlement-start"); entered.release(); await blocked.promise; await reconcile(reserved, outcome); order.push("settlement-end"); }
    else await reconcile(reserved, outcome);
  });
  const result = sy!.gate.request(request).catch(error => error);
  await entered.promise;
  expect(client.requests).toHaveLength(1);
  blocked.release();
  expect(await result).toHaveProperty("requestId");
  expect(order).toEqual(["provider-1", "settlement-start", "settlement-end", "provider-2"]);
});

it.each([false, true])("settlement rejection after a paid provider attempt preserves evidence without fallback (provider failed: %s)", async providerFailed => {
  const { client, request } = setup({ paid: true, respond: req => {
    if (providerFailed) throw new GatewayError("server", "fixture provider failure", 502);
    return reply("ok", { model: req.model, provider: req.provider });
  } });
  vi.spyOn(sy!.gate.ledger, "reconcile").mockRejectedValue(new GatewayError("transport", "ledger settlement unavailable"));
  const error = await sy!.gate.request(request).catch(error => error);
  expect(error).toBeInstanceOf(RequestPersistenceError); expect(error.stage).toBe("reconcile");
  expect(client.requests).toHaveLength(1);
  const row = sy!.db.prepare("SELECT id,status FROM model_requests").get() as { id: string; status: string };
  expect(row).toEqual({ id: error.requestId, status: "reserved" });
  const paid = sy!.db.prepare("SELECT reserved_usd,actual_usd FROM paid_spend").get() as { reserved_usd: number; actual_usd: null };
  expect(paid.reserved_usd).toBeGreaterThan(0); expect(paid.actual_usd).toBeNull();
  expect(sy!.spend.summary().week).toBe(paid.reserved_usd);
});

it("the actual default submitted-task path uses data-only ledger requests and persists unchanged charges", async () => {
  const { client } = setup({ worker: true });
  const reserve = vi.spyOn(sy!.gate.ledger, "reserve");
  const reconcile = vi.spyOn(sy!.gate.ledger, "reconcile");
  const [task] = await sy!.submitTasks([summarizeTask()]);
  const result = await sy!.awaitResults([task!.taskId], { timeoutSeconds: 15 });
  expect(result.completed[0]!.executionStatus).toBe("completed");
  expect(reserve).toHaveBeenCalledTimes(1); expect(reconcile).toHaveBeenCalledTimes(1);
  expect(client.requests).toHaveLength(1);
  expect(sy!.db.prepare("SELECT status,input_tokens,output_tokens FROM model_requests").get()).toEqual({ status: "succeeded", input_tokens: 100, output_tokens: 50 });
  expect(sy!.db.prepare("SELECT task_id,input_tokens,output_tokens,tokens_exact FROM request_charges").get()).toEqual({ task_id: task!.taskId, input_tokens: 100, output_tokens: 50, tokens_exact: 1 });
  expect(reconcile.mock.calls[0]![1].response).not.toHaveProperty("message");
});


it.each([
  ["owner", "UPDATE tasks SET lease_owner = 'another-owner'", "lease_lost"],
  ["expiry", "UPDATE tasks SET lease_expires_at = 0", "lease_lost"],
  ["cancel", "UPDATE tasks SET cancel_requested = 1", "cancel_requested"],
  ["deadline", "UPDATE tasks SET deadline_at = 0", "deadline_exceeded"],
])("revalidates persisted %s after committed async reserve without an abort signal", async (_name, mutation, reason) => {
  const { client, request } = setup({ paid: true });
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "dispatch-task" }))]);
  sy!.tasks.claim("dispatch-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  request.participants = [{ taskId: "dispatch-task", lease: capturedLease(sy!.tasks.get("dispatch-task")!), leaseOwner: "dispatch-owner", budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 1 } }];
  request.executionId = sy!.admission.createExecution("task", "summarize", [{ taskId: "dispatch-task", itemId: "1" }]);
  const entered = barrier(), blocked = barrier();
  const reserve = sy!.gate.ledger.reserve.bind(sy!.gate.ledger);
  const spy = vi.spyOn(sy!.gate.ledger, "reserve").mockImplementation(async input => {
    const committed = await reserve(input); entered.release(); await blocked.promise; return committed;
  });
  const controller = new AbortController();
  const result = sy!.gate.request({ ...request, signal: controller.signal }).catch(error => error);
  await entered.promise;
  sy!.db.prepare(mutation + " WHERE id = ?").run("dispatch-task");
  blocked.release();
  const error = await result;
  expect(controller.signal.aborted).toBe(false);
  expect(error).toBeInstanceOf(AdmissionDenied);
  expect(error.reason).toBe(reason);
  expect(client.requests).toHaveLength(0);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(sy!.db.prepare("SELECT status,error_kind FROM model_requests").all()).toEqual([{ status: "failed", error_kind: reason }]);
  expect(sy!.db.prepare("SELECT actual_usd,cost_basis FROM paid_spend").all()).toEqual([{ actual_usd: 0, cost_basis: "not_billed" }]);
});
