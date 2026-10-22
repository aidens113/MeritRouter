import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { LabManager } from "./lab.js";
import type { TaskAttemptSource } from "./task-attempt-source.js";
import type { TaskAttemptRunner } from "./task-attempt-runner.js";
import { WorkerTaskSchema } from "../core/task.js";
import { immediate, newId } from "../storage/db.js";
import type { TaskAttemptRecord, TaskLabRecord } from "./task-attempt-schema.js";

/** Durable discriminator: ordinary cleanup recovery must not consume removal proof. */
export class TaskLabPruneRefusal extends Error {}
export const TASK_PRUNE_OPERATION = "task-lab-prune-v1";
const Intent = z.object({ kind: z.literal(TASK_PRUNE_OPERATION), identity: z.string().regex(/^[a-f0-9]{64}$/), verified: z.boolean() }).strict();
const Rows = z.array(z.object({ attempt_id: z.string() }));
const Terminal = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);

/** Both retention and explicit project cleanup use this same durable exclusion boundary. */
export class TaskAttemptPruner {
  constructor(readonly manager: LabManager, readonly source: TaskAttemptSource, readonly runner: TaskAttemptRunner, readonly open: () => boolean) {}
  private get db() { return this.source.store.db; }
  private eligible(request: TaskLabRecord, attempt: TaskAttemptRecord, ownId?: string): void {
    if (!this.open() || request.phase !== "retained" || request.desiredState !== "stopped" || request.result?.cleanup !== "complete" || !request.labId)
      throw new Error("task Lab cleanup is not complete");
    let id: string | undefined = attempt.taskId;
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id)) throw new Error("cyclic task ancestry");
      seen.add(id);
      const row = z.object({ state: z.string(), project_id: z.string(), spec_json: z.string() }).optional().parse(this.db.prepare("SELECT state,project_id,spec_json FROM tasks WHERE id=?").get(id));
      if (!row || row.project_id !== attempt.project || !Terminal.has(row.state)) throw new Error("task ancestry is not terminal in project");
      const task = WorkerTaskSchema.parse(JSON.parse(row.spec_json));
      if (task.id !== id) throw new Error("task identity changed");
      if (this.db.prepare("SELECT 1 FROM merge_queue WHERE task_id=? AND state IN ('queued','integrating','picked')").get(id)) throw new Error("task integration is pending");
      id = task.parentTaskId;
    }
    if (this.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND id!=? AND (state='pending' OR state='running')").get(attempt.id, ownId ?? "")) throw new Error("another task operation owns cleanup");
    if (this.db.prepare("SELECT 1 FROM lab_attempt_processes WHERE (lab_id=? OR attempt_id=?) AND state!='stopped'").get(request.labId, attempt.id)
      || this.db.prepare("SELECT 1 FROM lab_ports WHERE lab_id=?").get(request.labId)
      || this.db.prepare("SELECT 1 FROM lab_services WHERE lab_id=? AND (state!='stopped' OR pid IS NOT NULL OR token IS NOT NULL OR owner_id IS NOT NULL OR owner_until!=0)").get(request.labId)) throw new Error("task Lab still has resource ownership");
    const lab = this.manager.store.byId(request.labId);
    if (!lab || lab.state !== "stopped") throw new Error("task Lab is not stopped");
    this.runner.assertLab(lab, attempt);
  }
  private identity(attempt: TaskAttemptRecord, request: TaskLabRecord): string {
    const lab = this.manager.store.byId(request.labId!)!;
    return createHash("sha256").update(JSON.stringify({ attempt, lab: { id: lab.id, project: lab.project, name: lab.name, kind: lab.kind, root: lab.root, repositories: lab.repositories } })).digest("hex");
  }
  async run(project: string | undefined, retentionTime: number): Promise<{ removed: string[]; blocked: number }> {
    const rows = Rows.parse(this.db.prepare(`SELECT l.attempt_id FROM lab_task_attempts l JOIN task_workspace_attempts a ON a.id=l.attempt_id WHERE l.phase!='pruned' ${project === undefined ? "" : "AND a.project_id=?"} ORDER BY l.attempt_id`).all(...(project === undefined ? [] : [project])));
    const result = { removed: [] as string[], blocked: 0 };
    for (const row of rows) {
      if (!this.open()) { result.blocked += rows.length - result.removed.length - result.blocked; break; }
      let claim: { id: string; owner: string; identity: string; verified: boolean; request: TaskLabRecord; attempt: TaskAttemptRecord } | undefined;
      try {
        claim = immediate(this.db, () => {
          const request = this.source.store.lab(row.attempt_id)!;
          if (project === undefined && request.updatedAt > retentionTime - this.manager.services.config.keep_task_worktrees_days * 86400000) return undefined;
          const attempt = this.source.store.get(row.attempt_id);
          if (project !== undefined && attempt.project !== project) throw new Error("project scope changed");
          // Only expired removal generations may be superseded here. Other operation recovery stays with its supervisor.
          const now = Date.now();
          this.db.prepare("UPDATE task_lab_operations SET state='failed',lease_until=0,updated_at=? WHERE attempt_id=? AND error=? AND state='running' AND lease_until<=?").run(now, attempt.id, TASK_PRUNE_OPERATION, now);
          this.eligible(request, attempt);
          const identity = this.identity(attempt, request);
          const previous = z.array(z.object({ result_json: z.string().nullable() })).parse(this.db.prepare("SELECT result_json FROM task_lab_operations WHERE attempt_id=? AND error=?").all(attempt.id, TASK_PRUNE_OPERATION));
          const verified = previous.some(r => { try { const p = Intent.parse(JSON.parse(r.result_json ?? "null")); return p.identity === identity && p.verified; } catch { return false; } });
          if (!existsSync(this.manager.store.byId(request.labId!)!.root) && !verified) throw new Error("missing root has no verified removal intent");
          const id = newId("tlo"), owner = newId("prune");
          this.db.prepare("INSERT INTO task_lab_operations(id,attempt_id,kind,state,owner_id,lease_until,result_json,error,created_at,updated_at) VALUES(?,?,'cleanup','running',?,?,?,?,?,?)").run(id, attempt.id, owner, now + 30000, JSON.stringify({ kind: TASK_PRUNE_OPERATION, identity, verified }), TASK_PRUNE_OPERATION, now, now);
          return { id, owner, identity, verified, request, attempt };
        });
        if (!claim) continue;
        const c = claim;
        const assert = () => {
          if (!this.db.prepare("SELECT 1 FROM task_lab_operations WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").get(c.id, c.owner, Date.now())) throw new Error("prune generation lost");
          const request = this.source.store.lab(c.attempt.id)!;
          const attempt = this.source.store.get(c.attempt.id);
          this.eligible(request, attempt, c.id);
          if (this.identity(attempt, request) !== c.identity) throw new Error("prune identity changed");
        };
        const heartbeat = setInterval(() => {
          this.db.prepare("UPDATE task_lab_operations SET lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run(Date.now() + 30000, Date.now(), c.id, c.owner, Date.now());
        }, 250);
        heartbeat.unref();
        try {
          await this.runner.prune(c.request, c.attempt, { assert, resume: c.verified, verified: () => {
            assert();
            this.db.prepare("UPDATE task_lab_operations SET result_json=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run(JSON.stringify({ kind: TASK_PRUNE_OPERATION, identity: c.identity, verified: true }), c.id, c.owner, Date.now());
          } });
          // runner's final synchronous settlement is fenced; preserve immutable proof.
          const done = this.db.prepare("UPDATE task_lab_operations SET state='completed',lease_until=0,updated_at=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run(Date.now(), c.id, c.owner, Date.now());
          if (!done.changes) throw new Error("prune settlement generation lost");
          result.removed.push(c.request.labId!);
        } finally { clearInterval(heartbeat); }
      } catch (error) {
        if (claim) this.db.prepare("UPDATE lab_task_attempts SET cleanup_error=? WHERE attempt_id=? AND phase='retained'").run(error instanceof TaskLabPruneRefusal ? error.message : "Prune blocked: verify terminal task, stopped ownership and unchanged clean registered Git resources before retry", claim.attempt.id);
        if (claim) this.db.prepare("UPDATE task_lab_operations SET state='failed',lease_until=0,updated_at=? WHERE id=? AND owner_id=? AND state='running'").run(Date.now(), claim.id, claim.owner);
        result.blocked++;
      }
    }
    return result;
  }
}
