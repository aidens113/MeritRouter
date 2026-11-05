import { Ajv, type ValidateFunction } from "ajv";
import type { ChatRequest } from "../gateway/types.js";
import type { ModelEndpoint } from "../models/catalog.js";
import { buildAnthropicBody } from "../providers/anthropic.js";
import { buildOpenAiBody } from "../providers/openai-compatible.js";
import type { ResolvedProvider } from "../providers/registry.js";
import { canonicalJson } from "../storage/tasks.js";
import { ClientConnectionError, type ClientChatResponse } from "./protocol.js";

/** Inspect the same pure wire mapping dispatch will use; unsupported constraints must not disappear. */
export function routePreservesClientConstraints(provider: ResolvedProvider | null, endpoint: ModelEndpoint, chat: Omit<ChatRequest, "model">): boolean {
  if (!provider) return false;
  try {
    const request = { provider, model: endpoint.route.model, chat, anthropicProtocol: endpoint.anthropicProtocol };
    const wire = provider.api === "anthropic" ? buildAnthropicBody(request) : buildOpenAiBody(provider, request);
    if (chat.tools?.length && (chat.tool_choice === "required" || chat.tool_choice === "none")) {
      const expected = provider.toolChoice[chat.tool_choice];
      const actual = typeof wire.tool_choice === "string" ? wire.tool_choice
        : wire.tool_choice && typeof wire.tool_choice === "object" && "type" in wire.tool_choice ? wire.tool_choice.type : null;
      if (expected === null || actual !== expected) return false;
    }
    return !chat.response_format || canonicalJson(wire.response_format) === canonicalJson(chat.response_format);
  } catch { return false; }
}

/** Compile before admission; validate after accounting without retries or any client tool execution. */
export function clientResponseValidator(chat: Omit<ChatRequest, "model">): (response: ClientChatResponse) => void {
  const tools = new Map<string, ValidateFunction>();
  let structured: ValidateFunction | null = null;
  const compile = (schema: Record<string, unknown>): ValidateFunction => {
    // Each independently scoped client schema gets an isolated compiler. Nothing enters
    // the process-wide task schema cache, and repeated $ids cannot collide or accumulate.
    const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
    if ("$async" in validate && validate.$async) throw new Error("Asynchronous client schemas are unsupported");
    return validate;
  };
  try {
    for (const tool of chat.tools ?? []) {
      if (tools.has(tool.function.name)) throw new Error("Duplicate tool name");
      tools.set(tool.function.name, compile(tool.function.parameters));
    }
    if (chat.response_format?.type === "json_schema") {
      const schema = chat.response_format.json_schema.schema;
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Missing JSON schema");
      structured = compile(schema as Record<string, unknown>);
    }
  } catch { throw new ClientConnectionError(400, "unsupported_json_schema", "Tool and response schemas must be supported JSON schemas, and tool names must be unique."); }
  return response => {
    const calls = response.message.tool_calls ?? [];
    if (chat.tool_choice === "required" && !calls.length)
      throw new ClientConnectionError(502, "tool_choice_not_honored", "The model did not return the required tool call.");
    if (chat.tool_choice === "none" && calls.length)
      throw new ClientConnectionError(502, "tool_choice_not_honored", "The model returned a tool call when tool_choice was none.");
    for (const call of calls) {
      const validate = tools.get(call.function.name);
      let args: unknown;
      try { args = JSON.parse(call.function.arguments) as unknown; } catch { /* Refused below. */ }
      if (!validate || !args || typeof args !== "object" || Array.isArray(args) || !validate(args))
        throw new ClientConnectionError(502, "invalid_tool_call", "The model returned an undeclared tool or arguments that do not match its schema.");
    }
    // A tool step may carry no assistant content; response_format governs the eventual text answer.
    if (chat.response_format && !calls.length) {
      let value: unknown;
      try { value = JSON.parse(response.message.content ?? "") as unknown; }
      catch { throw new ClientConnectionError(502, "invalid_structured_response", "The model did not return the requested JSON response."); }
      if ((chat.response_format.type === "json_object" && (!value || typeof value !== "object" || Array.isArray(value))) || (structured && !structured(value)))
        throw new ClientConnectionError(502, "invalid_structured_response", "The model response does not match the requested JSON format or schema.");
    }
  };
}
