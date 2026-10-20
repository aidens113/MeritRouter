import { classifyProviderError, ProviderError } from "./errors.js";
import { parseRateLimitHeaders, type RateLimitSnapshot } from "./rate-limits.js";
import type { RateLimitHeaderSpec } from "./registry.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface HttpCall {
  provider: string;
  url: string;
  headers: Record<string, string>;
  /** JSON body for POST; omitted for GET. */
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  rateLimitHeaders: RateLimitHeaderSpec;
}

export interface HttpResult {
  json: unknown;
  headers: Headers;
  status: number;
  rateLimits: RateLimitSnapshot;
}

/**
 * One HTTP attempt, no retries. Non-2xx statuses become classified `ProviderError`s carrying
 * the rate-limit snapshot; timeouts, caller aborts, and network failures are classified too.
 */
export async function requestJson(fetchFn: FetchLike, call: HttpCall, now: () => number): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  const headers = call.body === undefined ? call.headers : { "content-type": "application/json", ...call.headers };
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(call.url, { method: call.body === undefined ? "GET" : "POST", headers, ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }), signal });
    text = await res.text();
  } catch (err) {
    if (call.signal?.aborted) throw new ProviderError("aborted", "request aborted by caller", { provider: call.provider, possiblyConsumed: true });
    if (timeout.aborted) throw new ProviderError("timeout", `${call.provider} timed out after ${call.timeoutMs} ms`, { provider: call.provider, possiblyConsumed: true });
    // A dropped connection can happen after the provider started generating: assume billed.
    throw new ProviderError("transport", `cannot reach ${call.provider}: ${(err as Error).message}`, { provider: call.provider, possiblyConsumed: true });
  }
  const rateLimits = parseRateLimitHeaders(res.headers, call.rateLimitHeaders, now());
  if (!res.ok) throw classifyProviderError(call.provider, res.status, text, rateLimits);
  try {
    return { json: JSON.parse(text) as unknown, headers: res.headers, status: res.status, rateLimits };
  } catch {
    throw new ProviderError("server", `${call.provider} returned a non-JSON body`, { provider: call.provider, status: res.status, possiblyConsumed: true, rateLimits });
  }
}
