import { GatewayError } from "../core/errors.js";
import type { ChatRequest, ChatResponse, GatewayTelemetry, InferenceClient, ProviderStatus } from "./types.js";
import { normalizeOpenAiUsage } from "./types.js";

/**
 * FreeLLMAPI resolves these `auto:<suffix>` names to a sort over the whole enabled catalog
 * before it looks up a profile of the same name (verified at server v0.2.1,
 * services/router.ts GLOBAL_SORT_ALIASES). They can never be used as curated pools.
 */
export const FREELLMAPI_GLOBAL_ALIASES = new Set([
  "smart",
  "smartest",
  "intelligence",
  "fast",
  "fastest",
  "speed",
  "cheap",
  "cheapest",
  "price",
  "budget",
  "reliable",
  "reliability",
  "balanced",
]);

/** Returns a reason when `model` is not a safe curated pool name for FreeLLMAPI. */
export function unsafePoolName(model: string): string | null {
  const m = /^auto:(.+)$/.exec(model);
  if (!m || !m[1]!.trim()) return `${model} is not an auto:<chain> name; raw ids and bare "auto" bypass curated chains`;
  if (FREELLMAPI_GLOBAL_ALIASES.has(m[1]!.trim().toLowerCase())) {
    return `${model} resolves to a whole-catalog sort in FreeLLMAPI, not a curated chain`;
  }
  return null;
}

export interface FreeLlmApiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  bypassCache: boolean;
  fetchImpl?: typeof fetch;
}

/** Headers kept for audit. Never includes credentials. */
const AUDIT_HEADERS = [
  "x-request-id",
  "x-routed-via",
  "x-fallback-attempts",
  "x-fallback-trail",
  "x-freellm-cache",
  "x-freellm-routing-strategy",
  "x-freellm-compress",
  "retry-after",
];

/** Error codes FreeLLMAPI emits before any upstream attempt (fallback-loop routingExhaustionBody). */
const PRE_ATTEMPT_CODES = new Set(["routing_exhausted", "quota_exceeded", "no_providers_configured"]);

export class FreeLlmApiClient implements InferenceClient {
  readonly name = "freellmapi";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FreeLlmApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  providers(): Promise<ProviderStatus[]> {
    return fetchProviders(this.opts.baseUrl, this.opts.apiKey, this.fetchImpl);
  }

  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const unsafe = unsafePoolName(req.model);
    if (unsafe) throw new GatewayError("policy_violation", unsafe, undefined, undefined, false);

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.max_tokens,
      stream: false,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length ? { tools: req.tools, tool_choice: req.tool_choice ?? "auto" } : {}),
      ...(req.response_format ? { response_format: req.response_format } : {}),
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (this.opts.bypassCache) headers["x-freellm-cache"] = "bypass";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new GatewayError("aborted", "request aborted by caller", undefined, undefined, true);
      if (timeout.aborted) throw new GatewayError("timeout", `gateway timed out after ${this.opts.timeoutMs} ms`, undefined, undefined, true);
      // Connection refused etc. never reached a provider.
      throw new GatewayError("transport", `cannot reach gateway: ${(err as Error).message}`, undefined, undefined, false);
    }

    const telemetry = readTelemetry(res.headers);
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      if (!res.ok) throw classifyError(res.status, {}, telemetry, res.headers);
      throw new GatewayError("server", `gateway returned non-JSON body (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) throw classifyError(res.status, json, telemetry, res.headers);

    const routedVia = json._routed_via as { platform?: string; model?: string } | undefined;
    if (typeof json.model === "string") telemetry.servedModel = json.model;
    else if (routedVia?.model) telemetry.servedModel = routedVia.model;
    if (routedVia?.platform) telemetry.servedProvider = routedVia.platform;

    const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) throw new GatewayError("server", "gateway response has no choices", res.status);
    const message = (choice.message ?? {}) as { content?: string | null; tool_calls?: ChatResponse["message"]["tool_calls"] };
    const usage = normalizeOpenAiUsage(json.usage);
    // FreeLLMAPI fills a chars/4 estimate flagged `estimated: true` when the upstream omits usage.
    if ((json.usage as Record<string, unknown> | undefined)?.estimated === true) usage.basis = "unknown";

    return {
      message: { content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage,
      telemetry,
      httpStatus: res.status,
    };
  }
}

export async function fetchProviders(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ProviderStatus[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/providers`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new GatewayError(res.status === 401 ? "auth" : "server", `GET /v1/providers: HTTP ${res.status}`, res.status, undefined, false);
  const body = (await res.json()) as { providers?: Array<Record<string, unknown>> };
  return (body.providers ?? []).map((p) => ({
    platform: String(p.platform),
    status: (["healthy", "rate_limited", "invalid", "unknown"].includes(String(p.status)) ? p.status : "unknown") as ProviderStatus["status"],
    keys: typeof p.keys === "number" ? p.keys : 0,
    resumeAt: typeof p.resume_at === "string" ? Date.parse(p.resume_at) : null,
    requestsRemainingPct: typeof p.requests_remaining_pct === "number" ? p.requests_remaining_pct : null,
    lastError: typeof p.last_error === "string" ? p.last_error : null,
  }));
}

function readTelemetry(h: Headers): GatewayTelemetry {
  const headers: Record<string, string> = {};
  for (const name of AUDIT_HEADERS) {
    const v = h.get(name);
    if (v !== null) headers[name] = v.slice(0, 2000);
  }
  const routed = headers["x-routed-via"];
  let servedProvider: string | null = null;
  let servedModel: string | null = null;
  let cacheHit: boolean | null = null;
  if (routed === "cache" || routed === "idempotency") {
    cacheHit = true;
  } else if (routed) {
    const slash = routed.indexOf("/");
    servedProvider = slash > 0 ? routed.slice(0, slash) : null;
    servedModel = slash > 0 ? routed.slice(slash + 1) : routed;
    cacheHit = false;
  }
  const failedHops = headers["x-fallback-attempts"] !== undefined ? Number(headers["x-fallback-attempts"]) : NaN;
  return {
    servedModel,
    servedProvider,
    // X-Fallback-Attempts counts failed hops before the served one. The gateway reports it
    // after the fact; provider-internal retries are not visible, so it is never exact.
    providerAttempts: cacheHit ? 0 : Number.isFinite(failedHops) ? failedHops + 1 : null,
    providerAttemptsExact: false,
    cacheHit,
    headers,
  };
}

function classifyError(status: number, json: Record<string, unknown>, telemetry: GatewayTelemetry, h: Headers): GatewayError {
  const err = (json.error ?? {}) as { message?: string; type?: string; code?: string; retryAtMs?: number };
  const msg = `gateway HTTP ${status}${err.code ? ` ${err.code}` : ""}: ${err.message ?? "no message"}`;
  const retryAfterHeader = h.get("retry-after");
  let retryAfterMs: number | undefined;
  if (typeof err.retryAtMs === "number") retryAfterMs = Math.max(0, err.retryAtMs - Date.now());
  else if (retryAfterHeader && /^\d+$/.test(retryAfterHeader)) retryAfterMs = Number(retryAfterHeader) * 1000;

  const attempted = (telemetry.providerAttempts ?? 0) > 0;
  const preAttempt = err.code !== undefined && PRE_ATTEMPT_CODES.has(err.code);
  // An upstream attempt may have consumed quota unless the gateway says it never dispatched.
  const consumed = !preAttempt && (attempted || err.code !== undefined);

  if (status === 401 || status === 403) return new GatewayError("auth", msg, status, undefined, false);
  if (status === 400 && /profile|model/i.test(err.message ?? "")) return new GatewayError("unknown_model", msg, status, undefined, false);
  if (status === 404) return new GatewayError("unknown_model", msg, status, undefined, false);
  if (status === 413) return new GatewayError("bad_request", msg, status, undefined, consumed);
  if (status === 429) {
    // No code: FreeLLMAPI's own proxy rate limiter, which never reaches a provider.
    const kind = err.code === "rate_limit_exceeded" && !attempted ? "rate_limited" : err.code ? "pool_exhausted" : "rate_limited";
    return new GatewayError(kind, msg, status, retryAfterMs, err.code ? consumed : false);
  }
  if (status === 503 || (status === 502 && err.code === "provider_authentication_failed")) {
    return new GatewayError(err.code === "provider_authentication_failed" ? "auth" : "pool_exhausted", msg, status, retryAfterMs, consumed);
  }
  if (status >= 400 && status < 500) return new GatewayError("bad_request", msg, status, undefined, consumed);
  return new GatewayError("server", msg, status, retryAfterMs, consumed);
}
