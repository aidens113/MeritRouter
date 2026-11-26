/**
 * Channel v1: the two-way message channel between one task's worker and its supervisor
 * (supervisor-offload Phase 1 contract; table `channel_messages`).
 *
 * Distinct from the T2 team channel (storage/channel.ts, `job_channel`), which is a job-wide
 * broadcast stream. Here every message belongs to one task and is either a request that waits
 * for one answer, a reply to a request, or a notice:
 *
 * - requests: question, tool_request, help, blocked (worker -> supervisor); probe (supervisor ->
 *   worker). Status pending -> answered | expired.
 * - replies: answer, grant, deny, recorded only through `answer()`, atomically with the request
 *   turning answered; at most one reply per request (unique index). Status pending (not yet
 *   seen by the recipient) -> delivered | expired.
 * - notices: rework (supervisor -> worker). Status pending -> delivered | expired.
 *
 * Bodies are model or user text: validated and length-limited here, and always shown to the
 * other side as quoted data, never as instructions. Tool names travel as `tool:<name>` refs; a
 * grant can only name tools the request asked for.
 */
import { z } from "zod";
import { immediate, newId, type Db } from "../storage/db.js";
import { cleanChannelText } from "../storage/channel.js";

export const CHANNEL_DIRECTIONS = ["worker_to_supervisor", "supervisor_to_worker"] as const;
export const ChannelDirectionSchema = z.enum(CHANNEL_DIRECTIONS);
export type ChannelDirection = z.infer<typeof ChannelDirectionSchema>;

export const CHANNEL_MESSAGE_KINDS = ["question", "tool_request", "help", "blocked", "answer", "grant", "deny", "probe", "rework"] as const;
export const ChannelMessageKindSchema = z.enum(CHANNEL_MESSAGE_KINDS);
export type ChannelMessageKind = z.infer<typeof ChannelMessageKindSchema>;

export const CHANNEL_MESSAGE_STATUSES = ["pending", "answered", "delivered", "expired"] as const;
export const ChannelMessageStatusSchema = z.enum(CHANNEL_MESSAGE_STATUSES);
export type ChannelMessageStatus = z.infer<typeof ChannelMessageStatusSchema>;

/** Kinds that wait for exactly one reply. */
export const CHANNEL_REQUEST_KINDS: ReadonlySet<ChannelMessageKind> = new Set(["question", "tool_request", "help", "blocked", "probe"]);
/** Kinds that answer a request (created only by `answer()`). */
export const CHANNEL_REPLY_KINDS: ReadonlySet<ChannelMessageKind> = new Set(["answer", "grant", "deny"]);
/** Which side may send each kind. `answer` goes both ways: the supervisor answers questions, the worker answers probes. */
export const KIND_DIRECTIONS: Readonly<Record<ChannelMessageKind, readonly ChannelDirection[]>> = {
  question: ["worker_to_supervisor"],
  tool_request: ["worker_to_supervisor"],
  help: ["worker_to_supervisor"],
  blocked: ["worker_to_supervisor"],
  probe: ["supervisor_to_worker"],
  rework: ["supervisor_to_worker"],
  answer: ["worker_to_supervisor", "supervisor_to_worker"],
  grant: ["supervisor_to_worker"],
  deny: ["supervisor_to_worker"],
};
/** Reply kinds each request kind accepts. */
export const REPLIES_FOR: Readonly<Partial<Record<ChannelMessageKind, readonly ChannelMessageKind[]>>> = {
  question: ["answer", "deny"],
  help: ["answer", "deny"],
  blocked: ["answer", "deny"],
  tool_request: ["grant", "deny", "answer"],
  probe: ["answer"],
};

/** Longest message body, in characters. */
export const CHANNEL_MESSAGE_MAX_BODY_CHARS = 20_000;
/** Most refs on one message. */
export const CHANNEL_MESSAGE_MAX_REFS = 32;
/** Most messages one list call returns. */
export const CHANNEL_MESSAGE_LIST_LIMIT = 200;

const TOOL_REF_RE = /^tool:([a-z][a-z0-9_]{0,63})$/;
/** `tool:<name>` refs for a tool request or grant. */
export function toolRefs(names: readonly string[]): string[] {
  return names.map((n) => `tool:${n}`);
}
/** Tool names carried by `tool:<name>` refs. */
export function toolsFromRefs(refs: readonly string[] | undefined): string[] {
  return (refs ?? []).flatMap((r) => {
    const m = TOOL_REF_RE.exec(r);
    return m ? [m[1]!] : [];
  });
}

export const RefsSchema = z.array(z.string().trim().min(1).max(400)).max(CHANNEL_MESSAGE_MAX_REFS);
const BodySchema = z
  .string()
  .transform(cleanChannelText)
  .pipe(z.string().min(1, "body is empty").max(CHANNEL_MESSAGE_MAX_BODY_CHARS, `body is longer than ${CHANNEL_MESSAGE_MAX_BODY_CHARS} characters`));

export const ChannelMessageSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    /** The task's project (copied from the task row when the message is stored). */
    projectId: z.string(),
    direction: ChannelDirectionSchema,
    kind: ChannelMessageKindSchema,
    body: z.string().min(1).max(CHANNEL_MESSAGE_MAX_BODY_CHARS),
    refs: RefsSchema.optional(),
    status: ChannelMessageStatusSchema,
    /** For a reply: the request it answers. */
    inReplyTo: z.string().min(1).optional(),
    createdAt: z.number().int(),
    /** Request: when its reply was recorded. */
    answeredAt: z.number().int().optional(),
    /** Reply or notice: when the recipient received it. */
    deliveredAt: z.number().int().optional(),
    expiredAt: z.number().int().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (!KIND_DIRECTIONS[m.kind].includes(m.direction)) ctx.addIssue({ code: "custom", path: ["direction"], message: `${m.kind} cannot be sent ${m.direction}` });
    if (CHANNEL_REPLY_KINDS.has(m.kind) !== (m.inReplyTo !== undefined)) ctx.addIssue({ code: "custom", path: ["inReplyTo"], message: "replies (answer, grant, deny) and only replies name inReplyTo" });
    if (m.status === "answered" && !CHANNEL_REQUEST_KINDS.has(m.kind)) ctx.addIssue({ code: "custom", path: ["status"], message: "only requests can be answered" });
    if (m.status === "delivered" && CHANNEL_REQUEST_KINDS.has(m.kind)) ctx.addIssue({ code: "custom", path: ["status"], message: "requests are answered, not delivered" });
  });
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

/** What `post` accepts: a request or a notice (replies go through `answer`). */
export const ChannelPostSchema = z
  .object({
    taskId: z.string().min(1),
    direction: ChannelDirectionSchema,
    kind: ChannelMessageKindSchema,
    body: BodySchema,
    refs: RefsSchema.default([]),
    /** Repeating a post with the same key for the same task returns the first message (e.g. a tool call id). */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ChannelPostInput = z.input<typeof ChannelPostSchema>;

/** What `answer` accepts. The reply's direction is the opposite of the request's. */
export const ChannelAnswerSchema = z
  .object({
    kind: ChannelMessageKindSchema,
    body: BodySchema,
    refs: RefsSchema.default([]),
  })
  .strict();
export type ChannelAnswerInput = z.input<typeof ChannelAnswerSchema>;

export type ChannelMessageErrorCode = "unknown_task" | "unknown_message" | "not_a_request" | "already_answered" | "expired" | "invalid_reply" | "invalid_post" | "not_deliverable";
export class ChannelMessageError extends Error {
  constructor(
    readonly code: ChannelMessageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a worker's wait for a reply ends with. */
export type ChannelAwaitOutcome =
  | { status: "answered"; request: ChannelMessage; reply: ChannelMessage }
  /** No answer within the wait. Control returns to the worker: proceed on its own judgment or stop. */
  | { status: "timeout"; request: ChannelMessage; guidance: "no answer, proceed or stop" }
  | { status: "expired"; request: ChannelMessage };

/**
 * The service surface over the channel (signatures only; the channel-backend lane implements
 * it, the MCP and worker-side lanes call it). Every method validates its input and enforces
 * task ownership and project scope in code.
 *
 * Wiring contract (implemented by the channel-backend lane, not here):
 * - `MeritRouter` (core/service.ts) exposes `readonly channel: SupervisorChannelService`, backed
 *   by a SupervisorChannelStore over each project's own store.
 * - `RunContext` (runners/types.ts) gains an optional `channel?: SupervisorChannelService`; the
 *   harness uses it for the always-on worker tools (ask_supervisor, request_tools,
 *   report_blocked, reply_supervisor), injects `pendingForWorker` messages at the start of each
 *   worker turn and then marks them delivered, and adds `grantedTools` to the worker's tool set.
 * - A worker waiting in awaitReply is watchdog-exempt (core/watchdog.ts WATCHDOG_EXEMPT_TOOLS
 *   gains the waiting tool's name) and spends no model requests.
 */
export interface SupervisorChannelService {
  /**
   * File a worker message (question, tool_request, help, blocked) for the worker's own running
   * task. `idempotencyKey` (the tool call id) makes a repeated call after an interruption return
   * the first message.
   */
  postFromWorker(input: { taskId: string; kind: "question" | "tool_request" | "help" | "blocked"; body: string; refs?: string[]; idempotencyKey?: string }): Promise<ChannelMessage>;

  /**
   * Wait for the reply to `messageId` without making model requests (the generalized
   * supervisor-action wait: watchdog-exempt, task lease and cancellation still enforced, the
   * paused span not charged to operation timeouts). Resolves `answered` (and marks the reply
   * delivered), `expired`, or `timeout` after `timeoutMs` with "no answer, proceed or stop";
   * rejects when `signal` aborts or the task lease is lost.
   */
  awaitReply(messageId: string, timeoutMs: number, signal: AbortSignal): Promise<ChannelAwaitOutcome>;

  /**
   * Answer a pending worker request: `answer` (question, help, blocked), `grant` (tool_request:
   * names a subset of the requested tools as tool:<name> refs; the grant takes effect for the
   * worker's next turn), or `deny`. Refuses a second answer.
   */
  replyFromSupervisor(input: { messageId: string; kind: "answer" | "grant" | "deny"; body: string; refs?: string[] }): Promise<ChannelMessage>;

  /**
   * Ask a task's worker a question. A running task receives it at its next turn and answers
   * with evidence refs; a finished task is answered by a read-only resume of its session.
   * Returns the probe request; its reply arrives in the supervisor's inbox.
   */
  probe(taskId: string, question: string): Promise<ChannelMessage>;

  /**
   * Send finished work back with feedback: creates a new task in the same worktree with the
   * original contract plus `criteria` as extra acceptance criteria, records a rework notice on
   * the original task, and keeps lineage with `SupervisorChannelStore.recordRework` (table
   * `task_rework`). Returns the new task's id.
   */
  rework(taskId: string, feedback: string, criteria?: string[]): Promise<string>;

  /**
   * Supervisor-to-worker messages for `taskId` not yet delivered (probes, replies, rework
   * notices), oldest first. The harness injects them into the worker's next turn, quoted as
   * data, then marks each delivered.
   */
  pendingForWorker(taskId: string): ChannelMessage[];

  /** Tool names granted to `taskId` through grant replies (see SupervisorChannelStore.grantedTools). */
  grantedTools(taskId: string): string[];

  /**
   * The supervisor's inbox: worker requests awaiting an answer and worker replies not yet
   * delivered, oldest first. `projectScope` limits it to one project; omitted, it covers every
   * project the calling supervisor may see (each project's own store).
   */
  listPendingForSupervisor(projectScope?: string): ChannelMessage[];
}
