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
 * `{result:[...]}`; `anthropic` is `{data:[...], has_more}`.
 */
export type ModelListShape = "openai" | "openrouter" | "google_native" | "cohere" | "cloudflare_search" | "anthropic";
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
  /** Headers every request needs (beyond auth). */
  extraHeaders: Readonly<Record<string, string>>;
  /** Headers the provider documents as optional (set them in `providers.<id>.headers`). */
  optionalHeaders: readonly string[];
  models: ModelListSpec;
  /** Quota probe endpoint (OpenRouter `/key`), as a URL template; null when none is documented. */
  keyInfoUrl: string | null;
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
  rateLimitHeaders: RateLimitHeaderSpec;
  quotaScope: QuotaScope;
  /** Documented behaviour worth knowing that the fields above do not express. */
  quirks: readonly string[];
  sourceUrl: string;
  checkedAt: string;
}

const RESEARCH = "docs/working/direct-providers/research.md";
const CHECKED = "2026-10-19";
const PASS_THROUGH: ToolChoiceMap = { auto: "auto", none: "none", required: "required" };
const OMIT_TOOL_CHOICE: ToolChoiceMap = { auto: null, none: null, required: null };
const NO_HEADERS: RateLimitHeaderSpec = { family: "none", requestsPeriod: "unknown", tokensPeriod: "unknown" };
const openAiList = (paginated = false): ModelListSpec => ({ url: "{base}/models", shape: "openai", auth: null, paginated });

/** Defaults for an OpenAI-compatible provider; each definition overrides what differs. */
function openAiCompatible(def: Pick<ProviderDefinition, "id" | "displayName" | "baseUrl" | "sourceUrl"> & Partial<ProviderDefinition>): ProviderDefinition {
  return {
    api: "openai_compatible",
    urlParams: [],
    chatPath: "/chat/completions",
    auth: "bearer",
    extraHeaders: {},
    optionalHeaders: [],
    models: openAiList(),
    keyInfoUrl: null,
    tokenLimitParam: "max_tokens",
    unsupportedParams: [],
    renameParams: {},
    stripMessageName: false,
    toolChoice: PASS_THROUGH,
    structuredOutputWithTools: true,
    imagesBase64Only: false,
    temperatureMax: null,
    bodyExtras: {},
    rateLimitHeaders: NO_HEADERS,
    quotaScope: "key",
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
    models: { url: "https://generativelanguage.googleapis.com/v1beta/models", shape: "google_native", auth: "x-goog-api-key", paginated: true },
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
    models: { url: "{base}/models", shape: "openrouter", auth: null, paginated: false },
    keyInfoUrl: "{base}/key",
    // Report the billed cost and never fall back to another (possibly pricier) model.
    bodyExtras: { usage: { include: true }, provider: { allow_fallbacks: false } },
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
    models: { url: "https://api.cohere.com/v1/models?endpoint=chat", shape: "cohere", auth: null, paginated: false },
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
    models: { url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search", shape: "cloudflare_search", auth: null, paginated: false },
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
    models: { url: "{base}/models", shape: "anthropic", auth: null, paginated: false },
    toolChoice: { auto: "auto", none: "none", required: "any" },
    rateLimitHeaders: { family: "anthropic", requestsPeriod: "unknown", tokensPeriod: "unknown" },
    quirks: ["no free tier", "spend-cap 429 (enforced_spend_limit_reached) has no retry-after and is not retried", "OpenAI compatibility is not production-ready; the native Messages API is used"],
  },
  openAiCompatible({
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    tokenLimitParam: "max_completion_tokens",
    rateLimitHeaders: { family: "openai", requestsPeriod: "unknown", tokensPeriod: "unknown" },
    quirks: ["model list reports ids only", "Retry-After on 429 and 503"],
    sourceUrl: `${RESEARCH}#openai-paid`,
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
  if (template.startsWith("{base}")) return template;
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

function applyEntry(def: ProviderDefinition, entry: ProviderEntryConfig | undefined, builtIn: boolean): ResolvedProvider {
  const auth: AuthStyle = entry?.no_key ? "none" : def.auth;
  const baseUrl = entry?.base_url ? trimSlash(entry.base_url) : def.baseUrl;
  // An override moves every request, including the registry's absolute (non-`{base}`) URLs.
  const moved = (url: string) => (entry?.base_url ? rebaseUrl(url, def.baseUrl, baseUrl) : url);
  return {
    ...def,
    displayName: entry?.display_name ?? def.displayName,
    baseUrl,
    auth,
    extraHeaders: { ...def.extraHeaders, ...(entry?.headers ?? {}) },
    models: { ...def.models, url: entry?.models_path ? `{base}${entry.models_path.startsWith("/") ? "" : "/"}${entry.models_path}` : moved(def.models.url) },
    keyInfoUrl: def.keyInfoUrl === null ? null : moved(def.keyInfoUrl),
    tokenLimitParam: entry?.token_limit_param ?? def.tokenLimitParam,
    rateLimitHeaders: entry?.rate_limit_headers ? { family: entry.rate_limit_headers, requestsPeriod: "unknown", tokensPeriod: "unknown" } : def.rateLimitHeaders,
    builtIn,
    enabled: entry?.enabled ?? true,
    noKey: entry?.no_key ?? false,
    accountId: entry?.account_id ?? null,
    quotaGroup: entry?.quota_group ?? null,
    limits: { rpm: entry?.rpm ?? null, rpd: entry?.rpd ?? null, tpm: entry?.tpm ?? null, tpd: entry?.tpd ?? null },
  };
}

/** Every built-in (with any config overrides) plus every custom provider from config. */
export function resolveProviders(section?: Pick<ProvidersConfig, "byId">): Map<string, ResolvedProvider> {
  const out = new Map<string, ResolvedProvider>();
  const entries = section?.byId ?? {};
  for (const def of BUILTIN_PROVIDERS) out.set(def.id, applyEntry(def, entries[def.id], true));
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
 * Expand a URL template: `{base}` becomes the provider's base URL and `{account_id}` the
 * account id. Throws when a needed account id is missing.
 */
export function expandUrl(template: string, provider: Pick<ProviderDefinition, "id" | "baseUrl">, accountId: string | null): string {
  const fill = (t: string): string =>
    t.replace(/\{account_id\}/g, () => {
      if (!accountId) throw new Error(`provider ${provider.id} needs an account id (set account_id on the key or provider)`);
      return encodeURIComponent(accountId);
    });
  return fill(template.replace(/\{base\}/g, () => provider.baseUrl));
}

/** The chat endpoint URL for a provider and the key's account. */
export function chatUrl(provider: Pick<ProviderDefinition, "id" | "baseUrl" | "chatPath">, accountId: string | null): string {
  return expandUrl(`{base}${provider.chatPath}`, provider, accountId);
}

/** Auth plus the provider's required and configured headers. Never logged. */
export function requestHeaders(provider: Pick<ProviderDefinition, "auth" | "extraHeaders">, apiKey: string | null, auth: AuthStyle = provider.auth): Record<string, string> {
  const h: Record<string, string> = { ...provider.extraHeaders };
  if (auth !== "none" && apiKey === null) throw new Error("this provider needs an API key");
  if (auth === "bearer") h.authorization = `Bearer ${apiKey}`;
  else if (auth === "x-api-key") h["x-api-key"] = apiKey!;
  else if (auth === "x-goog-api-key") h["x-goog-api-key"] = apiKey!;
  return h;
}
