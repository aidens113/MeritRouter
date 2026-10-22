import { z } from "zod";
import type { Db } from "../storage/db.js";
import { SwitchyardError } from "../core/errors.js";
import { TaskAttemptRecordSchema, TaskLabRecordSchema, type TaskAttemptRecord, type TaskLabRecord } from "./task-attempt-schema.js";
const AttemptRow = z.object({ id: z.string(), task_id: z.string(), project_id: z.string(), run_count: z.number(), lease_owner: z.string(), execution_id: z.string(), source_worktree: z.string(), writable_alias: z.string(), repositories_json: z.string(), submitted_commit: z.string().nullable(), submitted_tree: z.string().nullable(), patch_digest: z.string().nullable(), state: z.string(), created_at: z.number() });
const LabRow = z.object({ attempt_id: z.string(), lab_id: z.string().nullable(), desired_state: z.string(), phase: z.string(), checks_json: z.string(), recipe_json: z.string(), recipe_digest: z.string(), deadline_at: z.number(), result_json: z.string().nullable(), cleanup_error: z.string().nullable(), created_at: z.number(), updated_at: z.number() });
export class TaskAttemptStore {
  constructor(readonly db: Db) {
  }
  get(id: string): TaskAttemptRecord {
    const raw = this.db.prepare("SELECT * FROM task_workspace_attempts WHERE id=?").get(id);
    if (!raw)
      throw new SwitchyardError("not_found", "unknown task workspace attempt");
    const r = AttemptRow.parse(raw);
    return TaskAttemptRecordSchema.parse({ id: r.id, taskId: r.task_id, project: r.project_id, runCount: r.run_count, leaseOwner: r.lease_owner, executionId: r.execution_id, sourceWorktree: r.source_worktree, writableAlias: r.writable_alias, repositories: JSON.parse(r.repositories_json), submittedCommit: r.submitted_commit, submittedTree: r.submitted_tree, patchDigest: r.patch_digest, state: r.state, createdAt: r.created_at });
  }
  lab(id: string): TaskLabRecord | null {
    const raw = this.db.prepare("SELECT * FROM lab_task_attempts WHERE attempt_id=?").get(id);
    if (!raw)
      return null;
    const r = LabRow.parse(raw);
    return TaskLabRecordSchema.parse({ attemptId: r.attempt_id, labId: r.lab_id, desiredState: r.desired_state, phase: r.phase, checks: JSON.parse(r.checks_json), recipe: JSON.parse(r.recipe_json), recipeDigest: r.recipe_digest, deadlineAt: r.deadline_at, result: r.result_json ? JSON.parse(r.result_json) : null, cleanupError: r.cleanup_error, createdAt: r.created_at, updatedAt: r.updated_at });
  }
  save(lab: TaskLabRecord): void {
    const r = TaskLabRecordSchema.parse(lab);
    this.db.prepare("UPDATE lab_task_attempts SET lab_id=?,desired_state=CASE WHEN desired_state='stopped' THEN 'stopped' ELSE ? END,phase=?,result_json=?,cleanup_error=?,updated_at=? WHERE attempt_id=?").run(r.labId, r.desiredState, r.phase, r.result ? JSON.stringify(r.result) : null, r.cleanupError, Date.now(), r.attemptId);
  }
  all(): TaskLabRecord[] {
    return z.array(z.object({ attempt_id: z.string() })).parse(this.db.prepare("SELECT attempt_id FROM lab_task_attempts").all()).map(r => this.lab(r.attempt_id)!);
  }
}
