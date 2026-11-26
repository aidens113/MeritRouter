/**
 * Export the supervisor<->worker exchange for one project as JSONL, one record per task: its
 * brief (when the spec maps back onto Brief v1), the tools it was granted, its channel messages
 * in order, its rendered report, the supervisor's verdict, check outcomes, rework lineage, and
 * the model(s) that served it. This is the corpus `supervisor-offload.md`'s "Later" section
 * means to fine-tune on.
 *
 * Secrets are redacted before anything is yielded. There is no existing helper for scrubbing
 * unknown secrets out of arbitrary free text (`providers/secret-masking.ts`'s `maskSecrets` only
 * masks secrets it is handed, i.e. it requires already knowing the exact key string, which a
 * worker's own quoted error text is not guaranteed to match); this module instead
 * pattern-matches token-shaped strings (Bearer headers, `sk-`/`sk-ant-`/`xox` prefixes, AWS
 * access keys, generic `key=`/`token=`/`secret=`/`password=` assignments) wherever they appear
 * in a task's goal, messages, report, or verdict reason. Nothing beyond what `renderReportV1`
 * already includes is added: no raw file contents, only the report text and metadata already
 * stored on the task and channel rows.
 */
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { requireProjectStores } from "./project-reads.js";
import { WorkerResultSchema, type WorkerResult } from "../core/task.js";
import { renderReportV1 } from "../core/report.js";
import { ChannelMessageSchema, type ChannelMessage } from "../core/channel.js";
import { splitRepoKey } from "../projects/context.js";

export const ExportExchangesInputSchema = z
  .object({
    project: z.string().min(1).max(200),
    /** Window start, epoch ms (inclusive). Default: no lower bound. */
    since: z.number().int().min(0).optional(),
  })
  .strict();
export type ExportExchangesInput = z.input<typeof ExportExchangesInputSchema>;

interface ChannelMessageRow {
  id: string;
  direction: string;
  kind: string;
  body: string;
  refs_json: string;
  status: string;
  in_reply_to: string | null;
  created_at: number;
  answered_at: number | null;
  delivered_at: number | null;
}

export interface ExchangeRecord {
  taskId: string;
  project: string;
  profile: string;
  state: string;
  createdAt: number;
  finishedAt: number | null;
  /** The stored task spec (goal, context, constraints, scope) — Brief v1 fields when they exist on it, raw spec otherwise. */
  brief: {
    goal: string | null;
    allowedPaths: string[];
    writableRepository: string | null;
    checks: string[];
    acceptanceCriteria: unknown[];
    label: string | null;
  };
  /** Tool names granted through the channel (SupervisorChannelStore.grantedTools), when the channel backend is wired; empty otherwise. */
  toolGrants: string[];
  /** Channel messages for this task, oldest first. */
  messages: Array<{ id: string; direction: string; kind: string; body: string; refs: string[]; status: string; inReplyTo: string | null; createdAt: number; answeredAt: number | null; deliveredAt: number | null }>;
  /** The rendered Report v1 text, same as a supervisor reads. Null when the task has no result yet. */
  report: string | null;
  /** The stored verification record's supervisor/human decisions, oldest first. */
  verdicts: Array<{ decision: string; by: { kind: string; id: string }; reason: string | null; at: number }>;
  checks: Array<{ command: string; exitCode: number | null; logRef: string }>;
  /** This task's rework lineage: the task it reworks, and the tasks that rework it. */
  rework: { reworksTask: string | null; reworkedBy: string[] };
  servedEndpoints: string[];
}

function safeResult(raw: string | null): WorkerResult | null {
  if (!raw) return null;
  try {
    return WorkerResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Secret-shaped substrings with no fixed length and no vault entry: bearer tokens, common vendor key prefixes, AWS access keys, and key=/token=/secret= assignments. */
const PATTERN_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bxox[abps]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\b(api[-_]?key|token|secret|password|access[-_]?token)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1=[redacted]"],
];

function redactPatterns(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERN_REDACTIONS) out = out.replace(re, replacement);
  return out;
}

function redactDeep(value: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactPatterns(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, vv]) => [k, walk(vv)]));
    return v;
  };
  return walk(value);
}

/**
 * One JSONL record per task, oldest first. Reads happen one task at a time, not buffered, so a
 * large project exports without holding every record in memory at once.
 */
export async function* exportExchanges(sy: MeritRouter, input: ExportExchangesInput): AsyncIterable<ExchangeRecord> {
  const { project, since } = ExportExchangesInputSchema.parse(input);
  const stores = requireProjectStores(sy, project);
  const rows = stores.db
    .prepare(`SELECT id, profile, state, created_at, finished_at, writable_repo, spec_json, result_json FROM tasks WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC, rowid ASC`)
    .all(project, since ?? 0) as Array<{ id: string; profile: string; state: string; created_at: number; finished_at: number | null; writable_repo: string | null; spec_json: string; result_json: string | null }>;

  for (const row of rows) {
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    const constraints = (spec.constraints as Record<string, unknown> | undefined) ?? {};
    const context = (spec.context as Record<string, unknown> | undefined) ?? {};
    const result = safeResult(row.result_json);

    const messages = stores.db.prepare(`SELECT * FROM channel_messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`).all(row.id) as ChannelMessageRow[];
    const grantRows = messages.filter((m) => m.kind === "grant");
    const toolGrants = [...new Set(grantRows.flatMap((m) => (JSON.parse(m.refs_json) as string[]).map((r) => r.replace(/^tool:/, ""))))].sort();
    const typedMessages: ChannelMessage[] = messages.map((m) => {
      const refs = JSON.parse(m.refs_json) as string[];
      return ChannelMessageSchema.parse({
        id: m.id,
        taskId: row.id,
        projectId: project,
        direction: m.direction,
        kind: m.kind,
        body: m.body,
        ...(refs.length ? { refs } : {}),
        status: m.status,
        ...(m.in_reply_to ? { inReplyTo: m.in_reply_to } : {}),
        createdAt: m.created_at,
        ...(m.answered_at !== null ? { answeredAt: m.answered_at } : {}),
        ...(m.delivered_at !== null ? { deliveredAt: m.delivered_at } : {}),
      });
    });

    const reworkOf = stores.db.prepare(`SELECT rework_of FROM task_rework WHERE task_id = ?`).get(row.id) as { rework_of: string } | undefined;
    const reworkedBy = (stores.db.prepare(`SELECT task_id FROM task_rework WHERE rework_of = ? ORDER BY created_at ASC`).all(row.id) as Array<{ task_id: string }>).map((r) => r.task_id);

    const record: ExchangeRecord = {
      taskId: row.id,
      project,
      profile: row.profile,
      state: row.state,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      brief: {
        goal: typeof spec.goal === "string" ? spec.goal : null,
        allowedPaths: Array.isArray(constraints.allowedPaths) ? (constraints.allowedPaths as string[]) : [],
        writableRepository: row.writable_repo ? splitRepoKey(row.writable_repo).alias : null,
        checks: Array.isArray(constraints.checks) ? (constraints.checks as string[]) : [],
        acceptanceCriteria: Array.isArray(constraints.acceptanceCriteria) ? (constraints.acceptanceCriteria as unknown[]) : [],
        label: typeof spec.label === "string" ? spec.label : null,
      },
      toolGrants,
      messages: typedMessages.map((m) => ({
        id: m.id,
        direction: m.direction,
        kind: m.kind,
        body: m.body,
        refs: [...(m.refs ?? [])],
        status: m.status,
        inReplyTo: m.inReplyTo ?? null,
        createdAt: m.createdAt,
        answeredAt: m.answeredAt ?? null,
        deliveredAt: m.deliveredAt ?? null,
      })),
      report: result ? renderReportV1(result, { messages: typedMessages }) : null,
      verdicts: (result?.verification?.decisions ?? []).map((d) => ({ decision: d.decision, by: d.by, reason: d.reason, at: d.at })),
      checks: (result?.checks ?? []).map((c) => ({ command: c.command, exitCode: c.exitCode, logRef: c.logRef })),
      rework: { reworksTask: reworkOf?.rework_of ?? null, reworkedBy },
      servedEndpoints: result?.servedEndpoints ?? [],
    };
    yield redactDeep(record) as ExchangeRecord;
  }
}

/** Render one exchange record as a JSONL line. */
export function exchangeRecordLine(record: ExchangeRecord): string {
  return JSON.stringify(record);
}
