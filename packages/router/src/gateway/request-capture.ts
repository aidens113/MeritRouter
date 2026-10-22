import { z } from "zod";
import type { ChatRequest, ChatResponse } from "./types.js";

export const CAPTURE_LIMITS = Object.freeze({ recordBytes: 1048576, inputBytes: 524288, outputBytes: 262144, messages: 256, tools: 64, calls: 64, depth: 16, nodes: 10000, omissions: 128, scanBytes: 8388608, fieldBytes: 65536, retentionMs: 7 * 86400000, projectBytes: 134217728, totalBytes: 536870912, records: 10000 });
const Count = z.number().int().nonnegative();
export const CaptureOmissionSchema = z.object({ path: z.string().max(256), reason: z.enum(["byte_limit", "count_limit", "depth_limit", "image_locator", "unsupported_value", "scan_limit"]), originalBytes: Count.nullable(), storedBytes: Count, omittedCount: Count.optional() }).strict();
export type CaptureOmission = z.infer<typeof CaptureOmissionSchema>;
const Json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(CAPTURE_LIMITS.fieldBytes), z.array(Json), z.record(z.string().max(256), Json)]));
const Call = z.object({ id: z.string().max(256), name: z.string().max(256), arguments: z.string().max(CAPTURE_LIMITS.fieldBytes) }).strict();
const Part = z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string().max(CAPTURE_LIMITS.fieldBytes) }).strict(), z.object({ type: z.literal("image_omitted") }).strict()]);
const Message = z.object({ index: Count, role: z.enum(["system", "user", "assistant", "tool"]), content: z.union([z.string().max(CAPTURE_LIMITS.fieldBytes), z.null(), z.array(Part).max(256)]), toolCallId: z.string().max(256).optional(), toolCalls: z.array(Call).max(64).optional() }).strict();
export const CapturedInputSchema = z.object({ model: z.string().max(1024), messages: z.array(Message).max(256), maxTokens: Count, temperature: z.number().finite().optional(), tools: z.array(z.object({ name: z.string().max(256), description: z.string().max(65536), parameters: Json }).strict()).max(64).optional(), toolChoice: z.enum(["auto", "none", "required"]).optional(), responseFormat: z.object({ type: z.enum(["json_object", "json_schema"]), schema: Json.optional() }).strict().optional(), webSearch: z.object({ via: z.string().max(256), alwaysOn: z.boolean(), maxUses: Count, maxResults: Count }).strict().optional() }).strict().superRefine((value, ctx) => {
  if (value.messages.reduce((sum, message) => sum + (message.toolCalls?.length ?? 0), 0) > 64) ctx.addIssue({ code: "custom", message: "capture input exceeds whole-record tool-call limit" });
});
export const CapturedOutputSchema = z.object({ content: z.string().max(65536).nullable(), toolCalls: z.array(Call).max(64), finishReason: z.string().max(256).nullable() }).strict();
export const CaptureOutcomeSchema = z.object({ kind: z.enum(["succeeded", "failed", "uncertain"]), httpStatus: Count.nullable(), errorKind: z.string().max(128).nullable(), possiblyConsumed: z.boolean().nullable(), policyViolation: z.boolean() }).strict();
export const CapturePayloadSchema = z.object({ input: CapturedInputSchema.nullable(), output: CapturedOutputSchema.nullable(), outcome: CaptureOutcomeSchema.nullable(), omissions: z.array(CaptureOmissionSchema).max(128), originalBytes: Count.nullable() }).strict();
export type CapturePayload = z.infer<typeof CapturePayloadSchema>;
export type CapturedInput = z.infer<typeof CapturedInputSchema>;
export type CapturedOutput = z.infer<typeof CapturedOutputSchema>;
export type CaptureOutcome = z.infer<typeof CaptureOutcomeSchema>;
export const RequestCaptureViewSchema = CapturePayloadSchema.extend({ schemaVersion: z.literal(1), requestId: z.string(), provenance: z.literal("normalized_gate_v1"), availability: z.enum(["complete", "partial", "unavailable"]), unavailableReason: z.enum(["not_captured", "expired", "evicted", "capture_failed", "corrupt", "mixed_project_payload", "scope_unavailable"]).nullable(), dispatch: z.enum(["reserved", "dispatch_intent", "not_dispatched", "outcome_unknown"]), storedBytes: Count, capturedAt: Count.nullable(), expiresAt: Count.nullable() }).strict();
export type RequestCaptureView = z.infer<typeof RequestCaptureViewSchema>;
export interface CaptureInputProjection { input: CapturedInput; omissions: CaptureOmission[]; originalBytes: number | null }
export interface CaptureOutputProjection { output: CapturedOutput; omissions: CaptureOmission[]; originalBytes: number | null }
export interface RequestCaptureStore {
  begin(requestId: string, projection: CaptureInputProjection, participantTaskIds: readonly string[]): Promise<void>;
  dispatched(requestId: string): Promise<void>;
  complete(requestId: string, outcome: CaptureOutcome, projection?: CaptureOutputProjection, notDispatched?: boolean): Promise<void>;
  read(requestId: string, scope: { project: string | null }): RequestCaptureView | null;
  purgeProject(project: string): { captures: number; bytes: number };
  prune(limit?: number): { captures: number; bytes: number };
}
export const captureBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Bounded structural preflight before recursive zod validation of untrusted JSON. */
export function captureTreeWithinBounds(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]; let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++nodes > CAPTURE_LIMITS.nodes || current.depth > CAPTURE_LIMITS.depth) return false;
    if (current.value && typeof current.value === "object") {
      if (!Array.isArray(current.value) && Object.getPrototypeOf(current.value) !== Object.prototype) return false;
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        if (stack.length + nodes >= CAPTURE_LIMITS.nodes) return false;
        stack.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
      }
    } else if (!["string", "number", "boolean"].includes(typeof current.value) && current.value !== null) return false;
    else if (typeof current.value === "number" && !Number.isFinite(current.value)) return false;
  }
  return true;
}

class Bounds {
  readonly omissions: CaptureOmission[] = [];
  private remaining: number;
  private scan: number = CAPTURE_LIMITS.scanBytes / 2; // input + output share the approved 8 MiB work envelope
  private nodes = 0;
  private callCount = 0;
  private partCount = 0;
  constructor(bytes: number) { this.remaining = bytes - 32768; }
  omit(path: string, reason: CaptureOmission["reason"], originalBytes: number | null = null, storedBytes = 0, omittedCount?: number): void {
    const item = { path: path.slice(0, 256), reason, originalBytes, storedBytes, ...(omittedCount === undefined ? {} : { omittedCount }) };
    if (this.omissions.length < CAPTURE_LIMITS.omissions) this.omissions.push(item);
    else { const last = this.omissions[this.omissions.length - 1]!; last.path = "$"; last.reason = "count_limit"; last.omittedCount = (last.omittedCount ?? 1) + 1; }
  }
  text(value: string, path: string, cap: number = CAPTURE_LIMITS.fieldBytes): string {
    let original: number | null = null;
    if (value.length * 3 <= this.scan) { original = Buffer.byteLength(value); this.scan -= original; }
    else { this.omit(path, "scan_limit"); }
    const budget = Math.max(0, Math.min(cap, this.remaining - 2));
    // Prefix allocation is capped even for a multi-gigabyte source string; JSON escaping counts.
    let low = 0, high = Math.min(value.length, budget);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (mid * 3 > this.scan) { this.omit(path, "scan_limit"); break; }
      this.scan -= mid * 3;
      if (captureBytes(value.slice(0, mid)) <= budget) low = mid; else high = mid - 1;
    }
    if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!) && low < value.length) low--;
    const result = value.slice(0, low); this.remaining -= captureBytes(result);
    if (low < value.length) this.omit(path, "byte_limit", original, Buffer.byteLength(result));
    return result;
  }
  json(value: unknown, path: string, depth = 0): unknown {
    if (++this.nodes > CAPTURE_LIMITS.nodes / 2 || this.remaining <= 16) { this.omit(path, "count_limit"); return null; }
    this.remaining -= 16;
    if (depth > CAPTURE_LIMITS.depth - 8) { this.omit(path, "depth_limit"); return null; }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value === "string") return this.text(value, path);
    if (Array.isArray(value)) {
      const result = []; for (let i = 0; i < value.length && this.nodes < CAPTURE_LIMITS.nodes / 2 && this.remaining > 16; i++) result.push(this.json(value[i], `${path}[${i}]`, depth + 1));
      if (result.length < value.length) { this.omit(path, "count_limit", null, 0, value.length - result.length); } return result;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, unknown> = {}; let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++count > CAPTURE_LIMITS.nodes || this.nodes >= CAPTURE_LIMITS.nodes / 2 || this.remaining <= 16) { this.omit(path, "count_limit"); break; }
        if (key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key)) { this.omit(path, "unsupported_value"); continue; }
        this.remaining -= captureBytes(key); result[key] = this.json((value as Record<string, unknown>)[key], `${path}[${count}]`, depth + 1);
      } return result;
    }
    this.omit(path, "unsupported_value"); return null;
  }
  parts(length: number, path: string): number {
    const allowed = Math.min(length, 256 - this.partCount); this.partCount += allowed;
    if (allowed < length) this.omit(path, "count_limit", null, 0, length - allowed);
    return allowed;
  }
  calls(calls: NonNullable<ChatResponse["message"]["tool_calls"]>, path: string) {
    const allowed = Math.min(calls.length, 64 - this.callCount); this.callCount += allowed;
    if (calls.length > allowed) this.omit(path, "count_limit", null, 0, calls.length - allowed);
    return calls.slice(0, allowed).map((call, i) => ({ id: this.text(call.id, `${path}[${i}].id`, 256), name: this.text(call.function.name, `${path}[${i}].name`, 256), arguments: this.text(call.function.arguments, `${path}[${i}].arguments`) }));
  }
}

export function projectCaptureInput(model: string, chat: Omit<ChatRequest, "model">, webSearch?: CapturedInput["webSearch"]): CaptureInputProjection {
  const b = new Bounds(CAPTURE_LIMITS.inputBytes);
  const capturedModel = b.text(model, "model", 1024);
  const indices = Array.from({ length: Math.min(chat.messages.length, CAPTURE_LIMITS.messages) }, (_, i) => Math.max(0, chat.messages.length - CAPTURE_LIMITS.messages) + i);
  if (indices.length < chat.messages.length) b.omit("messages", "count_limit", null, 0, chat.messages.length - indices.length);
  const messages = indices.reverse().map(index => {
    const message = chat.messages[index]!; const path = `messages[${index}]`;
    const content = typeof message.content === "string" ? b.text(message.content, path + ".content") : message.content === null ? null : message.content.slice(0, b.parts(message.content.length, path + ".content")).map((part, i) => {
      if (part.type === "text") return { type: "text" as const, text: b.text(part.text, `${path}.content[${i}]`) };
      b.omit(`${path}.content[${i}]`, "image_locator"); return { type: "image_omitted" as const };
    });
    return { index, role: message.role, content, ...(message.role === "tool" ? { toolCallId: b.text(message.tool_call_id, path + ".toolCallId", 256) } : {}), ...(message.role === "assistant" && message.tool_calls ? { toolCalls: b.calls(message.tool_calls, path + ".toolCalls") } : {}) };
  }).reverse();
  let input: CapturedInput = { model: capturedModel, messages, maxTokens: chat.max_tokens,
    ...(chat.temperature === undefined ? {} : { temperature: chat.temperature }), ...(chat.tool_choice ? { toolChoice: chat.tool_choice } : {}),
    ...(chat.response_format ? { responseFormat: { type: chat.response_format.type, ...(chat.response_format.type === "json_schema" ? { schema: b.json(chat.response_format.json_schema, "responseFormat.schema") } : {}) } } : {}),
    ...(chat.tools ? { tools: chat.tools.slice(0, 64).map((tool, i) => ({ name: b.text(tool.function.name, `tools[${i}].name`, 256), description: b.text(tool.function.description, `tools[${i}].description`), parameters: b.json(tool.function.parameters, `tools[${i}].parameters`) })) } : {}), ...(webSearch ? { webSearch } : {}) };
  if ((chat.tools?.length ?? 0) > 64) b.omit("tools", "count_limit", null, 0, chat.tools!.length - 64);
  if (captureBytes(input) > CAPTURE_LIMITS.inputBytes || !captureTreeWithinBounds(input)) { b.omit("input", "byte_limit"); input = { model: input.model, maxTokens: input.maxTokens, messages: [] }; }
  return { input: CapturedInputSchema.parse(input), omissions: b.omissions, originalBytes: b.omissions.length ? null : captureBytes(input) };
}

export function projectCaptureOutput(response: Pick<ChatResponse, "message" | "finishReason">): CaptureOutputProjection {
  const b = new Bounds(CAPTURE_LIMITS.outputBytes);
  let output: CapturedOutput = { content: response.message.content === null ? null : b.text(response.message.content, "output.content"), toolCalls: b.calls(response.message.tool_calls ?? [], "output.toolCalls"), finishReason: response.finishReason === null ? null : b.text(response.finishReason, "output.finishReason", 256) };
  if (captureBytes(output) > CAPTURE_LIMITS.outputBytes || !captureTreeWithinBounds(output)) { b.omit("output", "byte_limit"); output = { content: null, toolCalls: [], finishReason: output.finishReason }; }
  return { output: CapturedOutputSchema.parse(output), omissions: b.omissions, originalBytes: b.omissions.length ? null : captureBytes(output) };
}
