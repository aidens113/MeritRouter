/** Minimal OpenAI-compatible chat shapes used between the package and the gateway. */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  /** Always a curated pool name; adapters must not accept raw model ids from callers. */
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
  reasoningTokens: number | null;
  reportedCostUsd: number | null;
  basis: "provider_reported" | "unknown";
}

export interface GatewayTelemetry {
  servedModel: string | null;
  servedProvider: string | null;
  /** Upstream provider attempts for this one gateway request, when the gateway reports it. */
  providerAttempts: number | null;
  /** True only when the attempt count comes from an authoritative source. */
  providerAttemptsExact: boolean;
  cacheHit: boolean | null;
  /** Gateway headers kept for audit (subset; never includes credentials). */
  headers: Record<string, string>;
}

export interface ChatResponse {
  message: { content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: string | null;
  usage: NormalizedUsage;
  telemetry: GatewayTelemetry;
  httpStatus: number;
}

/** Replaceable inference boundary; the FreeLLMAPI adapter is the first implementation. */
export interface InferenceClient {
  readonly name: string;
  complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
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
  for (const m of messages) {
    chars += 16;
    if ("content" in m && typeof m.content === "string") chars += m.content.length;
    if (m.role === "assistant" && m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 3);
}
