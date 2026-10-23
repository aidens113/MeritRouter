import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { RequestCaptures } from "../src/storage/request-captures.js";
import { CAPTURE_LIMITS as L, RequestCaptureViewSchema, captureBytes, projectCaptureInput, projectCaptureOutput, type CaptureOutcome } from "../src/gateway/request-capture.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const outcome: CaptureOutcome = { kind: "succeeded", httpStatus: 200, errorKind: null, possiblyConsumed: true, policyViolation: false };
function setup() {
  env = makeEnv({ config: baseConfig({ repositories: {}, projects: { alpha: {}, beta: {} } }) });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  let time = Date.now(); const store = new RequestCaptures(sy.db, () => time);
  return { store, advance: (n: number) => { time += n; } };
}
function reserve(projects: string[] = []) {
  const names = projects.map((project, i) => {
    const taskId = `task-${sy!.tasks.list().length}-${i}`;
    sy!.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: taskId }))], { project }); return taskId;
  });
  sy!.tasks.claim("owner", { maxConcurrent: 20, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 });
  const executionId = sy!.admission.createExecution(names.length > 1 ? "batch" : "task", "summarize", names.map(taskId => ({ taskId, itemId: taskId })));
  const request = { executionId, profile: "summarize" as const, purpose: "fixture", gatewayModel: "fixture/model", endpointId: "fixture/model", tier: "T1", estInputTokens: 10, reservedOutputTokens: 10, participants: names.map(taskId => ({ taskId, leaseOwner: "owner", budget: { maxModelRequests: 10, maxInputTokens: null, maxOutputTokens: null, maxPaidUsd: null }, estInputTokens: 10, reservedOutputTokens: 10 })) };
  if (new Set(projects).size > 1) {
    // Modern admission must refuse this cohort. Seed only historical accounting
    // rows to exercise capture privacy/purge for data predating that enforcement.
    expect(() => sy!.admission.reserve(request)).toThrow("different projects");
    const requestId = "historical-mixed-request";
    sy!.db.transaction(() => {
      sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES (?,?,'fixture','fixture/model','succeeded',?,10,10,?)").run(requestId, executionId, Date.now(), projects[0]!);
      const charge = sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact) VALUES (?,?,10,10,0)");
      for (const taskId of names) charge.run(requestId, taskId);
    })();
    return { ...request, requestId };
  }
  return sy!.admission.reserve(request);
}
const input = (text = "private fixture") => projectCaptureInput("fixture/model", { messages: [{ role: "user", content: text }], max_tokens: 10 });

const begin = (store: RequestCaptures, id: string, projection: ReturnType<typeof input>) => store.begin(id, projection, sy!.db.prepare("SELECT task_id FROM request_charges WHERE request_id=?").pluck().all(id) as string[]);

it("stores immutable bounded JSON with scoped reads and idempotent writes/conflict refusal", async () => {
  const { store } = setup(); const res = reserve(["alpha"]); const body = input();
  await begin(store, res.requestId, body); await begin(store, res.requestId, body);
  await expect(begin(store, res.requestId, input("different"))).rejects.toThrow("conflict");
  await store.dispatched(res.requestId);
  const output = projectCaptureOutput({ message: { content: "observed", tool_calls: [{ id: "call", type: "function", function: { name: "submit", arguments: '{"ok":true}' } }] }, finishReason: "tool_calls" });
  await store.complete(res.requestId, outcome, output); await store.complete(res.requestId, outcome, output);
  await expect(store.complete(res.requestId, outcome, projectCaptureOutput({ message: { content: "replaced" }, finishReason: "stop" }))).rejects.toThrow("conflict");
  const view = store.read(res.requestId, { project: "alpha" })!;
  expect(RequestCaptureViewSchema.safeParse(view).success).toBe(true);
  expect(view).toMatchObject({ availability: "complete", provenance: "normalized_gate_v1", output: { content: "observed" }, dispatch: "dispatch_intent" });
  expect(view.input!.messages[0]!.content).toBe("private fixture");
  expect(store.read(res.requestId, { project: "beta" })).toBeNull(); expect(store.read(res.requestId, { project: null })).toBeNull();
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: 1 });
});

it("refuses mixed/changed/unknown scope and keeps private participant sets for purge", async () => {
  const { store } = setup(); const mixed = reserve(["alpha", "beta"]);
  await begin(store, mixed.requestId, input("MIXED-PRIVATE")); await store.complete(mixed.requestId, outcome, projectCaptureOutput({ message: { content: "MIXED-RESPONSE" }, finishReason: "stop" }));
  expect(store.read(mixed.requestId, { project: "alpha" })).toMatchObject({ availability: "unavailable", unavailableReason: "mixed_project_payload", input: null, output: null });
  expect(JSON.stringify(sy!.db.prepare("SELECT * FROM request_captures").all())).not.toContain("MIXED-PRIVATE");
  const scoped = reserve(["alpha"]); await begin(store, scoped.requestId, input());
  sy!.db.prepare("UPDATE tasks SET project_id='beta' WHERE id=?").run(scoped.participants[0]!.taskId);
  expect(store.read(scoped.requestId, { project: "alpha" })).toMatchObject({ unavailableReason: "scope_unavailable" });
  const unknown = reserve(["alpha"]); sy!.db.prepare("UPDATE tasks SET project_id='' WHERE id=?").run(unknown.participants[0]!.taskId);
  await begin(store, unknown.requestId, input("UNKNOWN-PRIVATE"));
  expect(store.read(unknown.requestId, { project: "alpha" })).toMatchObject({ unavailableReason: "scope_unavailable", input: null });
  const purge = store.purgeProject("beta"); expect(purge.captures).toBe(1);
  expect(store.read(mixed.requestId, { project: "alpha" })).toMatchObject({ unavailableReason: "not_captured" });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 3 });
});

it("requires explicit unscoped access and reports historical absence, expiry and corruption safely", async () => {
  const { store, advance } = setup(); const res = reserve();
  expect(store.read(res.requestId, { project: null })).toMatchObject({ unavailableReason: "not_captured" });
  await begin(store, res.requestId, input());
  expect(store.read(res.requestId, { project: "alpha" })).toBeNull();
  sy!.db.prepare("UPDATE request_captures SET payload_json='bad-json' WHERE request_id=?").run(res.requestId);
  expect(store.read(res.requestId, { project: null })).toMatchObject({ unavailableReason: "corrupt", input: null });
  const later = reserve(); await begin(store, later.requestId, input()); advance(L.retentionMs + 1);
  expect(store.read(later.requestId, { project: null })).toMatchObject({ unavailableReason: "expired", input: null });
  expect(store.prune().captures).toBe(2);
  expect(sy!.db.prepare("SELECT payload_json FROM request_captures WHERE request_id=?").get(later.requestId)).toEqual({ payload_json: null });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 2 });
});

it("bounds entire Unicode messages/tool schemas/output and omits image locators without autoload", () => {
  const image = "data:image/png;base64,IMAGE-SECRET";
  const deep: Record<string, unknown> = {}; let tail = deep;
  for (let i = 0; i < 30; i++) { const next = {}; tail.child = next; tail = next; }
  const source = (String.fromCodePoint(0x1f642) + String.fromCharCode(0xe9) + "\n").repeat(100000);
  const p = projectCaptureInput("model", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: image } }, { type: "text", text: source }] }], max_tokens: 10, tools: [{ type: "function", function: { name: "tool", description: source, parameters: deep } }], response_format: { type: "json_schema", json_schema: { literal: "safe" } } });
  expect(captureBytes(p.input)).toBeLessThanOrEqual(L.inputBytes);
  expect(JSON.stringify(p)).not.toContain("IMAGE-SECRET"); expect(JSON.stringify(p).includes(String.fromCharCode(0xfffd))).toBe(false);
  expect(p.omissions.some(o => o.reason === "image_locator")).toBe(true); expect(p.omissions.some(o => o.reason === "depth_limit")).toBe(true);
  expect(p.originalBytes).toBeNull();
  const output = projectCaptureOutput({ message: { content: source, tool_calls: Array.from({ length: 100 }, (_, i) => ({ id: String(i), type: "function" as const, function: { name: "tool", arguments: source } })) }, finishReason: "stop" });
  expect(captureBytes(output.output)).toBeLessThanOrEqual(L.outputBytes); expect(output.output.toolCalls).toHaveLength(64); expect(output.omissions.length).toBeLessThanOrEqual(128);
  const many = projectCaptureInput("model", { messages: Array.from({ length: 1000 }, () => ({ role: "user" as const, content: "text" })), max_tokens: 10 });
  expect(many.input.messages).toHaveLength(256); expect(many.omissions.some(o => o.reason === "count_limit")).toBe(true);
});

it("enforces record count retention in bounded prune without deleting accounting", async () => {
  const { store } = setup(); const res = reserve(); await begin(store, res.requestId, input());
  const insertReq = sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens) VALUES (?,?,'fixture','fixture','reserved',0,1,1)");
  const insertCapture = sy!.db.prepare("INSERT INTO request_captures(request_id,project_id,scope_json,payload_json,bytes,phase,created_at,expires_at,unavailable_reason) VALUES (?,'','[]',NULL,258,'reserved',0,9999999999999,'evicted')");
  sy!.db.transaction(() => { for (let i = 0; i < L.records; i++) { const id = `retained-${i}`; insertReq.run(id, res.executionId); insertCapture.run(id); } })();
  const result = store.prune(8); expect(result.captures).toBe(2);
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM request_captures").get()).toEqual({ n: L.records - 1 });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: L.records + 1 });
});


it("uses bounded project/global byte pressure pruning while preserving paid/request history", async () => {
  const { store } = setup(); const res = reserve(["alpha"]);
  sy!.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,actual_usd,cost_basis,created_at) VALUES (?,'fixture-key','fixture','fixture',0.1,0.01,'provider_reported',0)").run(res.requestId);
  // Simulate already-accounted bounded rows without writing hundreds of MiB of fixture blobs.
  const req = sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id) VALUES (?,?,'fixture','fixture','reserved',0,1,1,?)");
  const capture = sy!.db.prepare("INSERT INTO request_captures(request_id,project_id,scope_json,payload_json,bytes,phase,created_at,expires_at,unavailable_reason) VALUES (?,?,?,NULL,?,'reserved',0,9999999999999,'evicted')");
  sy!.db.transaction(() => { for (let i = 0; i < 512; i++) { const project = ["alpha", "beta", "gamma", "delta"][Math.floor(i / 128)]!; const id = `pressure-${String(i).padStart(3, "0")}`; req.run(id, res.executionId, project); capture.run(id, project, JSON.stringify([project]), L.recordBytes); } })();
  await begin(store, res.requestId, input());
  expect(store.read(res.requestId, { project: "alpha" })!.input).not.toBeNull();
  expect((sy!.db.prepare("SELECT SUM(bytes) AS n FROM request_captures").get() as { n: number }).n).toBeLessThanOrEqual(L.totalBytes);
  expect((sy!.db.prepare("SELECT SUM(bytes) AS n FROM request_captures WHERE project_id='alpha'").get() as { n: number }).n).toBeLessThanOrEqual(L.projectBytes);
  expect(sy!.db.prepare("SELECT actual_usd FROM paid_spend WHERE request_id=?").get(res.requestId)).toEqual({ actual_usd: .01 });
  expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get()).toEqual({ n: 513 });
});


it("cannot recapture former project content as unscoped after purge removes request attribution", async () => {
  const { store } = setup(); const res = reserve(["alpha"]);
  const expected = res.participants.map(p => p.taskId);
  store.purgeProject("alpha");
  sy!.db.prepare("DELETE FROM request_charges WHERE request_id=?").run(res.requestId);
  sy!.db.prepare("UPDATE model_requests SET project_id='' WHERE id=?").run(res.requestId);
  await store.begin(res.requestId, input("FORMER-PROJECT-PRIVATE"), expected);
  expect(store.read(res.requestId, { project: null })).toMatchObject({ availability: "unavailable", unavailableReason: "scope_unavailable", input: null });
  expect(JSON.stringify(sy!.db.prepare("SELECT * FROM request_captures").all()).includes("FORMER-PROJECT-PRIVATE")).toBe(false);
});
