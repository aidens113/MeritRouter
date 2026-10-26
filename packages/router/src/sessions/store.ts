import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProfileNameSchema, RoleNameSchema, TierNameSchema, type ProfileName, type RoleName, type TierName } from "../config/schema.js";
import type { ChatMessage } from "../gateway/types.js";
import { immediate, newId, type Db } from "../storage/db.js";
import { ProjectEvidenceScope } from "../storage/project-evidence-scope.js";
import { SessionEventSchema, SessionStatusSchema, SessionWorkspaceSchema, type CorruptLine, type SessionEndStatus, type SessionEvent, type SessionStatus, type SessionWorkspace } from "./events.js";
import { indexUpdateFor, SessionRecorder, writeIndex } from "./recorder.js";
import { pendingIntentsFrom, planResume, replayTranscript, type PendingIntent, type PlanResumeOptions, type ResumePlan } from "./resume.js";

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
  project_id:z.string().optional(),
});

const DEFAULT_EVENTS_LIMIT = 1000;
const MAX_EVENTS_LIMIT = 10_000;

/** Stop reason given to sessions `markDeadRunning` interrupts. */
export const PROCESS_DIED = "process_died";

export interface ReopenOptions {
  /** Statuses a session may be reopened from. Default `["interrupted"]`. */
  from?: SessionEndStatus[];
}

/** Valid events of a whole log, in log order, and the lines that failed. */
function parseLog(text: string): { events: SessionEvent[]; corrupt: CorruptLine[] } {
  const events: SessionEvent[] = [];
  const corrupt: CorruptLine[] = [];
  for (const [n, line] of text.split(/\r?\n/).entries()) {
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
    events.push(r.data);
  }
  return { events, corrupt };
}

/**
 * Terminate a torn final line (a crash mid-write) so the next append starts a line of its own;
 * the torn line stays in the log and is reported as corrupt. A missing log is left missing.
 */
function terminateTornLine(logPath: string): void {
  let buf: Buffer;
  try {
    buf = readFileSync(logPath);
  } catch {
    return;
  }
  if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Agent sessions: an append-only JSONL event log per session, indexed in SQLite. */
export class SessionStore {
  private readonly scope:ProjectEvidenceScope;
  constructor(
    private readonly db: Db,
    private readonly storageDir: string,
    private readonly now: () => number = Date.now,
  ) {this.scope=new ProjectEvidenceScope(db);this.storageDir=this.scope.rootFor(storageDir);}

  /** Absolute log path for a session id. */
  logPathFor(id: string): string {
    const file=path.join(this.storageDir, SESSIONS_DIR, `${id}.jsonl`);this.scope.path(file,path.join(this.storageDir,SESSIONS_DIR));return file;
  }

  /** Open a new running session and write its `started` event. */
  create(input: CreateSessionInput): SessionRecorder {
    const i = CreateSessionInputSchema.parse(input);
    this.scope.assertTask(i.taskId);this.scope.assertTask(i.jobId);
    if(this.scope.project!==null)for(const parent of [i.parentSessionId,i.previousSessionId])if(parent&&!this.get(parent))throw new Error("Session parent is unavailable in this project");
    const id = newId("s");
    const rel = `${SESSIONS_DIR}/${id}.jsonl`;
    this.logPathFor(id);
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
        `INSERT INTO sessions (id, task_id, job_id, parent_session_id, previous_session_id, role, agent_label, profile, tier, status, log_path, last_seq, model_requests, tool_calls, created_at, updated_at,project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?,?)`,
      )
      .run(id, fields.taskId, fields.jobId, fields.parentSessionId, fields.previousSessionId, fields.role, fields.agentLabel, fields.profile, fields.tier, rel, at, at,this.scope.project??"");
    const rec = new SessionRecorder(id, this.db, this.logPathFor(id), this.now);
    rec.append("started", { sessionId: id, ...fields });
    return rec;
  }

  /**
   * Continue an ended session: its status goes back to `running` (stop reason and end time
   * cleared) and the returned recorder continues its sequence numbers, knows the logged
   * transcript (so `syncMessages` logs only new or rewritten messages), and can still close its
   * open intents. A torn final log line is terminated first, and index rows missing for durable
   * log lines are backfilled. Writes a `note` "reopened" with the previous status. Throws when
   * the session does not exist or its status is not in `opts.from` (default `interrupted`); the
   * status check and the switch to `running` are one transaction, so two processes cannot
   * reopen the same session.
   */
  reopen(id: string, opts: ReopenOptions = {}): SessionRecorder {
    const rec = this.get(id);
    if (!rec) throw new Error(`unknown session ${id}`);
    const from = opts.from ?? ["interrupted"];
    const { events, seq } = this.reattach(rec);
    const prev = this.get(id)!;
    const at = this.now();
    const claimed = immediate(this.db, () =>
      from.length
        ? this.db
            .prepare(`UPDATE sessions SET status = 'running', stop_reason = NULL, ended_at = NULL, updated_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`)
            .run(at, id, ...from).changes
        : 0,
    );
    if (claimed !== 1) throw new Error(`session ${id} is ${prev.status}; only ${from.join(" or ") || "no"} sessions can be reopened`);
    const recorder = new SessionRecorder(id, this.db, rec.logPath, this.now, seq, {
      messages: replayTranscript(events).messages,
      openIntents: pendingIntentsFrom(events).map((p) => ({ seq: p.seq, callId: p.callId, name: p.name })),
    });
    recorder.note("reopened", { previousStatus: prev.status, previousStopReason: prev.stopReason });
    return recorder;
  }

  /**
   * At recovery: every `running` session for which `isLeaseLive` returns false (its owner is
   * gone, e.g. its task lease expired) ends `interrupted` with `stopReason` (default
   * `process_died`), written to its log as an `ended` event. Returns the sessions it ended.
   */
  markDeadRunning(isLeaseLive: (session: SessionRecord) => boolean, stopReason: string = PROCESS_DIED): SessionRecord[] {
    this.scope.assert();
    const out: SessionRecord[] = [];
    const running = this.db.prepare("SELECT * FROM sessions WHERE status = 'running' ORDER BY created_at, rowid").all().map((r) => this.record(r));
    for (const rec of running) {
      if (isLeaseLive(rec)) continue;
      const { seq } = this.reattach(rec);
      if (this.get(rec.id)?.status !== "running") continue; // the log already ended it
      new SessionRecorder(rec.id, this.db, rec.logPath, this.now, seq).end("interrupted", stopReason);
      out.push(this.get(rec.id)!);
    }
    return out;
  }

  /** The transcript rebuilt from the log's `message` events (see `replayTranscript`). Null for an unknown session. */
  transcript(id: string): ChatMessage[] | null {
    const all = this.allEvents(id);
    return all ? replayTranscript(all.events).messages : null;
  }

  /** Tool intents with no outcome (see `PendingIntent`). Null for an unknown session. */
  pendingIntents(id: string): PendingIntent[] | null {
    const all = this.allEvents(id);
    return all ? pendingIntentsFrom(all.events) : null;
  }

  /** `planResume` over the whole log, with corrupt lines added to its warnings. Null for an unknown session. */
  planResume(id: string, opts: PlanResumeOptions = {}): ResumePlan | null {
    const all = this.allEvents(id);
    if (!all) return null;
    const plan = planResume(all.events, opts);
    for (const c of all.corrupt) plan.warnings.push(`log line ${c.line} skipped: ${c.error}`);
    return plan;
  }

  get(id: string): SessionRecord | null {
    this.scope.assert();
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? this.record(row) : null;
  }

  /** Sessions matching every given filter, newest first. */
  list(filter: SessionListFilter = {}): SessionRecord[] {
    this.scope.assert();
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
    this.scope.assertTask(taskId);
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
    const log = this.readLog(rec.logPath);
    const after = log.events.filter((e) => e.seq > afterSeq);
    return { sessionId: id, events: after.slice(0, limit), corrupt: log.corrupt, hasMore: after.length > limit, lastSeq: rec.lastSeq };
  }

  /** Every valid event of a session's log (no paging). Null for an unknown session. */
  private allEvents(id: string): { events: SessionEvent[]; corrupt: CorruptLine[] } | null {
    const rec = this.get(id);
    return rec ? this.readLog(rec.logPath) : null;
  }

  private readLog(logPath: string): { events: SessionEvent[]; corrupt: CorruptLine[] } {
    this.scope.path(logPath,path.join(this.storageDir,SESSIONS_DIR));
    let text: string;
    try {
      text = readFileSync(logPath, "utf8");
    } catch (err) {
      return { events: [], corrupt: [{ line: 0, error: `log unreadable: ${(err as Error).message}`, excerpt: "" }] };
    }
    return parseLog(text);
  }

  /**
   * Bring a session's index in line with its log before appending to it again: terminate a
   * torn final line, then backfill index rows (and counters, status) for durable log lines the
   * index missed (a crash between the fsync and the SQLite update). Returns the log's events and
   * the seq to continue from.
   */
  private reattach(rec: SessionRecord): { events: SessionEvent[]; seq: number } {
    this.scope.path(rec.logPath,path.join(this.storageDir,SESSIONS_DIR));
    terminateTornLine(rec.logPath);
    const { events } = this.readLog(rec.logPath);
    const indexed = immediate(this.db, () => {
      const row = this.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(rec.id) as { last_seq: number } | undefined;
      const last = row?.last_seq ?? 0;
      for (const e of events) if (e.seq > last) writeIndex(this.db, rec.id, e.seq, e.type, e.at, indexUpdateFor(e));
      return last;
    });
    const seq = events.reduce((m, e) => Math.max(m, e.seq), Math.max(indexed, rec.lastSeq));
    return { events, seq };
  }

  private record(raw: unknown): SessionRecord {
    this.scope.assert();
    const r = RowSchema.parse(raw);
    if(this.scope.project!==null&&r.project_id!==this.scope.project)throw new Error("Session belongs to another project");
    this.scope.assertTask(r.task_id);this.scope.assertTask(r.job_id);
    let workspace: SessionWorkspace | null = null;
    if (r.workspace_json) {
      try {
        const w = SessionWorkspaceSchema.safeParse(JSON.parse(r.workspace_json));
        workspace = w.success ? w.data : null;
      } catch {
        workspace = null;
      }
    }
    const logPath=path.resolve(this.storageDir,r.log_path);this.scope.path(logPath,path.join(this.storageDir,SESSIONS_DIR));
    if(this.scope.project!==null&&logPath!==this.logPathFor(r.id))throw new Error("Session log pointer disagrees with its session identity");
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
      logPath,
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
