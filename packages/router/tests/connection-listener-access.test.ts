import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { MeritRouter } from "../src/core/service.js";
import { loadConfig } from "../src/config/load.js";
import { ClientConnectionsConfigSchema } from "../src/config/schema.js";
import { ClientConnectionsController } from "../src/connections/server.js";
import { clientConnectionTokenRequired, isClientConnectionLoopback, normalizeClientConnectionHost } from "../src/connections/access.js";
import { baseConfig, makeEnv, reply, ScriptedClient, type Env } from "./helpers.js";

const token = "a".repeat(64), nextToken = "b".repeat(64), hash = (value: string) => createHash("sha256").update(value).digest("hex");
const environments: Env[] = [], services: MeritRouter[] = [], controllers: ClientConnectionsController[] = [], releases: Array<() => void> = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); vi.restoreAllMocks(); await Promise.all(controllers.splice(0).map(controller => controller.close())); await Promise.allSettled(services.splice(0).map(service => service.close())); for (const env of environments.splice(0)) env.cleanup(); });
async function sparePort(host: string): Promise<number> { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); }); const port = (server.address() as AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
const request = { chat: { messages: [{ role: "user" as const, content: "External conversation" }], max_tokens: 100 } };
const body = { model: "meritrouter", messages: request.chat.messages };
const post = (url: string, value: unknown, key?: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) }, body: JSON.stringify(value) });
async function fixture(options: { host?: string; auth?: boolean; agent?: boolean; client?: ScriptedClient; now?: () => number } = {}) {
  const host = options.host ?? "0.0.0.0", port = await sparePort(host), base = baseConfig();
  const env = makeEnv({ config: baseConfig({ profiles: options.agent ? base.profiles : {}, repositories: options.agent ? base.repositories : {},
    client_connections: { enabled: true, host, port, access_token_hash: options.auth === false ? null : hash(token), ...(options.agent ? { project: "demo", enabled_modes: ["direct", "agent"], agent_profile: "inspect", repositories: ["core"] } : {}) },
    team: { provider_concurrency_start: 1, provider_concurrency_max: 1 }, providers: base.providers }) }); environments.push(env);
  const client = options.client ?? new ScriptedClient(req => reply("Direct output", { model: req.model, provider: req.provider }));
  const sy = new MeritRouter(env.cfg, { providerFetch: client.fetch, panelLifecycle: "passive", ...(options.now ? { now: options.now } : {}) }); services.push(sy);
  const controller = new ClientConnectionsController({ dispatch: (request, signal, key) => sy.requestClientConnection(request, signal, key), jobs: { submit: (request, signal, key) => sy.submitClientJob(request, signal, key), get: access => sy.getClientJob(access), cancel: access => sy.cancelClientJob(access) } }); controllers.push(controller);
  const edit = (change: (raw: Record<string, any>) => void) => { const raw = YAML.parse(readFileSync(env.cfg.configPath, "utf8")); change(raw); writeFileSync(env.cfg.configPath, YAML.stringify(raw)); };
  return { env, sy, client, controller, edit, async listen() { expect(await controller.sync(sy.cfg.client_connections)).toMatchObject({ state: "running" }); return controller.status().ollamaBaseUrl; } };
}

it("validates IP/localhost binding and hash-only authentication without a project prerequisite", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    expect(isClientConnectionLoopback(host)).toBe(true); expect(ClientConnectionsConfigSchema.safeParse({ enabled: true, host }).success).toBe(true);
  }
  for (const host of ["0.0.0.0", "::", "192.0.2.3", "2001:db8::1"]) {
    expect(ClientConnectionsConfigSchema.safeParse({ enabled: true, host }).success).toBe(false);
    expect(ClientConnectionsConfigSchema.safeParse({ enabled: true, host, access_token_hash: hash(token) }).success).toBe(true);
  }
  for (const host of ["https://localhost", "localhost:4479", "[::1]", "evil.test", "fe80::1%eth0", "127.0.0.1/", ""]) expect(ClientConnectionsConfigSchema.safeParse({ host }).success).toBe(false);
  expect(clientConnectionTokenRequired(ClientConnectionsConfigSchema.parse({}))).toBe(false);
  expect(clientConnectionTokenRequired(ClientConnectionsConfigSchema.parse({ access_token_hash: hash(token) }))).toBe(true);
  expect(normalizeClientConnectionHost("::ffff:7f00:1")).toBe("127.0.0.1");
  expect(() => isClientConnectionLoopback("fe80::1%eth0")).not.toThrow();
});

it("authenticates non-loopback discovery/chat before parsing bodies and never exposes credentials in status", async () => {
  const { sy, client, controller, listen } = await fixture(), url = await listen();
  for (const path of ["/", "/v1/models", "/api/tags", "/api/version"]) {
    expect((await fetch(url + path)).status).toBe(401);
    expect((await fetch(url + path, { headers: { authorization: "Bearer " + nextToken } })).status).toBe(401);
    expect((await fetch(url + path, { headers: { authorization: "Bearer " + token } })).status).toBe(200);
  }
  const badBody = await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "malformed body" }); expect(badBody.status).toBe(401);
  expect((await post(url + "/v1/chat/completions", body, token)).status).toBe(200);
  expect(controller.status()).toMatchObject({ host: "0.0.0.0", tokenConfigured: true, tokenRequired: true, project: null });
  expect(JSON.stringify(controller.status())).not.toContain(token); expect(JSON.stringify(controller.status())).not.toContain(hash(token));
  expect(client.requests).toHaveLength(1); expect(sy.tasks.list()).toEqual([]);
  expect(JSON.stringify(client.requests)).not.toContain(token);
});

it.each(["127.0.0.1", "0.0.0.0", "::1", "::"])("accepts the actual %s binding and rejects forged Host/remote origins without trusting forwarded headers", async host => {
  const { listen, controller } = await fixture({ host }), url = await listen(), port = controller.status().port;
  expect((await fetch(url + "/api/tags", { headers: { authorization: "Bearer " + token } })).status).toBe(200);
  for (const forged of ["evil.test:" + port, "192.0.2.9:" + port, "localhost.evil.test:" + port]) {
    const status = await new Promise<number>((resolve, reject) => { const req = httpRequest(url + "/api/tags", { headers: { Host: forged, authorization: "Bearer " + token, "x-forwarded-host": new URL(url).host } }, res => { res.resume(); resolve(res.statusCode!); }); req.once("error", reject); req.end(); });
    expect(status).toBe(403);
  }
  for (const origin of ["http://localhost:3000", "https://[::1]:8080", new URL(url).origin]) {
    const response = await fetch(url + "/api/tags", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(response.status).toBe(204); expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  }
  expect((await fetch(url + "/api/tags", { headers: { origin: "https://evil.test", authorization: "Bearer " + token } })).status).toBe(403);
});

it("rotates the connection key and drains the old listener while keeping scoped job tokens independently usable", async () => {
  const { sy, controller, listen, edit } = await fixture({ agent: true }), url = await listen();
  const response = await post(url + "/api/jobs", { mode: "agent", goal: "Inspect the fixture" }, token); expect(response.status).toBe(202);
  const job = await response.json() as { access_token: string; status_url: string; cancel_url: string };
  expect((await fetch(url + job.status_url, { headers: { authorization: "Bearer " + token } })).status).toBe(404);
  expect((await fetch(url + job.status_url, { headers: { authorization: "Bearer " + job.access_token } })).status).toBe(200);
  edit(raw => { raw.client_connections.access_token_hash = hash(nextToken); }); sy.reloadIfChanged(); await controller.sync(loadConfig(sy.cfg.configPath).client_connections);
  expect((await fetch(url + "/v1/models", { headers: { authorization: "Bearer " + token } })).status).toBe(401);
  expect((await fetch(url + "/v1/models", { headers: { authorization: "Bearer " + nextToken } })).status).toBe(200);
  const cancelled = await post(url + job.cancel_url, {}, job.access_token); expect(cancelled.status).toBe(200); expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
});

it("enables an unscoped listener but clearly refuses agent submissions until scoped settings exist", async () => {
  const { sy, controller, listen } = await fixture();
  const config = { ...sy.cfg.client_connections, enabled_modes: ["direct", "agent"] as const };
  await controller.sync({ ...config, enabled_modes: [...config.enabled_modes] }); const url = controller.status().ollamaBaseUrl;
  expect((await post(url + "/v1/chat/completions", { ...body, model: "meritrouter-agent" }, token)).status).toBe(400);
  expect((await post(url + "/api/jobs", { mode: "agent", goal: "Do work" }, token)).status).toBe(400);
  expect((await post(url + "/v1/chat/completions", body, token)).status).toBe(200);
  expect(sy.tasks.list()).toEqual([]);
});

it.each(["abort", "rotation", "invalid_config"] as const)("a capacity-blocked %s request makes no extra call/receipt and leaves no orphan slot", async kind => {
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  const client = new ScriptedClient(async (req, count) => { if (count === 1) { enter(); await held; } return reply("Held output", { model: req.model, provider: req.provider }); });
  const { sy, env, edit } = await fixture({ client });
  const first = sy.requestClientConnection(request, new AbortController().signal, token); await entered;
  const abort = new AbortController(), second = sy.requestClientConnection(request, abort.signal, token); const refused = expect(second).rejects.toThrow();
  await vi.waitFor(() => expect(sy.db.prepare("SELECT COUNT(*) n FROM executions WHERE profile='direct' AND status='running'").get()).toEqual({ n: 2 }));
  if (kind === "abort") abort.abort(new Error("fixture client cancelled"));
  if (kind === "rotation") edit(raw => { raw.client_connections.access_token_hash = hash(nextToken); });
  if (kind === "invalid_config") writeFileSync(env.cfg.configPath, "invalid: [yaml");
  release(); await first; await refused;
  expect(client.requests).toHaveLength(1); expect(sy.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({ n: 1 });
  expect(sy.db.prepare("SELECT COUNT(*) n FROM request_protocol").get()).toEqual({ n: 1 }); expect(sy.db.prepare("SELECT COUNT(*) n FROM provider_slots").get()).toEqual({ n: 0 });
});

it.each(["reserve", "begin"] as const)("fences key revocation after awaited %s without misclassifying definitely-unsent admission as storage uncertainty", async stage => {
  const { sy, client, edit } = await fixture(); const ledger = sy.gate.ledger;
  if (stage === "reserve") { const original = ledger.reserve.bind(ledger); vi.spyOn(ledger, "reserve").mockImplementationOnce(async input => { const result = await original(input); edit(raw => { raw.client_connections.access_token_hash = hash(nextToken); }); return result; }); }
  else { const original = ledger.beginDispatch.bind(ledger); vi.spyOn(ledger, "beginDispatch").mockImplementationOnce(async (...args) => { const result = await original(...args); edit(raw => { raw.client_connections.access_token_hash = hash(nextToken); }); return result; }); }
  await expect(sy.requestClientConnection(request, new AbortController().signal, token)).rejects.toMatchObject({ reason: "lease_lost" });
  expect(client.requests).toHaveLength(0); expect(sy.db.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "failed" });
  expect(sy.db.prepare("SELECT state FROM request_protocol").get()).toEqual({ state: "settled" }); expect(sy.db.prepare("SELECT COUNT(*) n FROM provider_slots").get()).toEqual({ n: 0 });
});

it("treats an execution deadline reached after reservation as definitely unsent, retaining the failed receipt without a poisoned slot", async () => {
  let now = Date.now(); const { sy, client } = await fixture({ now: () => now });
  const original = sy.gate.ledger.reserve.bind(sy.gate.ledger); vi.spyOn(sy.gate.ledger, "reserve").mockImplementationOnce(async input => { const result = await original(input); now += 121000; return result; });
  await expect(sy.requestClientConnection(request, new AbortController().signal, token)).rejects.toMatchObject({ reason: "deadline_exceeded" });
  expect(client.requests).toHaveLength(0); expect(sy.db.prepare("SELECT status FROM model_requests").get()).toEqual({ status: "failed" }); expect(sy.db.prepare("SELECT COUNT(*) n FROM provider_slots").get()).toEqual({ n: 0 });
});
