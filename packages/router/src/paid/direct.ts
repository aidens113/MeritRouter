import type { PaidProviderConfig } from "../config/schema.js";
import type { ChatRequest, ChatResponse } from "../gateway/types.js";
import { createProviderClient, type ProviderClient } from "../providers/client.js";
import { paidProviderAsDirect } from "../providers/runtime.js";

// Paid requests go through the direct-provider path (gateway/direct.ts) since direct providers
// P2. This module keeps the old paid-client interface as a seam for callers and tests that
// still inject one; p2-remove retires it with the FreeLLMAPI code.
export { toAnthropic } from "../providers/anthropic.js";

export interface DirectRequest {
  providerName: string;
  provider: PaidProviderConfig;
  apiKey: string;
  model: string;
  chat: Omit<ChatRequest, "model">;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Direct paid-provider calls: exactly one HTTP attempt per request, no SDK retries. */
export interface DirectClient {
  complete(req: DirectRequest): Promise<ChatResponse>;
}

const client = createProviderClient();

export const httpDirectClient: DirectClient = {
  async complete(req) {
    const { rateLimits: _rateLimits, ...res } = await client.complete({
      provider: paidProviderAsDirect(req.providerName, req.provider),
      credential: { apiKey: req.apiKey },
      model: req.model,
      chat: req.chat,
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return { ...res, telemetry: { ...res.telemetry, servedProvider: `paid:${req.providerName}` } };
  },
};

/**
 * An injected `DirectClient` as a provider client: it serves the providers declared under
 * `paid.providers`; every other provider goes to `fallback`.
 */
export function directClientAsProviderClient(direct: DirectClient, paidProviders: () => Readonly<Record<string, PaidProviderConfig>>, fallback: ProviderClient, now: () => number = Date.now): ProviderClient {
  return {
    async complete(req) {
      const provider = paidProviders()[req.provider.id];
      if (!provider) return fallback.complete(req);
      const res = await direct.complete({
        providerName: req.provider.id,
        provider,
        apiKey: req.credential.apiKey ?? "",
        model: req.model,
        chat: req.chat,
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return { ...res, rateLimits: { family: "none", observedAt: now(), retryAfterMs: null, windows: [] } };
    },
  };
}
