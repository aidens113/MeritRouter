import { afterEach, expect, it } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { SqliteRequestLedger } from "../src/admission/sqlite-request-ledger.js";
import { RequestOutcomeDTOSchema, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
function setup() {
  env = makeEnv({ config: baseConfig({ paid: { enabled: true, budgets: { per_week_usd: 5 } } }) });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  sy.tasks.submit(["one", "two"].map(id => WorkerTaskSchema.parse(summarizeTask({ id }))));
  sy.tasks.claim("ledger-owner", { maxConcurrent: 2, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const executionId = sy.admission.createExecution("batch", "summarize", ["one", "two"].map(taskId => ({ taskId, itemId: taskId })));
  const input: ReserveRequestDTO = {
    executionId, profile: "summarize", purpose: "test", gatewayModel: "fixture/model", endpointId: "fixture/model", tier: "T1", estInputTokens: 300, reservedOutputTokens: 90,
    participants: ["one", "two"].map((taskId, i) => ({ taskId, leaseOwner: "ledger-owner", budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 1 }, estInputTokens: (i + 1) * 100, reservedOutputTokens: (i + 1) * 30 })),
    paid: { key: { ref: "fixture-key", label: "nonsecret label", enabled: true, monthlyCapUsd: null, prepaidBalanceUsd: null, balanceCheckedAt: null }, provider: "fixture", worstCaseUsd: .1, price: { in: 2, out: 8, cacheWriteIn: null } },
  };
  return { input, ledger: new SqliteRequestLedger(sy.admission, sy.spend) };
}

it("validates data-only DTOs and leaves model messages outside accounting outcomes", async () => {
  const { input, ledger } = setup();
  await expect(ledger.reserve({ ...input, paid: { ...input.paid!, spend: sy!.spend } } as never)).rejects.toThrow();
  await expect(ledger.reserve({ ...input, paid: { ...input.paid!, key: { ...input.paid!.key, api_key: "forbidden-secret" } } } as never)).rejects.toThrow();
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 0 });
  const reserved = await ledger.reserve(input);
  expect(JSON.parse(JSON.stringify(reserved))).toEqual(reserved);
  expect(reserved.paid).not.toHaveProperty("spend");
  const outcome = RequestOutcomeDTOSchema.parse({ kind: "succeeded", servedEndpointId: "fixture/model", response: reply("private model message") });
  expect(outcome.response).not.toHaveProperty("message");
  await ledger.reconcile(reserved, outcome);
});

it.each(["request_charges", "paid_spend"])("rolls all request/participant/paid rows back when %s insertion fails", async table => {
  const { input, ledger } = setup();
  sy!.db.exec(`CREATE TRIGGER fixture_reserve_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture reservation failure'); END`);
  await expect(ledger.reserve(input)).rejects.toThrow("fixture reservation failure");
  for (const name of ["model_requests", "request_charges", "paid_spend"]) expect(sy!.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
});

it("settles batch charges and paid usage together and shares the synchronous compatibility core", async () => {
  const { input, ledger } = setup();
  const reserved = await ledger.reserve(input);
  const response = reply("ignored", { usage: { inputTokens: 300, outputTokens: 90 } });
  await ledger.reconcile(reserved, { kind: "succeeded", servedEndpointId: input.endpointId, response });
  expect(sy!.db.prepare("SELECT task_id,input_tokens,output_tokens,tokens_exact FROM request_charges ORDER BY task_id").all()).toEqual([
    { task_id: "one", input_tokens: 100, output_tokens: 30, tokens_exact: 0 }, { task_id: "two", input_tokens: 200, output_tokens: 60, tokens_exact: 0 },
  ]);
  expect((sy!.db.prepare("SELECT actual_usd FROM paid_spend").get() as { actual_usd: number }).actual_usd).toBeCloseTo(.00132, 8);
  const { paid, ...free } = input;
  const compatible = sy!.admission.reserve(free);
  expect(compatible).not.toBeInstanceOf(Promise);
  expect(sy!.admission.reconcile(compatible, { kind: "succeeded", servedEndpointId: input.endpointId, response })).toBeUndefined();
  expect(sy!.admission.taskTotals("one").requests).toBe(2);
});

it("rolls settlement back atomically and preserves unpriceable cache-write cost as uncertain", async () => {
  const { input, ledger } = setup();
  const reserved = await ledger.reserve(input);
  sy!.db.exec("CREATE TRIGGER fixture_settlement_failure BEFORE UPDATE ON paid_spend BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END");
  const response = reply("ignored", { usage: { inputTokens: 300, outputTokens: 90, cacheCreationInputTokens: 10 } });
  await expect(ledger.reconcile(reserved, { kind: "succeeded", servedEndpointId: input.endpointId, response })).rejects.toThrow("fixture settlement failure");
  expect(sy!.db.prepare("SELECT status,finished_at FROM model_requests").get()).toEqual({ status: "reserved", finished_at: null });
  expect(sy!.db.prepare("SELECT actual_usd FROM paid_spend").get()).toEqual({ actual_usd: null });
  sy!.db.exec("DROP TRIGGER fixture_settlement_failure");
  await ledger.reconcile(reserved, { kind: "succeeded", servedEndpointId: input.endpointId, response });
  expect(sy!.db.prepare("SELECT actual_usd,reserved_usd,cost_basis FROM paid_spend").get()).toEqual({ actual_usd: .1, reserved_usd: .1, cost_basis: "uncertain" });
  expect((sy!.db.prepare("SELECT policy_violation FROM model_requests").get() as { policy_violation: string }).policy_violation).toMatch(/cannot price reported cache creation/);
});
