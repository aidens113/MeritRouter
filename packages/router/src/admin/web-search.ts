import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { isSearchService, SEARCH_SERVICE_IDS, SEARCH_SERVICES, type SearchServiceId } from "../web/services.js";
import type { WebBackendStatus, WebBackendView, WebStatus } from "../web/access.js";
export type { WebAttempt, WebBackendStatus, WebBackendView, WebKeyView, WebStatus } from "../web/access.js";
import type { WebRequestRow } from "../web/ledger.js";

/**
 * The panel's (and `keys`') view of web search: which backend serves, the search-service keys
 * (vault and config, last four characters only), and recent web requests. Search-service keys
 * live in the vault under the service id and are never model credentials.
 */

export interface SearchKeyView {
  ref: string;
  /** Vault key id; null for a key declared in config. */
  id: number | null;
  service: SearchServiceId;
  label: string;
  source: "vault" | "config";
  last4: string;
  enabled: boolean;
  /** Why the key cannot be used; null when usable. */
  unusableReason: string | null;
  createdAt: number | null;
}

export interface SearchServiceView {
  id: SearchServiceId;
  displayName: string;
  docsUrl: string;
  signupUrl: string;
  note: string;
  /** `web.search.<id>.base_url`, when set. */
  baseUrl: string | null;
  keys: SearchKeyView[];
}

export interface WebSearchView {
  status: WebStatus;
  services: SearchServiceView[];
  searxngUrl: string | null;
  recent: WebRequestRow[];
  configPath: string;
}

/** Search-service keys of one service (or all): config first, then vault. No secret is included. */
export function searchKeys(sy: MeritRouter, service?: SearchServiceId): SearchKeyView[] {
  const out: SearchKeyView[] = [];
  const now = sy.providers.now();
  for (const id of service ? [service] : SEARCH_SERVICE_IDS) {
    const c = sy.cfg.web.search[id];
    if (c?.api_key_env) {
      const v = process.env[c.api_key_env];
      out.push({ ref: `config:${id}:env:${c.api_key_env}`, id: null, service: id, label: c.api_key_env, source: "config", last4: v ? v.slice(-4) : "", enabled: true, unusableReason: v ? null : `environment variable ${c.api_key_env} is not set`, createdAt: null });
    } else if (c?.api_key) {
      out.push({ ref: `config:${id}:literal`, id: null, service: id, label: "web.search api_key", source: "config", last4: c.api_key.slice(-4), enabled: true, unusableReason: null, createdAt: null });
    }
    for (const k of sy.vault.list(id)) {
      out.push({
        ref: `vault:${k.id}`,
        id: k.id,
        service: id,
        label: k.label || `key ${k.id}`,
        source: "vault",
        last4: k.last4,
        enabled: k.enabled,
        unusableReason: k.removed ? "removed" : !k.enabled ? "disabled" : k.expiresAt !== null && k.expiresAt <= now ? "expired" : null,
        createdAt: k.createdAt,
      });
    }
  }
  return out;
}

/** Everything the panel shows about web search. */
export function webSearchView(sy: MeritRouter, opts: { project?: string; recent?: number } = {}): WebSearchView {
  const keys = searchKeys(sy);
  // Split installations keep web state per project; a fresh one has no project to read yet.
  if (sy.layout === "split" && !sy.projects.slugs().length) {
    const cfg = sy.cfg.web;
    return {
      status: { on: false, reason: "no project yet: create one to use web search", strategy: cfg.search.strategy, search: [], fetch: [], warnings: [], roles: [],
        budgets: { perTask: cfg.max_requests_per_task, perDay: cfg.max_requests_per_day }, usedToday: 0 },
      services: SEARCH_SERVICE_IDS.map((id) => ({ id, ...SEARCH_SERVICES[id], baseUrl: cfg.search[id]?.base_url ?? null, keys: keys.filter((k) => k.service === id) })),
      searxngUrl: cfg.search.searxng?.base_url ?? null,
      recent: [],
      configPath: sy.cfg.configPath,
    };
  }
  return {
    status: sy.web.status(),
    services: SEARCH_SERVICE_IDS.map((id) => ({ id, ...SEARCH_SERVICES[id], baseUrl: sy.cfg.web.search[id]?.base_url ?? null, keys: keys.filter((k) => k.service === id) })),
    searxngUrl: sy.cfg.web.search.searxng?.base_url ?? null,
    recent: sy.web.ledger.recent(opts.recent ?? 25, opts.project),
    configPath: sy.cfg.configPath,
  };
}

/** A task's web searches and fetches, oldest first (the task page's usage). */
export function taskWebRequests(sy: MeritRouter, taskId: string): WebRequestRow[] {
  return sy.web.ledger.forTask(taskId);
}

export const NewSearchKeySchema = z
  .object({
    service: z.enum(SEARCH_SERVICE_IDS),
    secret: z.string().trim().min(8).max(500),
    label: z.string().max(80).default(""),
  })
  .strict();

/** Store a search-service key in the encrypted vault. */
export function addSearchKey(sy: MeritRouter, input: z.input<typeof NewSearchKeySchema>): SearchKeyView {
  const parsed = NewSearchKeySchema.safeParse(input);
  if (!parsed.success) throw new MeritRouterError("config_invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const k = sy.vault.add({ provider: parsed.data.service, secret: parsed.data.secret, label: parsed.data.label, billingClass: "free_tier" });
  return searchKeys(sy, parsed.data.service).find((v) => v.id === k.id)!;
}

function searchVaultKey(sy: MeritRouter, id: number) {
  const k = sy.vault.get(id);
  if (!k || !isSearchService(k.provider)) throw new MeritRouterError("not_found", `unknown search key ${id}`);
  return k;
}

export function setSearchKeyEnabled(sy: MeritRouter, id: number, enabled: boolean): SearchKeyView {
  const k = searchVaultKey(sy, id);
  if (k.removed) throw new MeritRouterError("config_invalid", `key ${id} was removed; add a new key instead`);
  sy.vault.update(id, { enabled });
  // Re-enabling is the user saying the key is fixed: clear its cooldown, invalid, or credits mark.
  if (enabled) sy.web.clearSearchKey(k.provider, id);
  return searchKeys(sy, k.provider as SearchServiceId).find((v) => v.id === id)!;
}

export function removeSearchKey(sy: MeritRouter, id: number): { removed: number } {
  searchVaultKey(sy, id);
  const k = sy.vault.get(id)!;
  sy.vault.remove(id);
  sy.web.clearSearchKey(k.provider, id);
  return { removed: id };
}

const STATUS_TEXT: Record<WebBackendStatus, string> = {
  healthy: "healthy",
  cooling: "cooling down",
  invalid: "INVALID key",
  out_of_credits: "out of credits",
  capped: "at its cap",
  unconfigured: "no key",
  builtin: "built in",
};

/** One backend as text: its state, when it is back, and its requests today and this month. */
export function webBackendText(v: WebBackendView): string {
  const until = v.until ? ` until ${new Date(v.until).toISOString().replace(/\.\d+Z$/, "Z")}` : "";
  const cap = [v.cap.perDay !== null ? `${v.cap.perDay}/day` : "", v.cap.perMonth !== null ? `${v.cap.perMonth}/month` : ""].filter(Boolean).join(", ");
  const keys = v.keys.length > 1 ? `, ${v.keys.length} keys` : "";
  return `${v.backend} ${STATUS_TEXT[v.status]}${until}${v.status === "unconfigured" && v.missing ? ` (${v.missing})` : ""}${keys} (${v.requestsToday} today, ${v.requestsThisMonth} this month${cap ? `; cap ${cap}` : ""})`;
}

/** Doctor's and the CLI's summary: the pool and chain, or how to turn web search on. */
export function webStatusText(s: WebStatus): string {
  if (!s.on) return `off: ${s.reason ?? "no backend"}`;
  const search = s.search.filter((v) => v.configured).map(webBackendText).join("; ");
  const fetch = s.fetch.filter((v) => v.configured).map((v) => (v.backend === "builtin" ? "builtin" : webBackendText(v))).join(" -> ");
  return `search (${s.strategy}): ${search}. Fetch: ${fetch || "none"}. Roles ${s.roles.join(", ") || "none"}; ${s.usedToday} of ${s.budgets.perDay} calls today, ${s.budgets.perTask} per task`;
}
