import { ProviderEntrySchema, type PaidProviderConfig } from "../config/schema.js";
import type { ChatRequest, ChatResponse } from "../gateway/types.js";
import { createProviderClient } from "../providers/client.js";
import { builtinProvider, customProvider, defaultProvider, type ResolvedProvider } from "../providers/registry.js";

// The direct clients moved to src/providers/ (direct providers, P1). This shim keeps the paid
// route's interface and behaviour until P2 routes every request through the provider client.
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

/** The paid config as a provider: generic OpenAI-compatible (OpenRouter extras by URL) or Anthropic. */
function asProvider(name: string, cfg: PaidProviderConfig): ResolvedProvider {
  const base = cfg.base_url.replace(/\/+$/, "");
  if (cfg.kind === "anthropic") return { ...defaultProvider("anthropic")!, id: name, baseUrl: `${base}/v1` };
  const p = customProvider(name, ProviderEntrySchema.parse({ base_url: base }));
  return /openrouter\.ai/.test(base) ? { ...p, bodyExtras: builtinProvider("openrouter")!.bodyExtras } : p;
}

const client = createProviderClient();

export const httpDirectClient: DirectClient = {
  async complete(req) {
    const { rateLimits: _rateLimits, ...res } = await client.complete({
      provider: asProvider(req.providerName, req.provider),
      credential: { apiKey: req.apiKey },
      model: req.model,
      chat: req.chat,
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return { ...res, telemetry: { ...res.telemetry, servedProvider: `paid:${req.providerName}` } };
  },
};
