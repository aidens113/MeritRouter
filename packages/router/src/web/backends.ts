import { z } from "zod";
import { requestJson, type FetchLike } from "../providers/transport.js";
import { maskSecrets } from "../providers/secret-masking.js";
import { ProviderError, type ProviderErrorKind } from "../providers/errors.js";

/**
 * Web search and fetch backends. Each request and response shape was checked against the
 * service's own documentation (see docs/decisions.md, "Web search backends", checked
 * 2026-10-21). Responses are untrusted: they are validated with zod and capped before an agent
 * sees them, and keys never appear in an error message.
 */

import type { SearchServiceId, WebSearchBackend } from "./services.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  links: string[];
}

/** A configured search backend: where it is and the key it uses (null for SearXNG). */
export interface SearchTarget {
  backend: WebSearchBackend;
  /** Ollama: the server root (`https://ollama.com`); SearXNG: the instance URL. */
  baseUrl: string;
  apiKey: string | null;
}

export interface BackendIO {
  fetch: FetchLike;
  timeoutMs: number;
  now: () => number;
  signal?: AbortSignal;
}

const NO_HEADERS = { family: "none", requestsPeriod: "unknown", tokensPeriod: "unknown" } as const;
const SNIPPET_CHARS = 600;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = z.string().catch("");

/**
 * A web backend's failure, classified like a provider failure (429 rate limited, 401/403 invalid
 * key, 402 or a spend message out of credits, 5xx server, ...) so the pool can cool the backend,
 * mark its key, or move on. The message never carries the key.
 */
export class WebBackendError extends Error {
  constructor(
    readonly reason: ProviderErrorKind,
    message: string,
    /** The wait the backend asked for (retry-after or a reset header), when it named one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "WebBackendError";
  }
}

async function call(io: BackendIO, provider: string, url: string, headers: Record<string, string>, body: unknown, key: string | null): Promise<unknown> {
  try {
    const r = await requestJson(io.fetch, { provider, url, headers, ...(body === undefined ? {} : { body }), timeoutMs: io.timeoutMs, ...(io.signal ? { signal: io.signal } : {}), rateLimitHeaders: NO_HEADERS }, io.now);
    return r.json;
  } catch (err) {
    const message = maskSecrets((err as Error).message, [key]);
    if (err instanceof ProviderError) throw new WebBackendError(err.reason, message, err.retryAfterMs ?? null);
    throw new WebBackendError("transport", message);
  }
}

const OllamaSearch = z.object({ results: z.array(z.object({ title: str, url: str, content: str }).passthrough()).catch([]) }).passthrough();
const TavilySearch = z.object({ results: z.array(z.object({ title: str, url: str, content: str }).passthrough()).catch([]) }).passthrough();
const BraveSearch = z.object({ web: z.object({ results: z.array(z.object({ title: str, url: str, description: str }).passthrough()).catch([]) }).passthrough().optional() }).passthrough();
const ExaSearch = z
  .object({ results: z.array(z.object({ title: z.string().nullable().catch(""), url: str, text: str.optional(), highlights: z.array(z.string()).catch([]).optional(), summary: str.optional() }).passthrough()).catch([]) })
  .passthrough();
const SearxSearch = z.object({ results: z.array(z.object({ title: str, url: str, content: str }).passthrough()).catch([]) }).passthrough();
const OllamaFetch = z.object({ title: str, content: str, links: z.array(z.string()).catch([]) }).passthrough();

/** Strip tags a search API may leave in snippets (Brave marks matches with <strong>). */
const plain = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** One search through `target`, at most `max` results (1-10). */
export async function searchWith(target: SearchTarget, query: string, max: number, io: BackendIO): Promise<SearchResult[]> {
  const n = Math.max(1, Math.min(10, Math.floor(max)));
  let out: SearchResult[];
  switch (target.backend) {
    case "ollama": {
      // POST {root}/api/web_search {query, max_results (default 5, max 10)} -> {results: [{title, url, content}]}
      const j = OllamaSearch.parse(await call(io, "ollama web search", `${target.baseUrl}/api/web_search`, { authorization: `Bearer ${target.apiKey}` }, { query, max_results: n }, target.apiKey));
      out = j.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
      break;
    }
    case "tavily": {
      // POST https://api.tavily.com/search {query, max_results (0-20, default 10)} -> {results: [{title, url, content, score}]}
      const j = TavilySearch.parse(await call(io, "tavily", `${target.baseUrl}/search`, { authorization: `Bearer ${target.apiKey}` }, { query, max_results: n, search_depth: "basic" }, target.apiKey));
      out = j.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
      break;
    }
    case "brave": {
      // GET https://api.search.brave.com/res/v1/web/search?q=&count= (max 20) with X-Subscription-Token -> {web: {results: [{title, url, description}]}}
      const u = new URL(`${target.baseUrl}/res/v1/web/search`);
      u.searchParams.set("q", query);
      u.searchParams.set("count", String(n));
      const j = BraveSearch.parse(await call(io, "brave", u.href, { accept: "application/json", "x-subscription-token": target.apiKey ?? "" }, undefined, target.apiKey));
      out = (j.web?.results ?? []).map((r) => ({ title: plain(r.title), url: r.url, snippet: plain(r.description) }));
      break;
    }
    case "exa": {
      // POST https://api.exa.ai/search {query, numResults (1-100, default 10), contents} with x-api-key -> {results: [{title, url, text, highlights, summary}]}
      const j = ExaSearch.parse(await call(io, "exa", `${target.baseUrl}/search`, { "x-api-key": target.apiKey ?? "" }, { query, numResults: n, contents: { highlights: true } }, target.apiKey));
      out = j.results.map((r) => ({ title: r.title ?? "", url: r.url, snippet: (r.highlights?.length ? r.highlights.join(" … ") : r.summary || r.text) ?? "" }));
      break;
    }
    case "searxng": {
      // GET {instance}/search?q=&format=json (the json format must be enabled in the instance's settings.yml) -> {results: [{title, url, content}]}
      const u = new URL(`${target.baseUrl.replace(/\/+$/, "")}/search`);
      u.searchParams.set("q", query);
      u.searchParams.set("format", "json");
      const j = SearxSearch.parse(await call(io, "searxng", u.href, { accept: "application/json" }, undefined, null));
      out = j.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
      break;
    }
  }
  return out
    .filter((r) => /^https?:\/\//i.test(r.url))
    .slice(0, n)
    .map((r) => ({ title: clip(r.title.trim(), 300), url: clip(r.url, 2000), snippet: clip(r.snippet.trim(), SNIPPET_CHARS) }));
}

/** One page through Ollama's web_fetch: POST {root}/api/web_fetch {url} -> {title, content, links}. */
export async function ollamaFetch(baseUrl: string, apiKey: string, url: string, io: BackendIO): Promise<FetchResult> {
  const j = OllamaFetch.parse(await call(io, "ollama web fetch", `${baseUrl}/api/web_fetch`, { authorization: `Bearer ${apiKey}` }, { url }, apiKey));
  return { url, title: j.title, content: j.content, links: j.links.filter((l) => /^https?:\/\//i.test(l)).slice(0, 40) };
}

/** Default API roots of the keyed search services. */
export const SEARCH_SERVICE_BASE: Record<SearchServiceId, string> = {
  tavily: "https://api.tavily.com",
  brave: "https://api.search.brave.com",
  exa: "https://api.exa.ai",
};
