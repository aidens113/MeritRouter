import { z } from "zod";
import { MODALITIES, type Modality } from "../config/schema.js";
import type { EndpointOverride, ParamEvidence } from "../models/catalog.js";
import { parseParamsFromDescription, parseParamsFromName, resolveParams, type ResolvedParams } from "../models/params.js";
import type { ProviderClient, RequestCredential } from "./client.js";
import { ProviderError } from "./errors.js";
import type { ResolvedProvider } from "./registry.js";
import type { ListedWebSearch } from "./native-search.js";
import { requestJson, type FetchLike } from "./transport.js";

/**
 * Model enrichment for direct-provider discovery. Each field is filled in a fixed order and
 * records where its value came from: the provider's own model list, the OpenRouter public
 * catalog (no key), Hugging Face weight metadata (parameter counts), an opt-in budgeted tool
 * probe, and finally user overrides. A field no source reports stays null (unknown); nothing is
 * guessed. Provider and catalog output is untrusted: every body is parsed with zod.
 */

/** One model as a provider's list reports it, normalized across list shapes; null = not reported. */
export interface ListedModel {
  /** The provider's own model id, as sent in requests. */
  id: string;
  displayName: string | null;
  description: string | null;
  contextLimitTokens: number | null;
  outputLimitTokens: number | null;
  supportsTools: boolean | null;
  supportsStructuredOutput: boolean | null;
  inputModalities: Modality[] | null;
  /** USD per million tokens, only when the list states prices in known units (OpenRouter). */
  priceUsdPerMillion: { input: number | null; output: number | null; cachedInput?: number | null } | null;
  /** Whether the list states a zero or a positive price (in any unit); null when it states none. */
  price: "zero" | "positive" | null;
  huggingFaceId: string | null;
  /**
   * A parameter count the server itself reports: exact (from the weights, e.g. Ollama's
   * `general.parameter_count`, llama.cpp's `n_params`) or a rounded size label (`"8.0B"`).
   */
  providerParams?: { totalB: number; exact: boolean; detail: string } | null;
  /**
   * The model's trained maximum context when the context requests can use
   * (`contextLimitTokens`, the server's effective context) is smaller or unknown.
   */
  maxContextTokens?: number | null;
  /** Where `contextLimitTokens` and `outputLimitTokens` came from, when more than "the model list". */
  contextDetail?: string | null;
  outputDetail?: string | null;
  /** Quantization the server reports (`Q4_K_M`, `F16`, ...). */
  quantization?: string | null;
  /** Things discovery should show about this model (a hosted model behind a local server, an assumed context). */
  notes?: string[];
  /** What the list says about web search inside the call (OpenRouter `supported_parameters`, Anthropic `capabilities`). */
  webSearch?: ListedWebSearch | null;
}

/** A listed model about which nothing but the id is known. */
export const blankListedModel = (id: string): ListedModel => ({
  id,
  displayName: null,
  description: null,
  contextLimitTokens: null,
  outputLimitTokens: null,
  supportsTools: null,
  supportsStructuredOutput: null,
  inputModalities: null,
  priceUsdPerMillion: null,
  price: null,
  huggingFaceId: null,
});

export type FieldSource = "provider" | "openrouter" | "huggingface" | "name" | "description" | "probe" | "override" | "unknown";
export interface FieldProvenance {
  source: FieldSource;
  detail: string;
}
export const ENRICHED_FIELDS = ["displayName", "contextLimitTokens", "outputLimitTokens", "supportsTools", "supportsStructuredOutput", "inputModalities", "parameters", "pricing"] as const;
export type EnrichedField = (typeof ENRICHED_FIELDS)[number];

export interface EnrichedModel {
  providerId: string;
  modelId: string;
  displayName: string | null;
  contextLimitTokens: number | null;
  outputLimitTokens: number | null;
  supportsTools: boolean | null;
  supportsStructuredOutput: boolean | null;
  inputModalities: Modality[] | null;
  /** The trained maximum context, when it differs from the usable `contextLimitTokens` (local servers). */
  maxContextTokens: number | null;
  quantization: string | null;
  params: ResolvedParams & { confirmed: boolean };
  priceUsdPerMillion: ListedModel["priceUsdPerMillion"];
  price: ListedModel["price"];
  /** The matched OpenRouter catalog entry, and how it matched. */
  openRouter: { id: string; match: "exact" | "name" } | null;
  huggingFaceId: string | null;
  sourceUrls: string[];
  provenance: Record<EnrichedField, FieldProvenance>;
  /** Things worth showing (probe skipped for budget, probe failed, ...). */
  notes: string[];
  /** The provider's own list on web search inside the call (never taken from a catalog match). */
  webSearch: ListedWebSearch | null;
}

// ---- lenient field parsers: a bad or missing value is unknown (null), never an error ----
const optPositiveInt = z.number().int().positive().nullable().optional().catch(null);
const optString = z.string().nullable().optional().catch(null);
const optStrings = z.array(z.string()).nullable().optional().catch(null);
const priceValue = z.union([z.string(), z.number()]).nullable().optional().catch(null);

/** A price field as a number >= 0; null for missing, malformed, or negative (variable) values. */
export function priceNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function knownModalities(list: readonly string[] | null | undefined): Modality[] | null {
  if (!list) return null;
  const out = list.filter((m): m is Modality => (MODALITIES as readonly string[]).includes(m));
  return out.length ? [...new Set(out)] : null;
}

export const OpenRouterModelSchema = z.object({
  id: z.string().min(1),
  name: optString,
  description: optString,
  hugging_face_id: optString,
  context_length: optPositiveInt,
  architecture: z.object({ input_modalities: optStrings, output_modalities: optStrings }).nullable().optional().catch(null),
  /** USD per token (prompt, completion, input_cache_read), per request (request), per web search (web_search). */
  pricing: z.object({ prompt: priceValue, completion: priceValue, input_cache_read: priceValue, request: priceValue, web_search: priceValue }).nullable().optional().catch(null),
  top_provider: z.object({ context_length: optPositiveInt, max_completion_tokens: optPositiveInt }).nullable().optional().catch(null),
  supported_parameters: optStrings,
});
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

/** One OpenRouter catalog entry (the public catalog and OpenRouter's own model list share it). */
export function listedFromOpenRouter(m: OpenRouterModel): ListedModel {
  const input = priceNumber(m.pricing?.prompt);
  const output = priceNumber(m.pricing?.completion);
  const cachedInput = priceNumber(m.pricing?.input_cache_read);
  const params = m.supported_parameters;
  return {
    id: m.id,
    displayName: m.name ?? null,
    description: m.description ?? null,
    contextLimitTokens: m.top_provider?.context_length ?? m.context_length ?? null,
    outputLimitTokens: m.top_provider?.max_completion_tokens ?? null,
    supportsTools: params ? params.includes("tools") : null,
    supportsStructuredOutput: params ? params.includes("response_format") || params.includes("structured_outputs") : null,
    inputModalities: knownModalities(m.architecture?.input_modalities),
    priceUsdPerMillion:
      input === null && output === null ? null : { input: input === null ? null : input * 1e6, output: output === null ? null : output * 1e6, ...(cachedInput !== null ? { cachedInput: cachedInput * 1e6 } : {}) },
    price: input === null || output === null ? null : input === 0 && output === 0 ? "zero" : "positive",
    huggingFaceId: m.hugging_face_id || null,
    // supported_parameters lists web_search_options for models with native search (models API reference, 2026-10-21).
    webSearch: {
      supported: params ? params.includes("web_search_options") : false,
      usdPerSearch: priceNumber(m.pricing?.web_search),
      usdPerRequest: priceNumber(m.pricing?.request),
      detail: "OpenRouter supported_parameters includes web_search_options",
    },
  };
}

/** Strip routing suffixes and the vendor prefix so the same model matches across providers. */
export function modelKey(id: string): string {
  const base = id.toLowerCase().replace(/:free$|:beta$|-free$/, "");
  return base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
}

export interface OpenRouterCatalog {
  byId: Map<string, ListedModel>;
  byKey: Map<string, ListedModel>;
}

export function openRouterCatalog(models: readonly ListedModel[]): OpenRouterCatalog {
  const byId = new Map<string, ListedModel>();
  const byKey = new Map<string, ListedModel>();
  for (const m of models) {
    byId.set(m.id.toLowerCase(), m);
    const k = modelKey(m.id);
    // Prefer the entry with a Hugging Face id: it can give an exact parameter count.
    if (!byKey.has(k) || (m.huggingFaceId && !byKey.get(k)!.huggingFaceId)) byKey.set(k, m);
  }
  return { byId, byKey };
}

const OpenRouterListSchema = z.object({ data: z.array(z.unknown()) });

/** Fetch the OpenRouter public catalog (no key). Failure yields an empty catalog and the error. */
export async function loadOpenRouterCatalog(fetchFn: FetchLike, url: string, now: () => number = Date.now, timeoutMs = 30_000): Promise<{ catalog: OpenRouterCatalog; error: string | null }> {
  try {
    const res = await requestJson(fetchFn, { provider: "openrouter-catalog", url, headers: { accept: "application/json" }, timeoutMs, rateLimitHeaders: { family: "none", requestsPeriod: "unknown", tokensPeriod: "unknown" } }, now);
    const body = OpenRouterListSchema.safeParse(res.json);
    if (!body.success) return { catalog: openRouterCatalog([]), error: "OpenRouter catalog: unexpected response shape" };
    const models = body.data.data.flatMap((raw) => {
      const m = OpenRouterModelSchema.safeParse(raw);
      return m.success ? [listedFromOpenRouter(m.data)] : [];
    });
    return { catalog: openRouterCatalog(models), error: null };
  } catch (err) {
    return { catalog: openRouterCatalog([]), error: `OpenRouter catalog unavailable: ${(err as Error).message}` };
  }
}

/**
 * Find a model in the OpenRouter catalog. `exact`: the same model from the same vendor (the
 * OpenRouter provider itself, or an OpenRouter id equal to `<provider>/<model>`); `name`: the
 * same model name with vendor prefix and `:free` stripped (another host may serve it differently).
 */
export function matchOpenRouter(catalog: OpenRouterCatalog, providerId: string, modelId: string): { model: ListedModel; match: "exact" | "name" } | null {
  const id = modelId.toLowerCase();
  const exact = providerId === "openrouter" ? (catalog.byId.get(id) ?? catalog.byId.get(id.replace(/:free$/, ""))) : catalog.byId.get(`${providerId.toLowerCase()}/${id}`);
  if (exact) return { model: exact, match: "exact" };
  const byName = catalog.byKey.get(modelKey(modelId));
  return byName ? { model: byName, match: "name" } : null;
}

const HuggingFaceModelSchema = z.object({ safetensors: z.object({ total: z.number().positive() }).nullable().optional().catch(null) });

/** Exact total parameters (billions) from a Hugging Face repo's safetensors metadata; cached per lookup. */
export function huggingFaceParamLookup(fetchFn: FetchLike, apiUrl: string, now: () => number = Date.now, timeoutMs = 20_000): (repo: string) => Promise<number | null> {
  const cache = new Map<string, number | null>();
  return async (repo) => {
    if (cache.has(repo)) return cache.get(repo)!;
    let total: number | null = null;
    try {
      const res = await requestJson(fetchFn, { provider: "huggingface-hub", url: `${apiUrl.replace(/\/+$/, "")}/${repo}`, headers: { accept: "application/json" }, timeoutMs, rateLimitHeaders: { family: "none", requestsPeriod: "unknown", tokensPeriod: "unknown" } }, now);
      const body = HuggingFaceModelSchema.safeParse(res.json);
      total = body.success && body.data.safetensors ? body.data.safetensors.total / 1e9 : null;
    } catch {
      total = null;
    }
    cache.set(repo, total);
    return total;
  };
}

/** Today's allowance of tool-probe requests. Injectable so the count can live in the store. */
export interface ProbeBudget {
  /** Take one probe request from today's allowance; false when it is spent. */
  take(): boolean;
  remaining(): number;
}

/** An in-memory budget of `maxPerDay` probes per UTC day. */
export function dailyProbeBudget(maxPerDay: number, now: () => number = Date.now): ProbeBudget {
  let day = "";
  let used = 0;
  const roll = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  };
  return {
    take() {
      roll();
      if (used >= maxPerDay) return false;
      used++;
      return true;
    },
    remaining() {
      roll();
      return Math.max(0, maxPerDay - used);
    },
  };
}

/** True: the model called the tool; false: the provider rejected tools; null: inconclusive. */
export type ToolProbe = (modelId: string) => Promise<boolean | null>;

const PROBE_TOOL = { type: "function" as const, function: { name: "ping", description: "Reply by calling this tool.", parameters: { type: "object", properties: {} } } };

/**
 * A tool probe: one small chat request that offers one tool and asks for it. `complete` is the
 * provider client's (or a Gate-backed equivalent with the same signature).
 */
export function toolProbe(client: Pick<ProviderClient, "complete">, provider: ResolvedProvider, credential: RequestCredential, timeoutMs = 30_000): ToolProbe {
  return async (modelId) => {
    try {
      const res = await client.complete({
        provider,
        credential,
        model: modelId,
        chat: { messages: [{ role: "user", content: "Call the ping tool now." }], max_tokens: 64, tools: [PROBE_TOOL], tool_choice: "required" },
        timeoutMs,
      });
      return res.message.tool_calls?.length ? true : null;
    } catch (err) {
      if (err instanceof ProviderError && err.reason === "bad_request" && /tool|function/i.test(err.message)) return false;
      return null;
    }
  };
}

export interface EnrichContext {
  openRouter: OpenRouterCatalog | null;
  huggingFaceTotal: ((repo: string) => Promise<number | null>) | null;
  /** Null when probing is off (the default). */
  probe: { run: ToolProbe; budget: ProbeBudget } | null;
}

interface Sourced<T> {
  value: T | null;
  prov: FieldProvenance;
}

const unknown = (what: string): FieldProvenance => ({ source: "unknown", detail: `no source reports ${what}` });

/** The first source (in enrichment order) that reports a value. */
function first<T>(what: string, ...candidates: Array<[T | null | undefined, FieldSource, string]>): Sourced<T> {
  for (const [value, source, detail] of candidates) if (value !== null && value !== undefined) return { value, prov: { source, detail } };
  return { value: null, prov: unknown(what) };
}

/** The Hugging Face repo for a model: the provider's own (Hugging Face router ids are repo ids), the list's, or OpenRouter's. */
function huggingFaceRepo(providerId: string, listed: ListedModel, or: ListedModel | null): string | null {
  if (providerId === "huggingface") return listed.id.replace(/:[^/]*$/, "");
  return listed.huggingFaceId ?? or?.huggingFaceId ?? null;
}

/** Enrich one listed model. `override` is the user's override for its endpoint id. */
export async function enrichModel(providerId: string, listed: ListedModel, override: EndpointOverride | undefined, ctx: EnrichContext): Promise<EnrichedModel> {
  const notes: string[] = [...(listed.notes ?? [])];
  const m = ctx.openRouter ? matchOpenRouter(ctx.openRouter, providerId, listed.id) : null;
  // The OpenRouter provider's list is the catalog: its fields are provider metadata already.
  const or = m && providerId !== "openrouter" ? m.model : null;
  const exact = m?.match === "exact" ? or : null;
  const orTag = (field: string) => `OpenRouter ${m?.model.id} (${m?.match} match) ${field}`;

  const displayName = first<string>("a display name", [listed.displayName, "provider", "model list"], [or?.displayName, "openrouter", orTag("name")]);
  // Context and output limits differ between hosts: only the provider or an exact match counts.
  let context = first<number>("the context limit", [listed.contextLimitTokens, "provider", listed.contextDetail ?? "model list"], [exact?.contextLimitTokens, "openrouter", orTag("context length")]);
  let output = first<number>("the output limit", [listed.outputLimitTokens, "provider", listed.outputDetail ?? "model list"], [exact?.outputLimitTokens, "openrouter", orTag("max completion tokens")]);
  let modalities = first<Modality[]>("input modalities", [listed.inputModalities, "provider", "model list"], [exact?.inputModalities, "openrouter", orTag("input modalities")]);
  let tools = first<boolean>("tool support", [listed.supportsTools, "provider", "model list"], [or?.supportsTools, "openrouter", orTag("supported_parameters")]);
  let structured = first<boolean>("structured output support", [listed.supportsStructuredOutput, "provider", "model list"], [or?.supportsStructuredOutput, "openrouter", orTag("supported_parameters")]);

  // Parameter counts: name heuristics, descriptions, then exact Hugging Face weight metadata.
  const evidence: ParamEvidence[] = [];
  const fromName = parseParamsFromName(listed.id) ?? (displayName.value ? parseParamsFromName(displayName.value) : null);
  if (fromName) evidence.push({ source: "name", totalB: fromName.totalB, activeB: fromName.activeB, detail: fromName.detail });
  for (const [text, label] of [[listed.description, `${providerId} description`], [or?.description, `OpenRouter ${or?.id}`]] as const) {
    const d = text ? parseParamsFromDescription(text) : null;
    if (d) {
      evidence.push({ source: "description", totalB: d.totalB, activeB: d.activeB, detail: `${label}: ${d.detail}` });
      break;
    }
  }
  const repo = huggingFaceRepo(providerId, listed, or ?? m?.model ?? null);
  if (repo && ctx.huggingFaceTotal) {
    const total = await ctx.huggingFaceTotal(repo);
    evidence.push(
      total !== null
        ? { source: "huggingface", totalB: total, activeB: null, detail: `Hugging Face ${repo} safetensors total ${total.toFixed(1)}B` }
        : { source: "huggingface", totalB: null, activeB: null, detail: `Hugging Face ${repo}: no parameter metadata (gated or missing)` },
    );
  }
  // A rounded size label from the server counts as one more heuristic; an exact count wins outright.
  const fromServer = listed.providerParams ?? null;
  if (fromServer && !fromServer.exact) evidence.push({ source: "provider", totalB: fromServer.totalB, activeB: null, detail: fromServer.detail });
  const resolved = resolveParams(evidence);
  let params: EnrichedModel["params"] = { ...resolved, confirmed: resolved.confidence === "exact" || resolved.confidence === "agreed" };
  let paramsProv: FieldProvenance =
    resolved.confidence === "unknown"
      ? unknown("a parameter count")
      : { source: resolved.source === "provider" ? "provider" : resolved.source === "huggingface" ? "huggingface" : resolved.source === "description" ? "description" : "name", detail: `${resolved.confidence}: ${evidence.filter((e) => e.totalB !== null).map((e) => e.detail).join("; ")}` };
  if (fromServer?.exact) {
    // Preserve the served weights' authoritative provenance separately from heuristics.
    const totalB = Math.round(fromServer.totalB * 10) / 10;
    params = { totalParametersB: totalB, activeParametersB: resolved.activeParametersB, source: "provider", confidence: "exact", evidence: [{ source: "provider", totalB, activeB: null, detail: fromServer.detail }, ...evidence], confirmed: true };
    paramsProv = { source: "provider", detail: `exact: ${fromServer.detail}` };
  }

  // User overrides win over every discovered source.
  const ov = (field: string): FieldProvenance => ({ source: "override", detail: `user override of ${field}` });
  if (override?.contextLimitTokens !== undefined) context = { value: override.contextLimitTokens, prov: ov("contextLimitTokens") };
  if (override?.outputLimitTokens !== undefined) output = { value: override.outputLimitTokens, prov: ov("outputLimitTokens") };
  if (override?.inputModalities !== undefined) modalities = { value: override.inputModalities, prov: ov("inputModalities") };
  if (override?.supportsStructuredOutput !== undefined) structured = { value: override.supportsStructuredOutput, prov: ov("supportsStructuredOutput") };
  if (override?.supportsTools !== undefined) tools = { value: override.supportsTools, prov: ov("supportsTools") };
  else if (tools.value === null && ctx.probe) {
    if (!ctx.probe.budget.take()) notes.push("tool probe skipped: today's probe budget is spent");
    else {
      const r = await ctx.probe.run(listed.id);
      if (r === null) notes.push("tool probe inconclusive");
      else tools = { value: r, prov: { source: "probe", detail: r ? "the model called the probe tool" : "the provider rejected a request with tools" } };
    }
  }
  if (override?.totalParametersB !== undefined || override?.activeParametersB !== undefined) {
    params = {
      ...params,
      totalParametersB: override.totalParametersB !== undefined ? override.totalParametersB : params.totalParametersB,
      activeParametersB: override.activeParametersB !== undefined ? override.activeParametersB : params.activeParametersB,
      source: "override",
      confidence: "exact",
      confirmed: true,
    };
    paramsProv = ov("parameter counts");
  }
  if (override?.confirmParams) params = { ...params, confirmed: true };

  const pricingProv: FieldProvenance =
    override?.freeVerified !== undefined ? ov("freeVerified") : listed.price !== null ? { source: "provider", detail: `model list states a ${listed.price} price` } : unknown("a price");
  const sourceUrls = [...(m ? [`https://openrouter.ai/${m.model.id}`] : []), ...(repo ? [`https://huggingface.co/${repo}`] : [])];

  return {
    providerId,
    modelId: listed.id,
    displayName: displayName.value,
    contextLimitTokens: context.value,
    outputLimitTokens: output.value,
    supportsTools: tools.value,
    supportsStructuredOutput: structured.value,
    inputModalities: modalities.value,
    maxContextTokens: listed.maxContextTokens ?? null,
    quantization: listed.quantization ?? null,
    params,
    priceUsdPerMillion: listed.priceUsdPerMillion,
    price: listed.price,
    openRouter: m ? { id: m.model.id, match: m.match } : null,
    huggingFaceId: repo,
    sourceUrls,
    provenance: {
      displayName: displayName.prov,
      contextLimitTokens: context.prov,
      outputLimitTokens: output.prov,
      supportsTools: tools.prov,
      supportsStructuredOutput: structured.prov,
      inputModalities: modalities.prov,
      parameters: paramsProv,
      pricing: pricingProv,
    },
    notes,
    webSearch: listed.webSearch ?? null,
  };
}
