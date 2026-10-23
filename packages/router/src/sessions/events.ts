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

export const SESSION_EVENT_TYPES = ["started", "message", "model_request", "model_response", "model_error", "tool_intent", "tool_outcome", "note", "workspace", "ended", "resumed"] as const;
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
  cacheCreationInputTokens: z.number().nonnegative().nullable().optional(),
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

/** How a resume treats uncommitted worktree changes left by an interrupted edit. */
export const RecoverEditsPolicySchema = z.enum(["commit", "reset"]);
export type RecoverEditsPolicy = z.infer<typeof RecoverEditsPolicySchema>;

/** One interrupted tool call that a resume action covers. */
export const ResumeToolRefSchema = z.object({
  /** Seq of the `tool_intent` with no outcome. */
  intentSeq: z.number().int().positive(),
  callId: z.string(),
  name: z.string(),
  args: z.unknown(),
  /** Index in `ResumePlan.messages` of the tool message to fill with the result; null when the call has no slot in the transcript. */
  messageIndex: z.number().int().nonnegative().nullable(),
});
export type ResumeToolRef = z.infer<typeof ResumeToolRefSchema>;

/**
 * Work a resume leaves to its caller (see `planResume`). `result` is unset in a plan; the
 * caller fills it with what it did before recording the `resumed` event.
 */
export const ResumeActionSchema = z.discriminatedUnion("kind", [
  /** Run the tool again (a `delegate`, or an `idempotent` `command`) and use its output as the call's result. */
  ResumeToolRefSchema.extend({ kind: z.literal("rerun_tool"), sideEffect: z.enum(["delegate", "command"]), result: z.string().optional() }),
  /**
   * Diff each repo's worktree against its `head` (last committed head) and commit the difference
   * as "recovered" under the session's identity (`commit`) or reset to `head` (`reset`), then tell
   * the model which files (`calls[].messageIndex`).
   */
  z.object({
    kind: z.literal("reconcile_edits"),
    policy: RecoverEditsPolicySchema,
    repos: z.array(WorkspaceRepoSchema),
    /** Edit calls with no outcome: their tool messages carry a placeholder to replace. */
    calls: z.array(ResumeToolRefSchema),
    /** Edit calls that completed after the last recorded head (their changes are uncommitted); their tool messages are real outputs. */
    completedCallIds: z.array(z.string()),
    result: z.string().optional(),
  }),
  /** Report the stored state of an external interaction (`ask_user`: the question and any answer) as the call's result. */
  ResumeToolRefSchema.extend({ kind: z.literal("report_external"), result: z.string().optional() }),
]);
export type ResumeAction = z.infer<typeof ResumeActionSchema>;

/** Runtime proof that one exact transcript tool occurrence had no applied effect. */
export const NotAppliedToolProofSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  callId: z.string(),
  transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type NotAppliedToolProof = z.infer<typeof NotAppliedToolProofSchema>;

export const ResumedDataSchema = z.object({
  /** What the model was told. */
  summary: z.string(),
  /** The plan's actions, with `result` set to what the caller did. */
  actions: z.array(ResumeActionSchema),
  /** Intents with no outcome that this resume settled; `pendingIntents` no longer reports them. */
  resolvedIntentSeqs: z.array(z.number().int().positive()),
  /** `model_request` events that got no response and were dropped. */
  droppedRequestSeqs: z.array(z.number().int().positive()),
  /** Optional for old logs; only the trusted resume service writes these absence proofs. */
  notAppliedTools: z.array(NotAppliedToolProofSchema).max(10000).optional(),
});

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
  envelope("resumed", ResumedDataSchema),
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
