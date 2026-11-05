import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeHost } from "../src/core/project-runtime-host.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { effectiveBudget } from "../src/admission/admission.js";
import { requestAttemptId } from "../src/admission/request-ledger.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { loadConfig, parseConfig } from "../src/config/load.js";
import { ClientConnectionsConfigSchema } from "../src/config/schema.js";
import { patchConfig } from "../src/admin/config-edit.js";
import { ClientConnectionsController } from "../src/connections/server.js";
import { ClientConnectionRequestSchema, parseClientChat, type ClientConnectionDispatch } from "../src/connections/protocol.js";
import { baseConfig, endpoint, makeEnv, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

const controllers: ClientConnectionsController[] = [], services: MeritRouter[] = [], environments: Env[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(controllers.splice(0).map(controller => controller.close()));
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  for (const env of environments.splice(0)) env.cleanup();
});
async function sparePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function listener(dispatch: ClientConnectionDispatch = async () => reply("hello"), changes: Record<string, unknown> = {}) {
  const controller = new ClientConnectionsController({ dispatch }); controllers.push(controller);
  const config = ClientConnectionsConfigSchema.parse({ enabled: true, project: "demo", port: await sparePort(), ...changes });
  expect(await controller.sync(config)).toMatchObject({ enabled: true, state: "running", running: true });
  return { controller, config, url: controller.status().ollamaBaseUrl };
}
const body = { model: "meritrouter", messages: [{ role: "user", content: "hello" }] };
const post = (url: string, value: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
const request = (project = "demo") => ClientConnectionRequestSchema.parse({ project, profile: "summarize", chat: { messages: [{ role: "user", content: "private client message" }], max_tokens: 100 } });
function service(config: Record<string, unknown> = {}, client = new ScriptedClient(req => reply("private response", { model: req.model, provider: req.provider })), endpoints?: unknown[]) {
  const env = makeEnv({ config: baseConfig({ client_connections: { enabled: true, project: "demo" }, ...config }), ...(endpoints ? { endpoints } : {}) }); environments.push(env);
  const sy = new MeritRouter(env.cfg, { providerFetch: client.fetch, panelLifecycle: "passive" }); services.push(sy);
  return { env, sy, client };
}

it.each(["legacy", "split"] as const)("never replays a dead panel's expired %s client request at worker startup or refunds its uncertain transport", async layout => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
  const deadPid = child.pid!;
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const env = makeEnv(); environments.push(env);
  const install = path.join(env.dir, "installation"), projectDir = path.join(env.dir, "owned-project");
  mkdirSync(install); mkdirSync(projectDir);
  const project = layout === "split" ? "alpha" : "demo";
  const raw = baseConfig({ repositories: {}, models: { file: path.join(env.dir, "models.yaml") },
    storage: { directory: "state", layout, durability: "full" }, brain: { path: "brain", project },
    projects: layout === "split" ? { alpha: { directory: projectDir } } : {},
    client_connections: { enabled: true, project, request_timeout_seconds: 600 }, team: { provider_concurrency_enabled: false } });
  const configPath = path.join(install, "meritrouter.config.yaml"); writeFileSync(configPath, YAML.stringify(raw));
  let now = Date.now();
  const client = new ScriptedClient(req => reply("must never dispatch the placeholder goal", { model: req.model, provider: req.provider }));
  const open = (worker: boolean) => { const sy = new MeritRouter(loadConfig(configPath), { providerFetch: client.fetch, panelLifecycle: "passive", worker, pollIntervalMs: 20, now: () => now }); services.push(sy); return sy; };
  const panel = open(false);
  if (layout === "split") await panel.createSplitProject({ slug: project, directory: projectDir });
  const local = panel.projectStores(project), bundle = layout === "split" ? local as ProjectRuntimeBundle : null;
  const host = (panel as unknown as { host: ProjectRuntimeHost | null }).host;
  const queue = bundle ? host!.bindings.forProject(bundle.identity) : null;
  const gate = bundle?.gate ?? panel.gate, cfg = bundle?.cfg ?? panel.projectContext(project);
  const spec = WorkerTaskSchema.parse({ id: "dead-panel-chat", profile: "summarize", goal: "External client chat request",
    constraints: { acceptanceCriteria: ["Return the requested model response to the connected client."] }, budget: { maxOutputTokens: 100, timeoutSeconds: 600 } });
  const owner = hostname() + ":" + deadPid + ":dead00";
  let task;
  if (queue) { task = queue.claimExternal(spec, owner, []); expect(queue.authorizeStart([task])).toBe("fresh"); }
  else {
    local.tasks.submit([spec], { project }); local.db.prepare("UPDATE tasks SET purpose='client_connection' WHERE id=?").run(spec.id);
    task = local.tasks.claim(owner, { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: cfg.execution.lease_seconds * 1000, defaultTimeoutMs: 600000, targetTaskId: spec.id })[0]!;
  }
  const lease = capturedLease(task), executionId = gate.admission.createExecution("task", "summarize", [{ taskId: task.row.id, itemId: task.row.id }]);
  const model = panel.catalog.endpoints().find(value => value.providerId === "openrouter")!;
  const reservation = await gate.ledger.reserve({ requestId: requestAttemptId(now), payloadDigest: "a".repeat(64), keyRef: "", providerReservationId: null,
    executionId, profile: "summarize", purpose: "client_connection", gatewayModel: "direct:" + model.id, endpointId: model.id, tier: "T1", estInputTokens: 100, reservedOutputTokens: 100,
    participants: [{ taskId: task.row.id, leaseOwner: owner, lease, budget: effectiveBudget(cfg, spec, "T1"), estInputTokens: 100, reservedOutputTokens: 100 }] });
  await gate.ledger.beginDispatch(reservation, "dead-panel-intent");
  const accountingBefore = local.db.prepare("SELECT * FROM model_requests").all();
  const physicalBefore = layout === "split" ? panel.db.prepare("SELECT * FROM physical_requests").all() : [];
  await panel.close(); // A process may disappear after durable dispatch intent and before an outcome.
  now += cfg.execution.lease_seconds * 1000 + 1;
  expect(now).toBeLessThan(task.row.deadline_at!);
  const worker = open(true), recovered = worker.projectStores(project);
  await vi.waitFor(() => {
    expect(recovered.tasks.get(task.row.id)!.row.state).toBe("cancelled");
    if (layout === "split") expect(worker.db.prepare("SELECT state FROM project_execution_grants").get()).toEqual({ state: "revoked" });
  }, { timeout: 5000, interval: 20 });
  expect(recovered.tasks.get(task.row.id)!.row).toMatchObject({ run_count: 1, lease_owner: null, state_reason: "client_connection_owner_lost" });
  expect(recovered.tasks.events(task.row.id).some(event => event.type === "resumed")).toBe(false);
  expect(recovered.db.prepare("SELECT * FROM model_requests").all()).toEqual(accountingBefore);
  if (layout === "split") {
    expect(worker.db.prepare("SELECT * FROM physical_requests").all()).toEqual(physicalBefore);
    expect(recovered.db.prepare("SELECT phase FROM project_execution_claims").get()).toEqual({ phase: "terminal" });
    expect(recovered.db.prepare("SELECT phase FROM project_request_protocol").get()).toEqual({ phase: "dispatch_intent" });
  }
  expect(client.requests).toHaveLength(0);
});

it("ordinary claims and batch companions skip queued client rows, and old interrupted client rows terminalize", () => {
  const { sy } = service();
  const spec = WorkerTaskSchema.parse(summarizeTask({ id: "forged-client", repositoryAliases: [] }));
  sy.tasks.submit([spec], { project: "demo" }); sy.db.prepare("UPDATE tasks SET purpose='client_connection' WHERE id=?").run(spec.id);
  const limits = { maxConcurrent: 10, maxWritersPerRepo: 1, leaseMs: 30000, defaultTimeoutMs: 600000 };
  expect(sy.tasks.claim("ordinary-worker", limits)).toEqual([]);
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "ordinary", repositoryAliases: [] }))], { project: "demo" });
  const [ordinary] = sy.tasks.claim("ordinary-worker", limits);
  expect(ordinary!.row.id).toBe("ordinary");
  expect(sy.tasks.claimCompanions("ordinary-worker", ordinary!, () => true, 10, 30000, 600000)).toEqual([]);
  sy.db.prepare("UPDATE tasks SET state='interrupted',run_count=5 WHERE id=?").run(spec.id);
  expect(() => sy.tasks.resume(spec.id!)).toThrow(/cannot be resumed/);
  sy.tasks.recoverExpiredLeases();
  expect(sy.tasks.get(spec.id!)!.row.state).toBe("cancelled");
});

const editorTool = { type: "function" as const, function: { name: "client_read_file", description: "A caller-owned tool",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const editorCall = { id: "call_editor", type: "function" as const, function: { name: "client_read_file", arguments: '{"path":"README.md"}' } };
it.each(["required", "none", "tools_and_format"] as const)("refuses Ollama adapter constraint %s before provider transport", async kind => {
  const client = new ScriptedClient(req => reply("must not be called", { model: req.model, provider: req.provider }));
  const { sy } = service({ providers: { ollama: {} } }, client, [endpoint({ providerId: "ollama", gatewayModelId: "fixture:latest" })]);
  const { url } = await listener((value, signal) => sy.requestClientConnection(value, signal));
  const response = await post(url + "/v1/chat/completions", { ...body, tools: [editorTool], ...(kind === "tools_and_format" ? { response_format: { type: "json_object" } } : { tool_choice: kind }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "unsupported_request_constraints" } });
  expect(client.requests).toHaveLength(0); expect(sy.tasks.list()).toHaveLength(0);
});

it("routes required tool choice to a configured adapter that preserves it", async () => {
  const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [editorCall] }));
  const { sy } = service({ providers: { ollama: {}, openrouter: { keys: [{ api_key: "test-key", billing_class: "free_tier" }] } } }, client,
    [endpoint({ providerId: "ollama", gatewayModelId: "fixture:latest", totalParametersB: 100 }), endpoint({ totalParametersB: 550 })]);
  const value = ClientConnectionRequestSchema.parse({ ...request(), chat: { ...request().chat, tools: [editorTool], tool_choice: "required" } });
  const result = await sy.requestClientConnection(value, new AbortController().signal);
  expect(result.message.tool_calls).toEqual([editorCall]);
  expect(client.requests).toHaveLength(1); expect(client.requests[0]).toMatchObject({ provider: "openrouter", tool_choice: "required" });
});

it("isolates repeated client schema ids across HTTP requests, tools and response formats", async () => {
  const client = new ScriptedClient((req, count) => count <= 2 ? reply(null, { model: req.model, provider: req.provider,
    toolCalls: [{ id: "schema_call_" + count, type: "function", function: { name: count === 1 ? "first" : "second", arguments: count === 1 ? '{"left":"okay"}' : '{"right":42}' } }] })
    : reply('{"done":true}', { model: req.model, provider: req.provider }));
  const { sy } = service({}, client), { url } = await listener((value, signal) => sy.requestClientConnection(value, signal));
  const schemaId = "https://example.test/editor-schema";
  const payload = { ...body, tools: [
    { type: "function", function: { name: "first", parameters: { $id: schemaId, type: "object", properties: { left: { type: "string" } }, required: ["left"], additionalProperties: false } } },
    { type: "function", function: { name: "second", parameters: { $id: schemaId, type: "object", properties: { right: { type: "number" } }, required: ["right"], additionalProperties: false } } },
  ], response_format: { type: "json_schema", json_schema: { name: "result", schema: { $id: schemaId, type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false } } } };
  for (let count = 0; count < 4; count++) {
    const response = await post(url + "/v1/chat/completions", payload);
    expect(response.status).toBe(200); await response.json();
  }
  expect(client.requests).toHaveLength(4);
});

it.each(["tool", "response"] as const)("rejects asynchronous %s schemas before any model request", async kind => {
  const client = new ScriptedClient(req => reply("invalid async output must never be requested", { model: req.model, provider: req.provider }));
  const { sy } = service({}, client), { url } = await listener((value, signal) => sy.requestClientConnection(value, signal));
  const schema = { $async: true, type: "object", properties: { required_value: { type: "string" } }, required: ["required_value"] };
  const payload = { ...body, ...(kind === "tool" ? { tools: [{ type: "function", function: { name: "client_tool", parameters: schema } }] }
    : { response_format: { type: "json_schema", json_schema: { name: "answer", schema } } }) };
  const response = await post(url + "/v1/chat/completions", payload);
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: "unsupported_json_schema" } });
  expect(client.requests).toHaveLength(0); expect(sy.tasks.list()).toHaveLength(0);
});

it.each(["required_without_call", "none_with_call", "invalid_arguments", "invalid_json", "schema_mismatch"] as const)("rejects model contract violation %s after accounting without a retry", async kind => {
  const client = new ScriptedClient(req => reply(kind === "invalid_json" ? "not JSON" : kind === "schema_mismatch" ? '{"ok":"wrong type"}' : "plain reply",
    { model: req.model, provider: req.provider, ...(kind === "none_with_call" ? { toolCalls: [editorCall] } : kind === "invalid_arguments" ? { toolCalls: [{ ...editorCall, function: { ...editorCall.function, arguments: '{"path":42}' } }] } : {}) }));
  const { sy } = service({}, client);
  const value = ClientConnectionRequestSchema.parse({ ...request(), chat: { ...request().chat,
    ...(kind === "invalid_json" ? { response_format: { type: "json_object" } }
      : kind === "schema_mismatch" ? { response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } } }
      : { tools: [editorTool], tool_choice: kind === "none_with_call" ? "none" : "required" }) } });
  await expect(sy.requestClientConnection(value, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  expect(client.requests).toHaveLength(1); expect(sy.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 1 });
  expect(sy.tasks.list()[0]!.row).toMatchObject({ state: "failed", lease_owner: null });
  expect(sy.tasks.list()[0]!.result!.usage.modelRequests).toBe(1);
});

it("defaults off and requires an explicit configured project and completion profile before enabling", () => {
  expect(ClientConnectionsConfigSchema.parse({})).toEqual({ enabled: false, port: 4479, project: null, profile: "summarize", max_output_tokens: 4096, max_concurrent: 2, request_timeout_seconds: 120 });
  expect(ClientConnectionsConfigSchema.safeParse({ enabled: true }).success).toBe(false);
  expect(ClientConnectionsConfigSchema.safeParse({ host: "0.0.0.0" }).success).toBe(false);
  expect(() => parseConfig(baseConfig({ client_connections: { enabled: true, project: "missing" } }), "C:/test/config.yaml")).toThrow(/configured project/);
  expect(() => parseConfig(baseConfig({ client_connections: { enabled: true, project: "demo", profile: "implement" } }), "C:/test/config.yaml")).toThrow(/completion profile/);
  const controller = new ClientConnectionsController({ dispatch: async () => reply("unused") }); controllers.push(controller);
  expect(controller.status()).toMatchObject({ enabled: false, running: false, state: "off", port: 4479 });
});

it("persists opt-in and opt-out through patchConfig and reload/restart without a provider request", async () => {
  const { env, sy, client } = service({ client_connections: {} });
  expect(patchConfig(sy, [{ path: ["client_connections"], value: { enabled: true, project: "demo", port: await sparePort() } }])).toEqual({ ok: true });
  const saved = loadConfig(env.cfg.configPath).client_connections;
  expect(saved.enabled).toBe(true);
  const first = new ClientConnectionsController({ dispatch: async () => reply("unused") }); controllers.push(first);
  await first.sync(saved); expect(first.status().running).toBe(true); await first.close();
  const restarted = new ClientConnectionsController({ dispatch: async () => reply("unused") }); controllers.push(restarted);
  await restarted.sync(loadConfig(env.cfg.configPath).client_connections); expect(restarted.status().running).toBe(true);
  expect(patchConfig(sy, [{ path: ["client_connections", "enabled"], value: false }])).toEqual({ ok: true });
  await restarted.sync(loadConfig(env.cfg.configPath).client_connections); expect(restarted.status()).toMatchObject({ state: "off", running: false });
  expect(client.requests).toEqual([]);
});

it("serves safe discovery and real OpenAI SSE/native NDJSON final frames with usage", async () => {
  const { sy, client } = service();
  const { url } = await listener((value, signal) => sy.requestClientConnection(value, signal));
  expect(await (await fetch(url + "/v1/models")).json()).toMatchObject({ data: [{ id: "meritrouter", owned_by: "meritrouter" }] });
  const tags = await (await fetch(url + "/api/tags")).json();
  expect(tags).toMatchObject({ models: [{ name: "meritrouter:latest", details: { format: "meritrouter" } }] });
  expect(await (await post(url + "/api/show", { model: "meritrouter" })).json()).toMatchObject({ capabilities: ["completion", "tools"] });
  expect(await (await fetch(url + "/api/version")).json()).toMatchObject({ meritrouter: true });
  expect(JSON.stringify(tags)).not.toMatch(/test-openrouter-key|api_key|vendor\/big/);
  const response = await post(url + "/v1/chat/completions", { ...body, stream: true, stream_options: { include_usage: true } });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-meritrouter-streaming")).toBe("buffered");
  const events = (await response.text()).trim().split("\n\n").map(line => line.slice(6));
  expect(events.at(-1)).toBe("[DONE]");
  const values = events.slice(0, -1).map(value => JSON.parse(value));
  expect(values[0].choices[0].delta.role).toBe("assistant");
  expect(values.find(value => value.choices[0]?.delta.content === "private response")).toBeTruthy();
  expect(values.at(-2).choices[0].finish_reason).toBe("stop");
  expect(values.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  const native = await post(url + "/api/chat", { ...body, model: "meritrouter:latest" });
  expect(native.headers.get("content-type")).toContain("application/x-ndjson");
  const chunks = (await native.text()).trim().split("\n").map(value => JSON.parse(value));
  expect(chunks[0]).toMatchObject({ done: false, message: { role: "assistant", content: "private response" } });
  expect(chunks.at(-1)).toMatchObject({ done: true, prompt_eval_count: 100, eval_count: 50 });
  expect(await (await post(url + "/api/generate", { model: "meritrouter", prompt: "hello", stream: false })).json()).toMatchObject({ done: true, response: "private response" });
  expect(client.requests).toHaveLength(3);
  expect(sy.tasks.list().every(task => task.row.state === "completed" && task.row.lease_owner === null)).toBe(true);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 3 });
});

it("passes client tool definitions/results through Gate without executing them, including native tool ids", async () => {
  const tool = { type: "function", function: { name: "client_read_file", description: "A tool owned by the editor", parameters: { type: "object", properties: { path: { type: "string" } } } } };
  const call = { id: "call_one", type: "function" as const, function: { name: "client_read_file", arguments: '{"path":"README.md"}' } };
  const client = new ScriptedClient(req => reply(null, { model: req.model, provider: req.provider, toolCalls: [call] }));
  const { sy } = service({}, client), { url } = await listener((value, signal) => sy.requestClientConnection(value, signal));
  const result = await post(url + "/v1/chat/completions", { ...body, tools: [tool], tool_choice: "auto", stream: true });
  const text = await result.text();
  expect(text).toContain('"tool_calls":[{"id":"call_one"'); expect(text).toContain('"finish_reason":"tool_calls"');
  expect(client.requests[0]!.tools).toEqual([tool]);
  const native = { model: "meritrouter", stream: false, tools: [tool], messages: [
    { role: "user", content: "Read a file" },
    { role: "assistant", tool_calls: [{ function: { name: "client_read_file", arguments: { path: "README.md" } } }] },
    { role: "tool", tool_name: "client_read_file", content: "client provided result" },
  ] };
  const response = await post(url + "/api/chat", native);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: { tool_calls: [{ function: { arguments: { path: "README.md" } } }] } });
  expect(client.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_ollama_1_0", content: "client provided result" });
  expect(sy.db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(() => parseClientChat("/v1/chat/completions", { ...body, messages: [{ role: "tool", content: "orphan", tool_call_id: "missing" }] }, ClientConnectionsConfigSchema.parse({}))).toThrow(/preceding/);
});

it("admits trusted loopback browser origins/preflight and refuses remote/null origins and forged Host", async () => {
  let calls = 0;
  const { url } = await listener(async () => { calls++; return reply("okay"); });
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:4477", "https://[::1]:8080"]) {
    const response = await fetch(url + "/api/tags", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
    expect(response.status).toBe(204); expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  }
  for (const origin of ["https://evil.test", "null", "chrome-extension://extension-id", "http://localhost.evil.test", "file://local"]) {
    expect((await post(url + "/api/chat", body, { Origin: origin })).status).toBe(403);
  }
  const forgedHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(url + "/api/tags", { headers: { Host: "evil.test" } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end();
  });
  expect(forgedHost).toBe(403);
  expect(calls).toBe(0);
});

it("bounds bodies, requested output and concurrency, rejects unsupported input and drains cancellation on disable", async () => {
  let started!: () => void, aborted = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const { controller, config, url } = await listener(async (_request, signal) => {
    started();
    await new Promise<void>(resolve => { signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
    throw signal.reason;
  }, { max_concurrent: 1 });
  expect((await post(url + "/api/chat", { ...body, options: { num_predict: 4097 } })).status).toBe(400);
  expect((await post(url + "/api/chat", { ...body, options: { arbitrary: true } })).status).toBe(400);
  expect((await post(url + "/api/chat", { ...body, model: "direct/provider" })).status).toBe(400);
  expect((await post(url + "/api/chat", { ...body, messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] })).status).toBe(413);
  const pending = post(url + "/api/chat", body); await entered;
  expect((await post(url + "/api/chat", body)).status).toBe(429);
  await controller.sync({ ...config, enabled: false });
  expect((await pending).status).toBe(503); expect(aborted).toBe(true);
  expect(controller.status()).toMatchObject({ enabled: false, running: false, state: "off", activeRequests: 0 });
});

it("cancels Gate transport on client abort and timeout and keeps its terminal task/accounting", async () => {
  let entered!: () => void, transportAborted = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client = new ScriptedClient(async (_request, _count, signal) => {
    entered();
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
    transportAborted++; throw new DOMException("aborted", "AbortError");
  });
  const { sy } = service({}, client);
  const { controller, url } = await listener((value, signal) => sy.requestClientConnection(value, signal), { request_timeout_seconds: 1 });
  const timeout = await post(url + "/v1/chat/completions", body);
  expect(timeout.status).toBe(504); expect(transportAborted).toBe(1);
  expect(sy.tasks.list()[0]!.row.state).toBe("cancelled");
  const abort = new AbortController();
  const pending = fetch(url + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal }).catch(error => error);
  await started; // The first call proved the provider boundary is reached.
  while (client.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort(); await pending; await controller.close();
  expect(transportAborted).toBe(2);
  expect(sy.tasks.list().every(task => task.row.lease_owner === null)).toBe(true);
});

it("shows a bind error without stealing an occupied listener or changing persisted desired state", async () => {
  const occupied = createServer((_req, res) => res.end("original"));
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  try {
    const port = (occupied.address() as AddressInfo).port, controller = new ClientConnectionsController({ dispatch: async () => reply("unused") }); controllers.push(controller);
    const status = await controller.sync(ClientConnectionsConfigSchema.parse({ enabled: true, project: "demo", port }));
    expect(status).toMatchObject({ enabled: true, running: false, state: "error" }); expect(status.error).toContain("already in use");
    expect(await (await fetch("http://127.0.0.1:" + port)).text()).toBe("original");
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

it("enforces the service timeout for direct SDK callers and releases the exact task lease", async () => {
  let aborted = false;
  const client = new ScriptedClient(async (_request, _count, signal) => {
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
    aborted = true; throw new DOMException("aborted", "AbortError");
  });
  const { sy } = service({ client_connections: { enabled: true, project: "demo", request_timeout_seconds: 1 } }, client);
  await expect(sy.requestClientConnection(request(), new AbortController().signal)).rejects.toMatchObject({ status: 504, code: "request_timeout" });
  expect(aborted).toBe(true); expect(sy.tasks.list()[0]!.row).toMatchObject({ state: "cancelled", lease_owner: null });
});

it("still finishes the task lease when execution finalization fails", async () => {
  const { sy } = service();
  vi.spyOn(sy.admission, "setMemberOutcome").mockImplementationOnce(() => { throw new Error("fixture finalization failure"); });
  const finish = vi.spyOn(sy.admission, "finishExecution");
  await expect(sy.requestClientConnection(request(), new AbortController().signal)).rejects.toThrow(/cleanup requires recovery/);
  expect(finish).toHaveBeenCalled();
  const task = sy.tasks.list()[0]!;
  expect(task.row).toMatchObject({ state: "completed", lease_owner: null });
  expect(sy.tasks.events(task.row.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "client_connection_cleanup_failed" })]));
});

it("uses the pinned split project and atomic queue grant, preserving older queued work and shared allocation", async () => {
  const env = makeEnv(); environments.push(env);
  const install = path.join(env.dir, "installation"), alpha = path.join(env.dir, "alpha"), beta = path.join(env.dir, "beta");
  for (const dir of [install, alpha, beta]) mkdirSync(dir);
  const raw = baseConfig({ repositories: {}, models: { file: path.join(env.dir, "models.yaml") }, storage: { directory: "state", layout: "split", durability: "full" },
    brain: { path: "brain", project: "alpha" }, projects: { alpha: { directory: alpha }, beta: { directory: beta } },
    allocation: { max_model_requests_per_hour: 1, max_model_requests_per_day: 1 }, client_connections: { enabled: true, project: "alpha" }, team: { provider_concurrency_enabled: false } });
  const configPath = path.join(install, "meritrouter.config.yaml"); writeFileSync(configPath, YAML.stringify(raw));
  const client = new ScriptedClient(req => reply("alpha private response", { model: req.model, provider: req.provider }));
  const sy = new MeritRouter(parseConfig(raw, configPath), { providerFetch: client.fetch, panelLifecycle: "passive" }); services.push(sy);
  await expect(sy.requestClientConnection(request("alpha"), new AbortController().signal)).rejects.toThrow(/no project-local store/);
  await sy.createSplitProject({ slug: "alpha", directory: alpha }); await sy.createSplitProject({ slug: "beta", directory: beta });
  const [queued] = await sy.submitTasks([summarizeTask({ id: "older-queued", goal: "Unrelated queued work" })], { project: "alpha" });
  expect(queued!.state).toBe("queued");
  const result = await sy.requestClientConnection(request("alpha"), new AbortController().signal);
  expect(result.message.content).toBe("alpha private response");
  const alphaStore = sy.projectStores("alpha"), betaStore = sy.projectStores("beta");
  expect(alphaStore.tasks.get("older-queued")!.row).toMatchObject({ state: "queued", run_count: 0 });
  const external = alphaStore.tasks.list().find(task => task.row.id !== "older-queued")!;
  expect(external.row).toMatchObject({ state: "completed", lease_owner: null, project_id: "alpha" });
  expect(alphaStore.db.prepare("SELECT phase FROM project_execution_claims").get()).toEqual({ phase: "terminal" });
  expect(sy.db.prepare("SELECT state FROM project_execution_grants").get()).toEqual({ state: "completed" });
  expect(alphaStore.db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 1 });
  expect(betaStore.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  for (const table of ["tasks", "model_requests", "request_captures"]) expect(sy.db.prepare("SELECT COUNT(*) n FROM " + table).get()).toEqual({ n: 0 });
  expect(JSON.stringify(alphaStore.db.prepare("SELECT * FROM request_captures").all())).toContain("private client message");
  expect(JSON.stringify(sy.db.prepare("SELECT * FROM physical_requests").all())).not.toMatch(/private client message|alpha private response/);
  await expect(sy.requestClientConnection(request("beta"), new AbortController().signal)).rejects.toThrow(/selected project/);
  await expect(sy.requestClientConnection(request("alpha"), new AbortController().signal)).rejects.toThrow();
  expect(client.requests).toHaveLength(1);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({ n: 1 });
  expect(alphaStore.tasks.list().filter(task => task.row.id !== "older-queued").every(task => task.row.lease_owner === null)).toBe(true);
});
