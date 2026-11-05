import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MeritRouter } from "../src/core/service.js";
import { ClientConnectionRequestSchema, parseClientChat } from "../src/connections/protocol.js";
import type { ChatToolCall } from "../src/gateway/types.js";
import { baseConfig, directEndpoint, FakeProvider, makeEnv, providerChat, providerJson, type Env, type FakeProviderCall, type FakeProviderHandler } from "./helpers.js";

const services: MeritRouter[] = [], environments: Env[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const env of environments.splice(0)) env.cleanup();
});

type Layout = "legacy" | "split";
interface RoutingFixture {
  env: Env;
  sy: MeritRouter;
  fake: FakeProvider;
  layout: Layout;
  authorityBefore: Record<string, unknown[]>;
}
const KEY_A = "test-direct-key-a", KEY_B = "test-direct-key-b", BACKUP_KEY = "test-direct-backup-key";
const providers = (twoKeys: boolean) => ({
  acme: { base_url: "https://api.acme.test/v1", keys: [
    { label: "a", api_key: KEY_A, billing_class: "free_tier" },
    ...(twoKeys ? [{ label: "b", api_key: KEY_B, billing_class: "free_tier" }] : []),
  ] },
  backup: { base_url: "https://api.backup.test/v1", keys: [{ label: "backup", api_key: BACKUP_KEY, billing_class: "free_tier" }] },
});

async function fixture(layout: Layout, endpoints: unknown[], handler: FakeProviderHandler, twoKeys = false): Promise<RoutingFixture> {
  const raw: Record<string, unknown> = baseConfig({
    providers: providers(twoKeys),
    storage: { directory: "installation-state", layout }, repositories: {}, projects: {},
    // No completion/summarize profile exists: direct is an intrinsic request route.
    profiles: { implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, max_output_tokens: 2000, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" } },
    client_connections: { enabled: true, enabled_modes: ["direct"], default_mode: "direct", max_output_tokens: 128, request_timeout_seconds: 30 },
    paid: { enabled: false, tiers: { T1: "never", T2: "never", T3: "never", T4: "never" } },
    routing: { max_endpoint_fallbacks: 3 },
  });
  const env = makeEnv({ config: raw, endpoints }); environments.push(env);
  const fake = new FakeProvider(handler);
  const sy = new MeritRouter(env.cfg, { worker: false, panelLifecycle: "passive", providerFetch: fake.fetch }); services.push(sy);
  expect(sy.cfg.profiles.summarize).toBeUndefined();
  expect(Object.values(sy.cfg.profiles).some(profile => profile?.mode === "completion")).toBe(false);
  if (layout === "split") expect(sy.projects.slugs()).toEqual([]);
  return { env, sy, fake, layout, authorityBefore: authoritySnapshot(sy) };
}

function authoritySnapshot(sy: MeritRouter): Record<string, unknown[]> {
  return Object.fromEntries(["tasks", "projects", "project_store_registrations", "project_execution_grants", "task_request_grants", "job_budget_carves"]
    .map(table => [table, sy.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

const clientRead = { id: "client_previous_read", type: "function" as const, function: { name: "client_read_file", arguments: '{"path":"README.md"}' } };
const clientTools = [
  { type: "function", function: { name: "client_read_file", description: "Read through the caller's editor", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  } } },
  { type: "function", function: { name: "client_write_file", description: "Write through the caller's editor", parameters: {
    type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false,
  } } },
];
const returnedCall: ChatToolCall = { id: "caller_must_execute", type: "function", function: {
  name: "client_write_file", arguments: '{"path":"must-not-be-written-by-direct.txt","content":"execute only in the external client"}',
} };
const conversation = () => ({
  model: "meritrouter-direct",
  messages: [
    { role: "system", content: "You are my editor assistant. Continue this arbitrary conversation; do not summarize it." },
    { role: "user", content: "We are planning a violet paper kite. Remember my phrase: cobalt otter." },
    { role: "assistant", content: null, tool_calls: [clientRead] },
    { role: "tool", tool_call_id: clientRead.id, content: "A file result supplied and owned by the external client." },
    { role: "user", content: "Now propose the next client edit using the remembered phrase." },
  ],
  tools: clientTools, tool_choice: "auto", temperature: 0.25, max_tokens: 128,
});

function requestFrom(f: RoutingFixture, route: "/v1/chat/completions" | "/api/chat", body: unknown) {
  const parsed = parseClientChat(route, body, f.sy.cfg.client_connections);
  expect(parsed.mode).toBe("direct");
  return ClientConnectionRequestSchema.parse({ chat: parsed.chat });
}

function expectCallerPayload(calls: FakeProviderCall[], chat: ReturnType<typeof requestFrom>["chat"]) {
  for (const call of calls) {
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({ messages: chat.messages, max_tokens: 128, temperature: 0.25, tools: chat.tools, tool_choice: "auto" });
    // An exact history comparison catches extra summarization/system prompts and hidden tools.
    expect(call.body!.messages).toEqual(chat.messages);
    expect(call.body!.tools).toEqual(chat.tools);
  }
}

interface AttemptRow {
  id: string; endpoint_id: string; profile: string; project_id: string; purpose: string; status: string; error_kind: string | null;
  http_status: number | null; provider_attempts: number | null; attempts_exact: number | null;
}
function expectAccounting(f: RoutingFixture, endpoints: string[], statuses: string[]) {
  const db = f.sy.db;
  expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  expect(authoritySnapshot(f.sy)).toEqual(f.authorityBefore);
  const requests = db.prepare("SELECT r.id,r.endpoint_id,e.profile,r.project_id,r.purpose,r.status,r.error_kind,r.http_status,r.provider_attempts,r.attempts_exact FROM model_requests r JOIN executions e ON e.id=r.execution_id ORDER BY r.rowid").all() as AttemptRow[];
  expect(requests.map(row => row.endpoint_id)).toEqual(endpoints);
  expect(requests.map(row => row.status)).toEqual(statuses);
  expect(requests.every(row => row.purpose === "client_connection")).toBe(true);
  expect(requests.every(row => row.profile === "direct" && row.project_id === "")).toBe(true);
  expect(requests.at(-1)).toMatchObject({ provider_attempts: 1, attempts_exact: 1, http_status: 200 });
  expect(new Set(requests.map(row => row.id)).size).toBe(endpoints.length);
  expect(db.prepare("SELECT COUNT(*) n FROM request_charges").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM execution_members").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT profile,status FROM executions").all()).toEqual([{ profile: "direct", status: "completed" }]);
  expect(db.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({ n: 0 });
  expect(f.fake.chats()).toHaveLength(endpoints.length);
  expect(f.fake.calls).toHaveLength(endpoints.length);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM provider_slots").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM broker_paid_spend").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM project_request_holds").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM project_execution_claims").get()).toEqual({ n: 0 });
  return requests;
}

function expectNoCallerExecution(f: RoutingFixture, previousReadme: Buffer) {
  expect(readFileSync(path.join(f.env.repo, "README.md"))).toEqual(previousReadme);
  expect(existsSync(path.join(f.env.repo, "must-not-be-written-by-direct.txt"))).toBe(false);
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM worker_action_requests").get()).toEqual({ n: 0 });
  expect(f.sy.db.prepare("SELECT COUNT(*) n FROM lab_command_owners").get()).toEqual({ n: 0 });
}

it.each([["legacy", 401], ["legacy", 429], ["split", 401], ["split", 429]] as const)("rotates a direct %s key after HTTP %i without rewriting history or executing client tools", async (layout, status) => {
  const f = await fixture(layout, [directEndpoint("acme", "chat-model")], call => call.key === KEY_A
    ? providerJson({ error: { message: status === 401 ? "invalid api key" : "rate limit reached" } }, status, status === 429 ? { "retry-after": "30" } : {})
    : providerChat(String(call.body?.model), { content: null, toolCalls: [returnedCall] }), true);
  const before = Date.now(), readme = readFileSync(path.join(f.env.repo, "README.md"));
  const request = requestFrom(f, "/v1/chat/completions", conversation()), beforeRequest = structuredClone(request);
  const response = await f.sy.requestClientConnection(request, new AbortController().signal);
  expect(response.message).toEqual({ content: null, tool_calls: [returnedCall] });
  expect(response.finishReason).toBe("tool_calls");
  expect(f.fake.chats().map(call => call.key)).toEqual([KEY_A, KEY_B]);
  expectCallerPayload(f.fake.chats(), request.chat);
  expect(request).toEqual(beforeRequest);
  const rows = expectAccounting(f, ["acme/chat-model", "acme/chat-model"], ["failed", "succeeded"]);
  expect(rows[0]).toMatchObject({ http_status: status, error_kind: status === 401 ? "auth" : "rate_limited" });
  const refused = f.sy.providers.keys.get("config:acme:literal:0")!;
  if (status === 401) expect(refused.disabledReason).toBe("auth_invalid");
  else expect(refused.cooldownUntil).toBeGreaterThan(before);
  expect(f.sy.providers.keys.get("config:acme:literal:1")!.lastSuccessAt).not.toBeNull();
  expectNoCallerExecution(f, readme);
});

it.each(["legacy", "split"] as const)("falls back from model refusal to another model and provider in %s, retaining every charged attempt", async layout => {
  const f = await fixture(layout, [
    directEndpoint("acme", "missing-model", { totalParametersB: 40 }),
    directEndpoint("acme", "overloaded-model", { totalParametersB: 100 }),
    directEndpoint("backup", "available-model", { totalParametersB: 550 }),
  ], call => call.body?.model === "missing-model" ? providerJson({ error: { message: "model not found" } }, 404)
    : call.body?.model === "overloaded-model" ? providerJson({ error: { message: "temporarily overloaded" } }, 503)
      : providerChat(String(call.body?.model), { content: null, toolCalls: [returnedCall] }));
  const readme = readFileSync(path.join(f.env.repo, "README.md")), request = requestFrom(f, "/v1/chat/completions", conversation());
  const response = await f.sy.requestClientConnection(request, new AbortController().signal);
  expect(response.message.tool_calls).toEqual([returnedCall]);
  expect(f.fake.chats().map(call => [new URL(call.url).hostname, call.body?.model, call.key])).toEqual([
    ["api.acme.test", "missing-model", KEY_A], ["api.acme.test", "overloaded-model", KEY_A], ["api.backup.test", "available-model", BACKUP_KEY],
  ]);
  expectCallerPayload(f.fake.chats(), request.chat);
  const rows = expectAccounting(f, ["acme/missing-model", "acme/overloaded-model", "backup/available-model"], ["failed", "uncertain", "succeeded"]);
  expect(rows.map(row => row.http_status)).toEqual([404, 503, 200]);
  expect(rows.map(row => row.error_kind)).toEqual(["unknown_model", "server", null]);
  expectNoCallerExecution(f, readme);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZ0AAAAASUVORK5CYII=";
it.each(["openai", "ollama"] as const)("preserves %s image input and excludes an otherwise preferred text-only model before charging", async protocol => {
  const f = await fixture("legacy", [
    directEndpoint("acme", "text-only", { totalParametersB: 40, inputModalities: ["text"] }),
    directEndpoint("acme", "vision", { totalParametersB: 100, inputModalities: ["text", "image"] }),
  ], call => providerChat(String(call.body?.model), { content: "The caller's image reached the vision route." }));
  const content = [{ type: "text", text: "Inspect my image without summarizing the conversation." }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }];
  const readme = readFileSync(path.join(f.env.repo, "README.md"));
  const request = protocol === "openai"
    ? requestFrom(f, "/v1/chat/completions", { model: "meritrouter-direct", messages: [{ role: "user", content }], max_tokens: 128 })
    : requestFrom(f, "/api/chat", { model: "meritrouter-direct:latest", messages: [{ role: "user", content: content[0]!.text, images: [PNG] }], stream: false, options: { num_predict: 128 } });
  const response = await f.sy.requestClientConnection(request, new AbortController().signal);
  expect(response.message.content).toBe("The caller's image reached the vision route.");
  expect(request.chat.messages).toEqual([{ role: "user", content }]);
  expect(f.fake.chats()[0]!.body).toMatchObject({ model: "vision", messages: request.chat.messages });
  expectAccounting(f, ["acme/vision"], ["succeeded"]);
  expectNoCallerExecution(f, readme);
});
