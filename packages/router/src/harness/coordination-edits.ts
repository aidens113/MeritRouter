import picomatch from "picomatch";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import { normalizeRelPath } from "../context/repo-reader.js";

/**
 * Supervisors delegate implementation (budget control D7). Under `supervisor.implementation:
 * delegate` a supervisor's edit tools may change only coordination files in its integration
 * worktree: paths matching `supervisor.coordination_paths` (shared docs), files a brief named as
 * `shared_files` (interface contracts it maintains for its workers), and the files of an
 * integration conflict it fixes. Everything else is refused in code with "delegate it".
 */

/** Job event recording the shared files a brief named (rebuilt on resume). */
export const SHARED_FILES_EVENT = "shared_files_declared";

/** A brief's `shared_files`, normalised to repository-relative paths (an `<alias>:` prefix is dropped). */
export function sharedFilesArg(it: Record<string, unknown>): string[] {
  const raw = Array.isArray(it.shared_files) ? it.shared_files : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) continue;
    const p = v.trim().replace(/^[A-Za-z0-9_-]+:(?![\\/])/, "").replace(/#L\d+(-L?\d+)?$/, "");
    try {
      const rel = normalizeRelPath(p);
      if (rel && !out.includes(rel)) out.push(rel);
    } catch {
      throw new Error(`shared_files: ${v} is not a repository-relative path`);
    }
  }
  return out;
}

const SharedEventSchema = z.object({ files: z.array(z.string()) }).passthrough();

/** Every shared file this job's briefs named (from its events). */
export function sharedFilesOf(db: Db, jobId: string): Set<string> {
  const rows = db.prepare("SELECT data_json FROM events WHERE task_id = ? AND type = ?").all(jobId, SHARED_FILES_EVENT) as Array<{ data_json: string | null }>;
  const out = new Set<string>();
  for (const r of rows) {
    const parsed = SharedEventSchema.safeParse(r.data_json ? JSON.parse(r.data_json) : null);
    if (parsed.success) for (const f of parsed.data.files) out.add(f);
  }
  return out;
}

const ConflictDetailSchema = z.object({ conflict: z.object({ files: z.array(z.string()) }).passthrough() }).passthrough();

/**
 * Files of this job's integrations that are in conflict now (the latest attempt of a task on the
 * repository ended `conflict`): the supervisor may fix them by hand.
 */
export function conflictFiles(db: Db, jobId: string, alias: string): Set<string> {
  const rows = db.prepare("SELECT task_id, state, detail_json FROM merge_queue WHERE job_id = ? AND repo_alias = ? ORDER BY created_at, rowid").all(jobId, alias) as Array<{ task_id: string; state: string; detail_json: string | null }>;
  const latest = new Map<string, { state: string; detail_json: string | null }>();
  for (const r of rows) latest.set(r.task_id, r);
  const out = new Set<string>();
  for (const r of latest.values()) {
    if (r.state !== "conflict" || !r.detail_json) continue;
    const parsed = ConflictDetailSchema.safeParse(JSON.parse(r.detail_json));
    if (parsed.success) for (const f of parsed.data.conflict.files) out.add(f.replace(/\\/g, "/"));
  }
  return out;
}

/**
 * The edit guard of a delegating supervisor's workspace: null when `rel` is a coordination file,
 * else the refusal. Null guard (no limit) under `supervisor.implementation: allowed`.
 */
export function coordinationGuard(o: { cfg: ResolvedConfig; db: Db; jobId: string; alias: string; sharedFiles: () => Set<string> }): ((rel: string) => string | null) | null {
  if (o.cfg.supervisor.implementation !== "delegate") return null;
  const docs = picomatch(o.cfg.supervisor.coordination_paths, { dot: true, nocase: true });
  return (rel) => {
    if (docs(rel)) return null;
    if (o.sharedFiles().has(rel)) return null;
    if (conflictFiles(o.db, o.jobId, o.alias).has(rel)) return null;
    return `${rel}: delegate it. Supervisors do not implement (supervisor.implementation: delegate); you may edit only coordination files: ${o.cfg.supervisor.coordination_paths.join(", ")}, files your briefs name in shared_files, and files of an integration conflict you are fixing. Delegate an implement task (with more budget, a narrower brief, or after its dependency lands) instead.`;
  };
}
