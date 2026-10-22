import { z } from "zod";
import type { RawConfig } from "../config/schema.js";
import { endpointIdFor, type EndpointOverride, type ModelEndpointInput } from "../models/catalog.js";
import type { ProviderClient } from "./client.js";
import type { ProviderCredential, ProviderCredentials } from "./credentials.js";
import {
  blankListedModel,
  dailyProbeBudget,
  enrichModel,
  huggingFaceParamLookup,
  knownModalities,
  listedFromOpenRouter,
  loadOpenRouterCatalog,
  OpenRouterModelSchema,
  priceNumber,
  toolProbe,
  type EnrichedModel,
  type ListedModel,
  type OpenRouterCatalog,
  type ProbeBudget,
} from "./enrich.js";
import { isKeyFailure, ProviderError, type ProviderErrorKind } from "./errors.js";
import { detectNativeWebSearch } from "./native-search.js";
import { llamaCppDetails, ollamaDetails, parseLmStudioModels, parseOllamaTags, type DetailsIO } from "./local-servers.js";
import { expandUrl, requestHeaders, type ModelListShape, type ResolvedProvider } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";

/**
 * Direct-provider model discovery: list each provider's models with one of its usable keys,
 * keep the models that key can use, enrich them (see `enrich.ts`), and map them to catalog
 * endpoints `<provider>/<model>` routed `{kind:"direct"}`. Results only: persisting them
 * (`runProviderDiscovery`, `Catalog.saveProviderDiscovery`) and scheduling are the caller's.
 */

/** Guards against a provider that keeps returning a continuation token. */
const MAX_PAGES = 50;

// ---- model-list page parsing, per registry shape (bodies are untrusted) ----
const optPositiveInt = z.number().int().positive().nullable().optional().catch(null);
const optString = z.string().nullable().optional().catch(null);
const optBool = z.boolean().nullable().optional().catch(null);
const optStrings = z.array(z.string()).nullable().optional().catch(null);

const OpenAiItemSchema = z.object({
  id: z.string().min(1),
  name: optString,
  display_name: optString,
  description: optString,
  /** Groq: false for a deactivated model. */
  active: optBool,
  /** Mistral: a retired model. */
  archived: optBool,
  /** Together: chat, language, embedding, image, ... */
  type: optString,
  context_window: optPositiveInt,
  context_length: optPositiveInt,
  max_context_length: optPositiveInt,
  max_completion_tokens: optPositiveInt,
  /** DeepSeek. */
  max_output_tokens: optPositiveInt,
  capabilities: z.object({ completion_chat: optBool, function_calling: optBool, vision: optBool }).nullable().optional().catch(null),
  pricing: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
  /** Nebius `?verbose=true`. */
  supported_features: optStrings,
  quantization: optString,
  /** llama.cpp: the loaded weights' parameter count and trained context. */
  meta: z.object({ n_params: optPositiveInt, n_ctx_train: optPositiveInt }).nullable().optional().catch(null),
});
const GoogleItemSchema = z.object({
  name: z.string().min(1),
  displayName: optString,
  description: optString,
  inputTokenLimit: optPositiveInt,
  outputTokenLimit: optPositiveInt,
  supportedGenerationMethods: optStrings,
});
const CohereItemSchema = z.object({ name: z.string().min(1), context_length: optPositiveInt, features: optStrings });
const CloudflareItemSchema = z.object({
  id: z.string().min(1),
  name: optString,
  description: optString,
  task: z.object({ name: optString }).nullable().optional().catch(null),
  properties: z.array(z.object({ property_id: z.string(), value: z.unknown() })).nullable().optional().catch(null),
});
const AnthropicItemSchema = z.object({
  id: z.string().min(1),
  display_name: optString,
  max_input_tokens: optPositiveInt,
  max_tokens: optPositiveInt,
  /** `server_tools.web_search.supported`: the model accepts at least one web search tool version (models overview, 2026-10-21). */
  capabilities: z
    .object({ server_tools: z.object({ web_search: z.object({ supported: optBool }).nullable().optional().catch(null) }).nullable().optional().catch(null) })
    .nullable()
    .optional()
    .catch(null),
});
const DeepInfraItemSchema = z.object({
  model_name: z.string().min(1),
  type: optString,
  description: optString,
  pricing: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
  /** The context length (research-coverage.md). */
  max_tokens: optPositiveInt,
  quantization: optString,
  deprecated: z.unknown().optional(),
  replaced_by: optString,
});
/** One field of the OVHcloud catalog that may be a string or a list of strings. */
const stringOrStrings = z
  .union([z.string().transform((v) => [v]), z.array(z.string())])
  .nullable()
  .optional()
  .catch(null);
const OvhItemSchema = z.object({
  id: z.string().min(1),
  name: optString,
  available: optBool,
  category: optString,
  tags: optStrings,
  metadata: z
    .object({
      model_specs: z
        .object({
          capabilities: z.object({ input_modality: stringOrStrings, output_modality: stringOrStrings, function_calling: optBool, reasoning: optBool }).nullable().optional().catch(null),
        })
        .nullable()
        .optional()
        .catch(null),
      usage_information: z.object({ pricing: z.unknown().optional() }).nullable().optional().catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
});

/** Model types and id fragments that are not chat models (lists that report ids only). */
const NON_CHAT_TYPES = new Set(["embedding", "embeddings", "image", "audio", "moderation", "rerank", "transcribe", "tts"]);
const NON_CHAT_ID = /(^|[-_/.])(embed|embedding|whisper|tts|dall-e|moderation|rerank|transcribe)([-_/.]|$)|text-embedding/i;
/** Free-text model types and categories (DeepInfra, OVHcloud) that are not chat models. Only excludes. */
const NON_CHAT_TEXT = /embed|image|audio|speech|tts|asr|rerank|classif|moderation|transcri|text-to-|-to-image|fill-mask/i;

const blank = blankListedModel;

/** Zero vs positive from a price object whose units the research does not state. */
function priceClass(p: Record<string, unknown> | null | undefined): ListedModel["price"] {
  if (!p) return null;
  const values = ["input", "output", "prompt", "completion"].filter((k) => k in p).map((k) => priceNumber(p[k]));
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return values.every((v) => v === 0) ? "zero" : "positive";
}

export interface ListPage {
  models: ListedModel[];
  excluded: Array<{ model: string; reason: string }>;
  /** Query parameters for the next page; null on the last page. */
  next: Record<string, string> | null;
}

const PageSchemas = {
  data: z.object({ data: z.array(z.unknown()), has_more: z.boolean().optional().catch(undefined), last_id: optString }),
  google: z.object({ models: z.array(z.unknown()).optional().default([]), nextPageToken: optString }),
  cohere: z.object({ models: z.array(z.unknown()), next_page_token: optString }),
  cloudflare: z.object({
    result: z.array(z.unknown()),
    result_info: z.object({ page: z.number().int().positive(), per_page: z.number().int().positive(), total_count: z.number().int().min(0) }).partial().nullable().optional().catch(null),
  }),
};

function parseItems<T>(schema: z.ZodType<T>, items: unknown[], excluded: ListPage["excluded"]): T[] {
  const out: T[] = [];
  for (const [i, raw] of items.entries()) {
    const r = schema.safeParse(raw);
    if (r.success) out.push(r.data);
    else excluded.push({ model: `#${i}`, reason: "malformed list entry" });
  }
  return out;
}

/** Parse one page of a provider's model list. Throws when the envelope is not the documented shape. */
export function parseModelListPage(shape: ModelListShape, body: unknown, provider: Pick<ResolvedProvider, "id" | "defaultContextTokens"> = { id: "provider", defaultContextTokens: null }): ListPage {
  const excluded: ListPage["excluded"] = [];
  const models: ListedModel[] = [];
  const keep = (m: ListedModel, reason: string | null) => (reason ? excluded.push({ model: m.id, reason }) : models.push(m));
  const fail = (): never => {
    throw new Error(`unexpected ${shape} model-list shape`);
  };
  switch (shape) {
    case "openai": {
      const env = Array.isArray(body) ? { data: body } : PageSchemas.data.safeParse(body).data;
      if (!env) fail();
      for (const it of parseItems(OpenAiItemSchema, env!.data, excluded)) {
        const caps = it.capabilities;
        const features = it.supported_features?.map((f) => f.toLowerCase());
        const m: ListedModel = {
          ...blank(it.id),
          displayName: it.display_name ?? it.name ?? null,
          description: it.description ?? null,
          contextLimitTokens: it.context_window ?? it.context_length ?? it.max_context_length ?? null,
          outputLimitTokens: it.max_completion_tokens ?? it.max_output_tokens ?? null,
          // A listed feature is evidence; an unlisted one is not evidence of absence.
          supportsTools: caps?.function_calling ?? (features?.some((f) => f === "tools" || f === "function_calling" || f === "tool_calling") ? true : null),
          inputModalities: caps?.vision === true ? ["text", "image"] : caps?.vision === false ? ["text"] : null,
          price: priceClass(it.pricing),
          quantization: it.quantization ?? null,
          providerParams: it.meta?.n_params ? { totalB: it.meta.n_params / 1e9, exact: true, detail: `model list meta.n_params ${it.meta.n_params}` } : null,
          maxContextTokens: it.meta?.n_ctx_train ?? null,
        };
        keep(
          m,
          it.active === false
            ? "inactive"
            : it.archived === true
              ? "archived"
              : caps?.completion_chat === false
                ? "not a chat model"
                : it.type && NON_CHAT_TYPES.has(it.type.toLowerCase())
                  ? `not a chat model (type ${it.type})`
                  : NON_CHAT_ID.test(it.id)
                    ? "not a chat model (id)"
                    : null,
        );
      }
      return { models, excluded, next: null };
    }
    case "openrouter": {
      const env = PageSchemas.data.safeParse(body).data ?? fail();
      for (const it of parseItems(OpenRouterModelSchema, env.data, excluded)) {
        const out = it.architecture?.output_modalities;
        keep(listedFromOpenRouter(it), out && !out.includes("text") ? "does not output text" : null);
      }
      return { models, excluded, next: null };
    }
    case "anthropic": {
      const env = PageSchemas.data.safeParse(body).data ?? fail();
      for (const it of parseItems(AnthropicItemSchema, env.data, excluded)) {
        const ws = it.capabilities?.server_tools?.web_search?.supported;
        keep(
          {
            ...blank(it.id),
            displayName: it.display_name ?? null,
            contextLimitTokens: it.max_input_tokens ?? null,
            outputLimitTokens: it.max_tokens ?? null,
            ...(typeof ws === "boolean" ? { webSearch: { supported: ws, usdPerSearch: null, usdPerRequest: null, detail: "Anthropic models API capabilities.server_tools.web_search.supported" } } : {}),
          },
          null,
        );
      }
      return { models, excluded, next: env.has_more && env.last_id ? { after_id: env.last_id } : null };
    }
    case "google_native": {
      const env = PageSchemas.google.safeParse(body).data ?? fail();
      for (const it of parseItems(GoogleItemSchema, env.models, excluded)) {
        const id = it.name.replace(/^models\//, "");
        const m: ListedModel = { ...blank(id), displayName: it.displayName ?? null, description: it.description ?? null, contextLimitTokens: it.inputTokenLimit ?? null, outputLimitTokens: it.outputTokenLimit ?? null };
        keep(m, it.supportedGenerationMethods && !it.supportedGenerationMethods.includes("generateContent") ? "does not support generateContent" : null);
      }
      return { models, excluded, next: env.nextPageToken ? { pageToken: env.nextPageToken } : null };
    }
    case "cohere": {
      const env = PageSchemas.cohere.safeParse(body).data ?? fail();
      for (const it of parseItems(CohereItemSchema, env.models, excluded)) {
        const f = it.features;
        keep(
          {
            ...blank(it.name),
            contextLimitTokens: it.context_length ?? null,
            // A listed feature is evidence; an unlisted one is not evidence of absence.
            supportsTools: f?.includes("tools") ? true : null,
            supportsStructuredOutput: f?.some((x) => x === "json_mode" || x === "json_schema") ? true : null,
            inputModalities: f?.includes("vision") ? ["text", "image"] : null,
          },
          null,
        );
      }
      return { models, excluded, next: env.next_page_token ? { page_token: env.next_page_token } : null };
    }
    case "cloudflare_search": {
      const env = PageSchemas.cloudflare.safeParse(body).data ?? fail();
      for (const it of parseItems(CloudflareItemSchema, env.result, excluded)) {
        const id = it.name?.startsWith("@") ? it.name : it.id;
        const prop = (k: string) => it.properties?.find((p) => p.property_id === k)?.value;
        const ctx = Number(prop("context_window"));
        const fc = prop("function_calling");
        const m: ListedModel = {
          ...blank(id),
          description: it.description ?? null,
          contextLimitTokens: Number.isInteger(ctx) && ctx > 0 ? ctx : null,
          supportsTools: fc === true || fc === "true" ? true : null,
        };
        keep(m, it.task?.name && it.task.name !== "Text Generation" ? `not a chat model (task ${it.task.name})` : null);
      }
      const info = env.result_info;
      const more = info?.page && info.per_page && info.total_count !== undefined && info.page * info.per_page < info.total_count;
      return { models, excluded, next: more ? { page: String(info!.page! + 1) } : null };
    }
    case "ollama_tags":
      return { ...parseOllamaTags(body), next: null };
    case "lmstudio_native":
      return { ...parseLmStudioModels(body, provider), next: null };
    case "deepinfra_list": {
      if (!Array.isArray(body)) fail();
      for (const it of parseItems(DeepInfraItemSchema, body as unknown[], excluded)) {
        const deprecated = it.deprecated !== undefined && it.deprecated !== null && it.deprecated !== false && it.deprecated !== 0;
        const m: ListedModel = { ...blank(it.model_name), description: it.description ?? null, contextLimitTokens: it.max_tokens ?? null, price: priceClass(it.pricing), quantization: it.quantization ?? null };
        keep(
          m,
          deprecated
            ? `deprecated${it.replaced_by ? ` (replaced by ${it.replaced_by})` : ""}`
            : it.type && NON_CHAT_TEXT.test(it.type)
              ? `not a chat model (type ${it.type})`
              : NON_CHAT_ID.test(it.model_name)
                ? "not a chat model (id)"
                : null,
        );
      }
      return { models, excluded, next: null };
    }
    case "ovh_catalog": {
      if (!Array.isArray(body)) fail();
      for (const it of parseItems(OvhItemSchema, body as unknown[], excluded)) {
        const caps = it.metadata?.model_specs?.capabilities;
        const input = caps?.input_modality?.map((x) => x.toLowerCase()) ?? null;
        const output = caps?.output_modality?.map((x) => x.toLowerCase()) ?? null;
        const pricing = it.metadata?.usage_information?.pricing;
        const m: ListedModel = {
          ...blank(it.id),
          displayName: it.name ?? null,
          supportsTools: caps?.function_calling ?? null,
          inputModalities: input ? knownModalities(input) : null,
          price: pricing && typeof pricing === "object" && !Array.isArray(pricing) ? priceClass(pricing as Record<string, unknown>) : null,
        };
        keep(
          m,
          it.available === false
            ? "not available"
            : output && !output.includes("text")
              ? "does not output text"
              : it.category && NON_CHAT_TEXT.test(it.category)
                ? `not a chat model (category ${it.category})`
                : NON_CHAT_ID.test(it.id)
                  ? "not a chat model (id)"
                  : null,
        );
      }
      return { models, excluded, next: null };
    }
  }
}

export interface ProviderListing {
  models: ListedModel[];
  excluded: Array<{ model: string; reason: string }>;
  pages: number;
  /** Things the listing could not do fully (a native list fell back to ids only, a details request failed). */
  warnings: string[];
}

type ListOptions = { timeoutMs: number; now: () => number; signal?: AbortSignal };

/** Read one list URL in one shape, following continuation tokens. Also returns the raw pages (for a details step). */
async function listPages(fetchFn: FetchLike, provider: ResolvedProvider, template: string, shape: ModelListShape, headers: Record<string, string>, accountId: string | null, opts: ListOptions) {
  const base = expandUrl(template, provider, accountId);
  const models: ListedModel[] = [];
  const excluded: ProviderListing["excluded"] = [];
  const bodies: unknown[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  let query: Record<string, string> | null = {};
  let pages = 0;
  while (query && pages < MAX_PAGES) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await requestJson(fetchFn, { provider: provider.id, url: url.toString(), headers, timeoutMs: opts.timeoutMs, rateLimitHeaders: provider.rateLimitHeaders, ...(opts.signal ? { signal: opts.signal } : {}) }, opts.now);
    let page: ListPage;
    try {
      page = parseModelListPage(shape, res.json, provider);
    } catch (err) {
      throw new ProviderError("server", `${provider.id}: ${(err as Error).message}`, { provider: provider.id, status: res.status, rateLimits: res.rateLimits });
    }
    pages++;
    bodies.push(res.json);
    for (const m of page.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
    excluded.push(...page.excluded);
    const token = page.next ? JSON.stringify(page.next) : null;
    query = token && !tokens.has(token) ? page.next : null;
    if (token) tokens.add(token);
  }
  return { models, excluded, pages, bodies };
}

/**
 * List every model on one provider with one credential, following continuation tokens. When a
 * native list fails for a reason other than the key, the registry's OpenAI-shaped fallback list
 * is read instead (ids only). Providers with a details step (Ollama `/api/show`, llama.cpp
 * `/props`) refine the listed models after a native listing.
 */
export async function listProviderModels(fetchFn: FetchLike, provider: ResolvedProvider, credential: { apiKey: string | null; accountId: string | null }, opts: ListOptions): Promise<ProviderListing> {
  const headers = { accept: "application/json", ...requestHeaders(provider, credential.apiKey, provider.auth === "none" ? "none" : (provider.models.auth ?? provider.auth)) };
  const warnings: string[] = [];
  let listed: Awaited<ReturnType<typeof listPages>>;
  let fellBack = false;
  try {
    listed = await listPages(fetchFn, provider, provider.models.url, provider.models.shape, headers, credential.accountId, opts);
  } catch (err) {
    const fallback = provider.models.fallbackUrl;
    if (!fallback || isKeyFailure(err) || (err instanceof ProviderError && err.reason === "aborted")) throw err;
    try {
      listed = await listPages(fetchFn, provider, fallback, "openai", headers, credential.accountId, opts);
    } catch {
      throw err;
    }
    fellBack = true;
    warnings.push(`${provider.id}: the native model list failed (${(err as Error).message}); listed ${expandUrl(fallback, provider, credential.accountId)} instead, with ids only`);
  }
  let { models, excluded } = listed;
  if (!fellBack && provider.models.details) {
    // Details requests carry the chat auth (ollama.com needs the key); the list's own auth may be none.
    const io: DetailsIO = { fetch: fetchFn, headers: { accept: "application/json", ...requestHeaders(provider, credential.apiKey) }, timeoutMs: opts.timeoutMs, now: opts.now, accountId: credential.accountId, ...(opts.signal ? { signal: opts.signal } : {}) };
    const d = provider.models.details === "ollama_show" ? await ollamaDetails(provider, models, listed.bodies, io) : await llamaCppDetails(provider, models, io);
    models = d.models;
    excluded = [...excluded, ...d.excluded];
    warnings.push(...d.warnings);
  }
  return { models, excluded, pages: listed.pages, warnings };
}

export interface DiscoveryOptions {
  providers: ReadonlyMap<string, ResolvedProvider>;
  credentials: Pick<ProviderCredentials, "usable" | "requestCredential">;
  config: Pick<RawConfig["discovery"], "openrouter_models_url" | "huggingface_api_url" | "probe_tools" | "max_probe_requests_per_day">;
  /** Limit to these provider ids (e.g. right after a key was added). Default: every provider. */
  only?: readonly string[];
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Previously stored discovered endpoints, so unlisted ones can be marked unavailable. */
  known?: readonly ModelEndpointInput[];
  /** Manual endpoints from the models file: never produced or marked unavailable here. */
  manual?: readonly ModelEndpointInput[];
  /** User overrides by endpoint id (models file and panel merged by the caller). */
  overrides?: Readonly<Record<string, EndpointOverride>>;
  /** Preloaded OpenRouter public catalog; fetched from `config.openrouter_models_url` when omitted. */
  openRouter?: OpenRouterCatalog;
  huggingFaceTotal?: (repo: string) => Promise<number | null>;
  /** Used only when `config.probe_tools` is on: the client that sends probes, and the shared daily budget. */
  probeClient?: Pick<ProviderClient, "complete">;
  probeBudget?: ProbeBudget;
  signal?: AbortSignal;
  /**
   * Called when a listing shows a key is unusable: the provider rejected it (401/403,
   * `auth_invalid`) or it is out of credits (402, `out_of_credits`). The caller records it on
   * the key (`ProviderKeys.recordFailure`), as a failed request would.
   */
  onKeyFailure?: (credential: ProviderCredential, err: ProviderError) => void;
}

export type ProviderDiscoveryStatus = "listed" | "no_key" | "disabled" | "failed";
export interface ProviderDiscovery {
  provider: string;
  status: ProviderDiscoveryStatus;
  /** The credential whose listing was used. */
  credentialRef: string | null;
  pages: number;
  kept: number;
  excluded: Array<{ model: string; reason: string }>;
  /** Listing failures, one per credential tried (`ref: message`). */
  errors: Array<{ ref: string; kind: ProviderErrorKind | "error"; message: string }>;
}

export interface DiscoveredEndpoint {
  /** Ready for `Catalog.saveDiscovered` (after schema parsing). */
  endpoint: ModelEndpointInput;
  enriched: EnrichedModel;
  free: { value: boolean; reason: string };
}

export interface DiscoveryResult {
  endpoints: DiscoveredEndpoint[];
  /** Previously known endpoints now unlisted (`enabled:false`) or without a usable key. */
  unavailable: Array<{ endpoint: ModelEndpointInput; reason: string }>;
  providers: ProviderDiscovery[];
  warnings: string[];
}

/**
 * Free when no money can move: a `:free` or $0 model, or any request through a `free_tier` key.
 * On OpenRouter a free key only reaches free models, so priced models there are not usable.
 */
export function freeStatus(
  provider: Pick<ResolvedProvider, "models" | "freeModelIds">,
  model: Pick<ListedModel, "id" | "price">,
  creds: readonly Pick<ProviderCredential, "billingClass">[],
): { value: boolean; usable: boolean; reason: string; basis?: "model" | "key" } {
  if (/:free$/.test(model.id)) return { value: true, usable: true, reason: "model id ends in :free", basis: "model" };
  if (model.price === "zero") return { value: true, usable: true, reason: "provider lists a price of 0", basis: "model" };
  // Per-model free with no prices in the list (Z.ai): only the documented free models are free.
  const freeIds = provider.freeModelIds ?? null;
  if (freeIds?.some((id) => id.toLowerCase() === model.id.toLowerCase())) return { value: true, usable: true, reason: "documented free model", basis: "model" };
  const freeKey = creds.some((c) => c.billingClass === "free_tier");
  const perModelFree = provider.models.shape === "openrouter" || freeIds !== null;
  const priced = model.price === "positive" || (freeIds !== null && model.price === null);
  if (freeKey && !(perModelFree && priced)) return { value: true, usable: true, reason: "a free_tier key serves it", basis: "key" };
  if (perModelFree && priced && creds.every((c) => c.billingClass === "free_tier")) return { value: false, usable: false, reason: freeIds !== null && model.price === null ? "not a documented free model; only free_tier keys" : "priced model; only free_tier keys" };
  return { value: false, usable: true, reason: freeKey ? "priced model" : "only paid or trial keys" };
}

function toEndpoint(provider: ResolvedProvider, e: EnrichedModel, free: { value: boolean; reason: string; basis?: "model" | "key" }, override: EndpointOverride | undefined, now: number): ModelEndpointInput {
  const freeValue = override?.freeVerified ?? free.value;
  // The user saying a model is free covers every key; otherwise a key-based free model stays on free keys.
  const freeBasis = !freeValue ? undefined : override?.freeVerified !== undefined ? "model" : (free.basis ?? "key");
  const usd = e.priceUsdPerMillion;
  return {
    id: endpointIdFor(provider.id, e.modelId),
    providerId: provider.id,
    gatewayModelId: e.modelId,
    ...(e.openRouter ? { providerModelId: e.openRouter.id } : {}),
    ...(e.displayName ? { displayName: e.displayName } : {}),
    origin: "discovered",
    route: { kind: "direct", provider: provider.id, model: e.modelId },
    quotaScopeIds: [`${provider.id}:${provider.quotaScope}`],
    totalParametersB: e.params.totalParametersB,
    activeParametersB: e.params.activeParametersB,
    params: { source: e.params.source, confidence: e.params.confidence, confirmed: e.params.confirmed, evidence: e.params.evidence },
    maxContextTokens: e.maxContextTokens,
    quantization: e.quantization,
    contextDetail: e.provenance.contextLimitTokens.detail,
    contextLimitTokens: e.contextLimitTokens,
    outputLimitTokens: e.outputLimitTokens,
    outputLimitSource: e.provenance.outputLimitTokens.source === "override" ? "override" : e.outputLimitTokens !== null ? "provider" : "default",
    inputModalities: e.inputModalities ?? ["text"],
    // Unknown support is stored as null: routing excludes it from work that needs it.
    supportsTools: e.supportsTools,
    supportsStructuredOutput: e.supportsStructuredOutput,
    nativeWebSearch: detectNativeWebSearch(provider.id, e.modelId, e.webSearch),
    pricing: {
      inputUsdPerMillion: freeValue ? 0 : (usd?.input ?? null),
      outputUsdPerMillion: freeValue ? 0 : (usd?.output ?? null),
      ...(!freeValue && usd?.cachedInput !== undefined && usd.cachedInput !== null ? { cachedInputUsdPerMillion: usd.cachedInput, cachedInputSource: `${provider.id} model list (input_cache_read)` } : {}),
      freeVerified: freeValue,
      source: override?.freeVerified !== undefined ? "override" : `${provider.id}: ${free.reason}`,
      ...(freeBasis ? { freeBasis } : {}),
    },
    available: true,
    enabled: true,
    sourceUrls: [...(provider.sourceUrl.startsWith("http") ? [provider.sourceUrl] : []), ...e.sourceUrls],
    checkedAt: new Date(now).toISOString(),
  };
}

const isDirect = (e: ModelEndpointInput, providerId: string) => e.origin === "discovered" && e.providerId === providerId;

/** Discover models on every enabled provider that has a usable credential. Never throws for one provider's failure. */
export async function discoverModels(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const manualIds = new Set((opts.manual ?? []).map((e) => e.id));
  const overrides = opts.overrides ?? {};
  const result: DiscoveryResult = { endpoints: [], unavailable: [], providers: [], warnings: [] };

  let openRouter = opts.openRouter ?? null;
  if (!openRouter) {
    const loaded = await loadOpenRouterCatalog(fetchFn, opts.config.openrouter_models_url, now, timeoutMs);
    openRouter = loaded.catalog;
    if (loaded.error) result.warnings.push(`${loaded.error}; enrichment limited to provider metadata and names`);
  }
  const huggingFaceTotal = opts.huggingFaceTotal ?? huggingFaceParamLookup(fetchFn, opts.config.huggingface_api_url, now);
  const probing = opts.config.probe_tools && opts.probeClient;
  const budget = opts.probeBudget ?? dailyProbeBudget(opts.config.max_probe_requests_per_day, now);
  if (opts.config.probe_tools && !opts.probeClient) result.warnings.push("discovery.probe_tools is on but no probe client was given; tool support stays unknown where no source reports it");

  for (const provider of opts.providers.values()) {
    if (opts.only && !opts.only.includes(provider.id)) continue;
    const known = (opts.known ?? []).filter((e) => isDirect(e, provider.id) && !manualIds.has(e.id));
    const report: ProviderDiscovery = { provider: provider.id, status: "listed", credentialRef: null, pages: 0, kept: 0, excluded: [], errors: [] };
    result.providers.push(report);
    const creds = provider.enabled ? opts.credentials.usable(provider.id) : [];
    if (!provider.enabled || creds.length === 0) {
      report.status = provider.enabled ? "no_key" : "disabled";
      const reason = provider.enabled ? `${provider.id} has no usable key` : `${provider.id} is disabled`;
      for (const e of known) if (e.available !== false) result.unavailable.push({ endpoint: { ...e, available: false }, reason });
      continue;
    }

    let listing: ProviderListing | null = null;
    let used: ProviderCredential | null = null;
    for (const cred of creds) {
      try {
        const rc = opts.credentials.requestCredential(cred.ref);
        listing = await listProviderModels(fetchFn, provider, { apiKey: rc.apiKey, accountId: rc.accountId ?? provider.accountId }, { timeoutMs, now, ...(opts.signal ? { signal: opts.signal } : {}) });
        used = cred;
        break;
      } catch (err) {
        report.errors.push({ ref: cred.ref, kind: err instanceof ProviderError ? err.reason : "error", message: (err as Error).message });
        if (isKeyFailure(err)) opts.onKeyFailure?.(cred, err);
        if (err instanceof ProviderError && err.reason === "aborted") break;
      }
    }
    if (!listing || !used) {
      // A failed listing says nothing about which models exist: leave known endpoints alone.
      report.status = "failed";
      result.warnings.push(`${provider.id}: model list failed with every usable key`);
      continue;
    }
    report.credentialRef = used.ref;
    report.pages = listing.pages;
    report.excluded.push(...listing.excluded);
    result.warnings.push(...listing.warnings);

    const rc = opts.credentials.requestCredential(used.ref);
    const probe = probing ? { run: toolProbe(opts.probeClient!, provider, { apiKey: rc.apiKey, accountId: rc.accountId ?? provider.accountId }, timeoutMs), budget } : null;
    const listed = new Set<string>();
    for (const m of listing.models) {
      const id = endpointIdFor(provider.id, m.id);
      if (manualIds.has(id)) {
        listed.add(id);
        report.excluded.push({ model: m.id, reason: "a manual entry defines this endpoint" });
        continue;
      }
      const free = freeStatus(provider, m, creds);
      if (!free.usable) {
        report.excluded.push({ model: m.id, reason: free.reason });
        continue;
      }
      listed.add(id);
      const enriched = await enrichModel(provider.id, m, overrides[id], { openRouter, huggingFaceTotal, probe });
      result.endpoints.push({ endpoint: toEndpoint(provider, enriched, free, overrides[id], now()), enriched, free: { value: overrides[id]?.freeVerified ?? free.value, reason: free.reason } });
      report.kept++;
    }
    for (const e of known) {
      if (listed.has(e.id) || (e.available === false && e.enabled === false)) continue;
      result.unavailable.push({ endpoint: { ...e, available: false, enabled: false }, reason: `no longer listed by ${provider.id}` });
    }
  }
  return result;
}
