/**
 * Names of the web search and fetch backends. Kept free of imports so the config schema and the
 * provider credentials can use them without a cycle.
 */

/** Search-only services whose keys are stored like provider keys but never routed for chat. */
export const SEARCH_SERVICE_IDS = ["tavily", "brave", "exa"] as const;
export type SearchServiceId = (typeof SEARCH_SERVICE_IDS)[number];
export const isSearchService = (id: string): id is SearchServiceId => (SEARCH_SERVICE_IDS as readonly string[]).includes(id);

/** Every search backend, in the order `auto` uses them. */
export const WEB_SEARCH_BACKENDS = ["ollama", "tavily", "brave", "exa", "searxng"] as const;
export type WebSearchBackend = (typeof WEB_SEARCH_BACKENDS)[number];
/** `web.search.backends` entries: a backend, or `auto` (every usable backend in the default order). */
export const WEB_SEARCH_BACKEND_SETTINGS = ["auto", ...WEB_SEARCH_BACKENDS] as const;
export type WebSearchBackendSetting = (typeof WEB_SEARCH_BACKEND_SETTINGS)[number];

/**
 * `web.search.strategy`: `spread` starts each call at the least recently used healthy backend so
 * free allowances add up; `fallback` starts at the first. Either way a failed call moves on to the
 * next backend within the same tool call.
 */
export const WEB_SEARCH_STRATEGIES = ["spread", "fallback"] as const;
export type WebSearchStrategy = (typeof WEB_SEARCH_STRATEGIES)[number];

/** Page fetch backends: MeritRouter's own SSRF-guarded fetch, and Ollama's web_fetch. */
export const WEB_FETCH_BACKENDS = ["builtin", "ollama"] as const;
export type WebFetchBackend = (typeof WEB_FETCH_BACKENDS)[number];

/** What each search service is, for the panel and docs (no facts that change: no prices or limits). */
export const SEARCH_SERVICES: Record<SearchServiceId, { displayName: string; docsUrl: string; signupUrl: string; note: string }> = {
  tavily: { displayName: "Tavily", docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search", signupUrl: "https://app.tavily.com/", note: "free monthly credits" },
  brave: { displayName: "Brave Search", docsUrl: "https://api-dashboard.search.brave.com/app/documentation/web-search/get-started", signupUrl: "https://api-dashboard.search.brave.com/", note: "free monthly credit; Brave asks for attribution" },
  exa: { displayName: "Exa", docsUrl: "https://exa.ai/docs/reference/search", signupUrl: "https://dashboard.exa.ai/", note: "free monthly credit" },
};

export const WEB_BACKEND_NAMES: Record<WebSearchBackend | WebFetchBackend, string> = {
  ollama: "Ollama web search",
  tavily: "Tavily",
  brave: "Brave Search",
  exa: "Exa",
  searxng: "SearXNG",
  builtin: "Built-in fetch",
};
