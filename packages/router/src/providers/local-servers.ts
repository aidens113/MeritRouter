import { z } from "zod";
import { blankListedModel, type ListedModel } from "./enrich.js";
import { ProviderError } from "./errors.js";
import { expandUrl, type ResolvedProvider } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";

/**
 * Model metadata from servers that report it on native endpoints rather than in an OpenAI model
 * list: Ollama (`/api/tags`, then `/api/show` per model and `/api/ps` for loaded contexts), LM
 * Studio (`/api/v1/models`), and llama.cpp (`/props`). Facts follow
 * `docs/working/direct-providers/research-coverage.md` sections 1 and 4. Server output is
 * untrusted: every body is parsed leniently with zod, and a field that does not parse is unknown.
 *
 * The context budgets use is the server's effective context, not the model's trained maximum:
 * Ollama runs a model with `num_ctx` from its parameters, else the context it was loaded with,
 * else the server default (4k, 32k, or 256k by VRAM, or `OLLAMA_CONTEXT_LENGTH`). The output a
 * local server can produce is bounded by that context (or Ollama's `num_predict`).
 */

/** The smallest server default context Ollama documents (< 24 GiB VRAM; the FAQ's "4096"). */
export const OLLAMA_MIN_DEFAULT_CONTEXT = 4096;
/** `/api/show` requests in flight at once during one listing. */
const SHOW_CONCURRENCY = 4;
/** Cached `/api/show` answers kept per process (keyed by server, model, and digest). */
const SHOW_CACHE_LIMIT = 2000;

const optPositiveInt = z.number().int().positive().nullable().optional().catch(null);
const optString = z.string().nullable().optional().catch(null);
const optBool = z.boolean().nullable().optional().catch(null);
const optStrings = z.array(z.string()).nullable().optional().catch(null);

const OllamaDetailsSchema = z
  .object({ format: optString, family: optString, parameter_size: z.union([z.string(), z.number()]).nullable().optional().catch(null), quantization_level: optString })
  .nullable()
  .optional()
  .catch(null);
const OllamaTagSchema = z.object({
  name: z.string().min(1),
  model: optString,
  digest: optString,
  size: z.number().nullable().optional().catch(null),
  remote_model: optString,
  remote_host: optString,
  details: OllamaDetailsSchema,
});
const OllamaTagsSchema = z.object({ models: z.array(z.unknown()) });
const OllamaShowSchema = z.object({
  parameters: optString,
  details: OllamaDetailsSchema,
  capabilities: optStrings,
  model_info: z.record(z.string(), z.unknown()).nullable().optional().catch(null),
});
type OllamaShow = z.infer<typeof OllamaShowSchema>;
const OllamaPsSchema = z.object({ models: z.array(z.object({ name: z.string(), model: optString, context_length: optPositiveInt }).loose()).catch([]) });

const LmStudioItemSchema = z.object({
  type: optString,
  key: z.string().min(1),
  display_name: optString,
  description: optString,
  params_string: optString,
  quantization: z.object({ name: optString }).nullable().optional().catch(null),
  max_context_length: optPositiveInt,
  loaded_instances: z.array(z.object({ id: optString, config: z.object({ context_length: optPositiveInt }).nullable().optional().catch(null) })).nullable().optional().catch(null),
  capabilities: z.object({ vision: optBool, trained_for_tool_use: optBool }).nullable().optional().catch(null),
});
const LmStudioListSchema = z.object({ models: z.array(z.unknown()) });

const LlamaCppPropsSchema = z.object({ default_generation_settings: z.object({ n_ctx: optPositiveInt }).nullable().optional().catch(null) });

/** One page of a native list: the same envelope `parseModelListPage` returns. */
export interface NativeListPage {
  models: ListedModel[];
  excluded: Array<{ model: string; reason: string }>;
}

function items<T>(schema: z.ZodType<T>, raw: unknown[], excluded: NativeListPage["excluded"]): T[] {
  const out: T[] = [];
  for (const [i, it] of raw.entries()) {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
    else excluded.push({ model: `#${i}`, reason: "malformed list entry" });
  }
  return out;
}

/** A size label (`"8.0B"`, `"567M"`, `"1.5T"`, or a bare number of parameters) in billions; null when unreadable. */
export function parseSizeLabel(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v / 1e9 : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMBT])?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const scale = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B" | "T"];
  if (scale === undefined) return n > 0 ? n / 1e9 : null;
  return n > 0 ? n * scale : null;
}

const sizeParams = (label: unknown, where: string): ListedModel["providerParams"] => {
  const b = parseSizeLabel(label);
  return b === null ? null : { totalB: b, exact: false, detail: `${where} ${String(label)}` };
};

/** `GET /api/tags` (Ollama, local or ollama.com): ids are the `name` exactly, tag included. */
export function parseOllamaTags(body: unknown): NativeListPage {
  const env = OllamaTagsSchema.safeParse(body);
  if (!env.success) throw new Error("unexpected ollama_tags model-list shape");
  const excluded: NativeListPage["excluded"] = [];
  const models = items(OllamaTagSchema, env.data.models, excluded).map((t): ListedModel => ({
    ...blankListedModel(t.name),
    providerParams: sizeParams(t.details?.parameter_size, "Ollama details.parameter_size"),
    quantization: t.details?.quantization_level ?? null,
    notes: t.remote_host ? [`hosted model served through this Ollama (${t.remote_host}); it may use Ollama Cloud quota`] : [],
  }));
  return { models, excluded };
}

/** `GET /api/v1/models` (LM Studio's native REST API): ids are the model `key`; only `llm` models chat. */
export function parseLmStudioModels(body: unknown, provider: Pick<ResolvedProvider, "id" | "defaultContextTokens">): NativeListPage {
  const env = LmStudioListSchema.safeParse(body);
  if (!env.success) throw new Error("unexpected lmstudio_native model-list shape");
  const excluded: NativeListPage["excluded"] = [];
  const models: ListedModel[] = [];
  for (const it of items(LmStudioItemSchema, env.data.models, excluded)) {
    if (it.type && it.type !== "llm") {
      excluded.push({ model: it.key, reason: `not a chat model (type ${it.type})` });
      continue;
    }
    const loaded = it.loaded_instances?.find((i) => i.config?.context_length)?.config?.context_length ?? null;
    const max = it.max_context_length ?? null;
    const [ctx, detail] = loaded
      ? [loaded, `loaded instance context_length ${loaded}`]
      : provider.defaultContextTokens
        ? [provider.defaultContextTokens, `providers.${provider.id}.default_context_tokens (the model is not loaded)`]
        : [null, null];
    const context = ctx !== null && max !== null ? Math.min(ctx, max) : ctx;
    const tools = it.capabilities?.trained_for_tool_use;
    models.push({
      ...blankListedModel(it.key),
      displayName: it.display_name ?? null,
      description: it.description ?? null,
      contextLimitTokens: context,
      contextDetail: detail,
      // A local server's output is bounded by the context it runs with.
      outputLimitTokens: context,
      outputDetail: context !== null ? "bounded by the context window (local server)" : null,
      maxContextTokens: max,
      // Untrained models still accept tools through a default format; they are not counted as tool-capable.
      supportsTools: tools ?? null,
      inputModalities: it.capabilities?.vision === true ? ["text", "image"] : it.capabilities?.vision === false ? ["text"] : null,
      providerParams: sizeParams(it.params_string, "LM Studio params_string"),
      quantization: it.quantization?.name ?? null,
      notes: context === null ? [`context unknown until the model is loaded: set providers.${provider.id}.default_context_tokens to its load-time context`] : [],
    });
  }
  return { models, excluded };
}

// ---- Ollama details (`/api/show`, cached by digest; `/api/ps` for loaded contexts) ----

/** Process-wide cache of `/api/show` answers: unchanged models (same digest) are not asked again. */
const showCache = new Map<string, OllamaShow>();

/** Forget every cached `/api/show` answer (tests; a server whose models were replaced in place). */
export function clearOllamaShowCache(): void {
  showCache.clear();
}

function rememberShow(key: string, show: OllamaShow): void {
  if (showCache.size >= SHOW_CACHE_LIMIT) showCache.delete(showCache.keys().next().value!);
  showCache.set(key, show);
}

/** A numeric `key value` line of `/api/show`'s `parameters` text (`num_ctx 8192`). */
function parameter(text: string | null | undefined, key: string): number | null {
  if (!text) return null;
  const m = new RegExp(`^\\s*${key}\\s+(-?\\d+)\\s*$`, "m").exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

export interface DetailsIO {
  fetch: FetchLike;
  headers: Record<string, string>;
  timeoutMs: number;
  now: () => number;
  signal?: AbortSignal;
  accountId: string | null;
}

export interface DetailsResult {
  models: ListedModel[];
  excluded: Array<{ model: string; reason: string }>;
  warnings: string[];
}

/**
 * Apply one model's `/api/show` (null when it failed) to its `/api/tags` entry: the effective and
 * maximum context, the output bound, parameters, capabilities, and quantization. Returns the
 * reason to leave it out of chat routing (embedding-only and other non-completion models).
 */
export function applyOllamaShow(listed: ListedModel, show: OllamaShow | null, loadedContext: number | null, provider: Pick<ResolvedProvider, "id" | "local" | "defaultContextTokens">): { model: ListedModel; exclude: string | null } {
  const caps = show?.capabilities ?? null;
  if (caps && !caps.includes("completion")) {
    return { model: listed, exclude: caps.includes("embedding") ? "embedding-only model" : `not a chat model (capabilities: ${caps.join(", ") || "none"})` };
  }
  const info = show?.model_info ?? null;
  const arch = typeof info?.["general.architecture"] === "string" ? (info["general.architecture"] as string) : null;
  const max = arch ? positiveInt(info?.[`${arch}.context_length`]) : null;
  const numCtx = parameter(show?.parameters, "num_ctx");
  const numPredict = parameter(show?.parameters, "num_predict");
  const notes = [...(listed.notes ?? [])];

  let context: number | null = null;
  let detail: string | null = null;
  if (numCtx) [context, detail] = [numCtx, `num_ctx ${numCtx} in the model's parameters (/api/show)`];
  else if (loadedContext) [context, detail] = [loadedContext, `loaded with context ${loadedContext} (/api/ps)`];
  else if (provider.defaultContextTokens) [context, detail] = [provider.defaultContextTokens, `providers.${provider.id}.default_context_tokens`];
  else if (provider.local) {
    [context, detail] = [OLLAMA_MIN_DEFAULT_CONTEXT, `server default assumed ${OLLAMA_MIN_DEFAULT_CONTEXT} (the smallest documented default)`];
    notes.push(`context assumed ${OLLAMA_MIN_DEFAULT_CONTEXT}: set providers.${provider.id}.default_context_tokens to the server's default (OLLAMA_CONTEXT_LENGTH, or 32k/256k on 24/48+ GiB VRAM)`);
  }
  if (context !== null && max !== null && max < context) [context, detail] = [max, `${detail}, capped at the model's maximum ${max}`];
  const output = context === null ? null : numPredict ? Math.min(numPredict, context) : context;

  const exact = positiveInt(info?.["general.parameter_count"]);
  const params: ListedModel["providerParams"] = exact
    ? { totalB: exact / 1e9, exact: true, detail: `Ollama model_info general.parameter_count ${exact}` }
    : (sizeParams(show?.details?.parameter_size, "Ollama details.parameter_size") ?? listed.providerParams ?? null);

  return {
    exclude: null,
    model: {
      ...listed,
      contextLimitTokens: context,
      contextDetail: detail,
      outputLimitTokens: output,
      outputDetail: output === null ? null : numPredict && numPredict < (context ?? Infinity) ? `num_predict ${numPredict} in the model's parameters` : "bounded by the context window (Ollama generates until it is full)",
      maxContextTokens: max,
      supportsTools: caps ? caps.includes("tools") : null,
      // Ollama's OpenAI path accepts response_format for every completion model.
      supportsStructuredOutput: caps ? true : null,
      inputModalities: caps ? (caps.includes("vision") ? ["text", "image"] : ["text"]) : null,
      providerParams: params,
      quantization: show?.details?.quantization_level ?? listed.quantization ?? null,
      notes,
    },
  };
}

/** Run `fn` over `list` with at most `n` in flight; results keep the input order. */
async function pool<T, R>(list: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

/** Digests from the raw `/api/tags` pages, by model name. */
function tagDigests(bodies: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const body of bodies) {
    const env = OllamaTagsSchema.safeParse(body);
    if (!env.success) continue;
    for (const raw of env.data.models) {
      const t = OllamaTagSchema.safeParse(raw);
      if (t.success && t.data.digest) out.set(t.data.name, t.data.digest);
    }
  }
  return out;
}

/**
 * Ollama details for a listing from `/api/tags`: `/api/show` per model (bounded concurrency,
 * cached by digest), plus `/api/ps` on a local server for contexts of loaded models. A model
 * whose `/api/show` fails keeps its `/api/tags` details; an aborted listing stops.
 */
export async function ollamaDetails(provider: ResolvedProvider, models: readonly ListedModel[], bodies: readonly unknown[], io: DetailsIO): Promise<DetailsResult> {
  const call = (url: string, body?: unknown) =>
    requestJson(io.fetch, { provider: provider.id, url, headers: io.headers, ...(body === undefined ? {} : { body }), timeoutMs: io.timeoutMs, rateLimitHeaders: provider.rateLimitHeaders, ...(io.signal ? { signal: io.signal } : {}) }, io.now);
  const root = expandUrl("{root}", provider, io.accountId);
  const digests = tagDigests(bodies);
  const loaded = new Map<string, number>();
  if (provider.local) {
    try {
      const ps = OllamaPsSchema.safeParse((await call(expandUrl("{root}/api/ps", provider, io.accountId))).json);
      for (const m of ps.success ? ps.data.models : []) if (m.context_length) loaded.set(m.name, m.context_length);
    } catch (err) {
      if (err instanceof ProviderError && err.reason === "aborted") throw err;
      // Loaded contexts are a refinement: without them the parameters or the default apply.
    }
  }
  const failures: string[] = [];
  const shows = await pool(models, SHOW_CONCURRENCY, async (m): Promise<OllamaShow | null> => {
    const digest = digests.get(m.id);
    const key = digest ? `${root}\n${m.id}\n${digest}` : null;
    if (key && showCache.has(key)) return showCache.get(key)!;
    try {
      const res = await call(expandUrl("{root}/api/show", provider, io.accountId), { model: m.id });
      const show = OllamaShowSchema.safeParse(res.json);
      if (!show.success) throw new Error("unexpected /api/show shape");
      if (key) rememberShow(key, show.data);
      return show.data;
    } catch (err) {
      if (err instanceof ProviderError && err.reason === "aborted") throw err;
      failures.push(`${m.id}: ${(err as Error).message}`);
      return null;
    }
  });
  const out: DetailsResult = { models: [], excluded: [], warnings: [] };
  models.forEach((m, i) => {
    const r = applyOllamaShow(m, shows[i] ?? null, loaded.get(m.id) ?? null, provider);
    if (r.exclude) out.excluded.push({ model: m.id, reason: r.exclude });
    else if (!shows[i] && /embed/i.test(m.id)) out.excluded.push({ model: m.id, reason: "embedding model (by name; /api/show failed)" });
    else out.models.push(shows[i] ? r.model : { ...r.model, notes: [...(r.model.notes ?? []), "details unavailable (/api/show failed): metadata from /api/tags only"] });
  });
  if (failures.length) out.warnings.push(`${provider.id}: /api/show failed for ${failures.length} of ${models.length} model(s); their metadata comes from /api/tags only (first: ${failures[0]})`);
  return out;
}

/**
 * llama.cpp details: the runtime context from `/props` applies when the server lists one model
 * (in router mode with several, each model's context is unknown unless configured). The output
 * a local server can produce is bounded by that context.
 */
export async function llamaCppDetails(provider: ResolvedProvider, models: readonly ListedModel[], io: DetailsIO): Promise<DetailsResult> {
  let nCtx: number | null = null;
  try {
    const res = await requestJson(io.fetch, { provider: provider.id, url: expandUrl("{root}/props", provider, io.accountId), headers: io.headers, timeoutMs: io.timeoutMs, rateLimitHeaders: provider.rateLimitHeaders, ...(io.signal ? { signal: io.signal } : {}) }, io.now);
    const props = LlamaCppPropsSchema.safeParse(res.json);
    nCtx = props.success ? (props.data.default_generation_settings?.n_ctx ?? null) : null;
  } catch (err) {
    if (err instanceof ProviderError && err.reason === "aborted") throw err;
  }
  const out: DetailsResult = { models: [], excluded: [], warnings: [] };
  for (const m of models) {
    const [ctx, detail] =
      m.contextLimitTokens !== null
        ? [m.contextLimitTokens, m.contextDetail ?? "model list"]
        : nCtx && models.length === 1
          ? [nCtx, `runtime n_ctx ${nCtx} (/props)`]
          : provider.defaultContextTokens
            ? [provider.defaultContextTokens, `providers.${provider.id}.default_context_tokens`]
            : [null, null];
    const max = m.maxContextTokens ?? null;
    const context = ctx !== null && max !== null ? Math.min(ctx, max) : ctx;
    out.models.push({
      ...m,
      contextLimitTokens: context,
      contextDetail: detail,
      outputLimitTokens: m.outputLimitTokens ?? context,
      outputDetail: m.outputLimitTokens !== null ? (m.outputDetail ?? null) : context !== null ? "bounded by the context window (local server)" : null,
      notes: [...(m.notes ?? []), ...(context === null ? [`runtime context unknown: set providers.${provider.id}.default_context_tokens`] : [])],
    });
  }
  return out;
}
