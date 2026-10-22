import type { ResolvedConfig } from "../config/load.js";
import { maxAgentsPerJob } from "../config/schema.js";
import { projectLimits } from "../projects/schema.js";
import { batchKey } from "../runners/batch.js";
import { redundancyFor } from "./plans.js";
import { immediate } from "./db.js";
import type { ClaimAdmission, StoredTask, TaskStore } from "./tasks.js";
import { QueueClaimSchema, QueueCompanionsSchema, QueueTasksSchema, type QueueClaim, type QueueCompanions, type TaskQueue, type StoredTaskDTO } from "./task-queue.js";

/** Canonical batch compatibility includes project visibility. */
export function projectBatchKey(task: StoredTask): string | null {
  const key = batchKey(task.spec);
  return key === null ? null : JSON.stringify([task.row.project_id, key]);
}

/** Policy dependencies remain local to the SQLite adapter and its shared claim transaction. */
export class SqliteTaskQueue implements TaskQueue {
  constructor(private readonly cfg: ResolvedConfig, private readonly tasks: TaskStore,
    private readonly providerSlots: ClaimAdmission | null = null,
    private readonly projectConfig: ((slug: string) => ResolvedConfig | undefined) | null = null) {}

  async claim(raw: QueueClaim): Promise<StoredTaskDTO[]> {
    const { owner } = QueueClaimSchema.parse(raw);
    return immediate(this.tasks.db, () => QueueTasksSchema.parse(this.tasks.claim(owner, {
      maxConcurrent: this.cfg.execution.max_concurrent_tasks,
      maxWritersPerRepo: this.cfg.execution.max_concurrent_writers_per_repository,
      leaseMs: this.cfg.execution.lease_seconds * 1000,
      defaultTimeoutMs: this.cfg.execution.job_timeout_seconds * 1000,
      supervisorProfiles: Object.entries(this.cfg.profiles).filter(([, p]) => p?.mode === "supervisor").map(([n]) => n),
      maxSupervisors: this.cfg.supervisor.max_concurrent_jobs,
      supervisorTimeoutMs: this.cfg.supervisor.job_timeout_seconds * 1000,
      maxAgentsPerJob: (slug: string) => maxAgentsPerJob(this.projectConfig?.(slug) ?? this.cfg),
      ...(this.providerSlots ? { providerSlots: this.providerSlots } : {}),
      projectLimits: (slug: string) => {
        const limits = projectLimits(this.cfg, slug);
        return { priority: limits.priority, maxConcurrent: limits.max_concurrent_tasks };
      },
    })));
  }

  async claimCompanions(raw: QueueCompanions): Promise<StoredTaskDTO[]> {
    const input = QueueCompanionsSchema.parse(raw);
    return immediate(this.tasks.db, () => {
      const leader = this.tasks.dispatchable(input.leader.taskId, input.owner, input.leader.runCount);
      if (!leader) return [];
      const profile = this.cfg.profiles[leader.spec.profile];
      const key = profile?.mode === "completion" && profile.batching.enabled && !this.redundant(leader) ? projectBatchKey(leader) : null;
      if (!key) return [];
      const excluded = new Set(input.excludeTaskIds);
      // Existing TaskStore policy deliberately lets companions share their leader's execution slot.
      return QueueTasksSchema.parse(this.tasks.claimCompanions(input.owner, leader,
        task => !excluded.has(task.row.id) && projectBatchKey(task) === key && !this.redundant(task),
        profile!.batching.max_items - 1, this.cfg.execution.lease_seconds * 1000, this.cfg.execution.job_timeout_seconds * 1000));
    });
  }

  private redundant(task: StoredTask): boolean { return redundancyFor(this.tasks.db, task.spec) > 1; }
}
