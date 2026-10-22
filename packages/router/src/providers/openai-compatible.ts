import type { ChatMessage, ChatToolCall } from "../gateway/types.js";
import { normalizeOpenAiUsage } from "../gateway/types.js";
import { errorInOkBody, ProviderError } from "./errors.js";
import { auditHeaders } from "./rate-limits.js";
import { chatUrl, requestHeaders, type ResolvedProvider } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";
import type { ProviderRequest, ProviderResponse } from "./client.js";
import { openAiCitations, openAiSearchFields, reportedSearches, searchOutcome } from "./native-search.js";

/**
 * Extra OpenAI request parameters a caller may pass in `ProviderRequest.params`. Anything else
 * is dropped. `n` is never sent: SwitchYard reads only the first choice (and Groq and Cerebras
 * require n = 1).
 */
export const PASS_THROUGH_PARAMS: ReadonlySet<string> = new Set(["seed", "top_p", "stop", "presence_penalty", "frequency_penalty", "parallel_tool_calls", "logprobs", "top_logprobs", "logit_bias", "user"]);

function mapMessages(p: ResolvedProvider, messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (p.imagesBase64Only && m.role === "user" && Array.isArray(m.content)) {
      const remote = m.content.find((part) => part.type === "image_url" && !part.image_url.url.startsWith("data:"));
      if (remote) throw new ProviderError("bad_request", `${p.id} accepts only base64 (data:) images`, { provider: p.id, possiblyConsumed: false });
    }
    if (p.stripMessageName && "name" in m) {
      const { name: _name, ...rest } = m as ChatMessage & { name?: unknown };
      return rest;
    }
    return m;
  });
}

/** Build the chat-completions body with the provider's rules applied. Exported for tests and probes. */
export function buildOpenAiBody(p: ResolvedProvider, req: Pick<ProviderRequest, "model" | "chat" | "params" | "cacheKey" | "webSearch">): Record<string, unknown> {
  const { chat } = req;
  const body: Record<string, unknown> = { model: req.model, messages: mapMessages(p, chat.messages), stream: false, [p.tokenLimitParam]: chat.max_tokens };
  if (chat.temperature !== undefined) body.temperature = p.temperatureMax !== null ? Math.min(chat.temperature, p.temperatureMax) : chat.temperature;
  const hasTools = Boolean(chat.tools?.length);
  if (hasTools) {
    body.tools = chat.tools;
    const choice = p.toolChoice[chat.tool_choice ?? "auto"];
    if (choice !== null) body.tool_choice = choice;
  }
  // Structured output is validated locally anyway; drop it where the provider cannot combine it with tools.
  if (chat.response_format && (!hasTools || p.structuredOutputWithTools)) body.response_format = chat.response_format;
  for (const [k, v] of Object.entries(req.params ?? {})) {
    if (v === undefined || !PASS_THROUGH_PARAMS.has(k) || p.unsupportedParams.includes(k)) continue;
    if (k === "parallel_tool_calls" && !hasTools) continue;
    body[p.renameParams[k] ?? k] = v;
  }
  // One key per conversation routes its requests to the same cache (only where documented).
  if (p.promptCache === "prompt_cache_key" && req.cacheKey) body.prompt_cache_key = req.cacheKey;
  // Native web search: the provider's own switch (OpenRouter's web plugin, web_search_options).
  return { ...body, ...openAiSearchFields(req.webSearch), ...p.bodyExtras };
}

export async function completeOpenAiCompatible(fetchFn: FetchLike, req: ProviderRequest, now: () => number): Promise<ProviderResponse> {
  const p = req.provider;
  const accountId = req.credential.accountId ?? p.accountId;
  const res = await requestJson(
    fetchFn,
    { provider: p.id, url: chatUrl(p, accountId), headers: requestHeaders(p, req.credential.apiKey), body: buildOpenAiBody(p, req), timeoutMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}), rateLimitHeaders: p.rateLimitHeaders },
    now,
  );
  const bodyError = errorInOkBody(p.id, res.json, res.status, res.rateLimits, "choices");
  if (bodyError) throw bodyError;
  const json = (res.json ?? {}) as Record<string, unknown>;
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!choice) throw new ProviderError("server", `${p.id} response has no choices`, { provider: p.id, status: res.status, possiblyConsumed: true, rateLimits: res.rateLimits });
  const message = (choice.message ?? {}) as { content?: string | null; tool_calls?: ChatToolCall[] };
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (finishReason === "content_filter" && !message.content && !message.tool_calls?.length) {
    throw new ProviderError("policy", `${p.id} withheld the response (content_filter)`, { provider: p.id, status: res.status, possiblyConsumed: true, rateLimits: res.rateLimits });
  }
  const usage = (json.usage ?? undefined) as Record<string, unknown> | undefined;
  const normalized = normalizeOpenAiUsage(usage, usage?.cost);
  return {
    message: { content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
    finishReason,
    usage: normalized,
    // A hit only when the provider reported cached tokens; unknown when it reports none.
    telemetry: { servedModel: typeof json.model === "string" ? json.model : null, servedProvider: p.id, providerAttempts: 1, providerAttemptsExact: true, cacheHit: normalized.cachedInputTokens === null ? null : normalized.cachedInputTokens > 0, headers: auditHeaders(res.headers) },
    httpStatus: res.status,
    rateLimits: res.rateLimits,
    ...(req.webSearch ? { webSearch: searchOutcome(req.webSearch, reportedSearches(usage), openAiCitations(choice.message)) } : {}),
  };
}
