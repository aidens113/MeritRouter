import { capturedLease } from "../src/storage/task-leases.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { afterEach, expect, it, vi } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import type { GateRequest } from "../src/gateway/gate.js";
import { GatewayError, AdmissionDenied } from "../src/core/errors.js";
import { RequestPersistenceError } from "../src/admission/request-ledger.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
const releases: Array<() => void> = [];
afterEach(async () => { releases.splice(0).forEach(release => release()); await sy?.close(); sy = undefined; vi.restoreAllMocks(); env?.cleanup(); env = undefined; });
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); releases.push(release); return { promise, release }; }
function setup(paid = false, twoKeys = false) {
  const client = new ScriptedClient(req => reply("observed-output", { model: req.model, provider: req.provider, toolCalls: [{ id: "call", type: "function", function: { name: "answer", arguments: '{"answer":1}' } }] }));
  env = makeEnv({ endpoints: [endpoint({ supportsStructuredOutput: false }), endpoint({ providerId: "groq", gatewayModelId: "vendor/second:free" })], config: baseConfig({
    ...(twoKeys ? { providers: { openrouter: { keys: [{ label: "KEY-LABEL-SENTINEL-A", api_key: "KEY-SECRET-SENTINEL-A", billing_class: "free_tier" }, { label: "KEY-LABEL-SENTINEL-B", api_key: "KEY-SECRET-SENTINEL-B", billing_class: "free_tier" }] } } } : {}),
    ...(paid ? { paid: { enabled: true, budgets: { per_week_usd: 5 }, tiers: { T1: "preferred", T2: "preferred", T3: "preferred" }, providers: { acme: { kind: "openai_compatible", base_url: "https://api.acme.test/v1" } }, models: [{ provider: "acme", model: "fixture-large", input_usd_per_million: 2, output_usd_per_million: 8, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true }] } } : {}),
  }) });
  sy = open(env, client, { worker: false });
  if (paid) sy.vault.add({ provider: "acme", label: "KEY-LABEL-SENTINEL", secret: "KEY-SECRET-SENTINEL" });
  const request: GateRequest = { plan: sy.router.plan("summarize", "T1", ["text"], undefined, false, paid ? "preferred" : undefined), executionId: sy.admission.createExecution("task", "summarize", []), purpose: "fixture", participants: [], cacheKey: "CACHE-KEY-SENTINEL", chat: { messages: [{ role: "system", content: "system fixture" }, { role: "user", content: "literal-private-input" }], max_tokens: 100, temperature: .2, response_format: { type: "json_object" }, tools: [{ type: "function", function: { name: "answer", description: "schema fixture", parameters: { type: "object", properties: { answer: { type: "number" } } } } }] } };
  return { client, request };
}
const rows = () => sy!.db.prepare("SELECT id,status,endpoint_id FROM model_requests ORDER BY reserved_at,id").all() as Array<{ id: string; status: string; endpoint_id: string }>;
const view = (id: string) => sy!.gate.captures.read(id, { project: null })!;

it.each([false, true])("captures normalized input/schema/observed tool response for default Gate without any journal (paid %s)", async paid => {
  const { request, client } = setup(paid);
  if (!paid) request.preferEndpointId = "openrouter/vendor/big-a:free";
  const result = await sy!.gate.request(request); const capture = view(result.requestId);
  expect(capture).toMatchObject({ availability: "complete", provenance: "normalized_gate_v1", output: { content: "observed-output", toolCalls: [{ name: "answer", arguments: '{"answer":1}' }] }, outcome: { kind: "succeeded" } });
  expect(capture.input!.messages[1]!.content).toBe("literal-private-input");
  expect(capture.input!.tools![0]!.parameters).toEqual({ type: "object", properties: { answer: { type: "number" } } });
  expect(client.requests).toHaveLength(1); expect(sy!.sessions.list()).toHaveLength(0);
  const raw = JSON.stringify(sy!.db.prepare("SELECT * FROM request_captures").all());
  for (const secret of ["KEY-SECRET-SENTINEL", "KEY-LABEL-SENTINEL", "CACHE-KEY-SENTINEL", "test-openrouter-key", "authorization", "telemetry"]) expect(raw.includes(secret)).toBe(false);
  if (!paid) expect(capture.input!.responseFormat).toBeUndefined();
});

it("captures endpoint fallback and key rotation under separate requestIds with exact normalized options", async () => {
  const { request, client } = setup();
  request.preferEndpointId = "openrouter/vendor/big-a:free";
  client.handler = (req, n) => { if (n === 1) throw new GatewayError("server", "fixture unavailable", 502); return reply("fallback", { model: req.model, provider: req.provider }); };
  const result = await sy!.gate.request(request); expect(client.requests).toHaveLength(2);
  const captures = rows().map(row => view(row.id)); expect(captures).toHaveLength(2);
  expect(captures.find(c => c.input!.model === "vendor/big-a:free")!.input!.responseFormat).toBeUndefined();
  expect(captures.find(c => c.requestId === result.requestId)!.input!.responseFormat).toEqual({ type: "json_object" });
  expect(captures.find(c => c.outcome!.kind !== "succeeded")!.outcome).toMatchObject({ kind: "uncertain", errorKind: "server" });
  request.chat.messages = [{ role: "user", content: "next-turn-distinct" }];
  const next = await sy!.gate.request(request);
  expect(view(next.requestId).input!.messages[0]!.content).toBe("next-turn-distinct");
  expect(captures[0]!.input!.messages.some(m => m.content === "literal-private-input")).toBe(true);
});

it("each admitted credential retry gets one separate capture without key/header material", async () => {
  const { request, client } = setup(false, true);
  client.handler = (req, n) => { if (n === 1) throw new GatewayError("auth", "fixture key refused", 401); return reply("second key", { model: req.model, provider: req.provider }); };
  await sy!.gate.request(request);
  expect(client.requests).toHaveLength(2); expect(new Set(client.requests.map(req => req.key)).size).toBe(2);
  const captures = rows().map(row => view(row.id)); expect(captures).toHaveLength(2);
  expect(captures.map(c => c.outcome!.kind).sort()).toEqual(["failed", "succeeded"]);
  const raw = JSON.stringify(sy!.db.prepare("SELECT * FROM request_captures").all()); expect(raw.includes("KEY-SECRET-SENTINEL")).toBe(false); expect(raw.includes("KEY-LABEL-SENTINEL")).toBe(false);
});

it.each(["begin", "dispatched", "complete"] as const)("capture %s failure cannot change paid dispatch, billing or trigger fallback", async method => {
  const { request, client } = setup(true);
  vi.spyOn(sy!.gate.captures, method).mockRejectedValue(new Error("capture storage fault"));
  const result = await sy!.gate.request(request);
  expect(client.requests).toHaveLength(1); expect(rows()).toHaveLength(1); expect(rows()[0]!.status).toBe("succeeded");
  const paid = sy!.db.prepare("SELECT actual_usd FROM paid_spend").get() as { actual_usd: number }; expect(paid.actual_usd).toBeGreaterThan(0);
  if (method === "complete") expect(view(result.requestId)).toMatchObject({ availability: "partial", unavailableReason: "capture_failed", output: null });
});

it("capture still retains observed response when paid ledger settlement fails, without masking persistence uncertainty", async () => {
  const { request, client } = setup(true);
  vi.spyOn(sy!.gate.ledger, "reconcile").mockRejectedValue(new Error("ledger unavailable"));
  const error = await sy!.gate.request(request).catch(error => error);
  expect(error).toBeInstanceOf(RequestPersistenceError); expect(client.requests).toHaveLength(1);
  expect(view(error.requestId).output!.content).toBe("observed-output");
  expect(sy!.db.prepare("SELECT actual_usd FROM paid_spend").get()).toEqual({ actual_usd: null });
});

it.each(["abort", "lease", "deadline"])("revalidates %s after delayed capture before HTTP and records definitely-unsent paid cost", async change => {
  const { request, client } = setup(true);
  sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "captured" }))], { project: "demo" });
  sy!.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  request.participants = [{ taskId: "captured", lease: capturedLease(sy!.tasks.get("captured")!), leaseOwner: "owner", budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: 1 } }];
  request.executionId = sy!.admission.createExecution("task", "summarize", [{ taskId: "captured", itemId: "1" }]);
  const entered = barrier(), blocked = barrier(); const begin = sy!.gate.captures.begin.bind(sy!.gate.captures);
  vi.spyOn(sy!.gate.captures, "begin").mockImplementation(async (...args) => { await begin(...args); entered.release(); await blocked.promise; });
  const controller = new AbortController();
  const pending = sy!.gate.request({ ...request, signal: controller.signal }).catch(error => error); await entered.promise;
  if (change === "abort") controller.abort();
  else sy!.db.prepare("UPDATE tasks SET " + (change === "lease" ? "lease_owner='foreign'" : "deadline_at=0") + " WHERE id='captured'").run();
  blocked.release(); const error = await pending;
  if (change !== "abort") expect(error).toBeInstanceOf(AdmissionDenied);
  expect(client.requests).toHaveLength(0); expect(sy!.db.prepare("SELECT actual_usd,cost_basis FROM paid_spend").get()).toEqual({ actual_usd: 0, cost_basis: "not_billed" });
  expect(sy!.gate.captures.read(rows()[0]!.id, { project: "demo" })!.dispatch).toBe("not_dispatched");
});

it("Gate/service close drains a pending terminal capture before closing SQLite", async () => {
  const { request } = setup(); const entered = barrier(), blocked = barrier();
  const complete = sy!.gate.captures.complete.bind(sy!.gate.captures);
  vi.spyOn(sy!.gate.captures, "complete").mockImplementation(async (...args) => { entered.release(); await blocked.promise; return complete(...args); });
  const result = sy!.gate.request(request); await entered.promise;
  const service = sy!; let closed = false; const closing = service.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(false); expect(service.db.open).toBe(true);
  blocked.release(); await result; await closing; expect(service.db.open).toBe(false); sy = undefined;
});

it("observes a policy-discarded provider response without presenting it as accepted", async () => {
  const { request, client } = setup(); client.handler = req => reply("discarded response", { model: "wrong-model", provider: req.provider });
  const error = await sy!.gate.request(request).catch(error => error); expect(error.kind).toBe("policy_violation");
  expect(client.requests).toHaveLength(1);
  expect(view(rows()[0]!.id)).toMatchObject({ output: { content: "discarded response" }, outcome: { policyViolation: true } });
});


it("captures one shared classifier payload per admitted request, without duplicating per journal member", async () => {
  const { client } = setup();
  client.handler = req => {
    const ids = [...String(req.messages[1]!.content).matchAll(/<item id="(c\d+)">/g)].map(match => match[1]!);
    return reply(JSON.stringify({ items: ids.map(id => ({ id, tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" }, confidence: .9, rationale: "fixture", suggestedTier: "T1" })) }), { model: req.model, provider: req.provider });
  };
  const specs = ["a", "b"].map(id => WorkerTaskSchema.parse(summarizeTask({ id })));
  sy!.tasks.submit(specs, { project: "demo" });
  sy!.tasks.claim("owner", { maxConcurrent: 2, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const features = { mode: "completion" as const, linesInScope: 10, linesApproximate: false, contextTokens: 10, repositories: 0, acceptanceCriteria: 1, checksRequired: false, outputSchema: false, retryAfterFailure: false, inputModalities: ["text" as const], scopeSample: [] };
  const values = await Promise.all(specs.map(spec => sy!.router.classifier.classify({ taskId: spec.id!, lease: capturedLease(sy!.tasks.get(spec.id!)!), leaseOwner: "owner", budget: { maxModelRequests: 4, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, spec, specHash: sy!.tasks.get(spec.id!)!.row.spec_hash, features })));
  expect(values.every(Boolean)).toBe(true); expect(client.requests).toHaveLength(1); expect(rows()).toHaveLength(1);
  const capture = sy!.gate.captures.read(rows()[0]!.id, { project: "demo" })!;
  expect(capture.availability).toBe("complete"); expect(capture.input!.messages[0]!.content).toContain("You classify");
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: 1 });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_charges").get()).toEqual({ n: 2 });
});

it("captures the default completion batch once while preserving each participant charge", async () => {
  const { client } = setup();
  client.handler = req => {
    const ids = [...String(req.messages[1]!.content).matchAll(/<item id="(i\d+)">/g)].map(match => match[1]!);
    return reply(JSON.stringify({ items: ids.map(id => ({ id, result: goodOutput() })) }), { model: req.model, provider: req.provider });
  };
  const submitted = await sy!.submitTasks([summarizeTask({ id: "batch-a" }), summarizeTask({ id: "batch-b" })]);
  await (sy as unknown as { scheduler: { tick(): Promise<void> } }).scheduler.tick();
  const result = await sy!.awaitResults(submitted.map(task => task.taskId), { timeoutSeconds: 10 });
  expect(result.completed.map(task => task.executionStatus)).toEqual(["completed", "completed"]);
  expect(client.requests).toHaveLength(1);
  const capture = sy!.gate.captures.read(rows()[0]!.id, { project: "demo" })!;
  expect(capture.input!.messages[1]!.content).toContain('<item id="i1">');
  expect(capture.input!.messages[1]!.content).toContain('<item id="i2">');
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: 1 });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_charges").get()).toEqual({ n: 2 });
});


it.each(["native", "command"])("captures actual %s coding calls through the default Gate", async runner => {
  const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent.mjs");
  env = makeEnv({ config: baseConfig({ coding: runner === "native" ? { runner } : { runner, command: `node "${agent}" good` } }) });
  const client = new ScriptedClient((req, n) => {
    if (runner === "native") return reply(null, { model: req.model, provider: req.provider, toolCalls: [{ id: `call-${n}`, type: "function", function: n === 1 ? { name: "write_file", arguments: JSON.stringify({ path: "src/app.ts", content: "export function add(a: number, b: number) { return a + b; }\nexport function subtract(a: number, b: number) { return a - b; }\n" }) } : { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "core:src/app.ts#L1-L2")) } }] });
    return reply(JSON.stringify(goodOutput()), { model: req.model, provider: req.provider });
  });
  sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
  const [task] = await sy.submitTasks([{ profile: "implement", goal: "Add subtract", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, context: { fileRefs: ["core:src/app.ts"] }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"] } }]);
  const result = await sy.awaitResults([task!.taskId], { timeoutSeconds: 60 });
  if (runner === "command") {
    expect(result.completed[0]!.stopReason).toBe("worker_sandbox_unavailable");
    expect(client.requests).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(sy.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: 0 });
    return;
  }
  expect(result.completed[0]!.executionStatus).toBe("completed");
  expect(client.requests.length).toBeGreaterThan(0);
  expect(rows()).toHaveLength(client.requests.length);
  expect(sy.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: client.requests.length });
  for (const row of rows()) {
    const capture = sy.gate.captures.read(row.id, { project: "demo" })!;
    expect(["complete", "partial"]).toContain(capture.availability);
    expect(capture.input).not.toBeNull(); expect(capture.output).not.toBeNull();
    expect(capture.outcome!.kind).toBe("succeeded");
  }
}, 90000);
