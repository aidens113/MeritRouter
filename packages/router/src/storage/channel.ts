import { z } from "zod";
import type { Db } from "./db.js";
import { immediate } from "./db.js";

/**
 * The team channel (T2): an append-only, per-job stream of posts between a job's supervisor and
 * its workers (`job_channel`). Posts are model output: validated here, capped in length and
 * count, and always shown to other agents as quoted data, never as instructions. A post is
 * idempotent per (author session, call id), and a repeat of the same text by the same author
 * returns the earlier post, so a call repeated after an interruption does not post twice.
 */

export const CHANNEL_KINDS = ["finding", "blocker", "interface_contract"] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** Longest post text, in characters. */
export const CHANNEL_MAX_TEXT_CHARS = 2_000;
/** Most task references on one post. */
export const CHANNEL_MAX_REFS = 8;
/**
 * Default posts one worker task may make to its job's channel (proposed config key
 * `team.channel_max_posts_per_task`).
 */
export const DEFAULT_CHANNEL_POSTS_PER_TASK = 10;
/** Default posts a supervisor may make to its own job's channel. */
export const DEFAULT_CHANNEL_POSTS_PER_SUPERVISOR = 40;
/** Most posts one read returns. */
export const CHANNEL_READ_LIMIT = 50;

/** Strip control characters other than newline and tab; normalise line endings. */
export function cleanChannelText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

/** What an agent may post: validated before anything is stored. */
export const ChannelPostInputSchema = z
  .object({
    kind: ChannelKindSchema,
    text: z
      .string()
      .transform(cleanChannelText)
      .pipe(z.string().min(1, "text is empty").max(CHANNEL_MAX_TEXT_CHARS, `text is longer than ${CHANNEL_MAX_TEXT_CHARS} characters`)),
    /** Task ids or labels of the job's tasks the post is about; empty means job-wide. */
    refs: z.array(z.string().min(1).max(120)).max(CHANNEL_MAX_REFS).default([]),
  })
  .strict();
export type ChannelPostInput = z.input<typeof ChannelPostInputSchema>;

export interface ChannelAuthor {
  taskId: string | null;
  sessionId: string | null;
  role: string;
  label: string;
}

export interface ChannelPost {
  id: number;
  jobId: string;
  author: ChannelAuthor;
  kind: ChannelKind;
  /** Task ids the post references; empty for a job-wide post. */
  refs: string[];
  text: string;
  callId: string | null;
  createdAt: number;
  mirroredAt: number | null;
}

const RowSchema = z.object({
  id: z.number().int(),
  job_id: z.string(),
  author_task_id: z.string().nullable(),
  author_session_id: z.string().nullable(),
  author_role: z.string(),
  author_label: z.string(),
  kind: ChannelKindSchema,
  refs_json: z.string(),
  text: z.string(),
  call_id: z.string().nullable(),
  created_at: z.number().int(),
  mirrored_at: z.number().int().nullable(),
});

function hydrate(raw: unknown): ChannelPost {
  const r = RowSchema.parse(raw);
  const refs = z.array(z.string()).parse(JSON.parse(r.refs_json));
  return {
    id: r.id,
    jobId: r.job_id,
    author: { taskId: r.author_task_id, sessionId: r.author_session_id, role: r.author_role, label: r.author_label },
    kind: r.kind,
    refs,
    text: r.text,
    callId: r.call_id,
    createdAt: r.created_at,
    mirroredAt: r.mirrored_at,
  };
}

export class ChannelError extends Error {
  readonly code = "channel_rejected";
}

export interface ChannelReadFilter {
  /** Only posts that reference this task, are job-wide, or were posted by it (a worker's view). */
  forTask?: string;
  kinds?: ChannelKind[];
  /** Only posts with a larger id. */
  afterId?: number;
  limit?: number;
}

/** The `job_channel` table. */
export class ChannelStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Append a post (`refs` already resolved to task ids). Returns the stored post and whether it
   * is new: the same (author session, call id), or the same kind and text from the same author
   * in this job, returns the earlier post. Refused past `maxPerAuthor` posts by the author's task.
   */
  post(input: { jobId: string; author: ChannelAuthor; kind: ChannelKind; text: string; refs: string[]; callId: string | null; maxPerAuthor: number }): { post: ChannelPost; created: boolean } {
    const { jobId, author } = input;
    const text = cleanChannelText(input.text);
    const parsed = ChannelPostInputSchema.parse({ kind: input.kind, text, refs: input.refs });
    const refs = [...new Set(parsed.refs)].sort();
    return immediate(this.db, () => {
      if (author.sessionId && input.callId) {
        const same = this.db.prepare("SELECT * FROM job_channel WHERE author_session_id = ? AND call_id = ?").get(author.sessionId, input.callId);
        if (same) return { post: hydrate(same), created: false };
      }
      const repeat = this.db
        .prepare("SELECT * FROM job_channel WHERE job_id = ? AND author_task_id IS ? AND author_label = ? AND kind = ? AND text = ? ORDER BY id DESC LIMIT 1")
        .get(jobId, author.taskId, author.label, parsed.kind, parsed.text);
      if (repeat) return { post: hydrate(repeat), created: false };
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM job_channel WHERE job_id = ? AND author_task_id IS ? AND author_label = ?").get(jobId, author.taskId, author.label) as { n: number }).n;
      if (count >= input.maxPerAuthor) throw new ChannelError(`post limit reached: ${count} of ${input.maxPerAuthor} posts for this task`);
      const at = this.now();
      const r = this.db
        .prepare(
          `INSERT INTO job_channel (job_id, author_task_id, author_session_id, author_role, author_label, kind, refs_json, text, call_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(jobId, author.taskId, author.sessionId, author.role, author.label, parsed.kind, JSON.stringify(refs), parsed.text, input.callId, at);
      return { post: hydrate(this.db.prepare("SELECT * FROM job_channel WHERE id = ?").get(r.lastInsertRowid)), created: true };
    });
  }

  /** A job's posts, oldest first. */
  list(jobId: string, filter: ChannelReadFilter = {}): ChannelPost[] {
    const limit = Math.max(1, Math.min(filter.limit ?? CHANNEL_READ_LIMIT, CHANNEL_READ_LIMIT));
    const rows = this.db.prepare("SELECT * FROM job_channel WHERE job_id = ? AND id > ? ORDER BY id ASC").all(jobId, filter.afterId ?? 0).map(hydrate);
    const visible = rows.filter((p) => {
      if (filter.kinds?.length && !filter.kinds.includes(p.kind)) return false;
      if (!filter.forTask) return true;
      return p.refs.length === 0 || p.refs.includes(filter.forTask) || p.author.taskId === filter.forTask;
    });
    // The newest `limit` posts, still oldest first.
    return visible.slice(-limit);
  }

  get(id: number): ChannelPost | null {
    const row = this.db.prepare("SELECT * FROM job_channel WHERE id = ?").get(id);
    return row ? hydrate(row) : null;
  }

  /** Posts of a job not yet mirrored to the brain, oldest first. */
  unmirrored(jobId: string): ChannelPost[] {
    return this.db.prepare("SELECT * FROM job_channel WHERE job_id = ? AND mirrored_at IS NULL ORDER BY id ASC").all(jobId).map(hydrate);
  }

  /** Stamp posts as mirrored (once; the trigger refuses a second stamp). */
  markMirrored(ids: number[]): void {
    if (!ids.length) return;
    const at = this.now();
    const stmt = this.db.prepare("UPDATE job_channel SET mirrored_at = ? WHERE id = ? AND mirrored_at IS NULL");
    immediate(this.db, () => {
      for (const id of ids) stmt.run(at, id);
    });
  }
}
