import type { MeritRouter } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import { comparisons, type ComparisonRecord } from "../qualification/comparison.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { locateProjectTask, openProjectStores, taskIn } from "./project-reads.js";

// The work of the reserved `_qualification` project for the panel's install-wide Qualification
// page: qualification eval tasks and team-vs-single comparison runs on eval goals. That project is
// never listed among the projects (grid, switcher, pickers, dashboard), so this is where its tasks
// are viewed.

/** A top-level task of the qualification project (an eval trial, or one run of a comparison). */
export interface QualificationTaskRow {
  taskId: string;
  /** `qualification` (an eval trial) or `comparison` (a team or single run of an eval goal). */
  purpose: string;
  profile: string;
  label: string | null;
  goal: string;
  state: TaskState;
  createdAt: number;
  finishedAt: number | null;
  /** For an eval trial: its run, eval, trial number, and the model under test. */
  run: { runId: string; evalId: string; trial: number; endpointId: string } | null;
}

/** Whether a task belongs to the qualification project (checked in that project's own store). */
export function isQualificationTask(sy: MeritRouter, taskId: string): boolean {
  return locateProjectTask(sy, taskId, QUALIFICATION_PROJECT) !== null;
}

/**
 * The qualification project's top-level tasks, newest first (`purpose` limits them to one kind).
 * Read through the qualification project's own store; empty (never a crash) when that store
 * cannot be opened.
 */
export function qualificationTasks(sy: MeritRouter, opts: { limit?: number; purpose?: "qualification" | "comparison" } = {}): QualificationTaskRow[] {
  const opened = openProjectStores(sy, QUALIFICATION_PROJECT);
  if (!opened.ok) return [];
  const stores = opened.stores;
  const rows = stores.db
    .prepare(
      `SELECT t.id, t.purpose, q.run_id, q.eval_id, q.trial, q.endpoint_id FROM tasks t LEFT JOIN qualification_tasks q ON q.task_id = t.id
        WHERE t.project_id = ? AND json_extract(t.spec_json, '$.parentTaskId') IS NULL${opts.purpose ? " AND t.purpose = ?" : ""}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    )
    .all(QUALIFICATION_PROJECT, ...(opts.purpose ? [opts.purpose] : []), Math.max(1, Math.min(opts.limit ?? 100, 1000))) as Array<{ id: string; purpose: string; run_id: string | null; eval_id: string | null; trial: number | null; endpoint_id: string | null }>;
  return rows.flatMap((r) => {
    const t = taskIn(sy, stores, r.id);
    if (!t) return [];
    return [
      {
        taskId: r.id,
        purpose: r.purpose,
        profile: t.row.profile,
        label: t.spec.label ?? null,
        goal: t.spec.goal,
        state: t.row.state,
        createdAt: t.row.created_at,
        finishedAt: t.row.finished_at ?? null,
        run: r.run_id ? { runId: r.run_id, evalId: r.eval_id ?? "", trial: r.trial ?? 0, endpointId: r.endpoint_id ?? "" } : null,
      },
    ];
  });
}

/**
 * Comparisons on eval goals: those whose runs are in the qualification project, and those not
 * started yet whose goals all come from the eval suite. Newest first. A comparison of supplied
 * goals runs in a user project and is shown on that project's Teams page instead.
 */
export function qualificationComparisons(sy: MeritRouter, opts: { limit?: number } = {}): ComparisonRecord[] {
  const inQualification = (id: string) => isQualificationTask(sy, id);
  return comparisons(sy, { limit: 10_000 })
    .filter((c) => (c.results.length ? c.results.some((r) => inQualification(r.team.taskId) || inQualification(r.single.taskId)) : c.goals.length > 0 && c.goals.every((g) => g.source === "eval")))
    .slice(0, opts.limit ?? 20);
}
