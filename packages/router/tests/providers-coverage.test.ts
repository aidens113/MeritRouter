import { beforeEach, describe, expect, it } from "vitest";
import { ModelEndpointSchema } from "../src/models/catalog.js";
import { ProvidersSectionSchema } from "../src/config/schema.js";
import {
  OLLAMA_MIN_DEFAULT_CONTEXT,
  ProviderCredentials,
  clearOllamaShowCache,
  createProviderClient,
  discoverModels,
  freeStatus,
  listProviderModels,
  ollamaHostRoot,
  openRouterCatalog,
  parseModelListPage,
  parseSizeLabel,
  probeFreeDailyQuota,
  probeOllamaBalance,
  resolveProviders,
  type FetchLike,
  type ResolvedProvider,
} from "../src/providers/index.js";

/**
 * P4 coverage: the built-ins added from research-coverage.md (local servers and more hosted
 * providers), their list shapes, Ollama discovery, keyless local providers, and OLLAMA_HOST.
 * Every provider is a fake fetch; nothing here reaches a network.
 */

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const now = () => NOW;
const DISCOVERY = { openrouter_models_url: "https://openrouter.ai/api/v1/models", huggingface_api_url: "https://huggingface.co/api/models", probe_tools: false, max_probe_requests_per_day: 0 };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake fetch: `answer` gets each call (with its parsed body) and returns the response. */
function fakeFetch(answer: (call: Call) => Response): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    return answer(call);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function setup(section: Record<string, unknown>, env: Record<string, string> = {}) {
  const parsed = ProvidersSectionSchema.parse(section);
  const providers = resolveProviders(parsed, env);
  const credentials = new ProviderCredentials(providers, parsed, null, env, now);
  return { providers, credentials, provider: (id: string): ResolvedProvider => providers.get(id)! };
}

const listOpts = { timeoutMs: 5000, now };

// ---- a fake local Ollama ----
const TAGS = {
  models: [
    { name: "llama3.1:8b", model: "llama3.1:8b", digest: "d-llama", size: 4920753328, details: { format: "gguf", family: "llama", parameter_size: "8.0B", quantization_level: "Q4_K_M" } },
    { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", digest: "d-nomic", details: { family: "nomic-bert", parameter_size: "137M", quantization_level: "F16" } },
    { name: "qwen3", model: "qwen3", digest: "d-qwen", details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
    { name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud", digest: "d-cloud", remote_model: "gpt-oss:120b", remote_host: "https://ollama.com:443", details: { parameter_size: "116.8B", quantization_level: "MXFP4" } },
    { model: "missing name" },
  ],
};
const SHOW: Record<string, unknown> = {
  "llama3.1:8b": {
    parameters: 'num_ctx                        8192\nstop                           "<|eot_id|>"',
    details: { family: "llama", parameter_size: "8.0B", quantization_level: "Q4_K_M" },
    capabilities: ["completion", "tools"],
    model_info: { "general.architecture": "llama", "general.parameter_count": 8030261248, "llama.context_length": 131072 },
  },
  "nomic-embed-text:latest": { capabilities: ["embedding"], model_info: { "general.architecture": "nomic-bert", "nomic-bert.context_length": 2048 } },
  qwen3: {
    parameters: "temperature 0.6\nnum_predict 2048",
    details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" },
    capabilities: ["completion", "tools", "thinking", "vision"],
    model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
  },
};
const PS = { models: [{ name: "qwen3", model: "qwen3", context_length: 16384 }] };

function ollamaServer(root = "http://127.0.0.1:11434", over: { tags?: unknown; tagsStatus?: number } = {}) {
  return fakeFetch((c) => {
    if (c.url === `${root}/api/tags`) return over.tagsStatus ? json({ error: "not found" }, over.tagsStatus) : json(over.tags ?? TAGS);
    if (c.url === `${root}/api/ps`) return json(PS);
    if (c.url === `${root}/api/show`) {
      const show = SHOW[String(c.body?.model)];
      return show ? json(show) : json({ error: "internal error" }, 500);
    }
    if (c.url === `${root}/v1/models`) return json({ object: "list", data: [{ id: "llama3.1:8b", object: "model", owned_by: "library" }, { id: "nomic-embed-text:latest", object: "model" }] });
    return json({ error: `no route ${c.url}` }, 404);
  });
}

beforeEach(() => clearOllamaShowCache());

describe("coverage built-ins", () => {
  it("encode the research facts: keys, list shapes, tool_choice, concurrency, free models", () => {
    const { provider } = setup({});
    expect(provider("ollama")).toMatchObject({ local: true, keyPolicy: "none", auth: "none", noKey: true, baseUrl: "http://127.0.0.1:11434/v1", toolChoice: { auto: null, none: null, required: null } });
    expect(provider("ollama").unsupportedParams).toEqual(expect.arrayContaining(["logit_bias", "user", "logprobs"]));
    expect(provider("ollama").models).toMatchObject({ url: "{root}/api/tags", shape: "ollama_tags", fallbackUrl: "{base}/models", details: "ollama_show" });
    expect(provider("ollama-cloud")).toMatchObject({ local: false, auth: "bearer", keyInfoUrl: "{root}/api/balance", keyInfoShape: "ollama_balance", quotaScope: "account", concurrency: { scope: "account" } });
    expect(provider("lmstudio")).toMatchObject({ local: true, keyPolicy: "optional", noKey: false, baseUrl: "http://localhost:1234/v1", models: { shape: "lmstudio_native" } });
    expect(provider("llamacpp")).toMatchObject({ local: true, keyPolicy: "optional", baseUrl: "", models: { shape: "openai", details: "llamacpp_props" } });
    expect(provider("deepseek")).toMatchObject({ concurrency: { scope: "account" }, unsupportedParams: ["frequency_penalty", "presence_penalty"] });
    expect(provider("deepinfra").models).toMatchObject({ shape: "deepinfra_list", auth: "none" });
    expect(provider("deepinfra").concurrency).toMatchObject({ scope: "model" });
    expect(provider("ovhcloud")).toMatchObject({ keyPolicy: "optional", models: { shape: "ovh_catalog", auth: "none" } });
    expect(provider("nebius")).toMatchObject({ models: { url: "{base}/models?verbose=true" }, rateLimitHeaders: { family: "openai", requestsPeriod: "minute", tokensPeriod: "minute" } });
    expect(provider("fireworks").bodyExtras).toEqual({ context_length_exceeded_behavior: "error" });
    expect(provider("zai")).toMatchObject({ temperatureMax: 1, toolChoice: { auto: "auto", none: null, required: null } });
    expect(provider("moonshot").tokenLimitParam).toBe("max_completion_tokens");
    expect(provider("vercel").baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
  });

  it("decide Z.ai's free models per model: only the documented ones are free, and a free key reaches only them", () => {
    const zai = setup({}).provider("zai");
    const free = [{ billingClass: "free_tier" as const }];
    const paid = [{ billingClass: "paid_credits" as const }];
    expect(freeStatus(zai, { id: "GLM-4.5-Flash", price: null }, free)).toMatchObject({ value: true, usable: true, basis: "model" });
    expect(freeStatus(zai, { id: "glm-4.6", price: null }, free)).toMatchObject({ value: false, usable: false });
    expect(freeStatus(zai, { id: "glm-4.6", price: null }, paid)).toMatchObject({ value: false, usable: true });
    // Other providers keep key-based free marking.
    expect(freeStatus(setup({}).provider("deepinfra"), { id: "x", price: null }, free)).toMatchObject({ value: true, basis: "key" });
  });
});

describe("OLLAMA_HOST", () => {
  it("parses the documented and client forms into a server root", () => {
    expect(ollamaHostRoot(undefined)).toBeNull();
    expect(ollamaHostRoot("  ")).toBeNull();
    expect(ollamaHostRoot("0.0.0.0")).toBe("http://127.0.0.1:11434");
    expect(ollamaHostRoot("0.0.0.0:8080")).toBe("http://127.0.0.1:8080");
    expect(ollamaHostRoot("gpu-box")).toBe("http://gpu-box:11434");
    expect(ollamaHostRoot(":9999")).toBe("http://127.0.0.1:9999");
    expect(ollamaHostRoot("http://10.0.0.5:11434/")).toBe("http://10.0.0.5:11434");
    expect(ollamaHostRoot("https://ollama.example.com")).toBe("https://ollama.example.com");
    expect(ollamaHostRoot("https://example.com/ollama")).toBe("https://example.com/ollama");
    expect(ollamaHostRoot("[::]:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaHostRoot("[::1]")).toBe("http://[::1]:11434");
    for (const bad of ["ftp://host", "a:b:c", "host:port", "host:123456"]) expect(ollamaHostRoot(bad)).toBeNull();
  });

  it("sets Ollama's base URL when base_url is not configured; config wins; other providers ignore it", () => {
    const fromEnv = setup({ ollama: {} }, { OLLAMA_HOST: "0.0.0.0:8080" }).provider("ollama");
    expect(fromEnv).toMatchObject({ baseUrl: "http://127.0.0.1:8080/v1", baseUrlSource: "env" });
    const fromConfig = setup({ ollama: { base_url: "http://gpu-box:11434/v1" } }, { OLLAMA_HOST: "0.0.0.0:8080" }).provider("ollama");
    expect(fromConfig).toMatchObject({ baseUrl: "http://gpu-box:11434/v1", baseUrlSource: "config" });
    expect(setup({ ollama: {} }, { OLLAMA_HOST: "not a host:x" }).provider("ollama")).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1", baseUrlSource: "registry" });
    expect(setup({}, { OLLAMA_HOST: "gpu-box" }).provider("lmstudio").baseUrl).toBe("http://localhost:1234/v1");
  });

  it("is where discovery and chat go", async () => {
    const { provider, credentials } = setup({ ollama: {} }, { OLLAMA_HOST: "gpu-box:8080" });
    const fetchFn = ollamaServer("http://gpu-box:8080");
    const listing = await listProviderModels(fetchFn, provider("ollama"), { apiKey: null, accountId: null }, listOpts);
    expect(listing.models.map((m) => m.id)).toContain("llama3.1:8b");
    expect(fetchFn.calls[0]!.url).toBe("http://gpu-box:8080/api/tags");
    const chat = fakeFetch(() => json({ model: "llama3.1:8b", choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }));
    await createProviderClient({ fetch: chat, now }).complete({ provider: provider("ollama"), credential: credentials.requestCredential("none:ollama"), model: "llama3.1:8b", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 10 }, timeoutMs: 5000 });
    expect(chat.calls[0]!.url).toBe("http://gpu-box:8080/v1/chat/completions");
  });
});

describe("new list shapes", () => {
  it("ollama_tags keeps ids exactly, reads size labels and quantization, and flags hosted models", () => {
    const page = parseModelListPage("ollama_tags", TAGS);
    expect(page.models.map((m) => m.id)).toEqual(["llama3.1:8b", "nomic-embed-text:latest", "qwen3", "gpt-oss:120b-cloud"]);
    expect(page.models[0]).toMatchObject({ providerParams: { totalB: 8, exact: false }, quantization: "Q4_K_M", contextLimitTokens: null });
    expect(page.models[3]!.notes![0]).toMatch(/hosted model served through this Ollama/);
    expect(page.excluded).toEqual([{ model: "#4", reason: "malformed list entry" }]);
    expect(() => parseModelListPage("ollama_tags", { data: [] })).toThrow(/ollama_tags/);
    expect(parseSizeLabel("567M")).toBeCloseTo(0.567);
    expect(parseSizeLabel("1.5T")).toBe(1500);
    expect(parseSizeLabel(8030261248)).toBeCloseTo(8.03);
    expect(parseSizeLabel("big")).toBeNull();
  });

  it("lmstudio_native: llm models only, loaded context as the effective one, tool training, vision", () => {
    const body = {
      models: [
        { type: "llm", publisher: "qwen", key: "qwen/qwen3-8b", display_name: "Qwen3 8B", params_string: "8B", quantization: { name: "Q4_K_M", bits_per_weight: 4 }, max_context_length: 40960, loaded_instances: [{ id: "qwen/qwen3-8b", config: { context_length: 8192 } }], capabilities: { vision: false, trained_for_tool_use: true } },
        { type: "llm", key: "google/gemma-3-12b", max_context_length: 131072, loaded_instances: [], capabilities: { vision: true, trained_for_tool_use: false } },
        { type: "embedding", key: "nomic-ai/nomic-embed-text-v1.5" },
      ],
    };
    const page = parseModelListPage("lmstudio_native", body, { id: "lmstudio", defaultContextTokens: null });
    expect(page.models[0]).toMatchObject({ id: "qwen/qwen3-8b", displayName: "Qwen3 8B", contextLimitTokens: 8192, outputLimitTokens: 8192, maxContextTokens: 40960, supportsTools: true, inputModalities: ["text"], quantization: "Q4_K_M", providerParams: { totalB: 8, exact: false } });
    // Not loaded: its load-time context is unknown unless configured.
    expect(page.models[1]).toMatchObject({ id: "google/gemma-3-12b", contextLimitTokens: null, supportsTools: false, inputModalities: ["text", "image"] });
    expect(page.models[1]!.notes![0]).toMatch(/default_context_tokens/);
    expect(page.excluded).toEqual([{ model: "nomic-ai/nomic-embed-text-v1.5", reason: "not a chat model (type embedding)" }]);
    const configured = parseModelListPage("lmstudio_native", body, { id: "lmstudio", defaultContextTokens: 16384 });
    expect(configured.models[1]).toMatchObject({ contextLimitTokens: 16384, outputLimitTokens: 16384 });
  });

  it("deepinfra_list: a bare array keyed by model_name; non-chat types and deprecated models are left out", () => {
    const page = parseModelListPage("deepinfra_list", [
      { model_name: "meta-llama/Llama-3.3-70B-Instruct", type: "text-generation", max_tokens: 131072, pricing: { input: 0.23, output: 0.4 }, quantization: "fp8" },
      { model_name: "deepseek-ai/free-thing", type: "text-generation", pricing: { input: 0, output: 0 } },
      { model_name: "BAAI/bge-m3", type: "embeddings" },
      { model_name: "old/model", type: "text-generation", deprecated: 1730000000, replaced_by: "new/model" },
      { type: "text-generation" },
    ]);
    expect(page.models[0]).toMatchObject({ id: "meta-llama/Llama-3.3-70B-Instruct", contextLimitTokens: 131072, price: "positive", quantization: "fp8" });
    expect(page.models[1]!.price).toBe("zero");
    expect(page.excluded).toEqual([
      { model: "#4", reason: "malformed list entry" },
      { model: "BAAI/bge-m3", reason: "not a chat model (type embeddings)" },
      { model: "old/model", reason: "deprecated (replaced by new/model)" },
    ]);
    expect(() => parseModelListPage("deepinfra_list", { data: [] })).toThrow(/deepinfra_list/);
  });

  it("ovh_catalog: nested capabilities give tools and modalities; unavailable and non-text models are left out", () => {
    const page = parseModelListPage("ovh_catalog", [
      { id: "Meta-Llama-3_3-70B-Instruct", name: "Llama 3.3 70B", available: true, category: "Assistant", metadata: { model_specs: { capabilities: { input_modality: ["text"], output_modality: ["text"], function_calling: true } } } },
      { id: "Qwen2.5-VL-72B-Instruct", available: true, metadata: { model_specs: { capabilities: { input_modality: ["text", "image"], output_modality: "text", function_calling: false } } } },
      { id: "retired-model", available: false },
      { id: "stable-diffusion-xl", metadata: { model_specs: { capabilities: { output_modality: ["image"] } } } },
      { id: "bge-multilingual-gemma2", category: "Embeddings" },
    ]);
    expect(page.models.map((m) => [m.id, m.displayName, m.supportsTools, m.inputModalities])).toEqual([
      ["Meta-Llama-3_3-70B-Instruct", "Llama 3.3 70B", true, ["text"]],
      ["Qwen2.5-VL-72B-Instruct", null, false, ["text", "image"]],
    ]);
    expect(page.excluded.map((e) => e.reason)).toEqual(["not available", "does not output text", "not a chat model (category Embeddings)"]);
    expect(() => parseModelListPage("ovh_catalog", { models: [] })).toThrow(/ovh_catalog/);
  });

  it("openai lists with extra fields: llama.cpp meta, Nebius supported_features, DeepSeek max_output_tokens", () => {
    const page = parseModelListPage("openai", {
      data: [
        { id: "qwen2.5-7b-instruct-q4_k_m.gguf", object: "model", owned_by: "llamacpp", meta: { n_params: 7615616512, n_ctx_train: 32768 } },
        { id: "nebius/model", context_length: 131072, supported_features: ["function_calling", "json_mode"], quantization: "fp8" },
        { id: "deepseek-flash", context_window: 1000000, max_output_tokens: 393216 },
      ],
    });
    expect(page.models[0]).toMatchObject({ providerParams: { totalB: 7.615616512, exact: true }, maxContextTokens: 32768, contextLimitTokens: null });
    expect(page.models[1]).toMatchObject({ supportsTools: true, quantization: "fp8", contextLimitTokens: 131072 });
    expect(page.models[2]).toMatchObject({ contextLimitTokens: 1000000, outputLimitTokens: 393216 });
  });
});

describe("Ollama discovery", () => {
  it("maps /api/show (and /api/ps) to the effective context, parameters, capabilities, and excludes embedding-only models", async () => {
    const { providers, credentials } = setup({ ollama: {} });
    const fetchFn = ollamaServer();
    const r = await discoverModels({ providers, credentials, config: DISCOVERY, fetch: fetchFn, now, only: ["ollama"], openRouter: openRouterCatalog([]), huggingFaceTotal: async () => null });
    expect(r.providers[0]).toMatchObject({ provider: "ollama", status: "listed", credentialRef: "none:ollama", kept: 3 });
    expect(r.providers[0]!.excluded).toContainEqual({ model: "nomic-embed-text:latest", reason: "embedding-only model" });
    const byId = new Map(r.endpoints.map((e) => [e.endpoint.id, e]));
    expect([...byId.keys()].sort()).toEqual(["ollama/gpt-oss:120b-cloud", "ollama/llama3.1:8b", "ollama/qwen3"]);

    const llama = byId.get("ollama/llama3.1:8b")!;
    // num_ctx wins over the trained maximum; the output is bounded by that context.
    expect(llama.endpoint).toMatchObject({ gatewayModelId: "llama3.1:8b", route: { kind: "direct", provider: "ollama", model: "llama3.1:8b" }, contextLimitTokens: 8192, outputLimitTokens: 8192, supportsTools: true, supportsStructuredOutput: true, inputModalities: ["text"], totalParametersB: 8, pricing: { freeVerified: true } });
    expect(llama.endpoint.params).toMatchObject({ source: "provider", confidence: "exact", confirmed: true, evidence: expect.arrayContaining([expect.objectContaining({ source: "provider" })]) });
    expect(ModelEndpointSchema.parse(JSON.parse(JSON.stringify(llama.endpoint)))).toMatchObject({ quantization: "Q4_K_M", maxContextTokens: 131072, contextDetail: expect.stringContaining("num_ctx"), params: { source: "provider" } });
    expect(llama.enriched).toMatchObject({ maxContextTokens: 131072, quantization: "Q4_K_M" });
    expect(llama.enriched.provenance.contextLimitTokens).toEqual({ source: "provider", detail: "num_ctx 8192 in the model's parameters (/api/show)" });
    expect(llama.enriched.provenance.parameters.source).toBe("provider");

    const qwen = byId.get("ollama/qwen3")!;
    // No num_ctx: the loaded context from /api/ps; num_predict bounds the output; vision from capabilities.
    expect(qwen.endpoint).toMatchObject({ contextLimitTokens: 16384, outputLimitTokens: 2048, inputModalities: ["text", "image"], supportsTools: true });
    expect(qwen.enriched.provenance.contextLimitTokens.detail).toMatch(/\/api\/ps/);
    // Only the rounded size label reports its size: a heuristic, so it stays unconfirmed.
    expect(qwen.endpoint.params).toMatchObject({ confidence: "heuristic", confirmed: false });

    const cloud = byId.get("ollama/gpt-oss:120b-cloud")!;
    // /api/show failed: tags details only, and the smallest documented server default is assumed.
    expect(cloud.endpoint.contextLimitTokens).toBe(OLLAMA_MIN_DEFAULT_CONTEXT);
    expect(cloud.endpoint.supportsTools).toBeNull();
    expect(cloud.enriched.notes.join(" ")).toMatch(/hosted model served through this Ollama.*default_context_tokens.*details unavailable/s);
    expect(r.warnings.join(" ")).toMatch(/\/api\/show failed for 1 of 4 model/);

    // A keyless local server: no request carried a key.
    expect(fetchFn.calls.every((c) => !("authorization" in c.headers))).toBe(true);
  });

  it("uses default_context_tokens when the model sets no num_ctx and is not loaded, capped by the trained maximum", async () => {
    const { provider } = setup({ ollama: { default_context_tokens: 65536 } });
    const listing = await listProviderModels(ollamaServer(), provider("ollama"), { apiKey: null, accountId: null }, listOpts);
    const cloud = listing.models.find((m) => m.id === "gpt-oss:120b-cloud")!;
    expect(cloud).toMatchObject({ contextLimitTokens: 65536, contextDetail: "providers.ollama.default_context_tokens" });
    const shows: Record<string, unknown> = { ...SHOW, "gpt-oss:120b-cloud": { capabilities: ["completion", "tools"], model_info: { "general.architecture": "gptoss", "gptoss.context_length": 32768 } } };
    const capped = fakeFetch((c) => (c.url.endsWith("/api/show") ? json(shows[String(c.body?.model)]) : c.url.endsWith("/api/tags") ? json(TAGS) : json({ models: [] })));
    clearOllamaShowCache();
    const again = await listProviderModels(capped, provider("ollama"), { apiKey: null, accountId: null }, listOpts);
    expect(again.models.find((m) => m.id === "gpt-oss:120b-cloud")).toMatchObject({ contextLimitTokens: 32768, maxContextTokens: 32768, contextDetail: "providers.ollama.default_context_tokens, capped at the model's maximum 32768" });
  });

  it("caches /api/show by digest: unchanged models are not asked again", async () => {
    const { provider } = setup({ ollama: {} });
    const p = provider("ollama");
    const first = ollamaServer();
    await listProviderModels(first, p, { apiKey: null, accountId: null }, listOpts);
    expect(first.calls.filter((c) => c.url.endsWith("/api/show")).length).toBe(4);
    const second = ollamaServer();
    await listProviderModels(second, p, { apiKey: null, accountId: null }, listOpts);
    // Only the model whose /api/show failed is asked again.
    expect(second.calls.filter((c) => c.url.endsWith("/api/show")).map((c) => c.body?.model)).toEqual(["gpt-oss:120b-cloud"]);
    const changed = { models: TAGS.models.map((m) => (m.name === "qwen3" ? { ...m, digest: "d-qwen-2" } : m)) };
    const third = ollamaServer(undefined, { tags: changed });
    await listProviderModels(third, p, { apiKey: null, accountId: null }, listOpts);
    expect(third.calls.filter((c) => c.url.endsWith("/api/show")).map((c) => c.body?.model).sort()).toEqual(["gpt-oss:120b-cloud", "qwen3"]);
  });

  it("falls back to /v1/models (ids only) when /api/tags is not served, and models_path forces the OpenAI list", async () => {
    const { provider } = setup({ ollama: {} });
    const listing = await listProviderModels(ollamaServer(undefined, { tagsStatus: 404 }), provider("ollama"), { apiKey: null, accountId: null }, listOpts);
    expect(listing.models.map((m) => m.id)).toEqual(["llama3.1:8b"]);
    expect(listing.excluded).toEqual([{ model: "nomic-embed-text:latest", reason: "not a chat model (id)" }]);
    expect(listing.warnings[0]).toMatch(/native model list failed.*http:\/\/127\.0\.0\.1:11434\/v1\/models instead, with ids only/);
    const viaPath = setup({ ollama: { models_path: "/models" } }).provider("ollama");
    expect(viaPath.models).toMatchObject({ url: "{base}/models", shape: "openai", details: null, fallbackUrl: null });
  });

  it("Ollama Cloud sends the key on /api/tags and /api/show, never assumes a local default context, and parses /api/balance", async () => {
    const { provider } = setup({ "ollama-cloud": { keys: [{ api_key: "ollama-cloud-secret", billing_class: "free_tier" }] } });
    const p = provider("ollama-cloud");
    const fetchFn = fakeFetch((c) => {
      if (c.url === "https://ollama.com/api/tags") return json({ models: [{ name: "gemma4:31b", digest: "d-g", details: { parameter_size: "31B" } }] });
      if (c.url === "https://ollama.com/api/show") return json({ error: "not found" }, 404);
      return json({ error: "no route" }, 404);
    });
    const listing = await listProviderModels(fetchFn, p, { apiKey: "ollama-cloud-secret", accountId: null }, listOpts);
    expect(listing.models[0]).toMatchObject({ id: "gemma4:31b", contextLimitTokens: null });
    expect(fetchFn.calls.map((c) => c.url)).toEqual(["https://ollama.com/api/tags", "https://ollama.com/api/show"]);
    expect(fetchFn.calls.every((c) => c.headers.authorization === "Bearer ollama-cloud-secret")).toBe(true);

    // ollama.com's /api/show (shape observed 2026-10-21): no parameters text, the context in
    // model_info. The hosted server serves the model's own context.
    clearOllamaShowCache();
    const shown = fakeFetch((c) => {
      if (c.url === "https://ollama.com/api/tags") return json({ models: [{ name: "gpt-oss:120b", digest: "d-o" }] });
      if (c.url === "https://ollama.com/api/show") return json({ capabilities: ["completion", "tools", "thinking"], details: {}, model_info: { "general.architecture": "gptoss", "general.parameter_count": 116829156672, "gptoss.context_length": 131072 } });
      return json({ error: "no route" }, 404);
    });
    const hosted = await listProviderModels(shown, p, { apiKey: "ollama-cloud-secret", accountId: null }, listOpts);
    expect(hosted.models[0]).toMatchObject({ id: "gpt-oss:120b", contextLimitTokens: 131072, outputLimitTokens: 131072, supportsTools: true });
    expect(hosted.models[0]!.contextDetail).toMatch(/model's context length 131072 .*hosted server/);

    const balance = fakeFetch(() => json({ included: { balance_usd: 0.42, allowance_usd: 1, period: { from: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" } }, purchased: { balance_usd: 5 } }));
    expect(await probeOllamaBalance({ provider: p, credential: { apiKey: "ollama-cloud-secret" }, fetch: balance, now })).toMatchObject({ includedUsd: 0.42, allowanceUsd: 1, purchasedUsd: 5, periodUntil: Date.UTC(2026, 10, 1), checkedAt: NOW });
    expect(balance.calls[0]!.url).toBe("https://ollama.com/api/balance");
    const legacy = fakeFetch(() => json({ included: { session: { remaining_percent: 80, resets_at: "2026-10-20T15:00:00Z" }, weekly: { remaining_percent: 55 } } }));
    expect(await probeOllamaBalance({ provider: p, credential: { apiKey: "k" }, fetch: legacy, now })).toMatchObject({ sessionRemainingPct: 80, weeklyRemainingPct: 55, includedUsd: null });
    expect(await probeOllamaBalance({ provider: p, credential: { apiKey: "k" }, fetch: fakeFetch(() => json({ other: 1 })), now })).toBeNull();
    // The balance is not OpenRouter's free daily quota.
    await expect(probeFreeDailyQuota({ provider: p, credential: { apiKey: "k" }, fetch: balance, now })).rejects.toThrow(/key-info endpoint/);
  });
});

describe("requests to Ollama", () => {
  it("never send tool_choice or unsupported parameters, and send no key", async () => {
    const { provider, credentials } = setup({ ollama: {} });
    const fetchFn = fakeFetch(() => json({ model: "llama3.1:8b", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
    const tool = { type: "function" as const, function: { name: "read", description: "read", parameters: { type: "object", properties: {} } } };
    const client = createProviderClient({ fetch: fetchFn, now });
    for (const choice of ["required", "auto", "none"] as const) {
      await client.complete({
        provider: provider("ollama"),
        credential: credentials.requestCredential("none:ollama"),
        model: "llama3.1:8b",
        chat: { messages: [{ role: "user", content: "x" }], max_tokens: 50, tools: [tool], tool_choice: choice },
        params: { seed: 7, logit_bias: { "1": 2 }, user: "u", logprobs: true, top_logprobs: 2 },
        timeoutMs: 5000,
      });
    }
    for (const c of fetchFn.calls) {
      expect(c.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(c.body).toMatchObject({ model: "llama3.1:8b", tools: [tool], max_tokens: 50, seed: 7 });
      for (const k of ["tool_choice", "logit_bias", "user", "logprobs", "top_logprobs", "n"]) expect(c.body).not.toHaveProperty(k);
      expect(c.headers).not.toHaveProperty("authorization");
    }
  });
});

describe("keyless local providers", () => {
  it("get one keyless credential only when configured, and keys replace it on optional-key servers", () => {
    expect(setup({}).credentials.usable("ollama")).toEqual([]);
    expect(setup({ ollama: {} }).credentials.usable("ollama").map((c) => [c.ref, c.billingClass])).toEqual([["none:ollama", "free_tier"]]);
    expect(setup({ lmstudio: {} }).credentials.usable("lmstudio").map((c) => c.ref)).toEqual(["none:lmstudio"]);
    expect(setup({ lmstudio: { keys: [{ api_key: "lm-token-1234", billing_class: "free_tier" }] } }).credentials.usable("lmstudio").map((c) => c.ref)).toEqual(["config:lmstudio:literal:0"]);
    expect(setup({ ovhcloud: {} }).credentials.usable("ovhcloud").map((c) => c.ref)).toEqual(["none:ovhcloud"]);
    expect(setup({ ollama: { enabled: false } }).credentials.usable("ollama")).toEqual([]);
    // llama.cpp has no default address.
    const noUrl = setup({ llamacpp: {} }).credentials.list("llamacpp");
    expect(noUrl.map((c) => c.unusableReason)).toEqual(["llamacpp has no base URL: set providers.llamacpp.base_url"]);
    expect(setup({ llamacpp: { base_url: "http://127.0.0.1:8080/v1" } }).credentials.usable("llamacpp").map((c) => c.ref)).toEqual(["none:llamacpp"]);
  });

  it("are usable end to end: listing and chat without an auth header; a key is sent when configured", async () => {
    const { provider, credentials } = setup({ lmstudio: {} });
    const lm = provider("lmstudio");
    const fetchFn = fakeFetch((c) => {
      if (c.url === "http://localhost:1234/api/v1/models") return json({ models: [{ type: "llm", key: "qwen/qwen3-8b", max_context_length: 40960, loaded_instances: [{ config: { context_length: 8192 } }], capabilities: { trained_for_tool_use: true } }] });
      if (c.url === "http://localhost:1234/v1/chat/completions") return json({ model: "qwen/qwen3-8b", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      return json({}, 404);
    });
    const listing = await listProviderModels(fetchFn, lm, { apiKey: null, accountId: null }, listOpts);
    expect(listing.models.map((m) => m.id)).toEqual(["qwen/qwen3-8b"]);
    const res = await createProviderClient({ fetch: fetchFn, now }).complete({ provider: lm, credential: credentials.requestCredential("none:lmstudio"), model: "qwen/qwen3-8b", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 5 }, timeoutMs: 5000 });
    expect(res.message.content).toBe("ok");
    expect(fetchFn.calls.every((c) => !("authorization" in c.headers))).toBe(true);

    const keyed = setup({ lmstudio: { keys: [{ api_key: "lm-token-1234", billing_class: "free_tier" }] } });
    const withKey = fakeFetch(() => json({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    await createProviderClient({ fetch: withKey, now }).complete({ provider: keyed.provider("lmstudio"), credential: keyed.credentials.requestCredential("config:lmstudio:literal:0"), model: "m", chat: { messages: [{ role: "user", content: "x" }], max_tokens: 5 }, timeoutMs: 5000 });
    expect(withKey.calls[0]!.headers.authorization).toBe("Bearer lm-token-1234");

    // A hosted provider still needs its key, and llama.cpp without an address is refused before any request.
    const refused = fakeFetch(() => json({}));
    await expect(createProviderClient({ fetch: refused, now }).complete({ provider: provider("deepseek"), credential: { apiKey: null }, model: "m", chat: { messages: [], max_tokens: 5 }, timeoutMs: 5000 })).rejects.toMatchObject({ reason: "auth_invalid" });
    await expect(createProviderClient({ fetch: refused, now }).complete({ provider: provider("llamacpp"), credential: { apiKey: null }, model: "m", chat: { messages: [], max_tokens: 5 }, timeoutMs: 5000 })).rejects.toMatchObject({ reason: "bad_request" });
    expect(refused.calls).toEqual([]);
  });

  it("llama.cpp: n_params and n_ctx_train from meta, the runtime context from /props", async () => {
    const { provider, credentials, providers } = setup({ llamacpp: { base_url: "http://127.0.0.1:8080/v1" } });
    const fetchFn = fakeFetch((c) => {
      if (c.url === "http://127.0.0.1:8080/v1/models") return json({ object: "list", data: [{ id: "qwen2.5-7b-instruct", object: "model", owned_by: "llamacpp", meta: { n_params: 7615616512, n_ctx_train: 32768 } }] });
      if (c.url === "http://127.0.0.1:8080/props") return json({ default_generation_settings: { n_ctx: 8192 }, model_path: "/models/qwen.gguf" });
      return json({}, 404);
    });
    const r = await discoverModels({ providers, credentials, config: DISCOVERY, fetch: fetchFn, now, only: ["llamacpp"], openRouter: openRouterCatalog([]), huggingFaceTotal: async () => null });
    expect(r.endpoints[0]!.endpoint).toMatchObject({ id: "llamacpp/qwen2.5-7b-instruct", contextLimitTokens: 8192, outputLimitTokens: 8192, totalParametersB: 7.6 });
    expect(r.endpoints[0]!.enriched).toMatchObject({ maxContextTokens: 32768 });
    expect(r.endpoints[0]!.endpoint).toMatchObject({ maxContextTokens: 32768, params: { source: "provider" } });
    expect(provider("llamacpp").baseUrlSource).toBe("config");
  });

  it("DeepInfra's public model list is read without the key", async () => {
    const { provider } = setup({ deepinfra: { keys: [{ api_key: "di-secret-5678", billing_class: "paid_credits" }] } });
    const fetchFn = fakeFetch(() => json([{ model_name: "meta-llama/Llama-3.3-70B-Instruct", type: "text-generation", max_tokens: 131072 }]));
    const listing = await listProviderModels(fetchFn, provider("deepinfra"), { apiKey: "di-secret-5678", accountId: null }, listOpts);
    expect(listing.models.map((m) => m.id)).toEqual(["meta-llama/Llama-3.3-70B-Instruct"]);
    expect(fetchFn.calls[0]!.url).toBe("https://api.deepinfra.com/models/list");
    expect(fetchFn.calls[0]!.headers).not.toHaveProperty("authorization");
  });
});
