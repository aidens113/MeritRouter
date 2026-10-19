import { GatewayError } from "../core/errors.js";
import type { PaidProviderConfig } from "../config/schema.js";
import type { ChatMessage, ChatRequest, ChatResponse, ChatToolCall, ContentPart } from "../gateway/types.js";
import { normalizeOpenAiUsage } from "../gateway/types.js";

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

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after");
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

function classify(status: number, body: string, h: Headers): GatewayError {
  const msg = `provider HTTP ${status}: ${body.slice(0, 400)}`;
  if (status === 401 || status === 403) return new GatewayError("auth", msg, status, undefined, false);
  if (status === 404) return new GatewayError("unknown_model", msg, status, undefined, false);
  if (status === 429) return new GatewayError("rate_limited", msg, status, retryAfterMs(h), false);
  if (status === 402) return new GatewayError("pool_exhausted", `${msg} (out of credits)`, status, undefined, false);
  if (status >= 400 && status < 500) return new GatewayError("bad_request", msg, status, undefined, false);
  // 5xx and 529 (overloaded): the provider may or may not have billed; treat as possibly consumed.
  return new GatewayError("server", msg, status, retryAfterMs(h), true);
}

async function post(url: string, headers: Record<string, string>, body: unknown, req: DirectRequest): Promise<{ json: Record<string, unknown>; headers: Headers; status: number }> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (req.signal?.aborted) throw new GatewayError("aborted", "request aborted by caller", undefined, undefined, true);
    if (timeout.aborted) throw new GatewayError("timeout", `provider timed out after ${req.timeoutMs} ms`, undefined, undefined, true);
    // A dropped connection can happen after the provider started generating: assume billed.
    throw new GatewayError("transport", `cannot reach provider: ${(err as Error).message}`, undefined, undefined, true);
  }
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text, res.headers);
  try {
    return { json: JSON.parse(text) as Record<string, unknown>, headers: res.headers, status: res.status };
  } catch {
    throw new GatewayError("server", "provider returned non-JSON body", res.status, undefined, true);
  }
}

function telemetry(provider: string, model: string | null): ChatResponse["telemetry"] {
  return { servedModel: model, servedProvider: `paid:${provider}`, providerAttempts: 1, providerAttemptsExact: true, cacheHit: false, headers: {} };
}

async function openAiCompatible(req: DirectRequest): Promise<ChatResponse> {
  const isOpenRouter = /openrouter\.ai/.test(req.provider.base_url);
  const body = {
    model: req.model,
    messages: req.chat.messages,
    max_tokens: req.chat.max_tokens,
    stream: false,
    ...(req.chat.temperature !== undefined ? { temperature: req.chat.temperature } : {}),
    ...(req.chat.tools?.length ? { tools: req.chat.tools, tool_choice: req.chat.tool_choice ?? "auto" } : {}),
    ...(req.chat.response_format ? { response_format: req.chat.response_format } : {}),
    // OpenRouter: report the billed cost and never fall back to another (possibly pricier) model.
    ...(isOpenRouter ? { usage: { include: true }, models: undefined, route: undefined, provider: { allow_fallbacks: false } } : {}),
  };
  const { json, status } = await post(`${req.provider.base_url.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${req.apiKey}` }, body, req);
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!choice) throw new GatewayError("server", "provider response has no choices", status, undefined, true);
  const message = (choice.message ?? {}) as { content?: string | null; tool_calls?: ChatToolCall[] };
  const usage = normalizeOpenAiUsage(json.usage, (json.usage as Record<string, unknown> | undefined)?.cost);
  return {
    message: { content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage,
    telemetry: telemetry(req.providerName, typeof json.model === "string" ? json.model : null),
    httpStatus: status,
  };
}

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

async function anthropic(req: DirectRequest): Promise<ChatResponse> {
  const conv = toAnthropic(req.chat.messages);
  const tools = req.chat.tools?.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  const choice = req.chat.tool_choice === "required" ? { type: "any" } : req.chat.tool_choice === "none" ? { type: "none" } : { type: "auto" };
  const body = {
    model: req.model,
    max_tokens: req.chat.max_tokens,
    ...(conv.system ? { system: conv.system } : {}),
    messages: conv.messages,
    ...(req.chat.temperature !== undefined ? { temperature: req.chat.temperature } : {}),
    ...(tools?.length ? { tools, tool_choice: choice } : {}),
  };
  const { json, status } = await post(`${req.provider.base_url.replace(/\/$/, "")}/v1/messages`, { "x-api-key": req.apiKey, "anthropic-version": "2023-06-01" }, body, req);
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
    telemetry: telemetry(req.providerName, typeof json.model === "string" ? json.model : null),
    httpStatus: status,
  };
}

export const httpDirectClient: DirectClient = {
  complete(req) {
    return req.provider.kind === "anthropic" ? anthropic(req) : openAiCompatible(req);
  },
};
