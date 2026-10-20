import type { ChatRequest, ChatResponse } from "../gateway/types.js";
import { completeAnthropic } from "./anthropic.js";
import { ProviderError } from "./errors.js";
import { completeOpenAiCompatible } from "./openai-compatible.js";
import type { RateLimitSnapshot } from "./rate-limits.js";
import type { ResolvedProvider } from "./registry.js";
import { maskProviderError } from "./secret-masking.js";
import type { FetchLike } from "./transport.js";

/** The secret and account for one request. `apiKey` is null only for keyless (local) providers. */
export interface RequestCredential {
  apiKey: string | null;
  /** The key's account id (Cloudflare); falls back to the provider's. */
  accountId?: string | null;
}

export interface ProviderRequest {
  provider: ResolvedProvider;
  credential: RequestCredential;
  /** The provider's own model id (no `<provider>/` prefix). */
  model: string;
  chat: Omit<ChatRequest, "model">;
  /** Extra OpenAI parameters (`seed`, `top_p`, ...): filtered and renamed by the provider's rules. */
  params?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** A chat response plus the rate-limit state the provider reported on it. */
export interface ProviderResponse extends ChatResponse {
  rateLimits: RateLimitSnapshot;
}

/**
 * One HTTP attempt per call, no retries: key rotation and fallback belong to the caller.
 * Failures throw `ProviderError` (a `GatewayError`) with a reason, retryability, and the
 * rate-limit snapshot when the provider answered; the key never appears in their messages.
 */
export interface ProviderClient {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export interface ProviderClientOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  now?: () => number;
}

export function createProviderClient(opts: ProviderClientOptions = {}): ProviderClient {
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  return {
    async complete(req) {
      const p = req.provider;
      // Refuse locally, before any HTTP, what the provider would reject: nothing is consumed.
      if (p.auth !== "none" && !req.credential.apiKey) throw new ProviderError("auth_invalid", `${p.id} needs an API key`, { provider: p.id, possiblyConsumed: false });
      if (p.urlParams.includes("account_id") && !(req.credential.accountId ?? p.accountId)) {
        throw new ProviderError("bad_request", `${p.id} needs an account id (set account_id on the key or provider)`, { provider: p.id, possiblyConsumed: false });
      }
      try {
        return await (p.api === "anthropic" ? completeAnthropic(fetchFn, req, now) : completeOpenAiCompatible(fetchFn, req, now));
      } catch (err) {
        // The transport masks what it sent; an error inside an HTTP 200 body is built after it returned.
        throw err instanceof ProviderError ? maskProviderError(err, [req.credential.apiKey]) : err;
      }
    },
  };
}
