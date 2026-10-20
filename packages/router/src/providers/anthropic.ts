import type { ChatMessage, ChatToolCall, ContentPart } from "../gateway/types.js";
import { errorInOkBody } from "./errors.js";
import { auditHeaders } from "./rate-limits.js";
import { chatUrl, requestHeaders } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";
import type { ProviderRequest, ProviderResponse } from "./client.js";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

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

/** Build the Messages API body. Exported for tests. */
export function buildAnthropicBody(req: Pick<ProviderRequest, "model" | "chat" | "provider">): Record<string, unknown> {
  const conv = toAnthropic(req.chat.messages);
  const tools = req.chat.tools?.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const mapped = req.provider.toolChoice[req.chat.tool_choice ?? "auto"];
  return {
    model: req.model,
    max_tokens: req.chat.max_tokens,
    ...(conv.system ? { system: conv.system } : {}),
    messages: conv.messages,
    ...(req.chat.temperature !== undefined ? { temperature: req.chat.temperature } : {}),
    ...(tools?.length ? { tools, ...(mapped !== null ? { tool_choice: { type: mapped } } : {}) } : {}),
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
  const u = (json.usage ?? {}) as Record<string, number | undefined>;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const stop = json.stop_reason === "tool_use" ? "tool_calls" : json.stop_reason === "max_tokens" ? "length" : "stop";
  return {
    message: { content: text || null, ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: stop,
    usage: {
      // Anthropic's input_tokens excludes cache reads and writes; the total is their sum.
      inputTokens: typeof u.input_tokens === "number" ? u.input_tokens + cacheRead + cacheWrite : null,
      outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
      cachedInputTokens: cacheRead || null,
      reasoningTokens: null,
      reportedCostUsd: null,
      basis: typeof u.input_tokens === "number" ? "provider_reported" : "unknown",
    },
    telemetry: { servedModel: typeof json.model === "string" ? json.model : null, servedProvider: p.id, providerAttempts: 1, providerAttemptsExact: true, cacheHit: false, headers: auditHeaders(res.headers) },
    httpStatus: res.status,
    rateLimits: res.rateLimits,
  };
}
