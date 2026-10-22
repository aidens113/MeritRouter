/** Minimal OpenAI-compatible chat shapes used between the package and its provider clients. */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  /** The provider's model id, chosen by the gate from the catalog (never taken from a caller). */
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | "required";
  response_format?: { type: "json_object" } | { type: "json_schema"; json_schema: Record<string, unknown> };
}

export interface NormalizedUsage {
  /** Total prompt tokens as reported (cached tokens are a subset, not an addition). */
  inputTokens: number | null;
  /** Total completion tokens as reported (reasoning tokens are a subset). */
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Input written to prompt cache, a subset of total input; absent/null when unreported. */
  cacheCreationInputTokens?: number | null;
  reasoningTokens: number | null;
  reportedCostUsd: number | null;
  basis: "provider_reported" | "unknown";
}

export interface GatewayTelemetry {
  servedModel: string | null;
  servedProvider: string | null;
  /** Provider attempts behind this one request (1 for a direct call). */
  providerAttempts: number | null;
  /** True only when the attempt count comes from an authoritative source. */
  providerAttemptsExact: boolean;
  cacheHit: boolean | null;
  /** Provider headers kept for audit (subset; never includes credentials). */
  headers: Record<string, string>;
}

/** One source a provider cited for web content in its answer (untrusted data). */
export interface WebCitation {
  url: string;
  title: string | null;
  /** The cited passage, when the provider returns one (shortened). */
  text: string | null;
}

/**
 * Web search the provider ran inside this request (native web search). Present only when the
 * request had it on (or the model always searches). The answer is web-derived content.
 */
export interface NativeWebSearchOutcome {
  via: string;
  alwaysOn: boolean;
  /** Searches run: as the provider reported them, or assumed (one per request) when it reports none. */
  requests: number;
  requestsBasis: "provider_reported" | "assumed";
  citations: WebCitation[];
}

export interface ChatResponse {
  message: { content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: string | null;
  usage: NormalizedUsage;
  telemetry: GatewayTelemetry;
  httpStatus: number;
  webSearch?: NativeWebSearchOutcome;
}

export interface ProviderStatus {
  platform: string;
  status: "healthy" | "rate_limited" | "invalid" | "unknown";
  keys: number;
  resumeAt: number | null;
  requestsRemainingPct: number | null;
  lastError: string | null;
}

export function normalizeOpenAiUsage(usage: unknown, costUsd?: unknown): NormalizedUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const promptDetails = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const inputTokens = num(u.prompt_tokens);
  const outputTokens = num(u.completion_tokens);
  const cost = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: num(promptDetails.cached_tokens),
    reasoningTokens: num(completionDetails.reasoning_tokens),
    reportedCostUsd: cost,
    basis: inputTokens !== null || outputTokens !== null ? "provider_reported" : "unknown",
  };
}

/**
 * Conservative token estimate for admission (about 3 characters per token plus message
 * overhead). Used only where exact tokenization is unavailable; results are labelled estimated.
 */
export function estimateTokens(messages: ChatMessage[], tools?: ChatTool[]): number {
  let chars = 0;
  let dense = 0; // non-ASCII characters: count each as a full token (CJK, emoji, and the like)
  const add = (t: string) => {
    chars += t.length;
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 127) dense++;
  };
  for (const m of messages) {
    chars += 16;
    if ("content" in m && typeof m.content === "string") add(m.content);
    else if ("content" in m && Array.isArray(m.content)) {
      // Images are billed per tile; ~1,000 tokens is a conservative per-image bound.
      for (const part of m.content) {
        if (part.type === "text") add(part.text);
        else chars += 3000;
      }
    }
    if (m.role === "assistant" && m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.ceil((chars - dense) / 3 + dense);
}
