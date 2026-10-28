import { z } from "zod";
import type { Db } from "./db.js";

/**
 * Integration obligations of a supervised job: which of its completed coding tasks have reached
 * the job branch, and which are owed. Read from the store only (tasks, workspaces, merge_queue),
 * so the scheduler's dependency gate, the delivery stage guard and the supervisor's automatic
 * integration all judge the same facts. A completed coding task with changes whose acceptance is
 * `met` (verified, or accepted by its supervisor or a human) is owed to the job branch until its
 * merge-queue item is integrated; the supervisor runtime integrates it (see
 * harness/integration-tools.ts `drainOwedIntegrations`), never the model's memory.
 */

/** Prefix of a waiting dependent's state reason while an accepted upstream is not on the job branch yet. */
export const AWAITING_INTEGRATION = "awaiting_integration";

/**
 * When to record a prolonged integration wait, from the upstream's last result change.
 * This is an attention threshold, never permission to start without the accepted upstream.
 */
export const INTEGRATION_WAIT_MS = 15 * 60_000;

/** Where one completed coding task stands with its job branch. */
export type IntegrationStanding =
  /** Its merge-queue item is integrated. */
  | "integrated"
  /** Accepted (or not yet decided) and never queued. */
  | "owed"
  /** Queued or being integrated right now. */
  | "active"
  /** Its last integration attempt ended this way; it is not on the branch. */
  | "conflict"
  | "refused"
  | "failed"
  /** Its integration conflicted and a redo task took its place. */
  | "redelegated";

export interface JobIntegration {
  taskId: string;
  label: string | null;
  repo: string;
  /** The result's acceptance status (`met`, `not_verified`, `needs_supervisor`). */
  acceptance: string | null;
  standing: IntegrationStanding;
  /** Detail of the latest failed attempt (conflict files, refusal), when there is one. */
  detail: string | null;
  /** When the task's result last changed (completion or acceptance decision). */
  updatedAt: number;
}

const RowSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  parent: z.string().nullable(),
  result_json: z.string().nullable(),
  updated_at: z.number(),
  repo_alias: z.string(),
});

const ResultSchema = z
  .object({
    acceptanceStatus: z.string().nullable().optional(),
    patchRefs: z.array(z.string()).optional(),
    changedPaths: z.array(z.string()).optional(),
  })
  .passthrough();

const MergeRowSchema = z.object({ state: z.string(), detail_json: z.string().nullable(), redelegated_to: z.string().nullable() });

function standingOf(db: Db, jobId: string, taskId: string, repo: string, seen = new Set<string>(), followReplacement = true): { standing: IntegrationStanding; detail: string | null } {
  if (seen.has(taskId)) return { standing: "failed", detail: "cyclic integration replacement" };
  seen.add(taskId);
  if (db.prepare("SELECT 1 FROM merge_queue WHERE job_id = ? AND task_id = ? AND repo_alias = ? AND state = 'integrated' LIMIT 1").get(jobId, taskId, repo)) return { standing: "integrated", detail: null };
  const raw = db.prepare("SELECT state, detail_json, redelegated_to FROM merge_queue WHERE job_id = ? AND task_id = ? AND repo_alias = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId, taskId, repo);
  if (!raw) return { standing: "owed", detail: null };
  const row = MergeRowSchema.parse(raw);
  // A redo transfers work, not proof. Only its integration on this same job/repository
  // discharges the original accepted obligation, including a chain of conflict replacements.
  if (followReplacement && row.state === "redelegated" && row.redelegated_to && standingOf(db, jobId, row.redelegated_to, repo, seen).standing === "integrated") {
    return { standing: "integrated", detail: null };
  }
  let detail: string | null = null;
  try {
    const d = row.detail_json ? (JSON.parse(row.detail_json) as { error?: unknown; conflict?: { files?: unknown } }) : {};
    const files = Array.isArray(d.conflict?.files) ? (d.conflict.files as unknown[]).map(String).join(", ") : "";
    detail = files ? `conflicting files: ${files}` : typeof d.error === "string" ? d.error.slice(0, 300) : null;
  } catch {
    detail = null;
  }
  if (row.state === "redelegated") detail = `replacement ${row.redelegated_to ?? "unknown"}; cancel and re-delegate dependents against the replacement task instead of this original source`;
  switch (row.state) {
    case "queued":
    case "integrating":
    case "picked":
      return { standing: "active", detail };
    case "conflict":
    case "refused":
    case "failed":
    case "redelegated":
      return { standing: row.state, detail };
    default:
      return { standing: "owed", detail };
  }
}

function toIntegration(db: Db, raw: unknown, followReplacement = true): JobIntegration | null {
  const row = RowSchema.parse(raw);
  if (!row.parent || !row.result_json) return null;
  let result: z.infer<typeof ResultSchema>;
  try {
    result = ResultSchema.parse(JSON.parse(row.result_json));
  } catch {
    return null;
  }
  // Unmet results are never integrated; a result without changes has nothing to bring.
  if (result.acceptanceStatus === "unmet") return null;
  if (!(result.patchRefs?.length || result.changedPaths?.length)) return null;
  const { standing, detail } = standingOf(db, row.parent, row.id, row.repo_alias, new Set(), followReplacement);
  return { taskId: row.id, label: row.label, repo: row.repo_alias, acceptance: result.acceptanceStatus ?? null, standing, detail, updatedAt: row.updated_at };
}

const SELECT = `SELECT t.id AS id, json_extract(t.spec_json, '$.label') AS label, json_extract(t.spec_json, '$.parentTaskId') AS parent,
  t.result_json AS result_json, t.updated_at AS updated_at, w.repo_alias AS repo_alias
  FROM tasks t JOIN workspaces w ON w.task_id = t.id`;

/** Every completed coding task of a job with changes and a result that is not unmet, in completion order. */
export function jobIntegrations(db: Db, jobId: string): JobIntegration[] {
  const rows = db.prepare(`${SELECT} WHERE json_extract(t.spec_json, '$.parentTaskId') = ? AND t.state = 'completed' ORDER BY t.finished_at, t.id`).all(jobId);
  return rows.flatMap((r) => toIntegration(db, r) ?? []);
}

/** One task's standing, when it is a completed coding task of a job with changes (else null). */
export function taskIntegration(db: Db, taskId: string): JobIntegration | null {
  const row = db.prepare(`${SELECT} WHERE t.id = ? AND t.state = 'completed'`).get(taskId);
  return row ? toIntegration(db, row, false) : null;
}

/** Accepted results that are not on the job branch: what blocks validation and a completed finish. */
export function unintegratedAccepted(db: Db, jobId: string): JobIntegration[] {
  return jobIntegrations(db, jobId).filter((i) => i.acceptance === "met" && i.standing !== "integrated");
}

/** Is `jobId` a running (non-terminal) supervisor job, the only kind that integrates its tasks? */
function supervisingJob(db: Db, jobId: string): boolean {
  const raw = db.prepare("SELECT profile, state FROM tasks WHERE id = ?").get(jobId) as { profile: string; state: string } | undefined;
  return !!raw && raw.profile === "supervise" && !["completed", "failed", "cancelled", "budget_exhausted"].includes(raw.state);
}

/**
 * The upstreams a dependent waits for before it may start: accepted (`met`) coding tasks of the
 * same supervising job whose repository it reads and whose integration is incomplete.
 * `expired` is the subset needing attention after INTEGRATION_WAIT_MS; these remain waiting.
 */
export function awaitedIntegrations(
  db: Db,
  dependent: { parentTaskId?: string | undefined; repositoryAliases: readonly string[] },
  upstreamIds: readonly string[],
  now: number,
): { waiting: JobIntegration[]; expired: JobIntegration[] } {
  const waiting: JobIntegration[] = [];
  const expired: JobIntegration[] = [];
  const job = dependent.parentTaskId;
  if (!job || !supervisingJob(db, job)) return { waiting, expired };
  for (const id of upstreamIds) {
    const raw = db.prepare(`${SELECT} WHERE t.id = ? AND t.state = 'completed' AND json_extract(t.spec_json, '$.parentTaskId') = ?`).get(id, job);
    // A replacement's receipt proves its own source, never the original task's source.
    // Existing dependent specs must be re-delegated against the replacement explicitly.
    const i = raw ? toIntegration(db, raw, false) : null;
    if (!i || i.acceptance !== "met" || !dependent.repositoryAliases.includes(i.repo)) continue;
    if (i.standing === "integrated") continue;
    waiting.push(i);
    if (now - i.updatedAt >= INTEGRATION_WAIT_MS) expired.push(i);
  }
  return { waiting, expired };
}
