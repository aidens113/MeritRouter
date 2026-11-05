import { z } from "zod";
import { type ClientConnectionsConfig, type ClientConnectionMode } from "../config/schema.js";
import { estimateTokens, type ChatMessage, type ChatRequest, type ChatResponse, type ChatToolCall, type ContentPart } from "../gateway/types.js";

export const CLIENT_CONNECTION_MODEL = "meritrouter";
export const CLIENT_CONNECTION_HOST = "127.0.0.1";
export const CLIENT_CONNECTION_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const CLIENT_CONNECTION_MODELS = [{ id: CLIENT_CONNECTION_MODEL, name: "MeritRouter" },
  { id: "meritrouter-direct", name: "MeritRouter Direct" }, { id: "meritrouter-agent", name: "MeritRouter Agent" }, { id: "meritrouter-team", name: "MeritRouter Team" }] as const;
export function clientConnectionModels(config: ClientConnectionsConfig): Array<{ id: string; name: string }> {
  return CLIENT_CONNECTION_MODELS.filter(value => value.id === CLIENT_CONNECTION_MODEL || config.enabled_modes.includes(value.id.replace("meritrouter-", "") as ClientConnectionMode)).map(value => ({ ...value }));
}
const text = z.string().max(CLIENT_CONNECTION_MAX_BODY_BYTES);
const name = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const jsonObject = z.record(z.string(), z.json());
const toolCall = z.object({
  id: z.string().min(1).max(200), type: z.literal("function"),
  function: z.object({ name, arguments: text }).strict(),
}).strict();
const tool = z.object({
  type: z.literal("function"),
  function: z.object({ name, description: text.default(""), parameters: jsonObject, strict: z.literal(false).optional() }).strict(),
}).strict().transform(value => ({ type: value.type, function: { name: value.function.name, description: value.function.description, parameters: value.function.parameters } }));
const imageUrl = z.string().max(CLIENT_CONNECTION_MAX_BODY_BYTES).refine(value => /^https?:\/\/[^\s]+$/i.test(value) || /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value), "Use an HTTP(S) image URL or supported base64 image data URL");
const imagePart = z.object({ type: z.literal("image_url"), image_url: z.object({ url: imageUrl }).strict() }).strict();
const userText = z.union([text, z.array(z.union([z.object({ type: z.literal("text"), text }).strict(), imagePart])).min(1).max(256)])
  .transform(value => value);
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: text, name: name.optional() }).strict(),
  z.object({ role: z.literal("developer"), content: text, name: name.optional() }).strict(),
  z.object({ role: z.literal("user"), content: userText, name: name.optional() }).strict(),
  z.object({ role: z.literal("assistant"), content: text.nullable().optional(), tool_calls: z.array(toolCall).max(128).optional(), name: name.optional() }).strict(),
  z.object({ role: z.literal("tool"), content: text, tool_call_id: z.string().min(1).max(200) }).strict(),
]).transform((value): ChatMessage => {
  if (value.role === "developer" || value.role === "system") return { role: "system", content: value.content };
  if (value.role === "assistant") return { role: "assistant", content: value.content ?? null, ...(value.tool_calls ? { tool_calls: value.tool_calls } : {}) };
  if (value.role === "tool") return { role: "tool", content: value.content, tool_call_id: value.tool_call_id };
  return { role: "user", content: value.content };
});
const structuredFormat = z.union([
  z.object({ type: z.literal("json_object") }).strict(),
  z.object({ type: z.literal("json_schema"), json_schema: z.object({ name, description: text.optional(), schema: jsonObject, strict: z.boolean().optional() }).strict() }).strict(),
]);
const responseFormat = z.union([z.object({ type: z.literal("text") }).strict(), structuredFormat]);
const chat = z.object({
  messages: z.array(message).min(1).max(1024),
  max_tokens: z.number().int().positive().max(32768),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(tool).max(128).optional(),
  tool_choice: z.enum(["auto", "none", "required"]).optional(),
  response_format: structuredFormat.optional(),
}).strict();

export const ClientConnectionRequestSchema = z.object({
  chat,
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > CLIENT_CONNECTION_MAX_BODY_BYTES)
    ctx.addIssue({ code: "custom", message: "Client request exceeds the 2 MiB limit" });
  if (value.chat.tool_choice && value.chat.tool_choice !== "none" && !value.chat.tools?.length)
    ctx.addIssue({ code: "custom", path: ["chat", "tool_choice"], message: "tool_choice requires at least one tool definition" });
});
export type ClientConnectionRequest = z.infer<typeof ClientConnectionRequestSchema>;
export type ClientConnectionDispatch = (request: ClientConnectionRequest, signal: AbortSignal, accessToken?: string) => Promise<ChatResponse>;
export class ClientConnectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const model = z.enum(["meritrouter", "meritrouter:latest", "meritrouter-direct", "meritrouter-direct:latest", "meritrouter-agent", "meritrouter-agent:latest", "meritrouter-team", "meritrouter-team:latest"]);
export function clientConnectionMode(value: string, config: ClientConnectionsConfig): ClientConnectionMode {
  const id = model.parse(value).replace(/:latest$/, "");
  const mode = id === CLIENT_CONNECTION_MODEL ? config.default_mode : id.replace("meritrouter-", "") as ClientConnectionMode;
  if (!config.enabled_modes.includes(mode)) throw new ClientConnectionError(400, "connection_mode_disabled", "The requested connection mode is disabled.");
  return mode;
}
const openai = z.object({
  model, messages: z.array(message).min(1).max(1024),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().nullable().optional(),
  max_tokens: z.number().int().positive().max(32768).nullable().optional(),
  max_completion_tokens: z.number().int().positive().max(32768).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  tools: z.array(tool).max(128).optional(),
  tool_choice: z.enum(["auto", "none", "required"]).optional(),
  response_format: responseFormat.optional(),
  n: z.literal(1).optional(), user: z.string().max(200).optional(),
  presence_penalty: z.literal(0).optional(), frequency_penalty: z.literal(0).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.max_tokens != null && value.max_completion_tokens != null)
    ctx.addIssue({ code: "custom", message: "set only one output token limit" });
});
const nativeCall = z.object({
  id: z.string().min(1).max(200).optional(), type: z.literal("function").optional(),
  function: z.object({ name, arguments: jsonObject, index: z.number().int().nonnegative().optional() }).strict(),
}).strict();
const nativeMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: text.optional(), tool_calls: z.array(nativeCall).max(128).optional(),
  tool_name: name.optional(), tool_call_id: z.string().min(1).max(200).optional(), images: z.array(text.min(1)).min(1).max(16).optional(),
}).strict();
const nativeOptions = z.object({
  temperature: z.number().min(0).max(2).optional(),
  num_predict: z.number().int().positive().max(32768).optional(),
  /** Enforced as a client input ceiling; it cannot increase the selected route's context. */
  num_ctx: z.number().int().positive().max(1_000_000).optional(),
}).strict();
const nativeFields = {
  model, stream: z.boolean().default(true), options: nativeOptions.optional(),
  format: z.union([z.literal("json"), jsonObject]).optional(),
  /** Remote routes have no local residency; this option has no effect. */
  keep_alive: z.union([z.string().max(32), z.number().finite()]).optional(),
  think: z.union([z.literal(false), z.null()]).optional(),
};
const nativeChat = z.object({ ...nativeFields, messages: z.array(nativeMessage).min(1).max(1024), tools: z.array(tool).max(128).optional() }).strict();
const nativeGenerate = z.object({ ...nativeFields, prompt: text.min(1), system: text.optional(), raw: z.literal(false).optional(), images: z.array(text.min(1)).min(1).max(16).optional() }).strict();
export const ClientConnectionShowSchema = z.object({ model, verbose: z.boolean().optional() }).strict();

export interface ParsedClientChat {
  mode: ClientConnectionMode;
  model: string;
  protocol: "openai" | "ollama-chat" | "ollama-generate";
  stream: boolean;
  includeUsage: boolean;
  chat: Omit<ChatRequest, "model">;
}

function validateHistory(messages: ChatMessage[]): void {
  const pending = new Set<string>(), used = new Set<string>();
  for (const item of messages) {
    if (item.role === "assistant") for (const call of item.tool_calls ?? []) {
      if (used.has(call.id)) throw new ClientConnectionError(400, "invalid_tool_history", "Tool call ids must be unique in the conversation.");
      used.add(call.id); pending.add(call.id);
    }
    if (item.role === "tool" && !pending.delete(item.tool_call_id))
      throw new ClientConnectionError(400, "invalid_tool_history", "Each tool result must match one preceding assistant tool call.");
  }
}
function nativeHistory(values: z.infer<typeof nativeMessage>[]): ChatMessage[] {
  const pending: ChatToolCall[] = [], messages: ChatMessage[] = [];
  values.forEach((item, index) => {
    if (item.images && item.role !== "user") throw new ClientConnectionError(400, "invalid_images", "Only user messages may carry images.");
    if (item.role === "assistant") {
      if (item.tool_name || item.tool_call_id) throw new ClientConnectionError(400, "invalid_tool_history", "Assistant messages carry tool calls; tool ids and names belong on tool results.");
      const calls = item.tool_calls?.map((call, offset): ChatToolCall => ({
        id: call.id ?? "call_ollama_" + index + "_" + offset, type: "function",
        function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) },
      }));
      if (calls) pending.push(...calls);
      messages.push({ role: "assistant", content: item.content ?? null, ...(calls ? { tool_calls: calls } : {}) });
    } else if (item.role === "tool") {
      if (item.tool_calls) throw new ClientConnectionError(400, "invalid_tool_history", "Tool results cannot define assistant tool calls.");
      const candidates = pending.filter(call => item.tool_call_id ? call.id === item.tool_call_id : item.tool_name ? call.function.name === item.tool_name : pending.length === 1);
      const match = candidates[0];
      if (!match) throw new ClientConnectionError(400, "invalid_tool_history", "Ollama tool results must name a preceding tool call.");
      pending.splice(pending.indexOf(match), 1);
      messages.push({ role: "tool", content: item.content ?? "", tool_call_id: match.id });
    } else {
      if (item.tool_calls || item.tool_name || item.tool_call_id) throw new ClientConnectionError(400, "invalid_tool_history", "Only assistant and tool messages may carry tool call fields.");
      if (item.role === "user") messages.push({ role: "user", content: nativeUserContent(item.content ?? "", item.images) });
      else messages.push({ role: "system", content: item.content ?? "" });
    }
  });
  return messages;
}
function nativeUserContent(content: string, images?: string[]): string | ContentPart[] {
  if (!images) return content;
  return [{ type: "text", text: content }, ...images.map(value => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new ClientConnectionError(400, "invalid_images", "Ollama images must contain base64 encoded PNG, JPEG, GIF or WebP data.");
    const bytes = Buffer.from(value, "base64"), head = bytes.subarray(0, 16);
    const mime = head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
      : head[0] === 255 && head[1] === 216 && head[2] === 255 ? "jpeg"
      : /^GIF8[79]a/.test(head.toString("ascii")) ? "gif"
      : head.subarray(0,4).toString("ascii") === "RIFF" && head.subarray(8,12).toString("ascii") === "WEBP" ? "webp" : null;
    if (!mime) throw new ClientConnectionError(400, "invalid_images", "Unsupported image encoding; use PNG, JPEG, GIF or WebP.");
    return { type: "image_url" as const, image_url: { url: "data:image/" + mime + ";base64," + value } };
  })];
}

/** Validate protocol inputs once; the service seam validates the resulting request again. */
export function parseClientChat(path: string, raw: unknown, config: ClientConnectionsConfig): ParsedClientChat {
  let result: ParsedClientChat;
  if (path === "/v1/chat/completions") {
    const value = openai.parse(raw);
    const mode = clientConnectionMode(value.model, config);
    if (mode !== "direct" && (value.tools?.length || value.tool_choice || (value.response_format && value.response_format.type !== "text") || value.max_tokens != null || value.max_completion_tokens != null || value.temperature != null))
      throw new ClientConnectionError(400, "unsupported_agent_options", "Agent modes accept conversation text; use the jobs API for job limits. Caller tools and generation options belong to direct mode.");
    result = { mode, model: value.model, protocol: "openai", stream: value.stream, includeUsage: value.stream_options?.include_usage === true,
      chat: { messages: value.messages, max_tokens: value.max_completion_tokens ?? value.max_tokens ?? config.max_output_tokens,
        ...(value.temperature == null ? {} : { temperature: value.temperature }),
        ...(value.tools ? { tools: value.tools } : {}), ...(value.tool_choice ? { tool_choice: value.tool_choice } : {}),
        ...(value.response_format && value.response_format.type !== "text" ? { response_format: value.response_format } : {}) } };
  } else {
    const value = path === "/api/chat" ? nativeChat.parse(raw) : nativeGenerate.parse(raw);
    const mode = clientConnectionMode(value.model, config);
    if (mode !== "direct" && (("tools" in value && value.tools?.length) || value.format || value.options))
      throw new ClientConnectionError(400, "unsupported_agent_options", "Agent modes accept conversation text; use the jobs API for job limits. Caller tools and generation options belong to direct mode.");
    const messages: ChatMessage[] = "messages" in value ? nativeHistory(value.messages)
      : [...(value.system ? [{ role: "system" as const, content: value.system }] : []), { role: "user", content: nativeUserContent(value.prompt, value.images) }];
    result = { mode, model: value.model, protocol: path === "/api/chat" ? "ollama-chat" : "ollama-generate", stream: value.stream, includeUsage: true,
      chat: { messages, max_tokens: value.options?.num_predict ?? config.max_output_tokens,
        ...(value.options?.temperature === undefined ? {} : { temperature: value.options.temperature }),
        ...("tools" in value && value.tools ? { tools: value.tools } : {}),
        ...(value.format ? { response_format: value.format === "json" ? { type: "json_object" as const } : { type: "json_schema" as const, json_schema: { name: "response", schema: value.format } } } : {}) } };
    if (value.options?.num_ctx && estimateTokens(messages, result.chat.tools) > value.options.num_ctx)
      throw new ClientConnectionError(400, "context_limit_exceeded", "Messages exceed the requested num_ctx input ceiling.");
  }
  if (result.chat.max_tokens > config.max_output_tokens)
    throw new ClientConnectionError(400, "output_limit_exceeded", "Requested output exceeds the Connections output token limit.");
  if (result.chat.tool_choice && result.chat.tool_choice !== "none" && !result.chat.tools?.length)
    throw new ClientConnectionError(400, "invalid_tools", "tool_choice requires at least one tool definition.");
  validateHistory(result.chat.messages);
  if (result.mode !== "direct" && result.chat.messages.some(item => item.role === "tool" || (item.role === "assistant" && item.tool_calls?.length) || (item.role === "user" && typeof item.content !== "string" && item.content.some(part => part.type !== "text"))))
    throw new ClientConnectionError(400, "unsupported_agent_conversation", "Agent jobs accept text conversations without caller-owned tool history or images.");
  return result;
}

export function clientChatJobRequest(parsed: ParsedClientChat): import("./jobs.js").ClientJobRequest {
  if (parsed.mode === "direct") throw new Error("Direct conversations do not submit jobs");
  const messages = parsed.chat.messages, last = [...messages].reverse().find(item => item.role === "user");
  const goal = last?.role === "user" ? typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
  if (!goal.trim() || goal.length > 20000) throw new ClientConnectionError(400, "invalid_agent_goal", "End the conversation with a user request of 1–20,000 characters.");
  const context = JSON.stringify(messages);
  if (context.length > 400000) throw new ClientConnectionError(400, "agent_context_too_large", "Agent conversation context exceeds 400,000 characters.");
  return { mode: parsed.mode, goal, context };
}

const output = z.object({
  message: z.object({ content: text.nullable(), tool_calls: z.array(toolCall).max(128).optional() }),
  finishReason: z.string().max(100).nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable() }),
});
export function clientResponse(value: ChatResponse): z.infer<typeof output> {
  const parsed = output.safeParse(value);
  if (!parsed.success) throw new ClientConnectionError(502, "invalid_model_response", "The model returned an invalid compatibility response.");
  const result = parsed.data;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > CLIENT_CONNECTION_MAX_BODY_BYTES)
    throw new ClientConnectionError(502, "response_too_large", "Model response exceeded the compatibility response limit.");
  return result;
}
export type ClientChatResponse = ReturnType<typeof clientResponse>;
export function finishReason(value: ClientChatResponse): string {
  if (value.message.tool_calls?.length) return "tool_calls";
  return value.finishReason === "length" || value.finishReason === "content_filter" ? value.finishReason : "stop";
}
export function openaiUsage(value: ClientChatResponse): Record<string, number> | null {
  const { inputTokens, outputTokens } = value.usage;
  return inputTokens === null || outputTokens === null ? null
    : { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}
export function ollamaMessage(value: ClientChatResponse): Record<string, unknown> {
  try {
    return { role: "assistant", content: value.message.content ?? "", ...(value.message.tool_calls?.length ? {
      tool_calls: value.message.tool_calls.map(call => ({ id: call.id, type: "function", function: { name: call.function.name, arguments: jsonObject.parse(JSON.parse(call.function.arguments)) } })),
    } : {}) };
  } catch { throw new ClientConnectionError(502, "invalid_tool_arguments", "The model returned tool arguments that are not a JSON object."); }
}
