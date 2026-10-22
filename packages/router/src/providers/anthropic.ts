import type { ChatMessage, ChatToolCall, ContentPart } from "../gateway/types.js";
import { errorInOkBody } from "./errors.js";
import { auditHeaders } from "./rate-limits.js";
import { chatUrl, requestHeaders } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";
import type { ProviderRequest, ProviderResponse } from "./client.js";
import { anthropicCitations, anthropicSearchTool, reportedSearches, searchOutcome } from "./native-search.js";

type AnthropicBlock = (
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
) & { cache_control?: { type: "ephemeral" } };

/** A prompt-cache breakpoint (default five-minute lifetime). */
const EPHEMERAL = { type: "ephemeral" } as const;
/** Anthropic allows at most this many `cache_control` breakpoints per request (prompt-caching docs, 2026-10-21). */
export const MAX_CACHE_BREAKPOINTS = 4;

function imageBlock(url: string): AnthropicBlock {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } } : { type: "image", source: { type: "url", url } };
}

/** Convert OpenAI-style messages to Anthropic Messages API format. */
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
  const system: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") system.push(m.content);
    else if (m.role === "user") {
      const parts: ContentPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      push("user", parts.map((p) => (p.type === "text" ? { type: "text" as const, text: p.text || " " } : imageBlock(p.image_url.url))));
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = { _raw: c.function.arguments };
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      push("assistant", blocks);
    } else push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
  }
  return { system: system.join("\n\n"), messages: out };
}

/**
 * Build the Messages API body. Exported for tests.
 *
 * With `promptCache: cache_control` the body carries up to three breakpoints, in render order:
 * the last tool (tools never change within a run), the system prompt, and the last block of the
 * newest message (turns only append, so the next request reads everything before it from the
 * cache). A prefix shorter than the model's minimum is simply not cached; the API does not fail.
 */
export function buildAnthropicBody(req: Pick<ProviderRequest, "model" | "chat" | "provider" | "webSearch">): Record<string, unknown> {
  const conv = toAnthropic(req.chat.messages);
  const cache = req.provider.promptCache === "cache_control";
  const tools: Array<Record<string, unknown>> | undefined = req.chat.tools?.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const mapped = req.provider.toolChoice[req.chat.tool_choice ?? "auto"];
  let system: unknown = conv.system || undefined;
  let marks = 0;
  if (cache) {
    if (tools?.length) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL };
      marks++;
    }
    if (conv.system) {
      system = [{ type: "text", text: conv.system, cache_control: EPHEMERAL }];
      marks++;
    }
    const last = conv.messages[conv.messages.length - 1];
    if (last?.content.length && marks < MAX_CACHE_BREAKPOINTS) {
      const i = last.content.length - 1;
      last.content[i] = { ...last.content[i]!, cache_control: EPHEMERAL };
    }
  }
  // Native web search: the server tool goes first, so the cache breakpoint stays on the last client tool.
  const server = anthropicSearchTool(req.webSearch);
  return {
    model: req.model,
    max_tokens: req.chat.max_tokens,
    ...(system !== undefined ? { system } : {}),
    messages: conv.messages,
    ...(req.chat.temperature !== undefined ? { temperature: req.chat.temperature } : {}),
    ...(tools?.length ? { tools: [...(server ? [server] : []), ...tools], ...(mapped !== null ? { tool_choice: { type: mapped } } : {}) } : server ? { tools: [server] } : {}),
  };
}

export async function completeAnthropic(fetchFn: FetchLike, req: ProviderRequest, now: () => number): Promise<ProviderResponse> {
  const p = req.provider;
  const res = await requestJson(
    fetchFn,
    { provider: p.id, url: chatUrl(p, req.credential.accountId ?? p.accountId), headers: requestHeaders(p, req.credential.apiKey), body: buildAnthropicBody(req), timeoutMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}), rateLimitHeaders: p.rateLimitHeaders },
    now,
  );
  const bodyError = errorInOkBody(p.id, res.json, res.status, res.rateLimits, "content");
  if (bodyError) throw bodyError;
  const json = (res.json ?? {}) as Record<string, unknown>;
  const blocks = (json.content as AnthropicBlock[] | undefined) ?? [];
  const text = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
  const calls: ChatToolCall[] = blocks
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const ordinary = tokens(u.input_tokens);
  const cacheRead = tokens(u.cache_read_input_tokens);
  const cacheWrite = tokens(u.cache_creation_input_tokens);
  const stop = json.stop_reason === "tool_use" ? "tool_calls" : json.stop_reason === "max_tokens" ? "length" : "stop";
  return {
    message: { content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: stop,
    usage: {
      // Anthropic's input_tokens excludes cache reads and writes; the total is their sum.
      inputTokens: ordinary === null ? null : ordinary + (cacheRead ?? 0) + (cacheWrite ?? 0),
      outputTokens: tokens(u.output_tokens),
      cachedInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      reasoningTokens: null,
      reportedCostUsd: null,
      basis: ordinary !== null ? "provider_reported" : "unknown",
    },
    telemetry: { servedModel: typeof json.model === "string" ? json.model : null, servedProvider: p.id, providerAttempts: 1, providerAttemptsExact: true, cacheHit: ordinary !== null ? (cacheRead ?? 0) > 0 : null, headers: auditHeaders(res.headers) },
    httpStatus: res.status,
    rateLimits: res.rateLimits,
    ...(req.webSearch ? { webSearch: searchOutcome(req.webSearch, reportedSearches(json.usage), anthropicCitations(json.content)) } : {}),
  };
}
