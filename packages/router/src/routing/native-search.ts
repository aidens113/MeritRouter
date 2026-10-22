import type { ResolvedConfig } from "../config/load.js";
import type { ModelEndpoint } from "../models/catalog.js";
import type { NativeSearchRequest } from "../providers/native-search.js";

/**
 * Whether one request to one endpoint runs the provider's native web search, and what that may
 * cost (decision D9). An always-on model searches on every request. An optional search is turned
 * on only for a task that needs the web (`hints.web: true`), with `web.native.enabled`, at a known
 * price, and (when the price is above zero) only where paid routing is allowed for the request.
 */
export interface NativeSearchUse extends NativeSearchRequest {
  /** USD per search; null when unknown (only possible for an always-on model, which is then not routed). */
  usdPerSearch: number | null;
  /** The search costs money (a positive or unknown price): the request is paid. */
  charged: boolean;
  /** Searches reserved for the worst case. */
  maxSearches: number;
}

export interface NativeSearchContext {
  /** The task's `hints.web` (null or undefined: unset). */
  web: boolean | null | undefined;
  /** Paid routing is enabled and the request's paid policy is not `never`. */
  paidAllowed: boolean;
}

export function nativeSearchUse(ep: Pick<ModelEndpoint, "nativeWebSearch">, cfg: Pick<ResolvedConfig, "web">, ctx: NativeSearchContext): NativeSearchUse | null {
  const n = ep.nativeWebSearch;
  if (!n) return null;
  const native = cfg.web.native;
  // The plugin runs one search per request (OpenRouter's server tool, not used here, lets the model repeat).
  const maxSearches = n.via === "openrouter_plugin" ? 1 : native.max_searches_per_request;
  const base = { via: n.via, ...(n.engine ? { engine: n.engine } : {}), maxUses: native.max_searches_per_request, maxResults: native.max_results, usdPerSearch: n.usdPerSearch, maxSearches };
  if (n.via === "always_on") return { ...base, alwaysOn: true, charged: n.usdPerSearch !== 0 };
  if (ctx.web !== true || !native.enabled) return null;
  // An unknown price cannot be reserved: the search stays off (the agent's own web tools remain).
  if (n.usdPerSearch === null) return null;
  if (n.usdPerSearch > 0 && !ctx.paidAllowed) return null;
  return { ...base, alwaysOn: false, charged: n.usdPerSearch > 0 };
}

/** The endpoint searches the web on every request. */
export const alwaysSearches = (ep: Pick<ModelEndpoint, "nativeWebSearch">): boolean => ep.nativeWebSearch?.via === "always_on";
