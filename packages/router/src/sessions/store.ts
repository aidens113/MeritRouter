import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProfileNameSchema, RoleNameSchema, TierNameSchema, type ProfileName, type RoleName, type TierName } from "../config/schema.js";
import { newId, type Db } from "../storage/db.js";
import { SessionEventSchema, SessionStatusSchema, SessionWorkspaceSchema, type CorruptLine, type SessionEvent, type SessionStatus, type SessionWorkspace } from "./events.js";
import { SessionRecorder } from "./recorder.js";

/** Logs live under `<storage.directory>/sessions/`; rows store the path relative to the storage directory. */
export const SESSIONS_DIR = "sessions";

export const CreateSessionInputSchema = z.object({
  taskId: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).nullable().optional(),
  /** The session that delegated this work, when known. */
  parentSessionId: z.string().min(1).nullable().optional(),
  /** The session this one retries or escalates (the task's prior run). */
  previousSessionId: z.string().min(1).nullable().optional(),
  role: RoleNameSchema,
  agentLabel: z.string().min(1),
  profile: ProfileNameSchema.nullable().optional(),
  tier: TierNameSchema.nullable().optional(),
});
export type CreateSessionInput = z.input<typeof CreateSessionInputSchema>;

export interface SessionRecord {
  id: string;
  taskId: string | null;
  jobId: string | null;
  parentSessionId: string | null;
  previousSessionId: string | null;
  role: RoleName;
  agentLabel: string;
  profile: ProfileName | null;
  tier: TierName | null;
  status: SessionStatus;
  stopReason: string | null;
  /** Absolute path of the JSONL log. */
  logPath: string;
  lastSeq: number;
  modelRequests: number;
  toolCalls: number;
  workspace: SessionWorkspace | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export interface SessionListFilter {
  status?: SessionStatus | SessionStatus[];
  taskId?: string;
  jobId?: string;
  parentSessionId?: string;
  /** Default 100, at most 1000. Newest first. */
  limit?: number;
}

export interface SessionEventsPage {
  sessionId: string;
  /** Valid events with `seq > afterSeq`, in log order, at most `limit`. */
  events: SessionEvent[];
  /** Lines that failed to parse or validate (skipped). A missing log is reported as line 0. */
  corrupt: CorruptLine[];
  /** More events follow; continue with `afterSeq` = the last returned seq. */
  hasMore: boolean;
  /** The index's last seq (what the log should contain up to). */
  lastSeq: number;
}

const RowSchema = z.object({
  id: z.string(),
  task_id: z.string().nullable(),
  job_id: z.string().nullable(),
  parent_session_id: z.string().nullable(),
  previous_session_id: z.string().nullable(),
  role: RoleNameSchema,
  agent_label: z.string(),
  profile: ProfileNameSchema.nullable(),
  tier: TierNameSchema.nullable(),
  status: SessionStatusSchema,
  stop_reason: z.string().nullable(),
  log_path: z.string(),
  last_seq: z.number().int(),
  model_requests: z.number().int(),
  tool_calls: z.number().int(),
  workspace_json: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  ended_at: z.number().nullable(),
});

const DEFAULT_EVENTS_LIMIT = 1000;
const MAX_EVENTS_LIMIT = 10_000;

/** Agent sessions: an append-only JSONL event log per session, indexed in SQLite. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly storageDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Absolute log path for a session id. */
  logPathFor(id: string): string {
    return path.join(this.storageDir, SESSIONS_DIR, `${id}.jsonl`);
  }

  /** Open a new running session and write its `started` event. */
  create(input: CreateSessionInput): SessionRecorder {
    const i = CreateSessionInputSchema.parse(input);
    const id = newId("s");
    const rel = `${SESSIONS_DIR}/${id}.jsonl`;
    mkdirSync(path.join(this.storageDir, SESSIONS_DIR), { recursive: true });
    const at = this.now();
    const fields = {
      taskId: i.taskId ?? null,
      jobId: i.jobId ?? null,
      parentSessionId: i.parentSessionId ?? null,
      previousSessionId: i.previousSessionId ?? null,
      role: i.role,
      agentLabel: i.agentLabel,
      profile: i.profile ?? null,
      tier: i.tier ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, job_id, parent_session_id, previous_session_id, role, agent_label, profile, tier, status, log_path, last_seq, model_requests, tool_calls, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?)`,
      )
      .run(id, fields.taskId, fields.jobId, fields.parentSessionId, fields.previousSessionId, fields.role, fields.agentLabel, fields.profile, fields.tier, rel, at, at);
    const rec = new SessionRecorder(id, this.db, this.logPathFor(id), this.now);
    rec.append("started", { sessionId: id, ...fields }, { name: fields.role });
    return rec;
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? this.record(row) : null;
  }

  /** Sessions matching every given filter, newest first. */
  list(filter: SessionListFilter = {}): SessionRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status !== undefined) {
      const statuses = (Array.isArray(filter.status) ? filter.status : [filter.status]).map((s) => SessionStatusSchema.parse(s));
      if (statuses.length === 0) return [];
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      args.push(...statuses);
    }
    if (filter.taskId !== undefined) (where.push("task_id = ?"), args.push(filter.taskId));
    if (filter.jobId !== undefined) (where.push("job_id = ?"), args.push(filter.jobId));
    if (filter.parentSessionId !== undefined) (where.push("parent_session_id = ?"), args.push(filter.parentSessionId));
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 100), 1000));
    const rows = this.db.prepare(`SELECT * FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
    return rows.map((r) => this.record(r));
  }

  /** Every session of a task, oldest first (retries and escalations in order). */
  forTask(taskId: string): SessionRecord[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId)
      .map((r) => this.record(r));
  }

  /**
   * Read a session's events back from its log, validating each line. Corrupt lines (including
   * a torn final line after a crash) are skipped and reported, never thrown. Null when the
   * session does not exist.
   */
  events(id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionEventsPage | null {
    const rec = this.get(id);
    if (!rec) return null;
    const afterSeq = opts.afterSeq ?? 0;
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? DEFAULT_EVENTS_LIMIT), MAX_EVENTS_LIMIT));
    const corrupt: CorruptLine[] = [];
    let text = "";
    try {
      text = readFileSync(rec.logPath, "utf8");
    } catch (err) {
      corrupt.push({ line: 0, error: `log unreadable: ${(err as Error).message}`, excerpt: "" });
    }
    const events: SessionEvent[] = [];
    let hasMore = false;
    const lines = text.split(/\r?\n/);
    for (const [n, line] of lines.entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        corrupt.push({ line: n + 1, error: `invalid JSON: ${(err as Error).message}`, excerpt: line.slice(0, 200) });
        continue;
      }
      const r = SessionEventSchema.safeParse(parsed);
      if (!r.success) {
        corrupt.push({ line: n + 1, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), excerpt: line.slice(0, 200) });
        continue;
      }
      if (r.data.seq <= afterSeq) continue;
      if (events.length >= limit) {
        hasMore = true;
        continue; // keep scanning so corrupt lines are still reported
      }
      events.push(r.data);
    }
    return { sessionId: id, events, corrupt, hasMore, lastSeq: rec.lastSeq };
  }

  private record(raw: unknown): SessionRecord {
    const r = RowSchema.parse(raw);
    let workspace: SessionWorkspace | null = null;
    if (r.workspace_json) {
      try {
        const w = SessionWorkspaceSchema.safeParse(JSON.parse(r.workspace_json));
        workspace = w.success ? w.data : null;
      } catch {
        workspace = null;
      }
    }
    return {
      id: r.id,
      taskId: r.task_id,
      jobId: r.job_id,
      parentSessionId: r.parent_session_id,
      previousSessionId: r.previous_session_id,
      role: r.role,
      agentLabel: r.agent_label,
      profile: r.profile,
      tier: r.tier,
      status: r.status,
      stopReason: r.stop_reason,
      logPath: path.resolve(this.storageDir, r.log_path),
      lastSeq: r.last_seq,
      modelRequests: r.model_requests,
      toolCalls: r.tool_calls,
      workspace,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      endedAt: r.ended_at,
    };
  }
}
