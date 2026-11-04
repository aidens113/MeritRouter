import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { parseModelListPage } from "../src/providers/discovery.js";
import { baseConfig, FakeProvider, makeEnv, open, providerJson, type Env } from "./helpers.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { effectiveBudget } from "../src/admission/admission.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const MODELS = "https://api.anthropic.com/v1/models";
const DOC = "https://platform.claude.com/docs/en/api/models/list";
const credits = { api_key: "fixture-anthropic-key", billing_class: "paid_credits" };
// Synthetic values in the published ModelInfo shape; these are not real model facts.
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: "model", display_name: id, line: "opus", lifecycle: "active", created_at: "2026-01-01T00:00:00Z",
  deprecated_at: null, retires_at: null, max_input_tokens: 100_000, max_tokens: 8000, capabilities: null, ...extra,
});
function setup(models: () => unknown[], provider = "anthropic", entry: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const fake = new FakeProvider(call => call.url === "https://openrouter.ai/api/v1/models"
    ? providerJson({ data: [] })
    : call.url.endsWith("/models") ? providerJson({ data: models(), has_more: false })
      : providerJson({ error: { message: "unexpected fixture request" } }, 404));
  env = makeEnv({ config: baseConfig({ providers: { [provider]: { keys: [credits], ...entry } } }), endpoints: [], overrides });
  sy = open(env, fake);
  return fake;
}

it("preserves authoritative Anthropic capabilities through scan without inventing proprietary size or prices", async () => {
  const fake = setup(() => [
    model("claude-fixture-supported", { capabilities: { structured_outputs: { supported: true }, image_input: { supported: false }, pdf_input: { supported: true }, server_tools: { web_search: { supported: false } } } }),
    model("claude-fixture-unsupported", { capabilities: { structured_outputs: { supported: false }, image_input: { supported: false }, pdf_input: { supported: false } } }),
    model("claude-fixture-unknown"),
    model("claude-opus-name-only", { line: null }),
  ]);
  const scan = await sy!.scan();
  expect(scan.errors).toEqual([]);
  expect(scan.pendingConfirmation).toEqual([]);
  const supported = sy!.catalog.get("anthropic/claude-fixture-supported")!;
  expect(supported).toMatchObject({ status: "active", ignoreSizeFloor: true, totalParametersB: null, activeParametersB: null,
    contextLimitTokens: 100_000, outputLimitTokens: 8000, supportsTools: true, supportsStructuredOutput: true, inputModalities: ["text", "file"],
    params: { source: "unknown", confidence: "unknown", confirmed: false }, route: { kind: "direct", provider: "anthropic", model: "claude-fixture-supported" },
    pricing: { freeVerified: false, inputUsdPerMillion: null, outputUsdPerMillion: null } });
  expect(supported.sourceUrls).toContain(DOC);
  expect(supported.notes).toContain("line=opus");
  expect(supported.checkedAt).toBeTruthy();
  expect(sy!.catalog.get("anthropic/claude-fixture-unsupported")).toMatchObject({ supportsTools: null, supportsStructuredOutput: false, inputModalities: ["text"] });
  expect(sy!.catalog.get("anthropic/claude-fixture-unknown")).toMatchObject({ supportsTools: null, supportsStructuredOutput: null });
  expect(sy!.catalog.get("anthropic/claude-opus-name-only")).toMatchObject({ ignoreSizeFloor: true, totalParametersB: null });
  expect(sy!.catalog.get("anthropic/claude-opus-name-only")!.notes).toContain("line=unknown");
  expect(fake.calls.some(call => call.url.endsWith("/messages"))).toBe(false);
  expect(fake.calls.some(call => call.url === MODELS)).toBe(true);
});

it("does not convert a proprietary model name into a guessed parameter count", async () => {
  setup(() => [model("claude-fixture-999b")]);
  await sy!.scan();
  expect(sy!.catalog.get("anthropic/claude-fixture-999b")).toMatchObject({ totalParametersB: null, activeParametersB: null, ignoreSizeFloor: true,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] } });
});

it("preserves exact native thinking protocol for configured paid aliases without inferring it from model names", async () => {
  const nativeId = "claude-synthetic-always-adaptive";
  const fake = new FakeProvider(call => call.url === "https://api.anthropic.com/v1/models"
    ? providerJson({ data: [model(nativeId, { capabilities: { structured_outputs: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false }, disabled: { supported: false } } } } })], has_more: false })
    : call.url === "https://api.anthropic.com/v1/messages"
      ? providerJson({ model: nativeId, content: [{ type: "tool_use", id: "c1", name: "record", input: { value: "observed" } }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "tool_use" })
    : providerJson({ data: [] }));
  env = makeEnv({ config: baseConfig({ providers: { anthropic: { keys: [credits] } }, paid: { enabled: true,
    providers: { anthropic: { kind: "anthropic", base_url: "https://api.anthropic.com" } },
    models: [{ provider: "anthropic", model: nativeId, context_limit_tokens: 100000, output_limit_tokens: 8000, ignore_size_floor: true, input_usd_per_million: 2, output_usd_per_million: 8 }] } }), endpoints: [] });
  sy = open(env, fake, { worker: false });
  await sy.scan();
  const expected = { api: "anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: nativeId,
    thinking: { supported: true, adaptive: true, enabled: false, disabled: false }, sourceUrl: DOC };
  expect(sy.catalog.get(`anthropic/${nativeId}`)!.anthropicProtocol).toMatchObject(expected);
  expect(sy.catalog.get(`paid:anthropic/${nativeId}`)!.anthropicProtocol).toEqual(sy.catalog.get(`anthropic/${nativeId}`)!.anthropicProtocol);
  expect(sy.catalog.get(`paid:anthropic/${nativeId}`)!.anthropicProtocol!.checkedAt).toBeTruthy();
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "protocol-wire", profile: "inspect", goal: "Synthetic native protocol wire fixture", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["actual native tool record"] }, budget: { maxModelRequests: 1, maxPaidUsd: 1 } })], { project: sy.cfg.brain.project });
  const stored = sy.tasks.claim("protocol-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 60000, defaultTimeoutMs: 60000 })[0]!;
  const plan = sy.router.plan("inspect", "T1", ["text"], `paid:anthropic/${nativeId}`);
  const response = await sy.gate.request({ plan, executionId: sy.admission.createExecution("task", "inspect", [{ taskId: stored.row.id, itemId: stored.row.id }]), purpose: "native protocol fixture", participants: [{ taskId: stored.row.id, leaseOwner: "protocol-owner", lease: capturedLease(stored), budget: effectiveBudget(sy.cfg, stored.spec) }], chat: { messages: [{ role: "user", content: "Return record" }], tools: [{ type: "function", function: { name: "record", description: "record observed data", parameters: { type: "object" } } }], tool_choice: "required", max_tokens: 100 } });
  expect(response.response.message.tool_calls![0]!.function.name).toBe("record");
  const sent = fake.calls.filter(call => call.url.endsWith("/messages"));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body!.tool_choice).toEqual({ type: "auto" });
  expect(sy.spend.summary().week).toBeGreaterThan(0);
});

it("preserves manual disable and distinguishes reported retirement from an overdue retirement date", async () => {
  let retired = false;
  setup(() => [model("claude-fixture-manual"), model("claude-fixture-retiring", { lifecycle: retired ? "retired" : "deprecated", deprecated_at: "2025-01-01T00:00:00Z", retires_at: "2025-02-01T00:00:00Z" })],
    "anthropic", {}, { "anthropic/claude-fixture-manual": { forceStatus: "disabled" } });
  await sy!.scan();
  expect(sy!.catalog.get("anthropic/claude-fixture-manual")).toMatchObject({ status: "disabled", statusReason: "disabled manually" });
  expect(sy!.catalog.get("anthropic/claude-fixture-retiring")).toMatchObject({ status: "active", available: true });
  retired = true;
  const scan = await sy!.scan();
  expect(scan.unavailable).toContain("anthropic/claude-fixture-retiring");
  expect(sy!.catalog.get("anthropic/claude-fixture-retiring")).toMatchObject({ status: "removed", available: false });
  expect(sy!.catalog.get("anthropic/claude-fixture-manual")!.status).toBe("disabled");
});

it.each([
  ["custom", { base_url: "https://models.example.test/v1", api: "openai_compatible" }],
  ["anthropic", { base_url: "https://proxy.example.test/v1" }],
] as const)("does not exempt unknown size on a generic or proxy route: %s", async (provider, entry) => {
  setup(() => [model("claude-fixture")], provider, entry);
  const scan = await sy!.scan();
  expect(scan.pendingConfirmation).toContain(`${provider}/claude-fixture`);
  expect(sy!.catalog.get(`${provider}/claude-fixture`)).toMatchObject({ ignoreSizeFloor: false, totalParametersB: null, status: "pending_confirmation" });
});

it("keeps incomplete identity and malformed capabilities unknown rather than asserting support", async () => {
  setup(() => [model("claude-incomplete", { type: undefined, line: undefined }), model("claude-invalid", {
    type: "embedding", lifecycle: "future-status", line: "opus", max_input_tokens: -1, max_tokens: "8000",
    capabilities: { structured_outputs: { supported: "yes" }, image_input: { supported: 1 }, pdf_input: { supported: null } },
  })]);
  const scan = await sy!.scan();
  expect(scan.pendingConfirmation.sort()).toEqual(["anthropic/claude-incomplete", "anthropic/claude-invalid"]);
  expect(sy!.catalog.get("anthropic/claude-invalid")).toMatchObject({ ignoreSizeFloor: false, contextLimitTokens: null, outputLimitTokens: null, supportsTools: null, supportsStructuredOutput: null });
  expect(() => parseModelListPage("anthropic", { data: "invalid" })).toThrow();
  expect(parseModelListPage("anthropic", { data: [{ id: 3 }] }).models).toEqual([]);
});

it("retains hosted Ollama context under an explicitly empty architecture namespace", async () => {
  // Captured field shape: values are fixture metadata, not hardcoded production model facts.
  const fake = new FakeProvider(call => {
    if (call.url === "https://openrouter.ai/api/v1/models") return providerJson({ data: [] });
    if (call.url === "https://ollama.com/api/tags") return providerJson({ models: [{ name: "nemotron-3-ultra", digest: "fixture-empty-architecture" }] });
    if (call.url === "https://ollama.com/api/show") return providerJson({ capabilities: ["completion", "thinking", "tools"], model_info: {
      "general.architecture": "", ".context_length": 262144, "general.parameter_count": 550000000000,
    } });
    return providerJson({ error: { message: "unexpected fixture request" } }, 404);
  });
  env = makeEnv({ config: baseConfig({ providers: { "ollama-cloud": { keys: [credits] } } }), endpoints: [] });
  sy = open(env, fake);
  await sy.scan();
  expect(sy.catalog.get("ollama-cloud/nemotron-3-ultra")).toMatchObject({ contextLimitTokens: 262144, outputLimitTokens: 262144,
    maxContextTokens: 262144, supportsTools: true, totalParametersB: 550, params: { source: "provider", confidence: "exact" },
    route: { kind: "direct", provider: "ollama-cloud", model: "nemotron-3-ultra" } });
  expect(sy.catalog.get("ollama-cloud/nemotron-3-ultra")!.notes).toContain("context-derived ceiling");
  expect(fake.calls.some(call => call.url.endsWith("/chat/completions") || call.url.endsWith("/api/chat"))).toBe(false);
});
