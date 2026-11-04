import { createHash } from "node:crypto";
import { NativeContinuationSchema, type ChatMessage, type ChatToolCall, type ContentPart } from "../gateway/types.js";
import { AnthropicModelProtocolSchema } from "../models/catalog.js";
import { errorInOkBody, ProviderError } from "./errors.js";
import { auditHeaders } from "./rate-limits.js";
import { chatUrl, requestHeaders, type ResolvedProvider } from "./registry.js";
import { requestJson, type FetchLike } from "./transport.js";
import type { ProviderRequest, ProviderResponse } from "./client.js";
import { anthropicCitations, anthropicSearchTool, reportedSearches, searchOutcome } from "./native-search.js";

type AnthropicBlock = Record<string, unknown> & { type: string; cache_control?: { type: "ephemeral" } };

/** A prompt-cache breakpoint (default five-minute lifetime). */
const EPHEMERAL = { type: "ephemeral" } as const;
/** Anthropic allows at most this many `cache_control` breakpoints per request (prompt-caching docs, 2026-10-21). */
export const MAX_CACHE_BREAKPOINTS = 4;

const thinking = (block: AnthropicBlock) => block.type === "thinking" || block.type === "redacted_thinking";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const withoutCache = ({ cache_control: _cache, ...block }: Record<string, unknown>) => block;
/** Cache annotations are not Anthropic's signed prefix; tool inputs/schema values still are. */
function prefixDigest(system: unknown, tools: unknown, messages: unknown): string {
  const text = typeof system === "string" ? system : Array.isArray(system) ? system.map(block => block.text ?? "").join("") : "";
  const normalized = { system: text, tools: Array.isArray(tools) ? tools.map(withoutCache) : [], messages: Array.isArray(messages) ? messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(withoutCache) : message.content })) : [] };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

/** Current native metadata, never model names or a provider-wide forced-tool downgrade. */
function alwaysAdaptive(req: Pick<ProviderRequest, "provider" | "model" | "anthropicProtocol">): boolean {
  const parsed = AnthropicModelProtocolSchema.safeParse(req.anthropicProtocol);
  if (!parsed.success || req.provider.api !== "anthropic" || req.provider.baseUrl !== "https://api.anthropic.com/v1") return false;
  const p = parsed.data;
  return p.provider === req.provider.id && p.baseUrl === req.provider.baseUrl && p.model === req.model
    && Date.parse(p.checkedAt) <= Date.now() && p.thinking.supported === true && p.thinking.adaptive === true && p.thinking.enabled === false && p.thinking.disabled === false;
}

function projection(blocks: AnthropicBlock[]) {
  return { content: blocks.filter(b => b.type === "text").map(b => b.text).join("") || null,
    tool_calls: blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) };
}

function imageBlock(url: string): AnthropicBlock {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } } : { type: "image", source: { type: "url", url } };
}

/** Convert OpenAI-style messages to Anthropic Messages API format. */
export function toAnthropic(messages: ChatMessage[], context?: { provider: ResolvedProvider; tools?: Array<Record<string, unknown>> }): { system: string; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    else if (m.role === "user") {
      const parts: ContentPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      push("user", parts.map((p) => (p.type === "text" ? { type: "text" as const, text: p.text || " " } : imageBlock(p.image_url.url))));
    } else if (m.role === "assistant") {
      const state = NativeContinuationSchema.safeParse(m.nativeContinuation);
      if (state.success && context && state.data.routeProvider === context.provider.id && state.data.baseUrl === context.provider.baseUrl) {
        // state.model records the producing model, not permission for the target model.
        // Anthropic explicitly requires retaining signed history across model switches;
        // its API validates signatures and drops blocks the target cannot read. An exact
        // model-name filter here would permanently lose compatible reasoning on fallback.
        // https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#switching-models-mid-conversation
        const native = state.data.content as AnthropicBlock[], visible = projection(native);
        const unchanged = canonical(visible) === canonical({ content: m.content, tool_calls: m.tool_calls ?? [] });
        if (unchanged) {
          const intact = state.data.prefixDigest === prefixDigest(system, context.tools, out);
          // An explicit client history rewrite invalidates this and every later thinking
          // block. Preserve an unbroken valid run, never edit signed blocks or restore gaps.
          push("assistant", structuredClone(intact ? native : native.filter(b => !thinking(b))));
          continue;
        }
      }
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
  return { system, messages: out };
}

/**
 * Build the Messages API body. Exported for tests.
 *
 * With `promptCache: cache_control` the body carries up to three breakpoints, in render order:
 * the last tool (tools never change within a run), the system prompt, and the last block of the
 * newest message (turns only append, so the next request reads everything before it from the
 * cache). A prefix shorter than the model's minimum is simply not cached; the API does not fail.
 */
export function buildAnthropicBody(req: Pick<ProviderRequest, "model" | "chat" | "provider" | "webSearch" | "anthropicProtocol">): Record<string, unknown> {
  const cache = req.provider.promptCache === "cache_control";
  const tools: Array<Record<string, unknown>> | undefined = req.chat.tools?.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const adaptive = alwaysAdaptive(req);
  const mapped = adaptive && req.chat.tool_choice === "required" ? "auto" : req.provider.toolChoice[req.chat.tool_choice ?? "auto"];
  const server = anthropicSearchTool(req.webSearch);
  const nativeTools = [...(server ? [server] : []), ...(tools ?? [])];
  const conv = toAnthropic(req.chat.messages, { provider: req.provider, tools: nativeTools });
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
    if (last?.content.length && marks < MAX_CACHE_BREAKPOINTS && !thinking(last.content[last.content.length - 1]!)) {
      const i = last.content.length - 1;
      last.content[i] = { ...last.content[i]!, cache_control: EPHEMERAL };
    }
  }
  // Native web search: the server tool goes first, so the cache breakpoint stays on the last client tool.
  return {
    model: req.model,
    max_tokens: req.chat.max_tokens,
    ...(system !== undefined ? { system } : {}),
    messages: conv.messages,
    ...(req.chat.temperature !== undefined && !adaptive ? { temperature: req.chat.temperature } : {}),
    ...(tools?.length ? { tools: [...(server ? [server] : []), ...tools], ...(mapped !== null ? { tool_choice: { type: mapped } } : {}) } : server ? { tools: [server] } : {}),
  };
}

export async function completeAnthropic(fetchFn: FetchLike, req: ProviderRequest, now: () => number): Promise<ProviderResponse> {
  const p = req.provider;
  const body = buildAnthropicBody(req);
  const res = await requestJson(
    fetchFn,
    { provider: p.id, url: chatUrl(p, req.credential.accountId ?? p.accountId), headers: requestHeaders(p, req.credential.apiKey), body, timeoutMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}), rateLimitHeaders: p.rateLimitHeaders },
    now,
  );
  const bodyError = errorInOkBody(p.id, res.json, res.status, res.rateLimits, "content");
  if (bodyError) throw bodyError;
  const json = (res.json ?? {}) as Record<string, unknown>;
  const native = NativeContinuationSchema.safeParse({ provider: "anthropic", routeProvider: p.id, baseUrl: p.baseUrl, model: typeof json.model === "string" ? json.model : req.model,
    prefixDigest: prefixDigest(body.system, body.tools, body.messages), content: json.content ?? [] });
  if (!native.success || native.data.content.some(block => block.type === "text" && typeof block.text !== "string"
    || block.type === "tool_use" && (typeof block.id !== "string" || typeof block.name !== "string")))
    throw new ProviderError("server", "Anthropic returned invalid or oversized native content; signed content cannot be truncated", { provider: p.id, status: res.status, possiblyConsumed: true, rateLimits: res.rateLimits });
  const continuation = native.data;
  const blocks = continuation.content as AnthropicBlock[];
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
    message: { content: text || null, ...(calls.length ? { tool_calls: calls } : {}), nativeContinuation: continuation },
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
