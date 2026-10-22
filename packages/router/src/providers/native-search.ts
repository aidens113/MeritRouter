import { z } from "zod";
import type { NativeWebSearch, NativeWebSearchVia } from "../models/catalog.js";
import type { NativeWebSearchOutcome, WebCitation } from "../gateway/types.js";

/**
 * Web search inside the model call (decision D9 of the web-search working document): which
 * endpoints have it, how a request turns it on per provider, and what the response reports
 * (search counts and citations). Facts come from each provider's documentation (URL and date
 * below and in `docs/decisions.md`) or from the provider's own model metadata; nothing here is a
 * price or capability guessed from a model name alone. Provider output is untrusted: response
 * fields are read leniently and shortened.
 *
 * Checked 2026-10-21 and not used: Gemini grounding (the OpenAI-compatible endpoint documents
 * `google_search` only for an image model), Perplexity Sonar as a direct provider (its docs now
 * point to the Agent API; Perplexity is not a built-in provider), Groq compound (its model ids
 * were deprecated on 2026-09-21).
 */

export const NATIVE_SEARCH_CHECKED = "2026-10-21";
export const OPENROUTER_WEB_SEARCH_DOC = "https://openrouter.ai/docs/guides/features/web-search";
export const OPENROUTER_MODELS_DOC = "https://openrouter.ai/docs/api/api-reference/models/get-models";
export const OPENAI_WEB_SEARCH_DOC = "https://developers.openai.com/api/docs/guides/tools-web-search";
export const OPENAI_PRICING_DOC = "https://developers.openai.com/api/docs/pricing";
export const ANTHROPIC_WEB_SEARCH_DOC = "https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool";
export const ANTHROPIC_MODELS_DOC = "https://platform.claude.com/docs/en/models/overview";

/** OpenRouter's Exa engine: $0.007 per request with up to 10 results (web-search guide, 2026-10-21). */
export const OPENROUTER_EXA_USD_PER_REQUEST = 0.007;
/**
 * OpenAI lists web search at $10 per 1k calls (reasoning models) and $25 per 1k calls
 * (non-reasoning preview) and does not say which row a Chat Completions search model pays; the
 * higher is recorded so a reservation never falls short.
 */
export const OPENAI_SEARCH_MODEL_USD_PER_CALL = 0.025;
/** Anthropic: $10 per 1,000 searches (web search tool guide, 2026-10-21). */
export const ANTHROPIC_USD_PER_SEARCH = 0.01;
/** The basic server tool version: it is called directly (no code execution needed) on every model that supports web search. */
export const ANTHROPIC_WEB_SEARCH_TOOL = "web_search_20250305";

/** What one request carries when its native search is on (set by the gate, read by the provider adapters). */
export interface NativeSearchRequest {
  via: NativeWebSearchVia;
  alwaysOn: boolean;
  engine?: "native" | "exa";
  /** Most searches (Anthropic `max_uses`). */
  maxUses: number;
  /** Results per search (OpenRouter plugin `max_results`). */
  maxResults: number;
}

/** What a model list says about web search, normalized across providers. */
export interface ListedWebSearch {
  /** The provider's metadata says the model can search inside the call. */
  supported: boolean;
  /** USD per search the list states (OpenRouter `pricing.web_search`); null when it states none. */
  usdPerSearch: number | null;
  /** USD per request the list states (OpenRouter `pricing.request`); null when it states none. */
  usdPerRequest: number | null;
  detail: string;
}

/** OpenAI models that search on every request ("Chat Completions search models always search before responding"). */
const OPENAI_SEARCH_MODEL = /(^|\/)gpt-[\w.-]*-search-(preview|api)([-:].*)?$/i;
/** Perplexity's models on OpenRouter: native search by default (OpenRouter web-search guide); SwitchYard never turns it off. */
const OPENROUTER_PERPLEXITY = /^perplexity\//i;

/**
 * An endpoint's native web search from documented facts and its provider's model metadata, or
 * null when nothing says it has one. User overrides apply later, in the catalog.
 */
export function detectNativeWebSearch(providerId: string, modelId: string, listed: ListedWebSearch | null | undefined): NativeWebSearch | null {
  const listedPrice = listed?.usdPerSearch ?? null;
  if (OPENAI_SEARCH_MODEL.test(modelId) && (providerId === "openai" || providerId === "openrouter")) {
    const price = listedPrice ?? OPENAI_SEARCH_MODEL_USD_PER_CALL;
    return {
      via: "always_on",
      usdPerSearch: price,
      priceDetail: listedPrice !== null ? `${providerId} model list pricing.web_search` : `OpenAI pricing: higher web search row ($25 per 1k calls); ${OPENAI_PRICING_DOC}`,
      source: "registry",
      detail: "OpenAI: Chat Completions search models always search before responding",
      sourceUrl: OPENAI_WEB_SEARCH_DOC,
      checkedAt: NATIVE_SEARCH_CHECKED,
    };
  }
  if (providerId === "openrouter" && OPENROUTER_PERPLEXITY.test(modelId)) {
    const price = listedPrice ?? (listed?.usdPerRequest && listed.usdPerRequest > 0 ? listed.usdPerRequest : null);
    return {
      via: "always_on",
      usdPerSearch: price,
      priceDetail: listedPrice !== null ? "OpenRouter pricing.web_search" : price !== null ? "OpenRouter pricing.request (one search per request assumed)" : "not listed: set it in an override",
      source: "registry",
      detail: "OpenRouter: Perplexity models search natively by default; SwitchYard never sends the switch that turns it off",
      sourceUrl: OPENROUTER_WEB_SEARCH_DOC,
      checkedAt: NATIVE_SEARCH_CHECKED,
    };
  }
  if (!listed?.supported) return null;
  if (providerId === "openrouter") {
    return {
      via: "openrouter_plugin",
      engine: "native",
      usdPerSearch: listedPrice,
      priceDetail: listedPrice !== null ? "OpenRouter pricing.web_search (USD per web search)" : "not listed: counts as paid with an unknown price",
      source: "discovery",
      detail: listed.detail,
      sourceUrl: OPENROUTER_MODELS_DOC,
      checkedAt: NATIVE_SEARCH_CHECKED,
    };
  }
  if (providerId === "anthropic") {
    return {
      via: "anthropic_server_tool",
      usdPerSearch: ANTHROPIC_USD_PER_SEARCH,
      priceDetail: `Anthropic: $10 per 1,000 searches (${ANTHROPIC_WEB_SEARCH_DOC})`,
      source: "discovery",
      detail: listed.detail,
      sourceUrl: ANTHROPIC_MODELS_DOC,
      checkedAt: NATIVE_SEARCH_CHECKED,
    };
  }
  return null;
}

// ---- request switches ----

/** Fields added to an OpenAI-compatible chat body to turn native search on. */
export function openAiSearchFields(s: NativeSearchRequest | undefined): Record<string, unknown> {
  if (!s) return {};
  if (s.via === "openrouter_plugin") return { plugins: [{ id: "web", engine: s.engine ?? "native", max_results: s.maxResults }] };
  if (s.via === "openai_web_search_options") return { web_search_options: {} };
  return {};
}

/** The Anthropic server tool, or null when the request does not use it. */
export function anthropicSearchTool(s: NativeSearchRequest | undefined): Record<string, unknown> | null {
  if (s?.via !== "anthropic_server_tool") return null;
  return { type: ANTHROPIC_WEB_SEARCH_TOOL, name: "web_search", max_uses: s.maxUses };
}

// ---- responses (untrusted) ----

const MAX_CITATIONS = 50;
const clip = (s: unknown, n: number): string | null => (typeof s === "string" && s.trim() ? (s.length > n ? `${s.slice(0, n)}...` : s) : null);

const UrlCitationSchema = z.object({ type: z.literal("url_citation"), url_citation: z.object({ url: z.string(), title: z.unknown().optional(), content: z.unknown().optional() }) });
const AnthropicCitationSchema = z.object({ type: z.literal("web_search_result_location"), url: z.string(), title: z.unknown().optional(), cited_text: z.unknown().optional() });

function addCitation(out: WebCitation[], seen: Set<string>, url: string, title: unknown, text: unknown): void {
  if (out.length >= MAX_CITATIONS || !/^https?:\/\//i.test(url)) return;
  const u = url.slice(0, 2000);
  const key = `${u}\n${typeof text === "string" ? text.slice(0, 80) : ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ url: u, title: clip(title, 300), text: clip(text, 300) });
}

/** Citations from an OpenAI-style message (`message.annotations` of type `url_citation`: OpenAI and OpenRouter). */
export function openAiCitations(message: unknown): WebCitation[] {
  const anns = (message as { annotations?: unknown } | null)?.annotations;
  if (!Array.isArray(anns)) return [];
  const out: WebCitation[] = [];
  const seen = new Set<string>();
  for (const a of anns) {
    const r = UrlCitationSchema.safeParse(a);
    if (r.success) addCitation(out, seen, r.data.url_citation.url, r.data.url_citation.title, r.data.url_citation.content);
  }
  return out;
}

/** Citations from Anthropic text blocks (`citations` of type `web_search_result_location`). */
export function anthropicCitations(blocks: unknown): WebCitation[] {
  if (!Array.isArray(blocks)) return [];
  const out: WebCitation[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const cites = (b as { type?: unknown; citations?: unknown }).type === "text" ? (b as { citations?: unknown }).citations : null;
    if (!Array.isArray(cites)) continue;
    for (const c of cites) {
      const r = AnthropicCitationSchema.safeParse(c);
      if (r.success) addCitation(out, seen, r.data.url, r.data.title, r.data.cited_text);
    }
  }
  return out;
}

/** `usage.server_tool_use.web_search_requests` (Anthropic; OpenRouter's server tool), or null. */
export function reportedSearches(usage: unknown): number | null {
  const n = (usage as { server_tool_use?: { web_search_requests?: unknown } } | null | undefined)?.server_tool_use?.web_search_requests;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The outcome to attach to a response. Without a reported count, an always-on model or a
 * once-per-request plugin is assumed to have searched once; a model that decides for itself
 * (Anthropic's server tool) and reports nothing counts as one search when it cited sources.
 */
export function searchOutcome(s: NativeSearchRequest, reported: number | null, citations: WebCitation[]): NativeWebSearchOutcome {
  const assumed = s.via === "anthropic_server_tool" ? (citations.length ? 1 : 0) : 1;
  return { via: s.via, alwaysOn: s.alwaysOn, requests: reported ?? assumed, requestsBasis: reported !== null ? "provider_reported" : "assumed", citations };
}
