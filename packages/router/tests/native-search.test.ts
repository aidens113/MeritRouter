import { afterEach, describe, expect, it } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { ProvidersSectionSchema } from "../src/config/schema.js";
import { createProviderClient, discoverModels, ProviderCredentials, resolveProviders, type FetchLike, type ProviderRequest } from "../src/providers/index.js";
import { detectNativeWebSearch } from "../src/providers/native-search.js";
import { insights } from "../src/index.js";
import { baseConfig, endpoint, FakeProvider, goodOutput, makeEnv, open, providerChat, providerJson, summarizeTask, type Env, type FakeProviderCall } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that records bodies and answers by URL. */
function recorder(answer: (url: string, body: Record<string, unknown>) => Response): FetchLike & { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, body });
    return answer(url, body);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function provider(id: string) {
  return resolveProviders(ProvidersSectionSchema.parse({}), {}).get(id)!;
}

const chat = { messages: [{ role: "user" as const, content: "what changed in the release notes?" }], max_tokens: 50 };
const request = (id: string, model: string, webSearch?: ProviderRequest["webSearch"]): ProviderRequest => ({
  provider: provider(id),
  credential: { apiKey: "sk-test-key-1234" },
  model,
  chat,
  timeoutMs: 5000,
  ...(webSearch ? { webSearch } : {}),
});

describe("native web search: detection with provenance", () => {
  const OR_URL = "https://openrouter.ai/api/v1/models";
  const OR_LIST = {
    data: [
      { id: "vendor/searcher", name: "Searcher", context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002", web_search: "0.004" }, supported_parameters: ["tools", "web_search_options"] },
      { id: "vendor/plain", name: "Plain", context_length: 32768, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
      { id: "perplexity/sonar", name: "Sonar", context_length: 127000, pricing: { prompt: "0.000001", completion: "0.000001", request: "0.005" }, supported_parameters: ["web_search_options"] },
      { id: "openai/gpt-4o-search-preview", name: "GPT-4o Search", context_length: 128000, pricing: { prompt: "0.0000025", completion: "0.00001", web_search: "0.035" }, supported_parameters: ["web_search_options"] },
    ],
  };

  it("marks OpenRouter models from supported_parameters, always-on models from documented facts, and Anthropic models from their capabilities", async () => {
    const fetchFn = recorder((url) =>
      url === OR_URL
        ? json(OR_LIST)
        : url.startsWith("https://api.anthropic.com/v1/models")
          ? json({
              data: [
                { id: "claude-a", display_name: "Claude A", max_input_tokens: 200000, max_tokens: 64000, capabilities: { server_tools: { web_search: { supported: true } } } },
                { id: "claude-b", display_name: "Claude B", max_input_tokens: 200000, max_tokens: 64000, capabilities: { server_tools: { web_search: { supported: false } } } },
              ],
              has_more: false,
            })
          : json({ error: { message: "not found" } }, 404),
    );
    const section = ProvidersSectionSchema.parse({ openrouter: { keys: [{ api_key_env: "OR", billing_class: "paid_credits" }] }, anthropic: { keys: [{ api_key_env: "AN", billing_class: "paid_credits" }] } });
    const providers = resolveProviders(section, {});
    const credentials = new ProviderCredentials(providers, section, null, { OR: "sk-or", AN: "sk-an" }, () => NOW);
    const r = await discoverModels({
      providers,
      credentials,
      config: { openrouter_models_url: OR_URL, huggingface_api_url: "https://huggingface.co/api/models", probe_tools: false, max_probe_requests_per_day: 0 },
      fetch: fetchFn,
      now: () => NOW,
      only: ["openrouter", "anthropic"],
    });
    const byId = new Map(r.endpoints.map((e) => [e.endpoint.id, e.endpoint.nativeWebSearch]));
    expect(byId.get("openrouter/vendor/searcher")).toMatchObject({ via: "openrouter_plugin", engine: "native", usdPerSearch: 0.004, source: "discovery", detail: expect.stringMatching(/supported_parameters includes web_search_options/) });
    expect(byId.get("openrouter/vendor/plain")).toBeNull();
    expect(byId.get("openrouter/perplexity/sonar")).toMatchObject({ via: "always_on", usdPerSearch: 0.005, source: "registry", priceDetail: expect.stringMatching(/pricing.request/) });
    expect(byId.get("openrouter/openai/gpt-4o-search-preview")).toMatchObject({ via: "always_on", usdPerSearch: 0.035, sourceUrl: expect.stringMatching(/^https:\/\/developers\.openai\.com/) });
    expect(byId.get("anthropic/claude-a")).toMatchObject({ via: "anthropic_server_tool", usdPerSearch: 0.01, source: "discovery", detail: expect.stringMatching(/server_tools\.web_search\.supported/) });
    expect(byId.get("anthropic/claude-b")).toBeNull();
    // Every record carries where it came from and when it was checked.
    for (const n of [...byId.values()].filter(Boolean)) expect(n).toMatchObject({ checkedAt: "2026-10-21", sourceUrl: expect.stringMatching(/^https:\/\//) });
  });

  it("an OpenAI search model on OpenAI's own API is always on at the documented price; other models are not guessed", () => {
    expect(detectNativeWebSearch("openai", "gpt-5-search-api", null)).toMatchObject({ via: "always_on", usdPerSearch: 0.025, source: "registry" });
    expect(detectNativeWebSearch("openai", "gpt-5", null)).toBeNull();
    expect(detectNativeWebSearch("groq", "llama-3.3-70b", { supported: true, usdPerSearch: 0, usdPerRequest: null, detail: "x" })).toBeNull();
  });
});

describe("native web search: request switches, counts, and citations per provider", () => {
  const openAiAnswer = (model: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
    json({ model, choices: [{ message: { role: "assistant", content: "Release 2 adds X.", ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, ...usage } });

  it("OpenRouter: the web plugin goes in the body; url_citation annotations and the reported count come back", async () => {
    const f = recorder(() =>
      openAiAnswer(
        "vendor/searcher",
        { annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/notes", title: "Notes", content: "Release 2 adds X", start_index: 0, end_index: 10 } }, { type: "other" }, { type: "url_citation", url_citation: { url: "javascript:alert(1)" } }] },
        { server_tool_use: { web_search_requests: 1 } },
      ),
    );
    const res = await createProviderClient({ fetch: f, now: () => NOW }).complete(request("openrouter", "vendor/searcher", { via: "openrouter_plugin", alwaysOn: false, engine: "native", maxUses: 5, maxResults: 4 }));
    expect(f.calls[0]!.body.plugins).toEqual([{ id: "web", engine: "native", max_results: 4 }]);
    // OpenRouter's own extras stay.
    expect(f.calls[0]!.body).toMatchObject({ usage: { include: true }, provider: { allow_fallbacks: false } });
    expect(res.webSearch).toEqual({ via: "openrouter_plugin", alwaysOn: false, requests: 1, requestsBasis: "provider_reported", citations: [{ url: "https://example.org/notes", title: "Notes", text: "Release 2 adds X" }] });
  });

  it("OpenAI-style web_search_options goes in the body when that is the switch; an always-on model gets no switch and one assumed search", async () => {
    const f = recorder((url, body) => openAiAnswer(String(body.model)));
    const c = createProviderClient({ fetch: f, now: () => NOW });
    await c.complete(request("openai", "some-model", { via: "openai_web_search_options", alwaysOn: false, maxUses: 5, maxResults: 5 }));
    expect(f.calls[0]!.body.web_search_options).toEqual({});
    const res = await c.complete(request("openai", "gpt-5-search-api", { via: "always_on", alwaysOn: true, maxUses: 5, maxResults: 5 }));
    expect(f.calls[1]!.body).not.toHaveProperty("web_search_options");
    expect(f.calls[1]!.body).not.toHaveProperty("plugins");
    expect(res.webSearch).toMatchObject({ via: "always_on", alwaysOn: true, requests: 1, requestsBasis: "assumed", citations: [] });
    // Without native search nothing is added or reported.
    const plain = await c.complete(request("openai", "some-model"));
    expect(f.calls[2]!.body).not.toHaveProperty("web_search_options");
    expect(plain.webSearch).toBeUndefined();
  });

  it("Anthropic: the server tool rides beside client tools; web_search_requests and web_search_result_location citations come back", async () => {
    const f = recorder(() =>
      json({
        model: "claude-a",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "release notes" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://example.org/notes", title: "Notes", encrypted_content: "xx" }] },
          { type: "text", text: "Release 2 adds X.", citations: [{ type: "web_search_result_location", url: "https://example.org/notes", title: "Notes", encrypted_index: "yy", cited_text: "Release 2 adds X" }] },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10, server_tool_use: { web_search_requests: 2 } },
      }),
    );
    const tool = { type: "function" as const, function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } } };
    const req = { ...request("anthropic", "claude-a", { via: "anthropic_server_tool", alwaysOn: false, maxUses: 3, maxResults: 5 }) };
    req.chat = { ...chat, tools: [tool] };
    const res = await createProviderClient({ fetch: f, now: () => NOW }).complete(req);
    const tools = f.calls[0]!.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
    expect(tools[1]).toMatchObject({ name: "read", cache_control: { type: "ephemeral" } });
    expect(res.message).toEqual({ content: "Release 2 adds X." });
    expect(res.webSearch).toEqual({ via: "anthropic_server_tool", alwaysOn: false, requests: 2, requestsBasis: "provider_reported", citations: [{ url: "https://example.org/notes", title: "Notes", text: "Release 2 adds X" }] });
    // Without client tools the server tool is the only one, and no tool_choice is sent.
    await createProviderClient({ fetch: f, now: () => NOW }).complete(request("anthropic", "claude-a", { via: "anthropic_server_tool", alwaysOn: false, maxUses: 3, maxResults: 5 }));
    expect(f.calls[1]!.body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
    expect(f.calls[1]!.body).not.toHaveProperty("tool_choice");
  });
});

describe("native web search: routing, paid handling, usage, and evidence", () => {
  const SEARCH = { via: "openrouter_plugin", engine: "native", usdPerSearch: 0.004, source: "discovery", detail: "OpenRouter supported_parameters includes web_search_options" };
  const priced = (model: string, extra: Record<string, unknown> = {}) =>
    endpoint({ gatewayModelId: model, pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8, freeVerified: false }, ignoreSizeFloor: true, ...extra });
  const paidCfg = (paid: Record<string, unknown> = { enabled: true, tiers: { T1: "preferred" } }, web: Record<string, unknown> = {}) =>
    baseConfig({
      providers: { openrouter: { keys: [{ label: "credits", api_key: "sk-or-paid-1234", billing_class: "paid_credits" }] } },
      paid: { budgets: { per_week_usd: 5 }, ...paid },
      ...(Object.keys(web).length ? { web } : {}),
    });
  /** An OpenRouter answer with a citation and a reported count of 2 searches. */
  const citingAnswer = (call: FakeProviderCall) =>
    providerJson({
      model: String(call.body?.model),
      choices: [
        {
          message: { role: "assistant", content: JSON.stringify(goodOutput()), annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/notes", title: "Notes", content: "the error" } }] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 500, server_tool_use: { web_search_requests: 2 } },
    });

  it("a web task turns the provider's search on, prices the reported searches into spend, and records the count and citations", async () => {
    env = makeEnv({ config: paidCfg(), endpoints: [priced("vendor/searcher", { nativeWebSearch: SEARCH })] });
    const fake = new FakeProvider((call) => (call.url.endsWith("/chat/completions") ? citingAnswer(call) : providerJson({}, 404)));
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ hints: { web: true } })]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.servedEndpoints).toEqual(["openrouter/vendor/searcher"]);
    expect(fake.chats()[0]!.body!.plugins).toEqual([{ id: "web", engine: "native", max_results: 5 }]);
    // 1000 in x $2/M + 500 out x $8/M = $0.006, plus 2 searches x $0.004.
    const spend = sy.db.prepare("SELECT actual_usd, cost_basis, reserved_usd FROM paid_spend").get() as { actual_usd: number; cost_basis: string; reserved_usd: number };
    expect(spend.actual_usd).toBeCloseTo(0.014, 6);
    expect(spend.cost_basis).toBe("computed");
    // The worst case reserved one plugin search on top of the tokens.
    expect(spend.reserved_usd).toBeGreaterThan(0.004);
    expect(r.usage.nativeWebSearches).toBe(2);
    expect(r.usage.estimatedCostUsd).toBeCloseTo(0.014, 6);
    const [row] = insights.requestLog(sy, { taskId: sub!.taskId });
    expect(row).toMatchObject({ nativeWebSearch: "openrouter_plugin", webSearchRequests: 2, webCitations: [{ url: "https://example.org/notes", title: "Notes", text: "the error" }] });
    expect(row!.routeNote).toMatch(/native web search \(openrouter_plugin\)/);
  });

  it("without hints.web the search stays off and nothing is counted", async () => {
    env = makeEnv({ config: paidCfg(), endpoints: [priced("vendor/searcher", { nativeWebSearch: SEARCH })] });
    const fake = new FakeProvider((call) => (call.url.endsWith("/chat/completions") ? providerChat(String(call.body?.model), { promptTokens: 1000, completionTokens: 500 }) : providerJson({}, 404)));
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask()]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(fake.chats()[0]!.body).not.toHaveProperty("plugins");
    expect(r.usage.nativeWebSearches).toBe(0);
    expect((sy.db.prepare("SELECT actual_usd FROM paid_spend").get() as { actual_usd: number }).actual_usd).toBeCloseTo(0.006, 6);
  });

  it("a priced native search is skipped while paid routing is off: a free model serves the web task without it, and a priced always-on model is excluded", async () => {
    const freeSearcher = endpoint({ gatewayModelId: "vendor/searcher:free", nativeWebSearch: SEARCH });
    const alwaysOn = endpoint({ gatewayModelId: "perplexity/sonar:free", nativeWebSearch: { via: "always_on", usdPerSearch: 0.005, source: "registry", detail: "always searches" } });
    env = makeEnv({ config: baseConfig(), endpoints: [freeSearcher, alwaysOn] });
    const fake = new FakeProvider();
    sy = open(env, fake, { worker: true });
    const plan = sy.router.plan("summarize", "T1", ["text"], undefined, false, undefined, [], true);
    expect(plan.candidates.map((c) => c.id)).toEqual(["openrouter/vendor/searcher:free"]);
    expect(plan.explanations.find((e) => e.endpointId === "openrouter/perplexity/sonar:free")!.reasons.join("; ")).toMatch(/paid routing is disabled .* web search on every request is priced/);
    const [sub] = await sy.submitTasks([summarizeTask({ hints: { web: true } })]);
    const r = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 })).completed[0]!;
    expect(r.servedEndpoints).toEqual(["openrouter/vendor/searcher:free"]);
    expect(fake.chats()[0]!.body).not.toHaveProperty("plugins");
    expect(sy.db.prepare("SELECT COUNT(*) AS n FROM paid_spend").get()).toEqual({ n: 0 });
    expect(r.usage.nativeWebSearches).toBe(0);
  });

  it("an always-on model is never chosen for hints.web false, goes last otherwise, and a free search is preferred for web tasks", async () => {
    const plain = endpoint({ gatewayModelId: "vendor/plain:free", totalParametersB: 100 });
    const freeSearch = endpoint({ gatewayModelId: "vendor/searcher:free", totalParametersB: 400, nativeWebSearch: { ...SEARCH, usdPerSearch: 0 } });
    const alwaysFree = endpoint({ gatewayModelId: "vendor/always:free", totalParametersB: 50, nativeWebSearch: { via: "always_on", usdPerSearch: 0, source: "override", detail: "user override" } });
    env = makeEnv({ config: baseConfig(), endpoints: [plain, freeSearch, alwaysFree] });
    sy = open(env, new FakeProvider());
    const ids = (web?: boolean) => sy!.router.plan("summarize", "T1", ["text"], undefined, false, undefined, [], web).candidates.map((c) => c.id);
    expect(ids(false)).not.toContain("openrouter/vendor/always:free");
    expect(sy.router.plan("summarize", "T1", ["text"], undefined, false, undefined, [], false).explanations.find((e) => e.endpointId === "openrouter/vendor/always:free")!.reasons.join(";")).toMatch(/must not touch the web/);
    expect(ids().at(-1)).toBe("openrouter/vendor/always:free");
    const web = ids(true);
    expect(web.indexOf("openrouter/vendor/searcher:free")).toBeLessThan(web.indexOf("openrouter/vendor/plain:free"));
    expect(ids()).toContain("openrouter/vendor/plain:free");
  });

  it("an always-on model with an unknown search price is not routed until an override states it; overrides can also remove native search", async () => {
    const unknown = priced("perplexity/sonar", { nativeWebSearch: { via: "always_on", usdPerSearch: null, source: "registry", detail: "always searches" } });
    env = makeEnv({ config: paidCfg(), endpoints: [unknown] });
    sy = open(env, new FakeProvider());
    const reasons = () => sy!.router.plan("summarize", "T1", ["text"]).explanations.find((e) => e.endpointId === "openrouter/perplexity/sonar")!.reasons.join("; ");
    expect(reasons()).toMatch(/web search price unknown/);
    sy.catalog.setOverride("openrouter/perplexity/sonar", { nativeWebSearch: { via: "always_on", usdPerSearch: 0.005 } });
    expect(reasons()).toBe("");
    expect(sy.catalog.get("openrouter/perplexity/sonar")!.nativeWebSearch).toMatchObject({ via: "always_on", usdPerSearch: 0.005, source: "override" });
    sy.catalog.setOverride("openrouter/perplexity/sonar", { nativeWebSearch: null });
    expect(sy.catalog.get("openrouter/perplexity/sonar")!.nativeWebSearch).toBeNull();
  });

  it("web.native.enabled false keeps optional search off for web tasks", async () => {
    env = makeEnv({ config: paidCfg(undefined, { native: { enabled: false } }), endpoints: [priced("vendor/searcher", { nativeWebSearch: SEARCH })] });
    const fake = new FakeProvider((call) => (call.url.endsWith("/chat/completions") ? providerChat(String(call.body?.model)) : providerJson({}, 404)));
    sy = open(env, fake, { worker: true });
    const [sub] = await sy.submitTasks([summarizeTask({ hints: { web: true } })]);
    await sy.awaitResults([sub!.taskId], { timeoutSeconds: 10 });
    expect(fake.chats()[0]!.body).not.toHaveProperty("plugins");
  });
});
