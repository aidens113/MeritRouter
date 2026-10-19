import { z } from "zod";
import type { Db } from "./db.js";

/**
 * Team-wide file leases. A coding task holds a write lease on its allowed paths (globs) in its
 * writable repository from the moment it is claimed until it finishes, is interrupted, or is
 * deferred. A lease is live only while its task's lease is live (running and not expired), so
 * the leases of a task whose process died expire with the task lease; a resumed task acquires
 * a fresh lease when it is claimed again, before its session continues.
 */

export const LEASE_MODES = ["write"] as const;
export type LeaseMode = (typeof LEASE_MODES)[number];

/** Globs a coding task writes: its allowed paths, or the whole repository when it names none. */
export function writeGlobs(allowedPaths: string[] | undefined | null): string[] {
  return allowedPaths?.length ? allowedPaths : ["**"];
}

/** The literal directory part of a glob, before its first wildcard. */
function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?{[!]/);
  const head = cut < 0 ? glob : glob.slice(0, cut);
  return cut < 0 ? head : head.slice(0, head.lastIndexOf("/") + 1);
}

/**
 * Conservative overlap test: two path sets may overlap when one's literal prefix contains the
 * other's (may report overlap where none exists; never misses one).
 */
export function globsOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => {
    const px = staticPrefix(x);
    const py = staticPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }));
}

const LeaseRowSchema = z.object({
  id: z.number().int(),
  job_id: z.string().nullable(),
  task_id: z.string(),
  repository: z.string(),
  globs_json: z.string(),
  mode: z.enum(LEASE_MODES),
  acquired_at: z.number().int(),
  released_at: z.number().int().nullable(),
  release_reason: z.string().nullable(),
});

export interface FileLease {
  id: number;
  jobId: string | null;
  taskId: string;
  repository: string;
  globs: string[];
  mode: LeaseMode;
  acquiredAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
  /** Held now: not released and its task's lease is live. */
  live: boolean;
}

const LIVE_SQL = `l.released_at IS NULL AND t.state IN ('running','cancel_requested') AND t.lease_expires_at > ?`;

function hydrate(raw: unknown, live: boolean): FileLease {
  const r = LeaseRowSchema.parse(raw);
  const globs = z.array(z.string()).safeParse(JSON.parse(r.globs_json));
  return {
    id: r.id,
    jobId: r.job_id,
    taskId: r.task_id,
    repository: r.repository,
    globs: globs.success ? globs.data : ["**"],
    mode: r.mode,
    acquiredAt: r.acquired_at,
    releasedAt: r.released_at,
    releaseReason: r.release_reason,
    live,
  };
}

/** The live write lease (of another task) in `repository` whose globs overlap `globs`, if any. */
export function conflictingLease(db: Db, repository: string, globs: string[], now: number, exceptTaskId: string): FileLease | null {
  const rows = db
    .prepare(`SELECT l.* FROM file_leases l JOIN tasks t ON t.id = l.task_id WHERE l.repository = ? AND l.mode = 'write' AND l.task_id != ? AND ${LIVE_SQL} ORDER BY l.id`)
    .all(repository, exceptTaskId, now);
  for (const raw of rows) {
    const lease = hydrate(raw, true);
    if (globsOverlap(lease.globs, globs)) return lease;
  }
  return null;
}

/**
 * Acquire a write lease for a task being claimed (call inside the claim transaction). Leases the
 * task still holds from an earlier run are released first (`reacquired`).
 */
export function acquireLease(db: Db, lease: { jobId: string | null; taskId: string; repository: string; globs: string[]; mode?: LeaseMode }, now: number): void {
  releaseLeases(db, lease.taskId, "reacquired", now);
  db.prepare("INSERT INTO file_leases (job_id, task_id, repository, globs_json, mode, acquired_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    lease.jobId,
    lease.taskId,
    lease.repository,
    JSON.stringify(lease.globs),
    lease.mode ?? "write",
    now,
  );
}

/** Release every open lease of a task (finished, interrupted, deferred, or expired). */
export function releaseLeases(db: Db, taskId: string, reason: string, now: number): number {
  return db.prepare("UPDATE file_leases SET released_at = ?, release_reason = ? WHERE task_id = ? AND released_at IS NULL").run(now, reason, taskId).changes;
}

/** Read side of the file leases (plan views, insights, tests). */
export class FileLeaseStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private select(where: string, args: unknown[]): FileLease[] {
    const now = this.now();
    const rows = this.db
      .prepare(`SELECT l.*, (${LIVE_SQL}) AS is_live FROM file_leases l JOIN tasks t ON t.id = l.task_id WHERE ${where} ORDER BY l.id`)
      .all(now, ...args) as Array<Record<string, unknown> & { is_live: number }>;
    return rows.map(({ is_live, ...raw }) => hydrate(raw, is_live === 1));
  }

  /** Every lease a job's tasks held or hold, oldest first. */
  forJob(jobId: string): FileLease[] {
    return this.select("l.job_id = ?", [jobId]);
  }

  /** Every lease of one task, oldest first. */
  forTask(taskId: string): FileLease[] {
    return this.select("l.task_id = ?", [taskId]);
  }

  /** Leases held now, optionally in one repository. */
  live(repository?: string): FileLease[] {
    const now = this.now();
    return repository ? this.select(`l.repository = ? AND ${LIVE_SQL}`, [repository, now]) : this.select(LIVE_SQL, [now]);
  }
}
