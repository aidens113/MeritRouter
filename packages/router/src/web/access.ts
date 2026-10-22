import { randomBytes } from "node:crypto";
import type { Db } from "../storage/db.js";
import type { RoleName, WebConfig } from "../config/schema.js";
import type { FetchLike } from "../providers/transport.js";
import type { ProviderCredentials } from "../providers/credentials.js";
import type { ResolvedProvider } from "../providers/registry.js";
import { rootUrl } from "../providers/registry.js";
import type { KeyVault } from "../providers/vault.js";
import { maskSecrets } from "../providers/secret-masking.js";
import { checkWebUrl, SsrfRefusal, type Resolver } from "./address-guard.js";
import { ollamaFetch, searchWith, SEARCH_SERVICE_BASE, WebBackendError, type BackendIO, type FetchResult, type SearchResult, type SearchTarget } from "./backends.js";
import { WebBackendState, type WebKeyState } from "./backend-state.js";
import { fetchPage, type PageTransport } from "./page-fetch.js";
import { utcDayStart, utcMonth, WebLedger, type AttemptInput, type WebRequestKind } from "./ledger.js";
import { isSearchService, WEB_SEARCH_BACKENDS, type SearchServiceId, type WebFetchBackend, type WebSearchBackend } from "./services.js";

/**
 * Agents' web access as a pool of backends, the way SwitchYard treats model providers: every
 * configured search backend serves (`web.search.backends`, `auto` = all of them), chosen by
 * `web.search.strategy` (`spread`: least recently used first, so free allowances add up;
 * `fallback`: in order). A call that fails moves on to the next backend within the same tool call,
 * each backend at most once. Each backend key has persisted health (cooling, invalid, out of
 * credits), several keys of one backend rotate, and optional per-backend caps skip a backend until
 * its window resets. Fetching is a chain (`web.fetch.backends`, builtin then ollama); a URL the
 * SSRF guard refuses never reaches any backend. Budgets per task and per day count tool calls.
 */

/** The provider whose keys give Ollama's web search and fetch. */
export const OLLAMA_WEB_PROVIDER = "ollama-cloud";

/** Event recorded on the task for each web tool call (`tasks.event`). */
export const WEB_REQUEST_EVENT = "web_request";

export interface WebAccessDeps {
  /** The live config object (`web` is read on every call, so reloads apply). */
  cfg: { web: WebConfig };
  db: Db;
  providers: { credentials(): ProviderCredentials; provider(id: string): ResolvedProvider | null; vault: KeyVault | null };
  env?: Readonly<Record<string, string | undefined>>;
  /** Fetch for the search and fetch APIs (tests inject a fake). */
  fetch?: FetchLike;
  /** The built-in page fetch's transport and resolver (tests inject fakes). */
  page?: { transport?: PageTransport; resolve?: Resolver };
  event?: (taskId: string | null, type: string, data: unknown) => void;
  now?: () => number;
}

/** One key of one backend, ready to send with (the secret never leaves this module). */
interface BackendKey {
  backend: WebSearchBackend;
  /** `<backend>:<key>`, e.g. `tavily:vault:3`, `ollama:config:ollama-cloud:env:OLLAMA_API_KEY`, `searxng`. */
  ref: string;
  label: string;
  last4: string;
  target: SearchTarget;
  secret: string | null;
}

export type WebBackendStatus = "healthy" | "cooling" | "invalid" | "out_of_credits" | "capped" | "unconfigured" | "builtin";

export interface WebKeyView {
  ref: string;
  label: string;
  last4: string;
  state: WebKeyState["status"];
  until: number | null;
  lastUsedAt: number | null;
  lastError: string | null;
  /** May be tried now. */
  available: boolean;
}

export interface WebBackendView {
  backend: WebSearchBackend | WebFetchBackend;
  /** Has a key (or, for SearXNG, a base URL; the built-in fetch always). */
  configured: boolean;
  /** Why it is not configured. */
  missing: string | null;
  status: WebBackendStatus;
  /** When a cooling, out-of-credits, or capped backend is back (the earliest key). */
  until: number | null;
  keys: WebKeyView[];
  requestsToday: number;
  requestsThisMonth: number;
  cap: { perDay: number | null; perMonth: number | null };
}

export interface WebStatus {
  /** `web.enabled` and at least one search backend configured: agents get the tools. */
  on: boolean;
  /** Why the tools are off (null when on). */
  reason: string | null;
  strategy: WebConfig["search"]["strategy"];
  /** The search pool in configured order (auto expanded). */
  search: WebBackendView[];
  /** The fetch chain in order. */
  fetch: WebBackendView[];
  /** Backends named in the config that have no key: skipped (doctor warns). */
  warnings: string[];
  roles: RoleName[];
  budgets: { perTask: number; perDay: number };
  /** Web tool calls today, install-wide. */
  usedToday: number;
}

export interface WebCaller {
  taskId: string | null;
  sessionId?: string | null;
  signal?: AbortSignal;
}

/** One attempt in a call, for the tool output and the event. */
export interface WebAttempt {
  backend: string;
  ok: boolean;
  /** rate_limited, auth_invalid, out_of_credits, server, ssrf, ... */
  errorKind?: string;
  error?: string;
}

export class WebAccess {
  readonly ledger: WebLedger;
  readonly state: WebBackendState;
  private readonly now: () => number;

  constructor(private readonly d: WebAccessDeps) {
    this.now = d.now ?? Date.now;
    this.ledger = new WebLedger(d.db, this.now);
    this.state = new WebBackendState(d.db, this.now);
  }

  private get web(): WebConfig {
    return this.d.cfg.web;
  }

  private env(): Readonly<Record<string, string | undefined>> {
    return this.d.env ?? process.env;
  }

  private io(signal?: AbortSignal): BackendIO {
    return { fetch: this.d.fetch ?? ((url, init) => fetch(url, init)), timeoutMs: this.web.fetch.timeout_seconds * 1000, now: this.now, ...(signal ? { signal } : {}) };
  }

  // ---------- keys ----------

  /** Every key a backend has (none: the reason it is unconfigured). */
  private keysOf(backend: WebSearchBackend): { keys: BackendKey[]; missing: string | null } {
    if (backend === "ollama") {
      const p = this.d.providers.provider(OLLAMA_WEB_PROVIDER);
      if (!p || !p.enabled) return { keys: [], missing: `the ${OLLAMA_WEB_PROVIDER} provider is disabled` };
      const creds = this.d.providers.credentials();
      const keys: BackendKey[] = [];
      for (const c of creds.usable(OLLAMA_WEB_PROVIDER)) {
        if (c.source === "none") continue;
        const apiKey = creds.requestCredential(c.ref).apiKey;
        if (apiKey) keys.push({ backend, ref: `ollama:${c.ref}`, label: c.label, last4: c.last4, target: { backend, baseUrl: rootUrl(p.baseUrl), apiKey }, secret: apiKey });
      }
      return { keys, missing: keys.length ? null : `no usable ${OLLAMA_WEB_PROVIDER} key` };
    }
    if (backend === "searxng") {
      const url = this.web.search.searxng?.base_url;
      return url ? { keys: [{ backend, ref: "searxng", label: url, last4: "", target: { backend, baseUrl: url.replace(/\/+$/, ""), apiKey: null }, secret: null }], missing: null } : { keys: [], missing: "web.search.searxng.base_url is not set" };
    }
    const id: SearchServiceId = backend;
    const conf = this.web.search[id];
    const base = conf?.base_url?.replace(/\/+$/, "") ?? SEARCH_SERVICE_BASE[id];
    const keys: BackendKey[] = [];
    const key = (ref: string, label: string, secret: string): BackendKey => ({ backend, ref: `${id}:${ref}`, label, last4: secret.slice(-4), target: { backend, baseUrl: base, apiKey: secret }, secret });
    if (conf?.api_key_env) {
      const v = this.env()[conf.api_key_env];
      if (v) keys.push(key(`env:${conf.api_key_env}`, conf.api_key_env, v));
    } else if (conf?.api_key) keys.push(key("config", `web.search.${id}.api_key`, conf.api_key));
    const vault = this.d.providers.vault;
    for (const k of vault?.usable(id) ?? []) keys.push(key(`vault:${k.id}`, k.label || `key ${k.id}`, vault!.secret(k.id)));
    return { keys, missing: keys.length ? null : `no ${id} key${conf?.api_key_env ? ` (environment variable ${conf.api_key_env} is not set)` : ""}` };
  }

  /** The search pool in configured order: `auto` expands to every backend not listed elsewhere. */
  private pool(): WebSearchBackend[] {
    if (!this.web.enabled) return [];
    const listed = this.web.search.backends;
    const named = new Set(listed.filter((b): b is WebSearchBackend => b !== "auto"));
    const out: WebSearchBackend[] = [];
    for (const b of listed) {
      if (b === "auto") out.push(...WEB_SEARCH_BACKENDS.filter((x) => !named.has(x)));
      else out.push(b);
    }
    return out;
  }

  private cap(backend: string): { perDay: number | null; perMonth: number | null; cappedUntil: number | null; today: number; month: number } {
    const lim = (this.web.search.limits as Partial<Record<string, { per_day?: number | undefined; per_month?: number | undefined }>>)[backend];
    const now = this.now();
    const day = utcDayStart(now);
    const month = utcMonth(now);
    const today = this.ledger.backendCount(backend, day);
    const monthCount = this.ledger.backendCount(backend, month.start);
    let cappedUntil: number | null = null;
    if (lim?.per_month !== undefined && monthCount >= lim.per_month) cappedUntil = month.next;
    else if (lim?.per_day !== undefined && today >= lim.per_day) cappedUntil = day + 86_400_000;
    return { perDay: lim?.per_day ?? null, perMonth: lim?.per_month ?? null, cappedUntil, today, month: monthCount };
  }

  private keyViews(keys: BackendKey[]): Array<WebKeyView & { key: BackendKey }> {
    return keys.map((k) => {
      const s = this.state.get(k.ref, k.backend, k.secret);
      return { key: k, ref: k.ref, label: k.label, last4: k.last4, state: s.status, until: s.until, lastUsedAt: s.lastUsedAt, lastError: s.lastError, available: this.state.available(s) };
    });
  }

  private view(backend: WebSearchBackend): WebBackendView & { usable: Array<WebKeyView & { key: BackendKey }> } {
    const { keys, missing } = this.keysOf(backend);
    const kv = this.keyViews(keys);
    const c = this.cap(backend);
    const usable = kv.filter((k) => k.available);
    let status: WebBackendStatus;
    let until: number | null = null;
    const earliest = (ks: typeof kv) => Math.min(...ks.map((k) => k.until ?? Infinity));
    if (!keys.length) status = "unconfigured";
    else if (c.cappedUntil !== null) {
      status = "capped";
      until = c.cappedUntil;
    } else if (usable.length) status = "healthy";
    else if (kv.some((k) => k.state === "cooling")) {
      status = "cooling";
      until = earliest(kv.filter((k) => k.state === "cooling"));
    } else if (kv.some((k) => k.state === "out_of_credits")) {
      status = "out_of_credits";
      until = earliest(kv.filter((k) => k.state === "out_of_credits"));
    } else status = "invalid";
    const keyViews = kv.map(({ key: _k, ...v }) => v);
    return { backend, configured: keys.length > 0, missing, status, until: Number.isFinite(until) ? until : null, keys: keyViews, requestsToday: c.today, requestsThisMonth: c.month, cap: { perDay: c.perDay, perMonth: c.perMonth }, usable: status === "healthy" ? usable : [] };
  }

  private fetchChain(): WebFetchBackend[] {
    return this.web.enabled ? [...this.web.fetch.backends] : [];
  }

  private fetchView(backend: WebFetchBackend): WebBackendView {
    if (backend === "ollama") {
      const { usable: _u, ...v } = this.view("ollama");
      return v;
    }
    const c = this.cap("builtin");
    return { backend, configured: true, missing: null, status: "builtin", until: null, keys: [], requestsToday: c.today, requestsThisMonth: c.month, cap: { perDay: null, perMonth: null } };
  }

  status(): WebStatus {
    const search = this.pool().map((b) => {
      const { usable: _u, ...v } = this.view(b);
      return v;
    });
    const named = new Set(this.web.search.backends.filter((b) => b !== "auto"));
    const warnings = search.filter((v) => !v.configured && named.has(v.backend as WebSearchBackend)).map((v) => `${v.backend} is listed in web.search.backends but ${v.missing}: it is skipped`);
    if (this.web.fetch.backends.includes("ollama") && this.web.enabled) {
      const o = this.keysOf("ollama");
      if (!o.keys.length && !this.web.search.backends.includes("auto") && !named.has("ollama")) warnings.push(`ollama is in web.fetch.backends but ${o.missing}: it is skipped`);
    }
    const on = this.web.enabled && search.some((v) => v.configured);
    return {
      on,
      reason: !this.web.enabled ? "web.enabled is false" : on ? null : search.length ? "no search backend has a key: add an ollama-cloud key, a Tavily, Brave, or Exa key, or web.search.searxng.base_url" : "web.search.backends is empty",
      strategy: this.web.search.strategy,
      search,
      fetch: this.fetchChain().map((b) => this.fetchView(b)),
      warnings,
      roles: [...this.web.roles],
      budgets: { perTask: this.web.max_requests_per_task, perDay: this.web.max_requests_per_day },
      usedToday: this.ledger.dayCount(),
    };
  }

  /** Whether `role` gets the web tools: web is on, the role is listed, and some search backend has a key. */
  enabledFor(role: RoleName): boolean {
    if (!this.web.enabled || !this.web.roles.includes(role)) return false;
    return this.pool().some((b) => this.keysOf(b).keys.length > 0);
  }

  /** Forget a backend key's health (a re-enabled or replaced key), by its pool ref. */
  clearKey(ref: string): void {
    this.state.clear(ref);
  }

  /** Forget the health of the web side of a provider key (an `ollama-cloud` key re-enabled or replaced). */
  clearProviderKey(credentialRef: string): void {
    this.state.clear(`ollama:${credentialRef}`);
  }

  /** Forget a search-service vault key's health. */
  clearSearchKey(service: string, vaultId: number): void {
    if (isSearchService(service)) this.state.clear(`${service}:vault:${vaultId}`);
  }

  // ---------- calls ----------

  /** The least recently used key that may be tried now. */
  private pick(keys: Array<WebKeyView & { key: BackendKey }>): BackendKey {
    return [...keys].sort((a, b) => (a.lastUsedAt ?? -1) - (b.lastUsedAt ?? -1))[0]!.key;
  }

  /**
   * One tool call's attempts: reserve the call against the budgets on its first attempt, then try
   * each candidate until one answers. Returns the value and every attempt made.
   */
  private async attempts<C, T>(
    caller: WebCaller,
    kind: WebRequestKind,
    target: string,
    candidates: C[],
    describe: (c: C) => { backend: string; key: BackendKey | null },
    run: (c: C) => Promise<T>,
    measure: (v: T) => { results?: number; bytes?: number },
  ): Promise<{ value: T; backend: string; attempts: WebAttempt[] }> {
    const callId = `w_${randomBytes(8).toString("hex")}`;
    const tried: WebAttempt[] = [];
    let reserved = false;
    const started = this.now();
    const finish = (ok: boolean, extra: Record<string, unknown> = {}) =>
      this.d.event?.(caller.taskId, WEB_REQUEST_EVENT, { callId, kind, target, status: ok ? "ok" : "error", attempts: tried, ms: this.now() - started, ...extra });
    for (const c of candidates) {
      if (caller.signal?.aborted) break;
      const { backend, key } = describe(c);
      const input: AttemptInput = { callId, taskId: caller.taskId, sessionId: caller.sessionId ?? null, kind, backend, keyRef: key?.ref ?? null, target };
      let id: number;
      if (!reserved) {
        const r = this.ledger.reserve(input, { perTask: this.web.max_requests_per_task, perDay: this.web.max_requests_per_day });
        if (!r.ok) {
          this.d.event?.(caller.taskId, WEB_REQUEST_EVENT, { callId, kind, target, status: "refused", reason: r.reason });
          throw new Error(r.reason);
        }
        reserved = true;
        id = r.id;
      } else id = this.ledger.attempt(input);
      if (key) this.state.touch(key.ref, key.backend, key.secret);
      try {
        const value = await run(c);
        const m = measure(value);
        this.ledger.settle(id, { ok: true, ...m });
        if (key) this.state.succeeded(key.ref, key.backend, key.secret);
        tried.push({ backend, ok: true });
        finish(true, { backend, ...m });
        return { value, backend, attempts: tried };
      } catch (err) {
        const ssrf = err instanceof SsrfRefusal;
        const reason = ssrf ? "ssrf" : err instanceof WebBackendError ? err.reason : "error";
        const message = maskSecrets((err as Error).message, [key?.secret]);
        this.ledger.settle(id, { ok: false, error: message, errorKind: reason });
        if (key && err instanceof WebBackendError) this.state.failed(key.ref, key.backend, key.secret, err.reason, message, err.retryAfterMs);
        tried.push({ backend, ok: false, errorKind: reason, error: message });
        // A refused URL is never sent anywhere else; a cancelled call stops.
        if (ssrf || reason === "aborted" || caller.signal?.aborted) break;
      }
    }
    finish(false);
    const last = tried.at(-1);
    if (last?.errorKind === "ssrf") throw new SsrfRefusal(last.error ?? "refused");
    if (caller.signal?.aborted) throw new Error("aborted");
    throw new Error(`web ${kind} failed on every backend: ${tried.map((t) => `${t.backend}: ${t.errorKind}: ${t.error}`).join("; ")}`);
  }

  /** Why nothing can be tried now, backend by backend. */
  private unavailable(views: WebBackendView[]): string {
    const at = (t: number | null) => (t ? ` until ${new Date(t).toISOString()}` : "");
    return views.map((v) => `${v.backend} ${v.status === "unconfigured" ? `(${v.missing})` : `${v.status.replace("_", " ")}${at(v.until)}`}`).join("; ");
  }

  async search(caller: WebCaller, query: string, maxResults: number): Promise<{ backend: WebSearchBackend; results: SearchResult[]; attempts: WebAttempt[] }> {
    const q = query.trim();
    if (!q) throw new Error("query is required");
    if (q.length > 400) throw new Error("query is too long (at most 400 characters)");
    const views = this.pool().map((b) => this.view(b));
    if (!views.some((v) => v.configured)) throw new Error(`web search is off: ${this.status().reason}`);
    let ready = views.filter((v) => v.usable.length);
    if (this.web.search.strategy === "spread") {
      // Least recently used backend first (a never-used backend before any used one); ties keep the configured order.
      const last = (v: (typeof ready)[number]) => Math.max(-1, ...v.keys.map((k) => k.lastUsedAt ?? -1));
      ready = ready.map((v, i) => ({ v, i })).sort((a, b) => last(a.v) - last(b.v) || a.i - b.i).map((x) => x.v);
    }
    if (!ready.length) throw new Error(`no web search backend can serve now: ${this.unavailable(views)}`);
    const max = Math.max(1, Math.min(this.web.max_results, Math.floor(maxResults) || this.web.max_results));
    const r = await this.attempts(
      caller,
      "search",
      q,
      ready.map((v) => this.pick(v.usable)),
      (k) => ({ backend: k.backend, key: k }),
      (k) => searchWith(k.target, q, max, this.io(caller.signal)),
      (v) => ({ results: v.length }),
    );
    return { backend: r.backend as WebSearchBackend, results: r.value, attempts: r.attempts };
  }

  async fetch(caller: WebCaller, url: string): Promise<{ backend: WebFetchBackend; page: FetchResult & { truncated: boolean }; attempts: WebAttempt[] }> {
    // Checked before anything is sent or counted: http(s) only, no local or private hosts.
    const u = checkWebUrl(url.trim());
    if (!this.status().on) throw new Error(`web access is off: ${this.status().reason}`);
    const cap = this.web.fetch.max_bytes;
    type Candidate = { backend: "builtin" } | { backend: "ollama"; key: BackendKey };
    const chain: Candidate[] = [];
    const skipped: WebBackendView[] = [];
    for (const b of this.fetchChain()) {
      if (b === "builtin") chain.push({ backend: "builtin" });
      else {
        const v = this.view("ollama");
        if (v.usable.length) chain.push({ backend: "ollama", key: this.pick(v.usable) });
        else skipped.push(v);
      }
    }
    if (!chain.length) throw new Error(`no web fetch backend can serve now${skipped.length ? `: ${this.unavailable(skipped)}` : " (web.fetch.backends is empty)"}`);
    const r = await this.attempts(
      caller,
      "fetch",
      u.href,
      chain,
      (c) => ({ backend: c.backend, key: c.backend === "ollama" ? c.key : null }),
      async (c) => {
        if (c.backend === "ollama") {
          const p = await ollamaFetch(c.key.target.baseUrl, c.key.target.apiKey!, u.href, this.io(caller.signal));
          return { ...p, content: p.content.slice(0, cap), truncated: p.content.length > cap, bytes: Buffer.byteLength(p.content) };
        }
        const p = await fetchPage(u.href, { timeoutMs: this.web.fetch.timeout_seconds * 1000, maxBytes: cap, maxRedirects: this.web.fetch.max_redirects, ...(this.d.page?.transport ? { transport: this.d.page.transport } : {}), ...(this.d.page?.resolve ? { resolve: this.d.page.resolve } : {}), ...(caller.signal ? { signal: caller.signal } : {}) });
        return { url: p.url, title: p.title, content: p.content, links: p.links, truncated: p.truncated, bytes: p.bytes };
      },
      (v) => ({ bytes: v.bytes }),
    );
    const p = r.value;
    return { backend: r.backend as WebFetchBackend, page: { url: p.url, title: p.title, content: p.content, links: p.links, truncated: p.truncated }, attempts: r.attempts };
  }
}
