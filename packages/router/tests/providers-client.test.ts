import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, ProvidersSectionSchema } from "../src/config/schema.js";
import { parseConfig } from "../src/config/load.js";
import { GatewayError } from "../src/core/errors.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import {
  BUILTIN_PROVIDER_IDS,
  KeyVault,
  ProviderCredentials,
  ProviderError,
  createProviderClient,
  parseRateLimitHeaders,
  parseResetValue,
  resolveProviders,
  type FetchLike,
  type ProviderRequest,
  type ResolvedProvider,
} from "../src/providers/index.js";
import { httpDirectClient } from "../src/paid/direct.js";
import { baseConfig } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fake fetch that records requests and answers from a script. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    return answer(call);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const okChat = (extra: Record<string, unknown> = {}) => ({ id: "c1", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 }, ...extra });

const providers = (section: Record<string, unknown> = {}) => resolveProviders(ProvidersSectionSchema.parse(section));
const provider = (id: string, section: Record<string, unknown> = {}): ResolvedProvider => providers(section).get(id)!;

const tool = { type: "function" as const, function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } } };

function request(p: ResolvedProvider, over: Partial<ProviderRequest> = {}): ProviderRequest {
  return { provider: p, credential: { apiKey: "sk-test-key-1234" }, model: "some-model", chat: { messages: [{ role: "user", content: "hello" }], max_tokens: 100 }, timeoutMs: 5000, ...over };
}

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(GatewayError);
    return err as ProviderError;
  }
  throw new Error("expected a ProviderError");
}

describe("provider registry", () => {
  it("defines every researched built-in with a source and check date, and no GitHub Models", () => {
    expect([...BUILTIN_PROVIDER_IDS].sort()).toEqual(["anthropic", "cerebras", "cloudflare", "cohere", "google", "groq", "huggingface", "mistral", "nvidia", "openai", "openrouter", "sambanova", "together"]);
    for (const p of providers().values()) {
      expect(p.sourceUrl).toMatch(/^(https:\/\/|docs\/working\/direct-providers\/research\.md#)/);
      expect(p.checkedAt).toBe("2026-10-19");
      expect(p.baseUrl).not.toMatch(/\/$/);
    }
  });

  it("adds custom OpenAI-compatible providers (keyless local servers too) and applies built-in overrides", () => {
    const all = providers({ ollama: { base_url: "http://localhost:11434/v1/", no_key: true }, openrouter: { headers: { "HTTP-Referer": "https://example.test" } } });
    const ollama = all.get("ollama")!;
    expect(ollama).toMatchObject({ builtIn: false, api: "openai_compatible", baseUrl: "http://localhost:11434/v1", auth: "none", noKey: true, tokenLimitParam: "max_tokens" });
    expect(all.get("openrouter")!.extraHeaders).toEqual({ "HTTP-Referer": "https://example.test" });
  });
});

describe("providers config", () => {
  it("parses env and literal keys, billing classes, limits, and the request timeout", () => {
    const cfg = ConfigSchema.parse(
      baseConfig({
        providers: {
          request_timeout_seconds: 120,
          groq: { keys: [{ api_key_env: "GROQ_KEY_A", billing_class: "free_tier", rpm: 30, rpd: 1000 }, { api_key: "gsk_literal_secret", billing_class: "free_tier", label: "spare" }] },
          cloudflare: { account_id: "acct123", keys: [{ api_key_env: "CF_TOKEN", billing_class: "free_tier", quota_group: "cf-main" }] },
          local: { base_url: "http://127.0.0.1:8080/v1", no_key: true },
        },
      }),
    );
    expect(cfg.providers.request_timeout_seconds).toBe(120);
    expect(cfg.providers.byId.groq!.keys).toEqual([
      expect.objectContaining({ api_key_env: "GROQ_KEY_A", billing_class: "free_tier", rpm: 30, rpd: 1000, enabled: true, label: "" }),
      expect.objectContaining({ api_key: "gsk_literal_secret", label: "spare" }),
    ]);
    expect(cfg.providers.byId.cloudflare!.keys[0]!.quota_group).toBe("cf-main");
    expect(ConfigSchema.parse(baseConfig()).providers).toEqual({ request_timeout_seconds: 300, byId: {} });
  });

  it("rejects bad provider entries with paths under providers", () => {
    const bad = (providersSection: Record<string, unknown>) => () => parseConfig(baseConfig({ providers: providersSection }), "/tmp/sy.yaml");
    expect(bad({ myhost: { keys: [] } })).toThrow(/providers\.myhost\.base_url: myhost is not a built-in provider/);
    expect(bad({ groq: { keys: [{ api_key_env: "A", api_key: "b", billing_class: "free_tier" }] } })).toThrow(/providers\.groq\.keys\.0: set exactly one of api_key_env or api_key/);
    expect(bad({ groq: { keys: [{ api_key_env: "A" }] } })).toThrow(/providers\.groq\.keys\.0\.billing_class/);
    expect(bad({ cloudflare: { keys: [{ api_key_env: "CF", billing_class: "free_tier" }] } })).toThrow(/providers\.cloudflare\.keys\.0\.account_id: Cloudflare keys need account_id/);
    expect(bad({ groq: { no_key: true } })).toThrow(/providers\.groq\.no_key: no_key needs base_url/);
    expect(bad({ groq: { api: "anthropic" } })).toThrow(/providers\.groq\.api: api is set only for custom providers/);
    expect(bad({ request_timeout_seconds: 0 })).toThrow(/providers\.request_timeout_seconds/);
    expect(bad({ groq: { keys: [{ api_key_env: "A", billing_class: "free_tier" }, { api_key_env: "A", billing_class: "trial" }] } })).toThrow(/api_key_env A is listed twice/);
  });
});

describe("provider credentials", () => {
  let dir: string | undefined;
  let db: Db | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("merges config keys (env and literal) with vault keys behind one lookup", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "sy-prov-"));
    db = openDatabase(dir);
    const vault = new KeyVault(db, dir, () => NOW);
    const vk = vault.add({ provider: "groq", secret: "gsk-vault-secret-9999", billingClass: "free_tier", rpm: 20, quotaGroup: "team" });
    const cfVault = vault.add({ provider: "cloudflare", secret: "cf-vault-token-0000", billingClass: "free_tier" });
    expect(vault.get(vk.id)).toMatchObject({ limits: { rpm: 20, rpd: null, tpm: null, tpd: null }, quotaGroup: "team", accountId: null });
    const section = ProvidersSectionSchema.parse({
      groq: { keys: [{ api_key_env: "GROQ_A", billing_class: "free_tier" }, { api_key_env: "GROQ_UNSET", billing_class: "free_tier" }, { api_key: "gsk_literal_abcd", billing_class: "paid_postpaid" }] },
      local: { base_url: "http://127.0.0.1:1234/v1", no_key: true },
    });
    const creds = new ProviderCredentials(resolveProviders(section), section, vault, { GROQ_A: "gsk_from_env_wxyz" }, () => NOW);
    const groq = creds.list("groq");
    expect(groq.map((c) => [c.ref, c.source, c.last4, c.unusableReason])).toEqual([
      ["config:groq:env:GROQ_A", "config", "wxyz", null],
      ["config:groq:env:GROQ_UNSET", "config", "", "environment variable GROQ_UNSET is not set"],
      ["config:groq:literal:2", "config", "abcd", null],
      [`vault:${vk.id}`, "vault", "9999", null],
    ]);
    expect(creds.usable("groq").map((c) => c.billingClass)).toEqual(["free_tier", "paid_postpaid", "free_tier"]);
    expect(creds.requestCredential("config:groq:env:GROQ_A")).toEqual({ apiKey: "gsk_from_env_wxyz", accountId: null });
    expect(creds.requestCredential("config:groq:literal:2").apiKey).toBe("gsk_literal_abcd");
    expect(creds.requestCredential(`vault:${vk.id}`).apiKey).toBe("gsk-vault-secret-9999");
    expect(() => creds.requestCredential("config:groq:env:GROQ_UNSET")).toThrow(/not set/);
    expect(creds.list("local")).toEqual([expect.objectContaining({ ref: "none:local", source: "none", unusableReason: null })]);
    expect(creds.requestCredential("none:local")).toEqual({ apiKey: null, accountId: null });
    // A Cloudflare vault key without an account id cannot build its URL until one is set.
    expect(creds.get(`vault:${cfVault.id}`)!.unusableReason).toMatch(/account id/);
    vault.update(cfVault.id, { accountId: "acct-9" });
    expect(creds.requestCredential(`vault:${cfVault.id}`)).toEqual({ apiKey: "cf-vault-token-0000", accountId: "acct-9" });
    vault.update(vk.id, { enabled: false });
    expect(creds.get(`vault:${vk.id}`)!.unusableReason).toBe("disabled");
  });
});

describe("openai_compatible adapter", () => {
  it("Groq: max_completion_tokens, unsupported params stripped, structured output dropped beside tools, per-day request headers", async () => {
    const f = fakeFetch(() =>
      json(okChat({ model: "llama-x" }), 200, {
        "x-ratelimit-limit-requests": "14400",
        "x-ratelimit-remaining-requests": "14370",
        "x-ratelimit-reset-requests": "2m59.56s",
        "x-ratelimit-limit-tokens": "18000",
        "x-ratelimit-remaining-tokens": "17997",
        "x-ratelimit-reset-tokens": "7.66s",
        "x-request-id": "req_1",
      }),
    );
    const client = createProviderClient({ fetch: f, now: () => NOW });
    const res = await client.complete(
      request(provider("groq"), {
        chat: { messages: [{ role: "user", content: "hi" }], max_tokens: 64, tools: [tool], tool_choice: "required", response_format: { type: "json_object" } },
        params: { seed: 7, logit_bias: { "1": 5 }, logprobs: true, n: 3, bogus: 1 },
      }),
    );
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-test-key-1234");
    expect(call.body).toMatchObject({ model: "some-model", max_completion_tokens: 64, tool_choice: "required", seed: 7, stream: false });
    for (const k of ["max_tokens", "logit_bias", "logprobs", "n", "bogus", "response_format"]) expect(call.body).not.toHaveProperty(k);
    expect(res.telemetry).toMatchObject({ servedModel: "llama-x", servedProvider: "groq", providerAttempts: 1 });
    expect(res.telemetry.headers).toMatchObject({ "x-request-id": "req_1", "x-ratelimit-remaining-requests": "14370" });
    expect(res.telemetry.headers).not.toHaveProperty("content-type");
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, basis: "provider_reported" });
    expect(res.rateLimits.windows).toEqual([
      { metric: "requests", period: "day", limit: 14400, remaining: 14370, resetAt: NOW + 179_560 },
      { metric: "tokens", period: "minute", limit: 18000, remaining: 17997, resetAt: NOW + 7_660 },
    ]);
  });

  it("Mistral: required becomes any, seed becomes random_seed, max_tokens", async () => {
    const f = fakeFetch(() => json(okChat()));
    await createProviderClient({ fetch: f }).complete(request(provider("mistral"), { chat: { messages: [{ role: "user", content: "x" }], max_tokens: 50, tools: [tool], tool_choice: "required" }, params: { seed: 3, parallel_tool_calls: false } }));
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(call.body).toMatchObject({ max_tokens: 50, tool_choice: "any", random_seed: 3, parallel_tool_calls: false });
    expect(call.body).not.toHaveProperty("seed");
  });

  it("OpenRouter: no fallbacks, billed cost reported, X-RateLimit headers, and errors inside HTTP 200 bodies", async () => {
    const reset = String(NOW + 30_000);
    const f = fakeFetch(() => json(okChat({ usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0012 } }), 200, { "X-RateLimit-Limit": "20", "X-RateLimit-Remaining": "19", "X-RateLimit-Reset": reset }));
    const p = provider("openrouter");
    const res = await createProviderClient({ fetch: f, now: () => NOW }).complete(request(p, { model: "vendor/model:free" }));
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(f.calls[0]!.body).toMatchObject({ model: "vendor/model:free", max_tokens: 100, usage: { include: true }, provider: { allow_fallbacks: false } });
    expect(res.usage.reportedCostUsd).toBe(0.0012);
    expect(res.rateLimits.windows).toEqual([{ metric: "requests", period: "unknown", limit: 20, remaining: 19, resetAt: NOW + 30_000 }]);

    const limited = await failure(createProviderClient({ fetch: fakeFetch(() => json({ error: { code: 429, message: "Rate limit exceeded: free-models-per-min", metadata: { provider_name: "X" } } })) }).complete(request(p)));
    expect(limited).toMatchObject({ reason: "rate_limited", kind: "rate_limited", retryable: true, status: 200, possiblyConsumed: false });
    const broke = await failure(createProviderClient({ fetch: fakeFetch(() => json({ error: { code: 402, message: "Insufficient credits", metadata: { limit_source: "key" } } })) }).complete(request(p)));
    expect(broke).toMatchObject({ reason: "out_of_credits", kind: "pool_exhausted", retryable: false });
    expect(broke.message).toContain("limit_source");
    const midStream = await failure(createProviderClient({ fetch: fakeFetch(() => json({ error: { message: "upstream died" } })) }).complete(request(p)));
    expect(midStream).toMatchObject({ reason: "server", retryable: true, possiblyConsumed: true });
  });

  it("Cloudflare: account id in the URL, tool_choice omitted, and refused locally without an account", async () => {
    const f = fakeFetch(() => json(okChat()));
    const p = provider("cloudflare");
    await createProviderClient({ fetch: f }).complete(request(p, { model: "@cf/meta/llama", credential: { apiKey: "cf-token-1234", accountId: "acct42" }, chat: { messages: [{ role: "user", content: "x" }], max_tokens: 10, tools: [tool], tool_choice: "required" } }));
    expect(f.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct42/ai/v1/chat/completions");
    expect(f.calls[0]!.body).toMatchObject({ model: "@cf/meta/llama", max_tokens: 10, tools: [tool] });
    expect(f.calls[0]!.body).not.toHaveProperty("tool_choice");
    // Provider-level account id applies when the key has none.
    const withAcct = provider("cloudflare", { cloudflare: { account_id: "acct-prov" } });
    await createProviderClient({ fetch: f }).complete(request(withAcct));
    expect(f.calls[1]!.url).toContain("/accounts/acct-prov/ai/v1/");
    const err = await failure(createProviderClient({ fetch: f }).complete(request(p)));
    expect(err).toMatchObject({ reason: "bad_request", possiblyConsumed: false });
    expect(f.calls).toHaveLength(2);
    // Cloudflare's error envelope.
    const denied = await failure(createProviderClient({ fetch: fakeFetch(() => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401)) }).complete(request(withAcct)));
    expect(denied).toMatchObject({ reason: "auth_invalid", providerCode: "10000" });
  });

  it("Google, Cohere, NVIDIA, Cerebras, custom: tool_choice and parameter rules", async () => {
    const f = fakeFetch(() => json(okChat()));
    const c = createProviderClient({ fetch: f });
    const toolsChat = { messages: [{ role: "user" as const, content: "x" }], max_tokens: 10, tools: [tool], tool_choice: "required" as const };
    await c.complete(request(provider("google"), { chat: toolsChat }));
    expect(f.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(f.calls[0]!.body).not.toHaveProperty("tool_choice");
    await c.complete(request(provider("cohere"), { chat: toolsChat, params: { parallel_tool_calls: true, logit_bias: {} } }));
    expect(f.calls[1]!.url).toBe("https://api.cohere.ai/compatibility/v1/chat/completions");
    expect(f.calls[1]!.body).not.toHaveProperty("tool_choice");
    expect(f.calls[1]!.body).not.toHaveProperty("parallel_tool_calls");
    expect(f.calls[1]!.body).not.toHaveProperty("logit_bias");
    await c.complete(request(provider("nvidia"), { chat: { messages: [{ role: "user", content: "x" }], max_tokens: 10, temperature: 1.6 } }));
    expect(f.calls[2]!.body).toMatchObject({ temperature: 1, max_tokens: 10 });
    const img = { messages: [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "https://example.test/a.png" } }] }], max_tokens: 10 };
    expect(await failure(c.complete(request(provider("cerebras"), { chat: img })))).toMatchObject({ reason: "bad_request", possiblyConsumed: false });
    expect(f.calls).toHaveLength(3);
    await c.complete(request(provider("cerebras"), { chat: { ...img, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] } }));
    expect(f.calls[3]!.body).toMatchObject({ max_completion_tokens: 10 });
    await c.complete(request(provider("local", { local: { base_url: "http://127.0.0.1:11434/v1", no_key: true } }), { credential: { apiKey: null } }));
    expect(f.calls[4]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(f.calls[4]!.headers).not.toHaveProperty("authorization");
    expect(await failure(c.complete(request(provider("groq"), { credential: { apiKey: null } })))).toMatchObject({ reason: "auth_invalid", possiblyConsumed: false });
  });
});

describe("anthropic adapter", () => {
  it("sends the Messages API shape and parses tool use, usage, and anthropic-ratelimit headers", async () => {
    const f = fakeFetch(() =>
      json(
        { model: "claude-x", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "tu1", name: "read", input: { path: "a" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 } },
        200,
        { "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-requests-reset": "2026-10-20T12:01:00Z", "anthropic-ratelimit-input-tokens-remaining": "39000" },
      ),
    );
    const res = await createProviderClient({ fetch: f, now: () => NOW }).complete(
      request(provider("anthropic"), { model: "claude-x", chat: { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "x" }], max_tokens: 20, tools: [tool], tool_choice: "required" } }),
    );
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers).toMatchObject({ "x-api-key": "sk-test-key-1234", "anthropic-version": "2023-06-01" });
    expect(call.headers).not.toHaveProperty("authorization");
    expect(call.body).toMatchObject({ model: "claude-x", max_tokens: 20, system: "be brief", tool_choice: { type: "any" }, tools: [{ name: "read", input_schema: tool.function.parameters }] });
    expect(res.message.tool_calls).toEqual([{ id: "tu1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }]);
    expect(res).toMatchObject({ finishReason: "tool_calls", usage: { inputTokens: 15, outputTokens: 4, cachedInputTokens: 5 }, telemetry: { servedProvider: "anthropic", servedModel: "claude-x" } });
    expect(res.rateLimits.windows).toEqual([
      { metric: "requests", period: "unknown", limit: 50, remaining: 49, resetAt: NOW + 60_000 },
      { metric: "input_tokens", period: "unknown", limit: null, remaining: 39000, resetAt: null },
    ]);
  });

  it("a spend-cap 429 is out of credits and not retryable; an ordinary 429 is a rate limit", async () => {
    const p = provider("anthropic");
    const cap = await failure(createProviderClient({ fetch: fakeFetch(() => json({ type: "error", error: { type: "rate_limit_error", message: "enforced_spend_limit_reached: spend limit hit" } }, 429)) }).complete(request(p)));
    expect(cap).toMatchObject({ reason: "out_of_credits", retryable: false, status: 429 });
    const rl = await failure(createProviderClient({ fetch: fakeFetch(() => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "12" })) }).complete(request(p)));
    expect(rl).toMatchObject({ reason: "rate_limited", retryAfterMs: 12_000, providerCode: "rate_limit_error", possiblyConsumed: false });
    const overloaded = await failure(createProviderClient({ fetch: fakeFetch(() => json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529)) }).complete(request(p)));
    expect(overloaded).toMatchObject({ reason: "server", retryable: true, possiblyConsumed: true });
  });
});

describe("error classification", () => {
  const p = () => provider("groq");
  const status = (code: number, body: unknown, headers: Record<string, string> = {}) => failure(createProviderClient({ fetch: fakeFetch(() => json(body, code, headers)), now: () => NOW }).complete(request(p())));

  it("maps every HTTP class to a reason and a gateway kind", async () => {
    expect(await status(401, { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } })).toMatchObject({ reason: "auth_invalid", kind: "auth", retryable: false, possiblyConsumed: false });
    expect(await status(403, { error: { message: "forbidden" } })).toMatchObject({ reason: "auth_invalid" });
    expect(await status(403, { error: { message: "Input was flagged by moderation", code: 403 } })).toMatchObject({ reason: "policy", kind: "policy_violation", retryable: false });
    expect(await status(400, { error: { message: "violates our content policy" } })).toMatchObject({ reason: "policy" });
    expect(await status(402, { error: { message: "pay up" } })).toMatchObject({ reason: "out_of_credits", kind: "pool_exhausted", retryable: false });
    expect(await status(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota" } })).toMatchObject({ reason: "out_of_credits" });
    expect(await status(404, { error: { message: "model not found" } })).toMatchObject({ reason: "unknown_model", kind: "unknown_model" });
    expect(await status(400, { error: { message: "bad field" } })).toMatchObject({ reason: "bad_request", retryable: false, possiblyConsumed: false });
    expect(await status(408, { error: { message: "timeout" } })).toMatchObject({ reason: "timeout", possiblyConsumed: true });
    expect(await status(500, { error: { message: "boom" } })).toMatchObject({ reason: "server", kind: "server", retryable: true, possiblyConsumed: true });
    expect(await status(503, { error: { message: "busy" } }, { "retry-after": "3" })).toMatchObject({ reason: "server", retryAfterMs: 3000 });
  });

  it("rate limits carry retry-after (seconds or date), else the exhausted window's reset", async () => {
    expect(await status(429, { error: { message: "slow" } }, { "retry-after": "2.5" })).toMatchObject({ reason: "rate_limited", retryAfterMs: 2500 });
    const date = new Date(NOW + 90_000).toUTCString();
    expect(await status(429, { error: { message: "slow" } }, { "retry-after": date })).toMatchObject({ retryAfterMs: 90_000 });
    const viaHeaders = await status(429, { error: { message: "slow" } }, { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1m5s", "x-ratelimit-remaining-tokens": "500", "x-ratelimit-reset-tokens": "1s" });
    expect(viaHeaders).toMatchObject({ reason: "rate_limited", retryAfterMs: 65_000 });
    expect(viaHeaders.rateLimits!.windows).toHaveLength(2);
    // Gemini: 429 RESOURCE_EXHAUSTED in an array envelope and no headers.
    const gem = await failure(createProviderClient({ fetch: fakeFetch(() => json([{ error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }], 429)) }).complete(request(provider("google"))));
    expect(gem).toMatchObject({ reason: "rate_limited", providerCode: "RESOURCE_EXHAUSTED", retryAfterMs: undefined });
  });

  it("timeouts, caller aborts, network failures, non-JSON bodies, and content filters", async () => {
    const hang: FetchLike = (_url, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    expect(await failure(createProviderClient({ fetch: hang }).complete(request(p(), { timeoutMs: 20 })))).toMatchObject({ reason: "timeout", kind: "timeout", possiblyConsumed: true });
    const ac = new AbortController();
    const pending = createProviderClient({ fetch: hang }).complete(request(p(), { signal: ac.signal }));
    ac.abort();
    expect(await failure(pending)).toMatchObject({ reason: "aborted", retryable: false });
    expect(await failure(createProviderClient({ fetch: () => Promise.reject(new TypeError("fetch failed")) }).complete(request(p())))).toMatchObject({ reason: "transport", retryable: true, possiblyConsumed: true });
    expect(await failure(createProviderClient({ fetch: async () => new Response("<html>oops</html>", { status: 200 }) }).complete(request(p())))).toMatchObject({ reason: "server", possiblyConsumed: true });
    const filtered = { model: "m", choices: [{ message: { content: null }, finish_reason: "content_filter" }] };
    expect(await failure(createProviderClient({ fetch: fakeFetch(() => json(filtered)) }).complete(request(p())))).toMatchObject({ reason: "policy" });
    expect(await failure(createProviderClient({ fetch: fakeFetch(() => json({ id: "x", choices: [] })) }).complete(request(p())))).toMatchObject({ reason: "server" });
  });
});

describe("rate-limit header families", () => {
  const spec = (family: "openai" | "openrouter" | "anthropic" | "none", requestsPeriod: "minute" | "day" | "unknown" = "unknown") => ({ family, requestsPeriod, tokensPeriod: "unknown" as const });

  it("SambaNova per-minute and -day variants; OpenAI durations; none reads only retry-after", () => {
    const h = new Headers({ "x-ratelimit-limit-requests": "20", "x-ratelimit-remaining-requests": "18", "x-ratelimit-limit-requests-day": "20", "x-ratelimit-remaining-requests-day": "3", "x-ratelimit-reset-requests-day": "1792500000" });
    expect(parseRateLimitHeaders(h, spec("openai", "minute"), NOW).windows).toEqual([
      { metric: "requests", period: "minute", limit: 20, remaining: 18, resetAt: null },
      { metric: "requests", period: "day", limit: 20, remaining: 3, resetAt: 1_792_500_000_000 },
    ]);
    const none = parseRateLimitHeaders(new Headers({ "x-ratelimit-remaining-requests": "1", "retry-after": "4" }), spec("none"), NOW);
    expect(none).toEqual({ family: "none", observedAt: NOW, retryAfterMs: 4000, windows: [] });
  });

  it("parses reset values in every documented form", () => {
    expect(parseResetValue("6m0s", NOW)).toBe(NOW + 360_000);
    expect(parseResetValue("250ms", NOW)).toBe(NOW + 250);
    expect(parseResetValue("1h2m3s", NOW)).toBe(NOW + 3_723_000);
    expect(parseResetValue("30", NOW)).toBe(NOW + 30_000);
    expect(parseResetValue(String(NOW + 5000), NOW)).toBe(NOW + 5000);
    expect(parseResetValue("2026-10-20T12:00:10Z", NOW)).toBe(NOW + 10_000);
    expect(parseResetValue("soon", NOW)).toBeNull();
  });
});

describe("paid direct shim", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the paid client's interface on top of the provider client", async () => {
    const f = fakeFetch(() => json(okChat({ model: "acme-large" })));
    vi.stubGlobal("fetch", f);
    const res = await httpDirectClient.complete({ providerName: "acme", provider: { kind: "openai_compatible", base_url: "https://api.acme.test/v1/", balance_api: "none" }, apiKey: "sk-acme-1234", model: "acme-large", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 9, tools: [tool] }, timeoutMs: 5000 });
    expect(f.calls[0]!.url).toBe("https://api.acme.test/v1/chat/completions");
    expect(f.calls[0]!.body).toMatchObject({ max_tokens: 9, tool_choice: "auto" });
    expect(res.telemetry.servedProvider).toBe("paid:acme");
    expect(res).not.toHaveProperty("rateLimits");
    await httpDirectClient.complete({ providerName: "claude", provider: { kind: "anthropic", base_url: "https://api.anthropic.com", balance_api: "none" }, apiKey: "sk-ant-1234", model: "c", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 9 }, timeoutMs: 5000 }).catch(() => undefined);
    expect(f.calls[1]!.url).toBe("https://api.anthropic.com/v1/messages");
  });
});
