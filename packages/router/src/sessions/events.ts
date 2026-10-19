import { z } from "zod";
import { RoleNameSchema } from "../config/schema.js";

/**
 * Agent session event log: one JSON object per line, `{seq, at, type, data}`, appended (and
 * fsynced) before the SQLite index is updated. The log is the record of truth; every line is
 * validated with these schemas when read back.
 */

export const SESSION_STATUSES = ["running", "completed", "failed", "interrupted", "cancelled"] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
/** Statuses a session can end with. */
export type SessionEndStatus = Exclude<SessionStatus, "running">;

/**
 * What a tool call does to the world, so resume (S2) knows how to treat an intent without an
 * outcome: `none`/`read` re-run; `edit` reconciles the worktree with the last committed head;
 * `command` re-runs only when `idempotent`; `delegate` re-submits (idempotent by label);
 * `brain` checks the brain commit; `external` reports the outcome as unknown.
 */
export const TOOL_SIDE_EFFECTS = ["none", "read", "edit", "command", "delegate", "brain", "external"] as const;
export const ToolSideEffectSchema = z.enum(TOOL_SIDE_EFFECTS);
export type ToolSideEffect = z.infer<typeof ToolSideEffectSchema>;

export const SESSION_EVENT_TYPES = ["started", "message", "model_request", "model_response", "model_error", "tool_intent", "tool_outcome", "note", "workspace", "ended"] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** Tool outputs above this many bytes (UTF-8) are truncated in the log. */
export const TOOL_OUTPUT_CAP_BYTES = 16 * 1024;

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const ContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
]);

/** Mirrors `ChatMessage` in `gateway/types.ts`. */
export const LoggedMessageSchema = z.union([
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(ContentPartSchema)]) }),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(ToolCallSchema).optional() }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
]);

const UsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  reasoningTokens: z.number().nullable(),
  reportedCostUsd: z.number().nullable(),
  basis: z.enum(["provider_reported", "unknown"]),
});

const AttemptSchema = z.object({ endpointId: z.string(), outcome: z.string() });

export const WorkspaceRepoSchema = z.object({
  alias: z.string(),
  worktree: z.string(),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  /** Last committed head in the worktree. */
  head: z.string().nullable(),
});
export const SessionWorkspaceSchema = z.object({ repos: z.array(WorkspaceRepoSchema) });
export type WorkspaceRepo = z.infer<typeof WorkspaceRepoSchema>;
export type SessionWorkspace = z.infer<typeof SessionWorkspaceSchema>;

export const StartedDataSchema = z.object({
  sessionId: z.string(),
  taskId: z.string().nullable(),
  jobId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  previousSessionId: z.string().nullable(),
  role: RoleNameSchema,
  agentLabel: z.string(),
  profile: z.string().nullable(),
  tier: z.string().nullable(),
});

/**
 * One transcript message. Replaying the log: `transcript[index] = message`, dropping anything
 * after `index` (a lower index than the transcript's length means the transcript was rewritten).
 */
export const MessageDataSchema = z.object({ index: z.number().int().nonnegative(), message: LoggedMessageSchema });

export const ModelRequestDataSchema = z.object({
  executionId: z.string(),
  purpose: z.string(),
  /** Transcript length (messages 0..messageCount-1, logged as `message` events) sent with the request. */
  messageCount: z.number().int().nonnegative(),
  maxTokens: z.number(),
  temperature: z.number().nullable(),
  tools: z.array(z.string()),
  toolChoice: z.string().nullable(),
  responseFormat: z.string().nullable(),
});

export const ModelResponseDataSchema = z.object({
  requestId: z.string(),
  endpointId: z.string(),
  content: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema),
  finishReason: z.string().nullable(),
  usage: UsageSchema,
  servedModel: z.string().nullable(),
  servedProvider: z.string().nullable(),
  attempts: z.array(AttemptSchema),
  estimatedInputTokens: z.number(),
});

export const ModelErrorDataSchema = z.object({
  executionId: z.string(),
  message: z.string(),
  /** Error code (`gateway:rate_limited`, `admission_denied`, ...) when the error carries one. */
  code: z.string().nullable(),
  status: z.number().nullable(),
  attempts: z.array(AttemptSchema),
});

export const ToolIntentDataSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
  sideEffect: ToolSideEffectSchema,
  idempotent: z.boolean(),
});

export const ToolOutcomeDataSchema = z.object({
  intentSeq: z.number().int().positive(),
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  output: z.string(),
  truncated: z.boolean(),
});

export const NoteDataSchema = z.object({ text: z.string(), data: z.unknown().optional() });

export const EndedDataSchema = z.object({ status: SessionStatusSchema.exclude(["running"]), stopReason: z.string() });

const envelope = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ seq: z.number().int().positive(), at: z.number(), type: z.literal(type), data });

export const SessionEventSchema = z.discriminatedUnion("type", [
  envelope("started", StartedDataSchema),
  envelope("message", MessageDataSchema),
  envelope("model_request", ModelRequestDataSchema),
  envelope("model_response", ModelResponseDataSchema),
  envelope("model_error", ModelErrorDataSchema),
  envelope("tool_intent", ToolIntentDataSchema),
  envelope("tool_outcome", ToolOutcomeDataSchema),
  envelope("note", NoteDataSchema),
  envelope("workspace", SessionWorkspaceSchema),
  envelope("ended", EndedDataSchema),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;
export type SessionEventData<T extends SessionEventType> = SessionEventOf<T>["data"];

/** A log line that failed to parse or validate; reported, never thrown, on read. */
export interface CorruptLine {
  /** 1-based line number in the JSONL file. */
  line: number;
  error: string;
  /** The first 200 characters of the line. */
  excerpt: string;
}
