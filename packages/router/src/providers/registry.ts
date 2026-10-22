import type { ProviderEntryConfig, ProvidersConfig } from "../config/schema.js";
import type { KeyLimits } from "./vault.js";

/**
 * Built-in provider definitions. Every fact here comes from the provider research report
 * (`docs/working/direct-providers/research.md`, fetched 2026-10-19) and carries its source and
 * the date it was checked. Facts that change (rate limits, prices, model lists) are deliberately
 * absent: discovery, response headers, and the user's configuration supply them.
 */

export type ProviderApiKind = "openai_compatible" | "anthropic";
/** How the key is sent: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, or not at all. */
export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | "none";
export type TokenLimitParam = "max_tokens" | "max_completion_tokens";
/** Which rate-limit header names a provider sends (`none`: only `retry-after`, if anything). */
export type RateLimitHeaderFamily = "openai" | "openrouter" | "anthropic" | "none";
export type RateLimitPeriod = "minute" | "day" | "unknown";
/**
 * Envelope of the provider's model list, for discovery: `openai` is `{data:[{id,...}]}` (or a
 * bare array); `openrouter` adds pricing and `supported_parameters`; `google_native` is
 * `{models:[...], nextPageToken}`; `cohere` is `{models:[...]}`; `cloudflare_search` is
 * `{result:[...]}`; `anthropic` is `{data:[...], has_more}`; `ollama_tags` is Ollama's
 * `/api/tags` `{models:[{name, digest, details}]}`; `lmstudio_native` is LM Studio's
 * `/api/v1/models` `{models:[{key, type, max_context_length, ...}]}`; `deepinfra_list` is a bare
 * array of `{model_name, type, max_tokens, ...}`; `ovh_catalog` is a bare array of OVHcloud
 * catalog entries with nested `metadata`.
 */
export type ModelListShape = "openai" | "openrouter" | "google_native" | "cohere" | "cloudflare_search" | "anthropic" | "ollama_tags" | "lmstudio_native" | "deepinfra_list" | "ovh_catalog";
/**
 * A second request after listing: Ollama's `POST /api/show` per model (cached by digest; the
 * local server also reads `/api/ps` for loaded contexts) or llama.cpp's `GET /props` (runtime
 * context). See `local-servers.ts`.
 */
export type ModelDetails = "ollama_show" | "llamacpp_props";
/** Whether a provider takes a key: always, optionally (local servers with optional auth, anonymous use), or never. */
export type KeyPolicy = "required" | "optional" | "none";
/** Shape of the key-info endpoint: OpenRouter's `/key` (free daily quota) or Ollama's `/api/balance`. */
export type KeyInfoShape = "openrouter_key" | "ollama_balance";
/**
 * How a provider is asked to cache the prompt prefix: `cache_control` (Anthropic Messages API
 * breakpoints), `prompt_cache_key` (an OpenAI-style routing key per conversation), or `none`
 * (only the provider's automatic prefix caching can apply).
 */
export type PromptCacheStyle = "cache_control" | "prompt_cache_key" | "none";
/** Who a provider's quota belongs to: each key, the project a key is in, or the account. */
export type QuotaScope = "key" | "project" | "account";

/** The value sent for each SwitchYard `tool_choice`; null omits `tool_choice` from the request. */
export interface ToolChoiceMap {
  auto: string | null;
  none: string | null;
  required: string | null;
}

export interface RateLimitHeaderSpec {
  family: RateLimitHeaderFamily;
  /** Window of the request-count headers, where the provider documents it. */
  requestsPeriod: RateLimitPeriod;
  /** Window of the token-count headers, where the provider documents it. */
  tokensPeriod: RateLimitPeriod;
}

export interface ModelListSpec {
  /** URL template: `{base}` is the resolved base URL, `{account_id}` the key's account. */
  url: string;
  shape: ModelListShape;
  /** Auth for the model list when it differs from chat (Gemini's native list). */
  auth: AuthStyle | null;
  /** The list is documented as paginated. */
  paginated: boolean;
  /**
   * An OpenAI-shaped list (`{data:[{id}]}`) to read instead when the list above fails for a
   * reason other than the key (a proxy that forwards only `/v1`): ids only, metadata unknown.
   */
  fallbackUrl: string | null;
  /** A details request after listing; null when the list is all there is. */
  details: ModelDetails | null;
}

/**
 * The provider limits requests in flight rather than (or besides) per minute. The number is
 * account- or plan-specific and never assumed: `team.provider_concurrency_limits.<id>` sets it,
 * and the gate's provider slots (`gateway/capacity.ts`) enforce it across processes.
 */
export interface ConcurrencyLimit {
  scope: QuotaScope | "model";
  note: string;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  api: ProviderApiKind;
  /** Base URL, possibly a template with `{account_id}` (see `urlParams`). No trailing slash. */
  baseUrl: string;
  /** Template parameters the base URL needs from the key or provider config. */
  urlParams: ReadonlyArray<"account_id">;
  /** Path of the chat endpoint below the base URL. */
  chatPath: string;
  auth: AuthStyle;
  /**
   * `required`: every request needs a key. `optional`: keys are sent when configured; a
   * provider with an entry under `providers` and no keys gets one keyless credential (a local
   * server without auth, OVHcloud's anonymous tier). `none`: never takes a key.
   */
  keyPolicy: KeyPolicy;
  /** A server on the user's machine or network (default base URL on localhost, or none). */
  local: boolean;
  /** An environment variable that sets the server address when `base_url` is not configured. */
  baseUrlEnv: "OLLAMA_HOST" | null;
  /** Headers every request needs (beyond auth). */
  extraHeaders: Readonly<Record<string, string>>;
  /** Headers the provider documents as optional (set them in `providers.<id>.headers`). */
  optionalHeaders: readonly string[];
  models: ModelListSpec;
  /** Quota probe endpoint (OpenRouter `/key`, Ollama `/api/balance`), as a URL template; null when none is documented. */
  keyInfoUrl: string | null;
  keyInfoShape: KeyInfoShape | null;
  tokenLimitParam: TokenLimitParam;
  /** Extra request parameters the provider rejects or documents as unsupported: never sent. */
  unsupportedParams: readonly string[];
  /** Extra request parameters the provider names differently (`seed` -> `random_seed`). */
  renameParams: Readonly<Record<string, string>>;
  /** Strip `messages[].name` (Groq rejects it). */
  stripMessageName: boolean;
  toolChoice: ToolChoiceMap;
  /** Structured output may be combined with tools in one request. */
  structuredOutputWithTools: boolean;
  /** Images must be inline base64 (`data:` URLs); remote image URLs are refused locally. */
  imagesBase64Only: boolean;
  /** Highest documented temperature; larger values are clamped. Null: no documented cap. */
  temperatureMax: number | null;
  /** Fields always added to the request body. */
  bodyExtras: Readonly<Record<string, unknown>>;
  /** The documented way to ask for prompt caching (see `PromptCacheStyle`). */
  promptCache: PromptCacheStyle;
  rateLimitHeaders: RateLimitHeaderSpec;
  quotaScope: QuotaScope;
  /** Documented concurrency limiting (DeepSeek, DeepInfra, Ollama Cloud plans); null when none is documented. */
  concurrency: ConcurrencyLimit | null;
  /**
   * Ids of the models documented as free (case-insensitive) when free is decided per model and
   * the list states no prices (Z.ai's Flash models). A free_tier key then reaches only these.
   */
  freeModelIds: readonly string[] | null;
  /** Documented behaviour worth knowing that the fields above do not express. */
  quirks: readonly string[];
  sourceUrl: string;
  checkedAt: string;
}

const RESEARCH = "docs/working/direct-providers/research.md";
const CHECKED = "2026-10-19";
/** Providers added from the coverage research (`research-coverage.md`, fetched 2026-10-20). */
const COVERAGE_CHECKED = "2026-10-20";
const PASS_THROUGH: ToolChoiceMap = { auto: "auto", none: "none", required: "required" };
const OMIT_TOOL_CHOICE: ToolChoiceMap = { auto: null, none: null, required: null };
/** Only `auto` is documented or verified: `none` and `required` are omitted (the harness re-prompts a reply without a tool call). */
const AUTO_ONLY: ToolChoiceMap = { auto: "auto", none: null, required: null };
const NO_HEADERS: RateLimitHeaderSpec = { family: "none", requestsPeriod: "unknown", tokensPeriod: "unknown" };
const listSpec = (url: string, shape: ModelListShape, more: Partial<Omit<ModelListSpec, "url" | "shape">> = {}): ModelListSpec => ({ url, shape, auth: null, paginated: false, fallbackUrl: null, details: null, ...more });
const openAiList = (paginated = false): ModelListSpec => listSpec("{base}/models", "openai", { paginated });
/** Parameters Ollama's OpenAI path does not support (`tool_choice` is handled by `toolChoice`; `n` is never sent). */
const OLLAMA_UNSUPPORTED = ["logit_bias", "user", "logprobs", "top_logprobs"];

/** Defaults for an OpenAI-compatible provider; each definition overrides what differs. */
function openAiCompatible(def: Pick<ProviderDefinition, "id" | "displayName" | "baseUrl" | "sourceUrl"> & Partial<ProviderDefinition>): ProviderDefinition {
  return {
    api: "openai_compatible",
    urlParams: [],
    chatPath: "/chat/completions",
    auth: "bearer",
    keyPolicy: "required",
    local: false,
    baseUrlEnv: null,
    extraHeaders: {},
    optionalHeaders: [],
    models: openAiList(),
    keyInfoUrl: null,
    keyInfoShape: null,
    tokenLimitParam: "max_tokens",
    unsupportedParams: [],
    renameParams: {},
    stripMessageName: false,
    toolChoice: PASS_THROUGH,
    structuredOutputWithTools: true,
    imagesBase64Only: false,
    temperatureMax: null,
    bodyExtras: {},
    promptCache: "none",
    rateLimitHeaders: NO_HEADERS,
    quotaScope: "key",
    concurrency: null,
    freeModelIds: null,
    quirks: [],
    checkedAt: CHECKED,
    ...def,
  };
}

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  openAiCompatible({
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    tokenLimitParam: "max_completion_tokens",
    unsupportedParams: ["logprobs", "logit_bias", "top_logprobs"],
    stripMessageName: true,
    structuredOutputWithTools: false,
    rateLimitHeaders: { family: "openai", requestsPeriod: "day", tokensPeriod: "minute" },
    quirks: ["x-ratelimit-*-requests headers count per day; x-ratelimit-*-tokens per minute", "n must be 1", "structured output is not combined with tools or streaming; strict only on some models", "model list reports context_window and max_completion_tokens, no pricing"],
    sourceUrl: "https://console.groq.com/docs/openai",
  }),
  openAiCompatible({
    id: "google",
    displayName: "Google AI Studio (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: listSpec("https://generativelanguage.googleapis.com/v1beta/models", "google_native", { auth: "x-goog-api-key", paginated: true }),
    // Only "auto" is documented on the compat endpoint; required/named/none are unverified.
    toolChoice: { auto: "auto", none: null, required: null },
    quotaScope: "project",
    quirks: ["OpenAI-compatible endpoint is beta", "rate limits are per project, not per key; RPD resets at midnight Pacific", "429 RESOURCE_EXHAUSTED; no rate-limit headers documented", "free-tier content may be used to improve Google products"],
    sourceUrl: "https://ai.google.dev/gemini-api/docs/openai",
  }),
  openAiCompatible({
    id: "nvidia",
    displayName: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    temperatureMax: 1,
    quirks: ["keys start with nvapi-", "tools and parameter ranges vary per model", "rate limits not documented"],
    sourceUrl: "https://docs.api.nvidia.com/nim/reference/llm-apis",
  }),
  openAiCompatible({
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    optionalHeaders: ["HTTP-Referer", "X-OpenRouter-Title"],
    models: listSpec("{base}/models", "openrouter"),
    keyInfoUrl: "{base}/key",
    keyInfoShape: "openrouter_key",
    // Report the billed cost and never fall back to another (possibly pricier) model.
    bodyExtras: { usage: { include: true }, provider: { allow_fallbacks: false } },
    // OpenRouter takes prompt_cache_key as its sticky routing key (openrouter.ai/docs/features/prompt-caching, 2026-10-21).
    promptCache: "prompt_cache_key",
    rateLimitHeaders: { family: "openrouter", requestsPeriod: "unknown", tokensPeriod: "unknown" },
    quirks: ["unsupported parameters are silently ignored: gate on the model's supported_parameters", "HTTP 200 may carry an error body", "402 means out of credits (limit_source)", "free models are :free or $0; free daily quota via GET /key"],
    sourceUrl: "https://openrouter.ai/docs/api/api-reference/models/get-models",
  }),
  openAiCompatible({
    id: "mistral",
    displayName: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    renameParams: { seed: "random_seed" },
    toolChoice: { auto: "auto", none: "none", required: "any" },
    quirks: ["strict tool-message ordering", "429 with Retry-After; no x-ratelimit headers", "model list reports capabilities, max_context_length, aliases, archived"],
    sourceUrl: "https://docs.mistral.ai/api/",
  }),
  openAiCompatible({
    id: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    tokenLimitParam: "max_completion_tokens",
    structuredOutputWithTools: false,
    imagesBase64Only: true,
    quirks: ["no permanent free tier: trial credits after adding a payment method", "n must be 1", "never send both max_tokens and max_completion_tokens", "rate-limit header names unverified"],
    sourceUrl: `${RESEARCH}#cerebras`,
  }),
  openAiCompatible({
    id: "cohere",
    displayName: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    models: listSpec("https://api.cohere.com/v1/models?endpoint=chat", "cohere"),
    unsupportedParams: ["logit_bias", "n", "parallel_tool_calls"],
    // tool_choice is not listed for the compatibility API.
    toolChoice: OMIT_TOOL_CHOICE,
    quirks: ["trial keys are free with a monthly call cap", "no rate-limit headers"],
    sourceUrl: "https://docs.cohere.com/docs/compatibility-api",
  }),
  openAiCompatible({
    id: "cloudflare",
    displayName: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    urlParams: ["account_id"],
    models: listSpec("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search", "cloudflare_search"),
    // Tools on the OpenAI-compatible path are unverified.
    toolChoice: OMIT_TOOL_CHOICE,
    quotaScope: "account",
    quirks: ["model ids are @cf/...", "free daily Neurons allowance resets 00:00 UTC", "JSON mode on a short model list, not with streaming", "no rate-limit headers"],
    sourceUrl: `${RESEARCH}#cloudflare-workers-ai`,
  }),
  openAiCompatible({
    id: "sambanova",
    displayName: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai/v1",
    unsupportedParams: ["logit_bias"],
    rateLimitHeaders: { family: "openai", requestsPeriod: "minute", tokensPeriod: "unknown" },
    quirks: ["per-day limits arrive as x-ratelimit-*-requests-day", "penalties are ignored"],
    sourceUrl: `${RESEARCH}#sambanova-cloud`,
  }),
  openAiCompatible({
    id: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.ai/v1",
    quirks: ["no documented free tier", "rate-limit header names unverified"],
    sourceUrl: `${RESEARCH}#together-ai`,
  }),
  openAiCompatible({
    id: "huggingface",
    displayName: "Hugging Face Inference Providers",
    baseUrl: "https://router.huggingface.co/v1",
    quirks: ["chat only", "model ids are org/model[:policy|:provider]", "free users get no monthly credits"],
    sourceUrl: `${RESEARCH}#hugging-face-inference-providers`,
  }),
  {
    ...openAiCompatible({ id: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com/v1", sourceUrl: `${RESEARCH}#anthropic-paid` }),
    api: "anthropic",
    chatPath: "/messages",
    auth: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
    models: listSpec("{base}/models", "anthropic"),
    toolChoice: { auto: "auto", none: "none", required: "any" },
    promptCache: "cache_control",
    rateLimitHeaders: { family: "anthropic", requestsPeriod: "unknown", tokensPeriod: "unknown" },
    quirks: ["no free tier", "spend-cap 429 (enforced_spend_limit_reached) has no retry-after and is not retried", "OpenAI compatibility is not production-ready; the native Messages API is used"],
  },
  openAiCompatible({
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    tokenLimitParam: "max_completion_tokens",
    // Chat Completions takes prompt_cache_key (openai-node ChatCompletionCreateParamsBase, 2026-10-21).
    promptCache: "prompt_cache_key",
    rateLimitHeaders: { family: "openai", requestsPeriod: "unknown", tokensPeriod: "unknown" },
    quirks: ["model list reports ids only", "Retry-After on 429 and 503"],
    sourceUrl: `${RESEARCH}#openai-paid`,
  }),

  // ---- local servers (research-coverage.md section 1) ----
  openAiCompatible({
    id: "ollama",
    displayName: "Ollama (local)",
    // The documented default bind; OLLAMA_HOST overrides it when base_url is not configured.
    baseUrl: "http://127.0.0.1:11434/v1",
    auth: "none",
    keyPolicy: "none",
    local: true,
    baseUrlEnv: "OLLAMA_HOST",
    // Chat on the OpenAI path; metadata from the native API (`{root}` is the base without /v1).
    models: listSpec("{root}/api/tags", "ollama_tags", { fallbackUrl: "{base}/models", details: "ollama_show" }),
    unsupportedParams: OLLAMA_UNSUPPORTED,
    // tool_choice is unsupported: never sent; the harness re-prompts a reply without a tool call.
    toolChoice: OMIT_TOOL_CHOICE,
    // response_format beside tools is undocumented; JSON is validated locally anyway.
    structuredOutputWithTools: false,
    quirks: [
      "the local API needs no key; a reverse proxy that needs one takes providers.ollama.headers",
      "tool_choice is unsupported",
      "model ids are name[:tag] exactly as /api/tags lists them (llama3.1 and llama3.1:70b are different models)",
      "context is num_ctx from the model's parameters, else the server default (4k/32k/256k by VRAM, or OLLAMA_CONTEXT_LENGTH): set default_context_tokens to the server's value",
      "404 means the model is not pulled (ollama pull <name>); 503 means the queue is full (OLLAMA_MAX_QUEUE)",
      "no rate-limit headers",
    ],
    sourceUrl: "https://docs.ollama.com/api/openai-compatibility.md",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "lmstudio",
    displayName: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    // Tokens are off by default; when enabled in Developer > Server Settings they are Bearer keys.
    keyPolicy: "optional",
    local: true,
    models: listSpec("{root}/api/v1/models", "lmstudio_native", { fallbackUrl: "{base}/models" }),
    // tool_choice values are unverified: only auto is sent.
    toolChoice: AUTO_ONLY,
    structuredOutputWithTools: false,
    quirks: [
      "API tokens are optional: add the token as a key once they are enabled",
      "models without a native tool template get a default tool-call format (trained_for_tool_use false)",
      "context is the loaded instance's context_length; an unloaded model's load-time context is unknown (set default_context_tokens)",
      "no rate-limit headers",
    ],
    sourceUrl: "https://lmstudio.ai/docs/developer/rest/list",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "llamacpp",
    displayName: "llama.cpp server",
    // No default: the README says port 9931, older releases and most guides 8080. Set base_url.
    baseUrl: "",
    keyPolicy: "optional",
    local: true,
    models: listSpec("{base}/models", "openai", { details: "llamacpp_props" }),
    toolChoice: AUTO_ONLY,
    structuredOutputWithTools: false,
    quirks: [
      "set base_url: the default port differs between releases (9931 in the current README, 8080 before)",
      "--api-key makes the server require a Bearer key",
      "tool calls need the Jinja template engine (--jinja, on by default now); parallel tool calls are off by default",
      "the model list's meta reports n_params and n_ctx_train; the runtime context comes from /props",
    ],
    sourceUrl: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md",
    checkedAt: COVERAGE_CHECKED,
  }),

  // ---- hosted providers (research-coverage.md sections 2 and 3) ----
  openAiCompatible({
    id: "ollama-cloud",
    displayName: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    models: listSpec("{root}/api/tags", "ollama_tags", { details: "ollama_show" }),
    keyInfoUrl: "{root}/api/balance",
    keyInfoShape: "ollama_balance",
    unsupportedParams: OLLAMA_UNSUPPORTED,
    toolChoice: OMIT_TOOL_CHOICE,
    structuredOutputWithTools: false,
    quotaScope: "account",
    concurrency: { scope: "account", note: "plans limit concurrent requests (the free plan documents 1 as of 2026-10-20)" },
    quirks: [
      "free plan: starter usage credits and starter models, reset monthly from signup",
      "use the exact model name /api/tags returns (the -cloud suffix is only for the local app)",
      "whether /api/show works on ollama.com is unverified: discovery tries it and keeps the /api/tags details when it fails",
      "429 = rate limit; 502 = cloud model unreachable; no rate-limit headers",
    ],
    sourceUrl: "https://docs.ollama.com/cloud.md",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    unsupportedParams: ["frequency_penalty", "presence_penalty"],
    quotaScope: "account",
    concurrency: { scope: "account", note: "limits are concurrent requests per account; 429 when exceeded" },
    quirks: [
      "tool_choice required and named return 400 in thinking mode",
      "response_format json_object also needs JSON asked for in the prompt",
      "a request may wait up to 10 minutes, with keep-alive blank lines before the body",
      "temperature has no effect in thinking mode; off-peak prices are half",
      "no rate-limit headers",
    ],
    sourceUrl: "https://api-docs.deepseek.com/api/create-chat-completion",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    // tool_choice details are unverified: only auto is sent.
    toolChoice: AUTO_ONLY,
    // Otherwise max_tokens is silently reduced to fit the context; make it an error instead.
    bodyExtras: { context_length_exceeded_behavior: "error" },
    quotaScope: "account",
    quirks: ["10 RPM without a payment method or credits; up to 6,000 RPM with one", "rate-limit header names unverified", "model list fields beyond id unverified"],
    sourceUrl: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "deepinfra",
    displayName: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    // The public model list needs no key.
    models: listSpec("https://api.deepinfra.com/models/list", "deepinfra_list", { auth: "none" }),
    quotaScope: "account",
    concurrency: { scope: "model", note: "a documented number of concurrent requests per model (200 as of 2026-10-20); occasional 429 while autoscaling" },
    quirks: ["output is capped at 16,384 tokens for most models", "\"may not be 100% compatible\" with OpenAI", "rate-limit header names unverified"],
    sourceUrl: "https://docs.deepinfra.com/chat/overview",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "nebius",
    displayName: "Nebius Token Factory",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    models: listSpec("{base}/models?verbose=true", "openai"),
    // Only auto and a named function are documented.
    toolChoice: AUTO_ONLY,
    rateLimitHeaders: { family: "openai", requestsPeriod: "minute", tokensPeriod: "minute" },
    quirks: ["trial credit for new accounts", "limits scale in 15-minute windows (x-ratelimit-dynamic-*, x-ratelimit-over-limit)", "max_tokens naming unverified"],
    sourceUrl: "https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "scaleway",
    displayName: "Scaleway Generative APIs",
    baseUrl: "https://api.scaleway.ai/v1",
    unsupportedParams: ["user"],
    // tool_choice values are unverified: only auto is sent.
    toolChoice: AUTO_ONLY,
    // Unverified; the broader scope keeps configured limits shared.
    quotaScope: "project",
    quirks: ["the key is an IAM secret key (Bearer)", "first 1,000,000 tokens free", "only function tools; audio, modalities, stream_options, user unsupported", "rate limits and headers unverified"],
    sourceUrl: "https://www.scaleway.com/en/developers/api/generative-apis",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "ovhcloud",
    displayName: "OVHcloud AI Endpoints",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    // Anonymous use is documented (per IP and model); a key raises the limit.
    keyPolicy: "optional",
    models: listSpec("https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2", "ovh_catalog", { auth: "none" }),
    toolChoice: AUTO_ONLY,
    quotaScope: "project",
    quirks: [
      "without a key: 2 requests per minute per IP per model; with a key: 400 per minute per project per model (as of 2026-10-20)",
      "the public catalog reports function_calling, modalities, and pricing; which catalog field is the request model id is unverified (id is used)",
    ],
    sourceUrl: "https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-catalog-api",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "zai",
    displayName: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    toolChoice: AUTO_ONLY,
    temperatureMax: 1,
    // Documented free models (https://docs.z.ai/guides/overview/pricing, 2026-10-20); the list states no prices.
    freeModelIds: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.6v-flash"],
    quirks: ["tool_choice: only auto", "temperature range 0 to 1", "thinking:{type} controls reasoning", "whether a model list endpoint exists is unverified"],
    sourceUrl: "https://docs.z.ai/api-reference/llm/chat-completion",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "moonshot",
    displayName: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    tokenLimitParam: "max_completion_tokens",
    quirks: ["platform.moonshot.ai redirects to platform.kimi.ai", "max_tokens is deprecated for max_completion_tokens", "free tier, model list, and rate-limit headers unverified"],
    sourceUrl: "https://platform.kimi.ai/docs/api/chat",
    checkedAt: COVERAGE_CHECKED,
  }),
  openAiCompatible({
    id: "vercel",
    displayName: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    quotaScope: "account",
    quirks: ["monthly free credit; the free tier reaches a model subset with lower per-model limits", "402 quota_for_entity_exceeded means the budget is spent (not retried)", "retry-after is sometimes sent", "model list reports id and owned_by only"],
    sourceUrl: "https://vercel.com/docs/ai-gateway/openai-compat",
    checkedAt: COVERAGE_CHECKED,
  }),
];

export const BUILTIN_PROVIDER_IDS: readonly string[] = BUILTIN_PROVIDERS.map((p) => p.id);

export function builtinProvider(id: string): ProviderDefinition | null {
  return BUILTIN_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** A provider as configured: a built-in with config overrides applied, or a custom one. */
export interface ResolvedProvider extends ProviderDefinition {
  builtIn: boolean;
  enabled: boolean;
  /** No key is sent (a local server); one keyless credential stands in for keys. */
  noKey: boolean;
  /** Provider-level account id (Cloudflare); a key's own account id wins. */
  accountId: string | null;
  quotaGroup: string | null;
  /** Provider-level configured limits; null where unset. */
  limits: KeyLimits;
  /**
   * The context a local server gives a model that sets none (`providers.<id>.default_context_tokens`):
   * Ollama's server default, an LM Studio or llama.cpp load-time context. Null when not configured.
   */
  defaultContextTokens: number | null;
  /** Where the base URL came from: the registry, `providers.<id>.base_url`, or an environment variable (`OLLAMA_HOST`). */
  baseUrlSource: "registry" | "config" | "env";
}

/** Limits with nothing configured. */
export const emptyKeyLimits = (): KeyLimits => ({ rpm: null, rpd: null, tpm: null, tpd: null });
const trimSlash = (u: string) => u.replace(/\/+$/, "");

function customDefinition(id: string, entry: ProviderEntryConfig): ProviderDefinition {
  const anthropic = entry.api === "anthropic";
  return {
    ...openAiCompatible({ id, displayName: entry.display_name ?? id, baseUrl: trimSlash(entry.base_url!), sourceUrl: "config" }),
    ...(anthropic
      ? { api: "anthropic" as const, chatPath: "/messages", auth: "x-api-key" as const, extraHeaders: { "anthropic-version": "2023-06-01" }, toolChoice: { auto: "auto", none: "none", required: "any" } }
      : {}),
    checkedAt: "config",
    quirks: ["custom provider from configuration"],
  };
}

const ORIGIN = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Move an absolute registry URL template (one not under `{base}`, such as Google's native model
 * list or Cloudflare's model search) along with a `base_url` override. When the override ends in
 * the default base URL's path (a proxy or gateway in front of the same API), what precedes that
 * path becomes the new root and the template's own path and query follow it; a template
 * parameter the override fills with a literal (an account id) is filled the same way. Otherwise
 * the template's path goes on the override's origin. `models_path` sets the list path exactly.
 */
export function rebaseUrl(template: string, defaultBase: string, override: string): string {
  if (template.startsWith("{base}") || template.startsWith("{root}")) return template;
  const t = ORIGIN.exec(template);
  const d = ORIGIN.exec(defaultBase);
  const o = ORIGIN.exec(override);
  if (!t || !d || !o) return template;
  const names: string[] = [];
  const pattern = d[2]!
    .split(/(\{[a-z_]+\})/)
    .map((part) => {
      const param = /^\{([a-z_]+)\}$/.exec(part);
      if (!param) return escapeRegExp(part);
      names.push(param[1]!);
      return "([^/?#]+)";
    })
    .join("");
  const match = new RegExp(`^(.*?)${pattern}$`).exec(o[2]!);
  if (!match) return `${o[1]}${t[2]}`;
  let rest = t[2]!;
  names.forEach((name, i) => {
    const value = match[i + 2]!;
    if (value !== `{${name}}`) rest = rest.split(`{${name}}`).join(value);
  });
  return `${o[1]}${match[1]}${rest}`;
}

/**
 * The server root `OLLAMA_HOST` names, for a client: `host`, `host:port`, `:port`, or a URL
 * (`http://host:port/path`). Without a scheme the port defaults to 11434; with one, to the
 * scheme's own port. A bind-all address (`0.0.0.0`, `[::]`, empty) becomes `127.0.0.1`. Null for
 * an unset or malformed value. Forms beyond the FAQ's `host:port` follow Ollama's client, which
 * the research did not verify.
 */
export function ollamaHostRoot(value: string | undefined): string | null {
  const s = value?.trim();
  if (!s) return null;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)(\/[^?#]*)?$/i.exec(s);
  if (!m) return null;
  const scheme = (m[1] ?? "http").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const hostport = m[2]!;
  let host: string;
  let port: string | undefined;
  const v6 = /^\[([0-9a-f:.]*)\](?::(\d*))?$/i.exec(hostport);
  if (v6) {
    host = `[${v6[1]}]`;
    port = v6[2];
  } else {
    const parts = hostport.split(":");
    if (parts.length > 2) return null;
    host = parts[0]!;
    port = parts[1];
  }
  if (port !== undefined && port !== "" && !/^\d{1,5}$/.test(port)) return null;
  if (host === "" || host === "0.0.0.0" || host === "[::]") host = "127.0.0.1";
  const p = port ? port : m[1] ? "" : "11434";
  const root = `${scheme}://${host}${p ? `:${p}` : ""}${trimSlash(m[3] ?? "")}`;
  try {
    new URL(root);
  } catch {
    return null;
  }
  return root;
}

/** The server root of an OpenAI-style base URL: the base without a trailing `/v1` (`{root}` in URL templates). */
export const rootUrl = (baseUrl: string): string => baseUrl.replace(/\/v1$/i, "");

/** Native list shapes that a `models_path` (an OpenAI-style list) replaces. */
const NATIVE_SHAPES: ReadonlySet<ModelListShape> = new Set(["ollama_tags", "lmstudio_native"]);

function applyEntry(def: ProviderDefinition, entry: ProviderEntryConfig | undefined, builtIn: boolean, env: Readonly<Record<string, string | undefined>> = {}): ResolvedProvider {
  const noKey = (entry?.no_key ?? false) || def.keyPolicy === "none";
  const auth: AuthStyle = noKey ? "none" : def.auth;
  const fromEnv = !entry?.base_url && def.baseUrlEnv ? ollamaHostRoot(env[def.baseUrlEnv]) : null;
  const baseUrl = entry?.base_url ? trimSlash(entry.base_url) : fromEnv ? `${fromEnv}/v1` : def.baseUrl;
  // An override moves every request, including the registry's absolute (non-`{base}`) URLs.
  const moved = (url: string) => (entry?.base_url && def.baseUrl ? rebaseUrl(url, def.baseUrl, baseUrl) : url);
  // models_path names an OpenAI-style list exactly: a native list shape and its details step no longer apply.
  const modelsPath = entry?.models_path ? `{base}${entry.models_path.startsWith("/") ? "" : "/"}${entry.models_path}` : null;
  const models: ModelListSpec = modelsPath
    ? { ...def.models, url: modelsPath, ...(NATIVE_SHAPES.has(def.models.shape) ? { shape: "openai" as const, details: null, fallbackUrl: null } : {}) }
    : { ...def.models, url: moved(def.models.url), fallbackUrl: def.models.fallbackUrl === null ? null : moved(def.models.fallbackUrl) };
  return {
    ...def,
    displayName: entry?.display_name ?? def.displayName,
    baseUrl,
    auth,
    extraHeaders: { ...def.extraHeaders, ...(entry?.headers ?? {}) },
    models,
    keyInfoUrl: def.keyInfoUrl === null ? null : moved(def.keyInfoUrl),
    tokenLimitParam: entry?.token_limit_param ?? def.tokenLimitParam,
    rateLimitHeaders: entry?.rate_limit_headers ? { family: entry.rate_limit_headers, requestsPeriod: "unknown", tokensPeriod: "unknown" } : def.rateLimitHeaders,
    promptCache: entry?.prompt_cache ?? def.promptCache,
    builtIn,
    enabled: entry?.enabled ?? true,
    noKey,
    accountId: entry?.account_id ?? null,
    quotaGroup: entry?.quota_group ?? null,
    limits: { rpm: entry?.rpm ?? null, rpd: entry?.rpd ?? null, tpm: entry?.tpm ?? null, tpd: entry?.tpd ?? null },
    defaultContextTokens: entry?.default_context_tokens ?? null,
    baseUrlSource: entry?.base_url ? "config" : fromEnv ? "env" : "registry",
  };
}

/**
 * Every built-in (with any config overrides) plus every custom provider from config. `env`
 * supplies a local server's address variable (`OLLAMA_HOST`) when its `base_url` is not set.
 */
export function resolveProviders(section?: Pick<ProvidersConfig, "byId">, env: Readonly<Record<string, string | undefined>> = process.env): Map<string, ResolvedProvider> {
  const out = new Map<string, ResolvedProvider>();
  const entries = section?.byId ?? {};
  for (const def of BUILTIN_PROVIDERS) out.set(def.id, applyEntry(def, entries[def.id], true, env));
  for (const [id, entry] of Object.entries(entries)) {
    if (out.has(id)) continue;
    // The config schema guarantees custom providers carry base_url.
    out.set(id, applyEntry(customDefinition(id, entry), entry, false));
  }
  return out;
}

/** A custom provider from one config entry (which must carry base_url). */
export function customProvider(id: string, entry: ProviderEntryConfig): ResolvedProvider {
  if (!entry.base_url) throw new Error(`custom provider ${id} needs base_url`);
  return applyEntry(customDefinition(id, entry), entry, false);
}

/** A provider with no config at all (built-in defaults). */
export function defaultProvider(id: string): ResolvedProvider | null {
  const def = builtinProvider(id);
  return def ? applyEntry(def, undefined, true) : null;
}

/**
 * Expand a URL template: `{base}` becomes the provider's base URL, `{root}` the base without a
 * trailing `/v1` (a local server's native API), and `{account_id}` the account id. Throws when a
 * needed account id or the base URL is missing.
 */
export function expandUrl(template: string, provider: Pick<ProviderDefinition, "id" | "baseUrl">, accountId: string | null): string {
  if (!provider.baseUrl && /\{(base|root)\}/.test(template)) throw new Error(`provider ${provider.id} has no base URL: set providers.${provider.id}.base_url`);
  const fill = (t: string): string =>
    t.replace(/\{account_id\}/g, () => {
      if (!accountId) throw new Error(`provider ${provider.id} needs an account id (set account_id on the key or provider)`);
      return encodeURIComponent(accountId);
    });
  return fill(template.replace(/\{base\}/g, () => provider.baseUrl).replace(/\{root\}/g, () => rootUrl(provider.baseUrl)));
}

/** The chat endpoint URL for a provider and the key's account. */
export function chatUrl(provider: Pick<ProviderDefinition, "id" | "baseUrl" | "chatPath">, accountId: string | null): string {
  return expandUrl(`{base}${provider.chatPath}`, provider, accountId);
}

/** Auth plus the provider's required and configured headers. Never logged. */
export function requestHeaders(provider: Pick<ProviderDefinition, "auth" | "extraHeaders"> & { keyPolicy?: KeyPolicy }, apiKey: string | null, auth: AuthStyle = provider.auth): Record<string, string> {
  const h: Record<string, string> = { ...provider.extraHeaders };
  if (auth !== "none" && apiKey === null) {
    // Optional keys (a local server without auth, an anonymous tier): no key, no auth header.
    if (provider.keyPolicy === "optional") return h;
    throw new Error("this provider needs an API key");
  }
  if (auth === "bearer") h.authorization = `Bearer ${apiKey}`;
  else if (auth === "x-api-key") h["x-api-key"] = apiKey!;
  else if (auth === "x-goog-api-key") h["x-goog-api-key"] = apiKey!;
  return h;
}
