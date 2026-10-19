import type { ResolvedConfig } from "../config/load.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import { batchKey } from "../runners/batch.js";
import type { Executor } from "./executor.js";

const MAX_AUTO_RESUMES = 3;

/**
 * In-process worker loop. Claims runnable tasks under a lease, forms prompt batches for
 * compatible completion tasks, and runs them. Several processes may share one store.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly tasks: TaskStore,
    private readonly executor: Executor,
    private readonly owner: string,
    /** Housekeeping on every tick (registry sync, qualification grading). */
    private readonly onTick: () => void = () => undefined,
  ) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  /**
   * Expired leases become interrupted. Read-only and completion work has no side effects, so
   * it is resumed automatically (a bounded number of times); coding work never is.
   */
  recover(): string[] {
    const interrupted = this.tasks.recoverExpiredLeases();
    for (const t of this.tasks.list({ states: ["interrupted"], limit: 500 })) {
      const mode = this.cfg.profiles[t.spec.profile]?.mode;
      if (mode && mode !== "coding" && t.row.run_count < MAX_AUTO_RESUMES) {
        this.tasks.resume(t.row.id);
      }
    }
    return interrupted;
  }

  kick(): void {
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        // Liveness marker for the panel ("a worker is running").
        this.tasks.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`worker:${this.owner}`, String(Date.now()));
        this.tasks.recoverExpiredLeases();
        this.onTick();
        const leaseMs = this.cfg.execution.lease_seconds * 1000;
        const defaultTimeoutMs = this.cfg.execution.job_timeout_seconds * 1000;
        const claimed = this.tasks.claim(this.owner, {
          maxConcurrent: this.cfg.execution.max_concurrent_tasks,
          maxWritersPerRepo: this.cfg.execution.max_concurrent_writers_per_repository,
          leaseMs,
          defaultTimeoutMs,
        });
        const taken = new Set<string>();
        for (const task of claimed) {
          if (taken.has(task.row.id)) continue;
          taken.add(task.row.id);
          const profile = this.cfg.profiles[task.spec.profile]!;
          const key = profile.mode === "completion" && profile.batching.enabled ? batchKey(task.spec) : null;
          if (key) {
            const companions = this.tasks.claimCompanions(
              this.owner,
              task,
              (t: StoredTask) => !taken.has(t.row.id) && batchKey(t.spec) === key,
              profile.batching.max_items - 1,
              leaseMs,
              defaultTimeoutMs,
            );
            // Claimed tasks that fit this batch join it instead of running alone.
            const extra = claimed.filter((c) => !taken.has(c.row.id) && batchKey(c.spec) === key).slice(0, profile.batching.max_items - 1 - companions.length);
            const members = [task, ...companions, ...extra];
            for (const m of members) taken.add(m.row.id);
            this.track(members.length > 1 ? this.executor.runBatch(members) : this.executor.runSingle(task));
          } else {
            this.track(this.executor.runSingle(task));
          }
        }
      } while (this.again);
    } finally {
      this.ticking = false;
    }
  }

  private track(p: Promise<void>): void {
    const wrapped = p
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(wrapped);
        this.kick();
      });
    this.inFlight.add(wrapped);
  }

  /** Stop claiming; in-flight tasks are interrupted so a later run can recover them. */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.tasks.db.prepare("DELETE FROM meta WHERE key = ?").run(`worker:${this.owner}`);
    } catch {
      // database already closed
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.executor.abortAll("shutdown");
    await Promise.allSettled([...this.inFlight]);
  }

  get busy(): number {
    return this.inFlight.size;
  }
}
