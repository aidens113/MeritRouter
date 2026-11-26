/**
 * SQLite store for the supervisor offload channel (`channel_messages`, `task_rework`). Message
 * shapes, errors and the service interface live in core/channel.ts.
 */
import { z } from "zod";
import { immediate, newId, type Db } from "./db.js";
import { cleanChannelText } from "./channel.js";
import {
  CHANNEL_MESSAGE_LIST_LIMIT, CHANNEL_REPLY_KINDS, CHANNEL_REQUEST_KINDS, ChannelAnswerInput, ChannelAnswerSchema, ChannelDirection, ChannelDirectionSchema, ChannelMessage, ChannelMessageError, ChannelMessageKindSchema, ChannelMessageSchema, ChannelMessageStatusSchema, ChannelPostInput, ChannelPostSchema, KIND_DIRECTIONS, REPLIES_FOR, RefsSchema, toolsFromRefs,
} from "../core/channel.js";

const RowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string(),
  direction: ChannelDirectionSchema,
  kind: ChannelMessageKindSchema,
  body: z.string(),
  refs_json: z.string(),
  status: ChannelMessageStatusSchema,
  in_reply_to: z.string().nullable(),
  created_at: z.number().int(),
  answered_at: z.number().int().nullable(),
  delivered_at: z.number().int().nullable(),
  expired_at: z.number().int().nullable(),
});

function hydrate(raw: unknown): ChannelMessage {
  const r = RowSchema.parse(raw);
  const refs = RefsSchema.parse(JSON.parse(r.refs_json));
  return ChannelMessageSchema.parse({
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    direction: r.direction,
    kind: r.kind,
    body: r.body,
    ...(refs.length ? { refs } : {}),
    status: r.status,
    ...(r.in_reply_to !== null ? { inReplyTo: r.in_reply_to } : {}),
    createdAt: r.created_at,
    ...(r.answered_at !== null ? { answeredAt: r.answered_at } : {}),
    ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
    ...(r.expired_at !== null ? { expiredAt: r.expired_at } : {}),
  });
}

export interface ChannelListOptions {
  /** Only messages created after this time. */
  since?: number;
  limit?: number;
}

/**
 * The `channel_messages` table. Every write runs in BEGIN IMMEDIATE and conditions its UPDATE on
 * the expected status, so concurrent processes answering, delivering or expiring the same
 * message settle on exactly one outcome.
 */
export class SupervisorChannelStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Store a request (question, tool_request, help, blocked, probe) or a notice (rework). The
   * project is taken from the task row. Returns the stored message and whether it is new.
   */
  post(input: ChannelPostInput): { message: ChannelMessage; created: boolean } {
    const p = ChannelPostSchema.parse(input);
    if (CHANNEL_REPLY_KINDS.has(p.kind)) throw new ChannelMessageError("invalid_post", `${p.kind} is a reply: record it with answer() on the request it answers`);
    if (!KIND_DIRECTIONS[p.kind].includes(p.direction)) throw new ChannelMessageError("invalid_post", `${p.kind} cannot be sent ${p.direction}`);
    const tools = toolsFromRefs(p.refs);
    if (p.kind === "tool_request" && !tools.length) throw new ChannelMessageError("invalid_post", "a tool_request must name at least one tool as a tool:<name> ref");
    const refs = [...new Set(p.refs)];
    return immediate(this.db, () => {
      const task = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(p.taskId) as { project_id: string } | undefined;
      if (!task) throw new ChannelMessageError("unknown_task", `unknown task ${p.taskId}`);
      if (p.idempotencyKey) {
        const same = this.db.prepare("SELECT * FROM channel_messages WHERE task_id = ? AND idempotency_key = ?").get(p.taskId, p.idempotencyKey);
        if (same) return { message: hydrate(same), created: false };
      }
      const id = newId("msg");
      this.db
        .prepare(
          `INSERT INTO channel_messages (id, project_id, task_id, direction, kind, body, refs_json, status, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, task.project_id, p.taskId, p.direction, p.kind, p.body, JSON.stringify(refs), p.idempotencyKey ?? null, this.now());
      return { message: this.mustGet(id), created: true };
    });
  }

  get(id: string): ChannelMessage | null {
    const row = this.db.prepare("SELECT * FROM channel_messages WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
  }

  /** The reply to a request, if one was recorded. */
  replyTo(requestId: string): ChannelMessage | null {
    const row = this.db.prepare("SELECT * FROM channel_messages WHERE in_reply_to = ?").get(requestId);
    return row ? hydrate(row) : null;
  }

  /** A task's messages, oldest first. */
  listForTask(taskId: string, opts: ChannelListOptions = {}): ChannelMessage[] {
    return this.db
      .prepare("SELECT * FROM channel_messages WHERE task_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?")
      .all(taskId, opts.since ?? -1, clampLimit(opts.limit))
      .map(hydrate);
  }

  /**
   * The supervisor's inbox for one project, oldest first: worker requests awaiting an answer and
   * worker replies (probe answers) not yet delivered. `taskIds` narrows it to some tasks.
   */
  listPendingForSupervisor(projectId: string, opts: ChannelListOptions & { taskIds?: string[] } = {}): ChannelMessage[] {
    const ids = opts.taskIds;
    if (ids && !ids.length) return [];
    const filter = ids ? ` AND task_id IN (${ids.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(
        `SELECT * FROM channel_messages WHERE project_id = ? AND direction = 'worker_to_supervisor' AND status = 'pending' AND created_at > ?${filter}
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(projectId, opts.since ?? -1, ...(ids ?? []), clampLimit(opts.limit))
      .map(hydrate);
  }

  /** Messages waiting for a task's worker (probes, replies, rework notices), oldest first. */
  listPendingForWorker(taskId: string, opts: ChannelListOptions = {}): ChannelMessage[] {
    return this.db
      .prepare("SELECT * FROM channel_messages WHERE task_id = ? AND direction = 'supervisor_to_worker' AND status = 'pending' AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?")
      .all(taskId, opts.since ?? -1, clampLimit(opts.limit))
      .map(hydrate);
  }

  /**
   * Record the one reply to a pending request, atomically: the request turns answered and the
   * reply is stored (pending until its recipient receives it). Refuses a second answer, an
   * expired request, a reply kind the request does not accept, and a grant of tools the request
   * did not ask for.
   */
  answer(requestId: string, input: ChannelAnswerInput): { request: ChannelMessage; reply: ChannelMessage } {
    const a = ChannelAnswerSchema.parse(input);
    return immediate(this.db, () => {
      const request = this.get(requestId);
      if (!request) throw new ChannelMessageError("unknown_message", `unknown message ${requestId}`);
      if (!CHANNEL_REQUEST_KINDS.has(request.kind)) throw new ChannelMessageError("not_a_request", `${request.kind} messages do not take answers`);
      if (request.status === "answered") throw new ChannelMessageError("already_answered", `message ${requestId} is already answered`);
      if (request.status !== "pending") throw new ChannelMessageError("expired", `message ${requestId} is ${request.status}`);
      if (!(REPLIES_FOR[request.kind] ?? []).includes(a.kind)) {
        throw new ChannelMessageError("invalid_reply", `a ${request.kind} is answered with ${(REPLIES_FOR[request.kind] ?? []).join(" or ")}, not ${a.kind}`);
      }
      const direction: ChannelDirection = request.direction === "worker_to_supervisor" ? "supervisor_to_worker" : "worker_to_supervisor";
      if (a.kind === "grant") {
        const asked = new Set(toolsFromRefs(request.refs));
        const granted = toolsFromRefs(a.refs);
        if (!granted.length) throw new ChannelMessageError("invalid_reply", "a grant must name the granted tools as tool:<name> refs");
        const extra = granted.filter((t) => !asked.has(t));
        if (extra.length) throw new ChannelMessageError("invalid_reply", `a grant can only name requested tools; not requested: ${extra.join(", ")}`);
      }
      const at = this.now();
      const updated = this.db.prepare("UPDATE channel_messages SET status = 'answered', answered_at = ? WHERE id = ? AND status = 'pending'").run(at, requestId);
      if (updated.changes !== 1) throw new ChannelMessageError("already_answered", `message ${requestId} is no longer pending`);
      const id = newId("msg");
      this.db
        .prepare(
          `INSERT INTO channel_messages (id, project_id, task_id, direction, kind, body, refs_json, status, in_reply_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, request.projectId, request.taskId, direction, a.kind, a.body, JSON.stringify([...new Set(a.refs)]), requestId, at);
      return { request: this.mustGet(requestId), reply: this.mustGet(id) };
    });
  }

  /**
   * Mark a reply or notice received by its recipient. Idempotent: an already delivered message
   * is returned unchanged. Requests and expired messages are refused.
   */
  markDelivered(id: string): ChannelMessage {
    return immediate(this.db, () => {
      const m = this.get(id);
      if (!m) throw new ChannelMessageError("unknown_message", `unknown message ${id}`);
      if (CHANNEL_REQUEST_KINDS.has(m.kind)) throw new ChannelMessageError("not_deliverable", `${m.kind} requests are answered, not delivered`);
      if (m.status === "delivered") return m;
      if (m.status !== "pending") throw new ChannelMessageError("not_deliverable", `message ${id} is ${m.status}`);
      this.db.prepare("UPDATE channel_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'").run(this.now(), id);
      return this.mustGet(id);
    });
  }

  /**
   * Expire a pending message (a request nobody answered in time, or a reply whose recipient is
   * gone). Returns the message and whether this call expired it; an answered or delivered
   * message is left as it is.
   */
  expire(id: string): { message: ChannelMessage; expired: boolean } {
    return immediate(this.db, () => {
      const m = this.get(id);
      if (!m) throw new ChannelMessageError("unknown_message", `unknown message ${id}`);
      const r = this.db.prepare("UPDATE channel_messages SET status = 'expired', expired_at = ? WHERE id = ? AND status = 'pending'").run(this.now(), id);
      return { message: this.mustGet(id), expired: r.changes === 1 };
    });
  }

  /**
   * Tool names granted to a task through `grant` replies (pending or delivered; an expired grant
   * never reached the worker), sorted. The harness adds them to the task's tool set.
   */
  grantedTools(taskId: string): string[] {
    const rows = this.db.prepare("SELECT refs_json FROM channel_messages WHERE task_id = ? AND kind = 'grant' AND status IN ('pending','delivered')").all(taskId) as Array<{ refs_json: string }>;
    return [...new Set(rows.flatMap((r) => toolsFromRefs(RefsSchema.parse(JSON.parse(r.refs_json)))))].sort();
  }

  /**
   * Record that `taskId` reworks `reworkOf` (table `task_rework`). Both tasks must exist in the
   * same project. Idempotent for the same pair; a task reworks at most one earlier task.
   */
  recordRework(input: { taskId: string; reworkOf: string; messageId?: string }): void {
    const { taskId, reworkOf } = z.object({ taskId: z.string().min(1), reworkOf: z.string().min(1), messageId: z.string().min(1).optional() }).strict().parse(input);
    if (taskId === reworkOf) throw new ChannelMessageError("invalid_post", "a task cannot rework itself");
    immediate(this.db, () => {
      const projects = this.db.prepare("SELECT id, project_id FROM tasks WHERE id IN (?, ?)").all(taskId, reworkOf) as Array<{ id: string; project_id: string }>;
      const task = projects.find((p) => p.id === taskId);
      const original = projects.find((p) => p.id === reworkOf);
      if (!task || !original) throw new ChannelMessageError("unknown_task", `unknown task ${!task ? taskId : reworkOf}`);
      if (task.project_id !== original.project_id) throw new ChannelMessageError("invalid_post", "a rework must stay in the original task's project");
      const existing = this.db.prepare("SELECT rework_of FROM task_rework WHERE task_id = ?").get(taskId) as { rework_of: string } | undefined;
      if (existing) {
        if (existing.rework_of !== reworkOf) throw new ChannelMessageError("invalid_post", `task ${taskId} already reworks ${existing.rework_of}`);
        return;
      }
      // Lineage is a chain back to the first attempt: refuse a link that would make a cycle.
      const parent = this.db.prepare("SELECT rework_of FROM task_rework WHERE task_id = ?");
      for (let at: string | undefined = reworkOf, steps = 0; at; steps++) {
        if (at === taskId || steps > 10_000) throw new ChannelMessageError("invalid_post", `task ${taskId} is already in ${reworkOf}'s rework lineage`);
        at = (parent.get(at) as { rework_of: string } | undefined)?.rework_of;
      }
      this.db.prepare("INSERT INTO task_rework (task_id, rework_of, project_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)").run(taskId, reworkOf, task.project_id, input.messageId ?? null, this.now());
    });
  }

  /** The task `taskId` reworks, or null. */
  reworkOf(taskId: string): string | null {
    const row = this.db.prepare("SELECT rework_of FROM task_rework WHERE task_id = ?").get(taskId) as { rework_of: string } | undefined;
    return row?.rework_of ?? null;
  }

  /** Tasks that rework `taskId`, oldest first. */
  reworksOf(taskId: string): string[] {
    return (this.db.prepare("SELECT task_id FROM task_rework WHERE rework_of = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as Array<{ task_id: string }>).map((r) => r.task_id);
  }

  private mustGet(id: string): ChannelMessage {
    const m = this.get(id);
    if (!m) throw new ChannelMessageError("unknown_message", `unknown message ${id}`);
    return m;
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? CHANNEL_MESSAGE_LIST_LIMIT, CHANNEL_MESSAGE_LIST_LIMIT));
}

