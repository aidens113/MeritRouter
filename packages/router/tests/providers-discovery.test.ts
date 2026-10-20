import { describe, expect, it } from "vitest";
import { ConfigSchema, ProvidersSectionSchema } from "../src/config/schema.js";
import { ModelEndpointSchema, type ModelEndpointInput } from "../src/models/catalog.js";
import {
  ProviderCredentials,
  dailyProbeBudget,
  discoverModels,
  parseModelListPage,
  rebaseUrl,
  resolveProviders,
  type DiscoveryOptions,
  type FetchLike,
  type ProviderClient,
} from "../src/providers/index.js";
import { baseConfig } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const OR_URL = "https://openrouter.ai/api/v1/models";
const HF_URL = "https://huggingface.co/api/models";

interface Call {
  url: string;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch answering by URL (the path plus query, without the origin's scheme). */
function fakeFetch(routes: Record<string, (call: Call) => Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const call = { url, headers: init.headers };
    calls.push(call);
    const route = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && url.startsWith(k.slice(0, -1)))?.[1];
    return route ? route(call) : json({ error: { message: `no route for ${url}` } }, 404);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const OR_CATALOG = {
  data: [
    {
      id: "qwen/qwen3-32b",
      name: "Qwen: Qwen3 32B",
      hugging_face_id: "Qwen/Qwen3-32B",
      context_length: 40960,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000001", completion: "0.0000003" },
      supported_parameters: ["tools", "tool_choice", "response_format"],
    },
    {
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      pricing: { prompt: "0.0000025", completion: "0.00001" },
      top_provider: { context_length: 128000, max_completion_tokens: 16384 },
      supported_parameters: ["tools", "response_format"],
    },
    { id: "vendor/free-chat:free", name: "Free chat", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"], context_length: 32768 },
    { id: "vendor/zero-chat", name: "Zero chat", pricing: { prompt: "0", completion: "0" }, context_length: 8192 },
    { id: "vendor/priced-chat", name: "Priced chat", pricing: { prompt: "0.000001", completion: "0.000002" }, context_length: 65536 },
    { id: "vendor/image-maker", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" } },
    { name: "missing id" },
  ],
};

const DISCOVERY = { openrouter_models_url: OR_URL, huggingface_api_url: HF_URL, probe_tools: false, max_probe_requests_per_day: 20 };

function setup(section: Record<string, unknown>, env: Record<string, string> = {}) {
  const parsed = ProvidersSectionSchema.parse(section);
  const providers = resolveProviders(parsed);
  const credentials = new ProviderCredentials(providers, parsed, null, env, () => NOW);
  return { providers, credentials };
}

function run(section: Record<string, unknown>, env: Record<string, string>, fetchFn: FetchLike, over: Partial<DiscoveryOptions> = {}) {
  const { providers, credentials } = setup(section, env);
  return discoverModels({ providers, credentials, config: DISCOVERY, fetch: fetchFn, now: () => NOW, only: Object.keys(section), ...over });
}

const key = (env: string, billing = "free_tier", extra: Record<string, unknown> = {}) => ({ keys: [{ api_key_env: env, billing_class: billing, ...extra }] });
const catalogRoute = { [OR_URL]: () => json(OR_CATALOG) };

describe("model-list shapes", () => {
  it("openai shape (Groq): keeps active chat models, reads limits, sends bearer auth", async () => {
    const f = fakeFetch({
      ...catalogRoute,
      "https://api.groq.com/openai/v1/models": () =>
        json({
          object: "list",
          data: [
            { id: "llama-3.3-70b-versatile", owned_by: "Meta", active: true, context_window: 131072, max_completion_tokens: 32768 },
            { id: "old-model", active: false, context_window: 8192 },
            { id: "whisper-large-v3", active: true },
            { id: 42 },
          ],
        }),
    });
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "gsk-secret-1" }, f);
    expect(r.providers[0]).toMatchObject({ provider: "groq", status: "listed", credentialRef: "config:groq:env:GROQ_KEY", kept: 1 });
    expect(r.providers[0]!.excluded).toEqual([
      { model: "#3", reason: "malformed list entry" },
      { model: "old-model", reason: "inactive" },
      { model: "whisper-large-v3", reason: "not a chat model (id)" },
    ]);
    const groqCall = f.calls.find((c) => c.url.includes("groq"))!;
    expect(groqCall.headers.authorization).toBe("Bearer gsk-secret-1");
    const ep = r.endpoints[0]!.endpoint;
    expect(() => ModelEndpointSchema.parse(ep)).not.toThrow();
    expect(ep).toMatchObject({
      id: "groq/llama-3.3-70b-versatile",
      providerId: "groq",
      gatewayModelId: "llama-3.3-70b-versatile",
      origin: "discovered",
      route: { kind: "direct", provider: "groq", model: "llama-3.3-70b-versatile" },
      contextLimitTokens: 131072,
      outputLimitTokens: 32768,
      outputLimitSource: "provider",
      totalParametersB: 70,
      quotaScopeIds: ["groq:key"],
    });
    expect(r.endpoints[0]!.enriched.provenance.contextLimitTokens).toEqual({ source: "provider", detail: "model list" });
    expect(r.endpoints[0]!.enriched.provenance.parameters.source).toBe("name");
    expect(r.endpoints[0]!.free).toEqual({ value: true, reason: "a free_tier key serves it" });
  });

  it("openai shape variants: Mistral capabilities and archived, Together bare array with types, SambaNova zero price", () => {
    const mistral = parseModelListPage("openai", {
      data: [
        { id: "mistral-small-latest", max_context_length: 32768, capabilities: { completion_chat: true, function_calling: true, vision: false }, archived: false },
        { id: "mistral-old", archived: true },
        { id: "codestral-embed", capabilities: { completion_chat: false } },
      ],
    });
    expect(mistral.models).toHaveLength(1);
    expect(mistral.models[0]).toMatchObject({ contextLimitTokens: 32768, supportsTools: true, inputModalities: ["text"] });
    expect(mistral.excluded.map((e) => e.reason)).toEqual(["archived", "not a chat model"]);

    const together = parseModelListPage("openai", [
      { id: "meta-llama/Llama-3-8b-chat-hf", type: "chat", context_length: 8192, pricing: { hourly: 0, input: 0.2, output: 0.2 } },
      { id: "BAAI/bge-large-en-v1.5", type: "embedding" },
    ]);
    expect(together.models[0]).toMatchObject({ id: "meta-llama/Llama-3-8b-chat-hf", price: "positive", supportsTools: null });
    expect(together.excluded).toEqual([{ model: "BAAI/bge-large-en-v1.5", reason: "not a chat model (type embedding)" }]);

    const samba = parseModelListPage("openai", { data: [{ id: "Meta-Llama-3.1-8B-Instruct", context_length: 16384, max_completion_tokens: 4096, pricing: { prompt: "0", completion: "0" } }] });
    expect(samba.models[0]).toMatchObject({ price: "zero", contextLimitTokens: 16384, outputLimitTokens: 4096 });

    expect(() => parseModelListPage("openai", { models: [] })).toThrow(/unexpected openai model-list shape/);
  });

  it("google_native: follows nextPageToken, keeps generateContent models, strips models/, uses x-goog-api-key", async () => {
    const base = "https://generativelanguage.googleapis.com/v1beta/models";
    const f = fakeFetch({
      ...catalogRoute,
      [base]: () =>
        json({
          models: [
            { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ],
          nextPageToken: "t2",
        }),
      [`${base}?pageToken=t2`]: () => json({ models: [{ name: "models/gemma-3-27b-it", inputTokenLimit: 131072, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"] }] }),
    });
    const r = await run({ google: key("GEMINI_KEY") }, { GEMINI_KEY: "AIza-secret" }, f);
    const listCalls = f.calls.filter((c) => c.url.startsWith(base));
    expect(listCalls.map((c) => c.url)).toEqual([base, `${base}?pageToken=t2`]);
    expect(listCalls[0]!.headers["x-goog-api-key"]).toBe("AIza-secret");
    expect(listCalls[0]!.headers.authorization).toBeUndefined();
    expect(r.endpoints.map((e) => e.endpoint.id)).toEqual(["google/gemini-2.5-flash", "google/gemma-3-27b-it"]);
    expect(r.endpoints[0]!.endpoint).toMatchObject({ displayName: "Gemini 2.5 Flash", contextLimitTokens: 1048576, outputLimitTokens: 65536, quotaScopeIds: ["google:project"] });
    expect(r.providers[0]).toMatchObject({ pages: 2, excluded: [{ model: "text-embedding-004", reason: "does not support generateContent" }] });
  });

  it("anthropic: follows has_more with after_id and reads max_input_tokens / max_tokens", async () => {
    const base = "https://api.anthropic.com/v1/models";
    const f = fakeFetch({
      ...catalogRoute,
      [base]: () => json({ data: [{ id: "claude-a", display_name: "Claude A", max_input_tokens: 200000, max_tokens: 64000 }], has_more: true, last_id: "claude-a" }),
      [`${base}?after_id=claude-a`]: () => json({ data: [{ id: "claude-b", type: "model" }], has_more: false, last_id: "claude-b" }),
    });
    const r = await run({ anthropic: key("ANTHROPIC_KEY", "paid_postpaid") }, { ANTHROPIC_KEY: "sk-ant-x" }, f);
    const call = f.calls.find((c) => c.url === base)!;
    expect(call.headers["x-api-key"]).toBe("sk-ant-x");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r.endpoints.map((e) => e.endpoint.id)).toEqual(["anthropic/claude-a", "anthropic/claude-b"]);
    expect(r.endpoints[0]!.endpoint).toMatchObject({ contextLimitTokens: 200000, outputLimitTokens: 64000, pricing: { freeVerified: false, inputUsdPerMillion: null } });
    expect(r.endpoints[0]!.free).toEqual({ value: false, reason: "only paid or trial keys" });
    // Nothing reports Claude B's limits: unknown, never defaulted.
    expect(r.endpoints[1]!.endpoint).toMatchObject({ contextLimitTokens: null, outputLimitTokens: null, outputLimitSource: "default", supportsTools: null });
    expect(r.endpoints[1]!.enriched.provenance.contextLimitTokens.source).toBe("unknown");
  });

  it("cohere: keeps the endpoint=chat filter, reads context and listed features", async () => {
    const url = "https://api.cohere.com/v1/models?endpoint=chat";
    const f = fakeFetch({
      ...catalogRoute,
      [url]: () =>
        json({
          models: [
            { name: "command-a-03-2025", context_length: 256000, features: ["tools", "json_schema"] },
            { name: "command-light", context_length: 4096, features: [] },
          ],
        }),
    });
    const r = await run({ cohere: key("CO_KEY", "trial") }, { CO_KEY: "co-x" }, f);
    expect(f.calls.some((c) => c.url === url)).toBe(true);
    const [a, b] = r.endpoints.map((e) => e.enriched);
    expect(a).toMatchObject({ contextLimitTokens: 256000, supportsTools: true, supportsStructuredOutput: true });
    expect(b).toMatchObject({ supportsTools: null, supportsStructuredOutput: null });
    expect(r.endpoints[0]!.free.value).toBe(false);
  });

  it("cloudflare_search: account id in the URL, text-generation only, result_info pages", async () => {
    const base = "https://api.cloudflare.com/client/v4/accounts/acct123/ai/models/search";
    const f = fakeFetch({
      ...catalogRoute,
      [base]: () =>
        json({
          success: true,
          result: [
            { id: "uuid-1", name: "@cf/meta/llama-3.1-8b-instruct", description: "8 billion parameter model", task: { name: "Text Generation" }, properties: [{ property_id: "context_window", value: "7968" }, { property_id: "function_calling", value: "true" }] },
            { id: "uuid-2", name: "@cf/baai/bge-base-en-v1.5", task: { name: "Text Embeddings" } },
          ],
          result_info: { page: 1, per_page: 2, total_count: 3 },
        }),
      [`${base}?page=2`]: () => json({ success: true, result: [{ id: "uuid-3", name: "@cf/qwen/qwq-32b", task: { name: "Text Generation" } }], result_info: { page: 2, per_page: 2, total_count: 3 } }),
    });
    const r = await run({ cloudflare: key("CF_TOKEN", "free_tier", { account_id: "acct123" }) }, { CF_TOKEN: "cf-x" }, f);
    expect(r.endpoints.map((e) => e.endpoint.id)).toEqual(["cloudflare/@cf/meta/llama-3.1-8b-instruct", "cloudflare/@cf/qwen/qwq-32b"]);
    expect(r.endpoints[0]!.enriched).toMatchObject({ contextLimitTokens: 7968, supportsTools: true });
    expect(r.endpoints[0]!.endpoint.route).toEqual({ kind: "direct", provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct" });
    expect(r.providers[0]!.excluded).toEqual([{ model: "@cf/baai/bge-base-en-v1.5", reason: "not a chat model (task Text Embeddings)" }]);
  });

  it("a keyless custom provider (local server) is listed without auth at its models_path", async () => {
    const f = fakeFetch({ ...catalogRoute, "http://127.0.0.1:11434/v1/api/tags-compat": () => json({ data: [{ id: "llama3.2:3b" }] }) });
    const r = await run({ local: { base_url: "http://127.0.0.1:11434/v1", no_key: true, models_path: "/api/tags-compat" } }, {}, f);
    expect(r.providers[0]).toMatchObject({ provider: "local", status: "listed", credentialRef: "none:local" });
    const call = f.calls.find((c) => c.url.startsWith("http://127.0.0.1"))!;
    expect(call.headers.authorization).toBeUndefined();
    expect(r.endpoints[0]!.endpoint).toMatchObject({ id: "local/llama3.2:3b", route: { kind: "direct", provider: "local", model: "llama3.2:3b" }, sourceUrls: [], pricing: { freeVerified: true } });
  });

  it("stops on a repeated continuation token", async () => {
    const base = "https://generativelanguage.googleapis.com/v1beta/models";
    const f = fakeFetch({ ...catalogRoute, [`${base}*`]: () => json({ models: [{ name: "models/gemini-x", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "same" }) });
    const r = await run({ google: key("GEMINI_KEY") }, { GEMINI_KEY: "k" }, f);
    expect(r.providers[0]!.pages).toBe(2);
    expect(r.endpoints).toHaveLength(1);
  });
});

describe("base_url overrides", () => {
  const listUrl = (id: string, entry: Record<string, unknown> = {}) => setup({ [id]: entry }).providers.get(id)!.models.url;

  it("keep the registry's absolute model-list URLs when there is no override", () => {
    expect(listUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(listUrl("cohere")).toBe("https://api.cohere.com/v1/models?endpoint=chat");
    expect(listUrl("cloudflare", { account_id: "acct1" })).toBe("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search");
    expect(listUrl("groq")).toBe("{base}/models");
  });

  it("move google's native list with the override, keeping its path relative to the API root", async () => {
    // A gateway in front of the same API: the part before /v1beta/openai is the new root.
    const gw = "https://gw.example.test/v1/acct/gw/google-ai-studio";
    expect(listUrl("google", { base_url: `${gw}/v1beta/openai/` })).toBe(`${gw}/v1beta/models`);
    // An override that does not end in the default path: the list path goes on its origin.
    expect(listUrl("google", { base_url: "https://proxy.example.test/gemini" })).toBe("https://proxy.example.test/v1beta/models");
    // models_path still sets the list exactly.
    expect(listUrl("google", { base_url: "https://proxy.example.test/gemini", models_path: "/list" })).toBe("{base}/list");

    const f = fakeFetch({ ...catalogRoute, [`${gw}/v1beta/models`]: () => json({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] }) });
    const r = await run({ google: { base_url: `${gw}/v1beta/openai`, ...key("GEMINI_KEY") } }, { GEMINI_KEY: "AIza-secret" }, f);
    expect(r.providers[0]).toMatchObject({ status: "listed", kept: 1 });
    expect(f.calls.some((c) => c.url.includes("generativelanguage.googleapis.com"))).toBe(false);
  });

  it("move cohere's list (another host by default) and cloudflare's search, account id included", async () => {
    expect(listUrl("cohere", { base_url: "https://proxy.example.test/cohere/compatibility/v1" })).toBe("https://proxy.example.test/cohere/v1/models?endpoint=chat");
    // Cloudflare: the account id stays a template, or takes the literal the override carries.
    expect(listUrl("cloudflare", { base_url: "https://gw.example.test/client/v4/accounts/{account_id}/ai/v1", account_id: "acct1" })).toBe("https://gw.example.test/client/v4/accounts/{account_id}/ai/models/search");
    expect(listUrl("cloudflare", { base_url: "https://gw.example.test/client/v4/accounts/acct999/ai/v1", account_id: "acct1" })).toBe("https://gw.example.test/client/v4/accounts/acct999/ai/models/search");

    const f = fakeFetch({
      ...catalogRoute,
      "https://proxy.example.test/cohere/v1/models?endpoint=chat": () => json({ models: [{ name: "command-r", context_length: 128000 }] }),
      "https://gw.example.test/client/v4/accounts/acct1/ai/models/search": () => json({ result: [{ id: "x", name: "@cf/meta/llama-3.1-8b-instruct", task: { name: "Text Generation" } }] }),
    });
    const r = await run(
      {
        cohere: { base_url: "https://proxy.example.test/cohere/compatibility/v1", ...key("COHERE_KEY") },
        cloudflare: { base_url: "https://gw.example.test/client/v4/accounts/{account_id}/ai/v1", ...key("CF_KEY", "free_tier", { account_id: "acct1" }) },
      },
      { COHERE_KEY: "co-secret", CF_KEY: "cf-secret" },
      f,
    );
    expect(r.providers.map((p) => [p.provider, p.status, p.kept])).toEqual([
      ["cohere", "listed", 1],
      ["cloudflare", "listed", 1],
    ]);
    expect(f.calls.some((c) => /api\.cohere\.com|api\.cloudflare\.com/.test(c.url))).toBe(false);
  });

  it("leave {base} templates alone and move any absolute key-info URL the same way", () => {
    const or = setup({ openrouter: { base_url: "https://or-proxy.example.test/api/v1" } }).providers.get("openrouter")!;
    expect(or.models.url).toBe("{base}/models");
    expect(or.keyInfoUrl).toBe("{base}/key");
    expect(rebaseUrl("https://info.example.test/v2/key?x=1", "https://api.example.test/v1", "https://proxy.example.test/team/v1")).toBe("https://proxy.example.test/team/v2/key?x=1");
    expect(rebaseUrl("{base}/key", "https://api.example.test/v1", "https://proxy.example.test/v1")).toBe("{base}/key");
  });
});

describe("free marking", () => {
  const orList = { "https://openrouter.ai/api/v1/models": () => json(OR_CATALOG) };

  it("OpenRouter with a free_tier key: :free and $0 models are free, priced models are not usable", async () => {
    const r = await run({ openrouter: key("OR_KEY") }, { OR_KEY: "sk-or" }, fakeFetch(orList));
    const byId = new Map(r.endpoints.map((e) => [e.endpoint.id, e]));
    expect(byId.get("openrouter/vendor/free-chat:free")!.free).toEqual({ value: true, reason: "model id ends in :free" });
    expect(byId.get("openrouter/vendor/zero-chat")!.free).toEqual({ value: true, reason: "provider lists a price of 0" });
    expect(byId.has("openrouter/vendor/priced-chat")).toBe(false);
    expect(byId.has("openrouter/openai/gpt-4o")).toBe(false);
    expect(r.providers[0]!.excluded).toEqual(
      expect.arrayContaining([
        { model: "vendor/priced-chat", reason: "priced model; only free_tier keys" },
        { model: "vendor/image-maker", reason: "does not output text" },
        { model: "#6", reason: "malformed list entry" },
      ]),
    );
    // OpenRouter's own list is provider metadata.
    expect(byId.get("openrouter/vendor/free-chat:free")!.enriched.provenance.supportsTools).toEqual({ source: "provider", detail: "model list" });
  });

  it("OpenRouter with a paid key: priced models are kept, paid, and priced per million", async () => {
    const r = await run({ openrouter: key("OR_KEY", "paid_credits") }, { OR_KEY: "sk-or" }, fakeFetch(orList));
    const priced = r.endpoints.find((e) => e.endpoint.id === "openrouter/vendor/priced-chat")!;
    expect(priced.free.value).toBe(false);
    expect(priced.endpoint.pricing).toMatchObject({ inputUsdPerMillion: 1, outputUsdPerMillion: 2, freeVerified: false });
    expect(r.endpoints.find((e) => e.endpoint.id === "openrouter/vendor/free-chat:free")!.free.value).toBe(true);
  });

  it("a free_tier key on a provider with listed prices (SambaNova) is free; trial keys are not", async () => {
    const list = { "https://api.sambanova.ai/v1/models": () => json({ data: [{ id: "Llama-4-Maverick", context_length: 131072, pricing: { prompt: "0.00000063", completion: "0.0000018" } }] }) };
    const free = await run({ sambanova: key("SN_KEY") }, { SN_KEY: "x" }, fakeFetch({ ...catalogRoute, ...list }));
    expect(free.endpoints[0]!.free).toEqual({ value: true, reason: "a free_tier key serves it" });
    expect(free.endpoints[0]!.endpoint.pricing).toMatchObject({ inputUsdPerMillion: 0, freeVerified: true });
    const trial = await run({ sambanova: key("SN_KEY", "trial") }, { SN_KEY: "x" }, fakeFetch({ ...catalogRoute, ...list }));
    // Non-OpenRouter price units are unverified: not converted to USD per million.
    expect(trial.endpoints[0]!.endpoint.pricing).toMatchObject({ inputUsdPerMillion: null, freeVerified: false });
  });
});

describe("enrichment", () => {
  it("OpenRouter by name fills tools and structured output; context only from the provider or an exact match; Hugging Face gives exact params", async () => {
    const f = fakeFetch({
      ...catalogRoute,
      "https://api.groq.com/openai/v1/models": () => json({ data: [{ id: "qwen/qwen3-32b", active: true, context_window: 131072 }] }),
      "https://api.openai.com/v1/models": () => json({ data: [{ id: "gpt-4o" }, { id: "gpt-mystery" }, { id: "text-embedding-3-small" }] }),
      [`${HF_URL}/Qwen/Qwen3-32B`]: () => json({ id: "Qwen/Qwen3-32B", safetensors: { total: 32_762_123_264 } }),
    });
    const r = await run({ groq: key("GROQ_KEY"), openai: key("OPENAI_KEY", "paid_postpaid") }, { GROQ_KEY: "g", OPENAI_KEY: "o" }, f);
    const qwen = r.endpoints.find((e) => e.endpoint.id === "groq/qwen/qwen3-32b")!;
    expect(qwen.enriched.openRouter).toEqual({ id: "qwen/qwen3-32b", match: "name" });
    expect(qwen.enriched.provenance.supportsTools).toEqual({ source: "openrouter", detail: "OpenRouter qwen/qwen3-32b (name match) supported_parameters" });
    expect(qwen.enriched.provenance.contextLimitTokens.source).toBe("provider");
    expect(qwen.endpoint).toMatchObject({ contextLimitTokens: 131072, outputLimitTokens: null, supportsTools: true, supportsStructuredOutput: true, totalParametersB: 32.8, providerModelId: "qwen/qwen3-32b" });
    expect(qwen.endpoint.params).toMatchObject({ source: "huggingface", confidence: "exact", confirmed: true });
    expect(qwen.enriched.provenance.parameters.source).toBe("huggingface");
    expect(qwen.endpoint.sourceUrls).toEqual(expect.arrayContaining(["https://openrouter.ai/qwen/qwen3-32b", "https://huggingface.co/Qwen/Qwen3-32B"]));

    const gpt = r.endpoints.find((e) => e.endpoint.id === "openai/gpt-4o")!;
    expect(gpt.enriched.openRouter?.match).toBe("exact");
    expect(gpt.endpoint).toMatchObject({ contextLimitTokens: 128000, outputLimitTokens: 16384, inputModalities: ["text", "image", "file"], supportsTools: true });
    expect(gpt.enriched.provenance.outputLimitTokens.source).toBe("openrouter");

    const mystery = r.endpoints.find((e) => e.endpoint.id === "openai/gpt-mystery")!;
    expect(mystery.enriched).toMatchObject({ contextLimitTokens: null, outputLimitTokens: null, supportsTools: null, inputModalities: null, openRouter: null });
    expect(Object.values(mystery.enriched.provenance).every((p) => p.source === "unknown")).toBe(true);
    expect(mystery.endpoint).toMatchObject({ supportsTools: null, inputModalities: ["text"], totalParametersB: null });
    expect(r.endpoints.some((e) => e.endpoint.id === "openai/text-embedding-3-small")).toBe(false);
  });

  it("works without the OpenRouter catalog and says so", async () => {
    const f = fakeFetch({ [OR_URL]: () => json({}, 503), "https://api.groq.com/openai/v1/models": () => json({ data: [{ id: "qwen/qwen3-32b", context_window: 131072 }] }) });
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, f);
    expect(r.warnings[0]).toMatch(/OpenRouter catalog unavailable/);
    expect(r.endpoints[0]!.enriched).toMatchObject({ supportsTools: null, openRouter: null });
  });

  it("user overrides win over every discovered source and are recorded as the source", async () => {
    const f = fakeFetch({ ...catalogRoute, "https://api.groq.com/openai/v1/models": () => json({ data: [{ id: "qwen/qwen3-32b", context_window: 131072 }] }) });
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, f, {
      huggingFaceTotal: async () => null,
      overrides: { "groq/qwen/qwen3-32b": { supportsTools: false, contextLimitTokens: 32000, outputLimitTokens: 4000, totalParametersB: 33, freeVerified: false } },
    });
    const e = r.endpoints[0]!;
    expect(e.endpoint).toMatchObject({ supportsTools: false, contextLimitTokens: 32000, outputLimitTokens: 4000, outputLimitSource: "override", totalParametersB: 33 });
    expect(e.endpoint.pricing).toMatchObject({ freeVerified: false, source: "override" });
    expect(e.free.value).toBe(false);
    expect(e.enriched.provenance).toMatchObject({
      supportsTools: { source: "override" },
      contextLimitTokens: { source: "override" },
      parameters: { source: "override" },
      pricing: { source: "override" },
      supportsStructuredOutput: { source: "openrouter" },
    });
  });
});

describe("availability", () => {
  const groqList = (ids: string[]) => ({ ...catalogRoute, "https://api.groq.com/openai/v1/models": () => json({ data: ids.map((id) => ({ id, context_window: 8192 })) }) });
  const known = (id: string, extra: Partial<ModelEndpointInput> = {}): ModelEndpointInput => ({
    id: `groq/${id}`,
    providerId: "groq",
    gatewayModelId: id,
    origin: "discovered",
    route: { kind: "direct", provider: "groq", model: id },
    totalParametersB: 8,
    activeParametersB: null,
    contextLimitTokens: 8192,
    outputLimitTokens: null,
    supportsTools: false,
    supportsStructuredOutput: false,
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true },
    checkedAt: new Date(NOW).toISOString(),
    ...extra,
  });

  it("marks previously known but unlisted models unavailable; manual entries win and are never marked", async () => {
    const manual = { ...known("manual-model"), origin: "manual" as const };
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch(groqList(["model-a", "manual-model"])), {
      known: [known("model-a"), known("model-gone"), known("already-gone", { available: false, enabled: false }), known("manual-model")],
      manual: [manual],
    });
    expect(r.endpoints.map((e) => e.endpoint.id)).toEqual(["groq/model-a"]);
    expect(r.unavailable).toEqual([{ endpoint: expect.objectContaining({ id: "groq/model-gone", available: false, enabled: false }), reason: "no longer listed by groq" }]);
    expect(r.providers[0]!.excluded).toContainEqual({ model: "manual-model", reason: "a manual entry defines this endpoint" });
  });

  it("a provider that lost its keys makes its models unavailable; a failed listing changes nothing", async () => {
    const noKey = await run({ groq: { keys: [{ api_key_env: "UNSET_KEY", billing_class: "free_tier" }] } }, {}, fakeFetch(groqList([])), { known: [known("model-a")] });
    expect(noKey.providers[0]!.status).toBe("no_key");
    expect(noKey.unavailable).toEqual([{ endpoint: expect.objectContaining({ id: "groq/model-a", available: false }), reason: "groq has no usable key" }]);
    expect(noKey.unavailable[0]!.endpoint.enabled).toBeUndefined();

    const failed = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch({ ...catalogRoute, "https://api.groq.com/openai/v1/models": () => json({ error: { message: "upstream" } }, 500) }), { known: [known("model-a")] });
    expect(failed.providers[0]).toMatchObject({ status: "failed", errors: [{ ref: "config:groq:env:GROQ_KEY", kind: "server" }] });
    expect(failed.unavailable).toEqual([]);
    expect(failed.warnings).toContain("groq: model list failed with every usable key");
  });

  it("an invalid key falls through to the next usable key", async () => {
    const f = fakeFetch({
      ...catalogRoute,
      "https://api.groq.com/openai/v1/models": (c) => (c.headers.authorization === "Bearer bad" ? json({ error: { message: "Invalid API Key" } }, 401) : json({ data: [{ id: "model-a" }] })),
    });
    const section = { groq: { keys: [{ api_key_env: "K1", billing_class: "free_tier" }, { api_key_env: "K2", billing_class: "free_tier" }] } };
    const failed: Array<[string, string]> = [];
    const r = await run(section, { K1: "bad", K2: "good" }, f, { onKeyFailure: (cred, err) => failed.push([cred.ref, err.reason]) });
    expect(r.providers[0]).toMatchObject({ status: "listed", credentialRef: "config:groq:env:K2", errors: [{ ref: "config:groq:env:K1", kind: "auth_invalid" }] });
    expect(r.endpoints).toHaveLength(1);
    // The rejected key is reported to the caller, which records it on the key.
    expect(failed).toEqual([["config:groq:env:K1", "auth_invalid"]]);
  });

  it("an envelope that is not the documented shape fails the provider", async () => {
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch({ ...catalogRoute, "https://api.groq.com/openai/v1/models": () => json({ unexpected: true }) }));
    expect(r.providers[0]!.status).toBe("failed");
    expect(r.providers[0]!.errors[0]!.message).toMatch(/unexpected openai model-list shape/);
  });

  it("disabled providers are reported and not listed", async () => {
    const f = fakeFetch(catalogRoute);
    const r = await run({ groq: { enabled: false, keys: [{ api_key_env: "GROQ_KEY", billing_class: "free_tier" }] } }, { GROQ_KEY: "g" }, f);
    expect(r.providers[0]!.status).toBe("disabled");
    expect(f.calls.some((c) => c.url.includes("groq"))).toBe(false);
  });
});

describe("tool probe", () => {
  const list = { ...catalogRoute, "https://api.groq.com/openai/v1/models": () => json({ data: [{ id: "mystery-a", context_window: 8192 }, { id: "mystery-b", context_window: 8192 }, { id: "mystery-c", context_window: 8192 }] }) };

  function probeClient(answer: (model: string) => "tool" | "text" | "reject") {
    const models: string[] = [];
    const client: Pick<ProviderClient, "complete"> & { models: string[] } = {
      models,
      async complete(req) {
        models.push(req.model);
        expect(req.chat.tools?.[0]?.function.name).toBe("ping");
        expect(req.credential.apiKey).toBe("g");
        const a = answer(req.model);
        if (a === "reject") {
          const { ProviderError } = await import("../src/providers/index.js");
          throw new ProviderError("bad_request", "groq: tools are not supported for this model", { provider: "groq", status: 400 });
        }
        return {
          message: { content: a === "text" ? "pong" : null, ...(a === "tool" ? { tool_calls: [{ id: "t1", type: "function" as const, function: { name: "ping", arguments: "{}" } }] } : {}) },
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" },
          telemetry: { servedModel: req.model, servedProvider: "groq", providerAttempts: 1, providerAttemptsExact: true, cacheHit: null, headers: {} },
          httpStatus: 200,
          rateLimits: { family: "openai", observedAt: NOW, retryAfterMs: null, windows: [] },
        };
      },
    };
    return client;
  }

  it("is off by default even with a client", async () => {
    const client = probeClient(() => "tool");
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch(list), { probeClient: client });
    expect(client.models).toEqual([]);
    expect(r.endpoints.every((e) => e.enriched.supportsTools === null)).toBe(true);
  });

  it("probes unknown models within the daily budget and records the result as the source", async () => {
    const client = probeClient((m) => (m === "mystery-a" ? "tool" : "reject"));
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch(list), {
      config: { ...DISCOVERY, probe_tools: true, max_probe_requests_per_day: 2 },
      probeClient: client,
      overrides: { "groq/mystery-c": { supportsTools: true } },
    });
    expect(client.models).toEqual(["mystery-a", "mystery-b"]);
    const [a, b, c] = r.endpoints.map((e) => e.enriched);
    expect(a).toMatchObject({ supportsTools: true, provenance: { supportsTools: { source: "probe" } } });
    expect(b).toMatchObject({ supportsTools: false, provenance: { supportsTools: { source: "probe" } } });
    // An override answers the question: no probe is spent.
    expect(c).toMatchObject({ supportsTools: true, provenance: { supportsTools: { source: "override" } } });
  });

  it("stops at the budget and leaves the rest unknown", async () => {
    const client = probeClient(() => "text");
    const budget = dailyProbeBudget(1, () => NOW);
    const r = await run({ groq: key("GROQ_KEY") }, { GROQ_KEY: "g" }, fakeFetch(list), { config: { ...DISCOVERY, probe_tools: true }, probeClient: client, probeBudget: budget });
    expect(client.models).toEqual(["mystery-a"]);
    expect(r.endpoints[0]!.enriched).toMatchObject({ supportsTools: null, notes: ["tool probe inconclusive"] });
    expect(r.endpoints[1]!.enriched.notes).toEqual(["tool probe skipped: today's probe budget is spent"]);
    expect(budget.remaining()).toBe(0);
  });

  it("the daily budget resets at UTC midnight", () => {
    let t = Date.UTC(2026, 9, 20, 23, 59);
    const budget = dailyProbeBudget(2, () => t);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    t = Date.UTC(2026, 9, 21, 0, 1);
    expect(budget.remaining()).toBe(2);
    expect(budget.take()).toBe(true);
  });
});

describe("discovery config", () => {
  it("defaults: probing off, 20 probes per day, hourly", () => {
    const cfg = ConfigSchema.parse(baseConfig());
    expect(cfg.discovery).toMatchObject({ interval_minutes: 0, probe_tools: false, max_probe_requests_per_day: 20 });
    expect(ConfigSchema.parse({ ...baseConfig(), discovery: {} }).discovery.interval_minutes).toBe(60);
    expect(() => ConfigSchema.parse(baseConfig({ discovery: { max_probe_requests_per_day: -1 } }))).toThrow();
  });
});
