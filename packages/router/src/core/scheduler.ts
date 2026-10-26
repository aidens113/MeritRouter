import { readStoreIdentity } from "../projects/store-identity.js";
import { SqliteTaskLeases } from "../storage/sqlite-task-leases.js";
import type { TaskLeases } from "../storage/task-leases.js";
import { recoveryOperationId, leaseOperationId, reconcileLeaseOperation, capturedLease } from "../storage/task-leases.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ClaimAdmission, StoredTask, TaskStore } from "../storage/tasks.js";
import { redundancyFor } from "../storage/plans.js";
import { SqliteTaskQueue, projectBatchKey } from "../storage/sqlite-task-queue.js";
import { QueueTasksSchema, StoredTaskDTOSchema, TaskAttemptSchema, type TaskQueue, type TaskAttempt } from "../storage/task-queue.js";
import type { Executor } from "./executor.js";
import type { SessionStore } from "../sessions/store.js";
export { projectBatchKey } from "../storage/sqlite-task-queue.js";

/** Trusted coordination controls; project schedulers never write shared metadata locally. */
export interface SchedulerHostControls {
  managed:true;
  heartbeat(active:boolean):void;
  beforeDispatch(members:readonly StoredTask[]):"fresh"|"already_started"|"deferred"|Promise<"fresh"|"already_started"|"deferred">;
  wake?():void;
}
/** Runs an interrupted task gets automatically (recovery, watchdog) before an operator must resume it. */
export const MAX_AUTO_RESUMES = 3;

/**
 * In-process worker loop. Claims runnable tasks under a lease, forms prompt batches for
 * compatible completion tasks, and runs them. Several processes may share one store. Every
 * ready task of a job's task graph is claimed at once, up to `team.max_agents` per job and
 * `execution.max_concurrent_tasks` in all; a coding task whose write globs overlap another
 * task's live file lease in the same repository waits (see `TaskStore.claim`), and a worker
 * task waits while every platform in its route plan is out of concurrency slots. Projects share
 * the worker fairly: claims round-robin across projects with ready tasks, weighted by each
 * project's `priority` and bounded by its `max_concurrent_tasks`, and a prompt batch never
 * mixes projects.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private intervalMs = 1000;
  private retryDelayMs = 1000;
  private readonly taskLeases: TaskLeases;
  private startup: Promise<unknown> | null = null;
  private again = false;
  private stopped = false;
  private readonly recovering = new Set<Promise<string[]>>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly tasks: TaskStore,
    private readonly executor: Executor,
    private readonly owner: string,
    /** Housekeeping on every tick (registry sync, qualification grading). */
    private readonly onTick: () => void = () => undefined,
    /** Agent sessions: sessions left running by a dead process are ended `interrupted` at recovery. */
    private readonly sessions: SessionStore | null = null,
    /**
     * Per-provider concurrency: a worker task is claimed only when a platform in its route plan
     * has a free slot (see `ProviderSlotAdmission`); null claims without looking at providers.
     */
    private readonly providerSlots: ClaimAdmission | null = null,
    /** A project's configuration (its `team.max_agents` override); null or unknown: the global one. */
    private readonly projectConfig: ((slug: string) => ResolvedConfig | undefined) | null = null,
    readonly queue: TaskQueue = new SqliteTaskQueue(cfg, tasks, providerSlots, projectConfig),
    private readonly host:SchedulerHostControls|null=null,
  ) {
    this.taskLeases = executor.taskLeases ?? new SqliteTaskLeases(cfg, tasks);
    if(readStoreIdentity(tasks.db)?.role==="project"&&(!host||host.managed!==true||typeof host.heartbeat!=="function"||typeof host.beforeDispatch!=="function"))throw new Error("Project Scheduler requires explicit coordination controls");
  }

  start(intervalMs = 1000): void {
    if (this.timer || this.stopping || this.restartTimer || (this.host?.managed && this.startup && !this.stopped)) return;
    this.intervalMs = intervalMs;
    this.stopped = false;
    this.startup = this.recoverAsync();
    void this.startup.catch(() => undefined);
    if(this.host?.managed)return;
    this.timer = setInterval(() => this.wake(), intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  /**
   * Expired leases become interrupted, and sessions whose task lease is gone end `interrupted`
   * (`process_died`). Interrupted tasks are resumed automatically a bounded number of times:
   * agent-loop roles continue their session (coding in the same worktree, with interrupted
   * edits reconciled), the others re-run fresh (see the executor's resume rule).
   */
  recover(): string[] {
    const interrupted = this.tasks.recoverExpiredLeases();
    this.sessions?.markDeadRunning((s) => !s.taskId || this.tasks.leaseLive(s.taskId));
    for (const t of this.tasks.list({ states: ["interrupted"], limit: 500 })) {
      const mode = this.cfg.profiles[t.spec.profile]?.mode;
      if (mode && t.row.run_count < MAX_AUTO_RESUMES) {
        this.tasks.resume(t.row.id);
      }
    }
    return interrupted;
  }

  recoverAsync(mode: "expired_only" | "startup" = "startup"): Promise<string[]> {
    const operationId = recoveryOperationId(this.tasks.serverNow());
    const pending = (async () => {
      const receipt = await reconcileLeaseOperation(() => this.taskLeases.recover({ operationId, mode }));
      if (receipt.kind !== "recover" || receipt.operationId !== operationId) throw new Error("recovery receipt identity mismatch");
      if (mode === "startup") this.sessions?.markDeadRunning(s => !s.taskId || this.tasks.leaseLive(s.taskId));
      return [...new Set(receipt.affected.map(item => item.target.taskId))];
    })();
    this.recovering.add(pending);
    void pending.finally(() => this.recovering.delete(pending)).catch(() => undefined);
    return pending;
  }

  /** Wake the loop. A no-op unless start() was called (non-worker processes never run tasks). */
  kick(): void {
    if(this.host?.managed){this.host.wake?.();return;}
    if (!this.timer) return;
    this.wake();
  }

  private wake(): void {
    void this.tick().then(() => {
      this.retryDelayMs = 1000;
    }).catch(error => {
      const delay = this.retryDelayMs;
      console.error(`MeritRouter worker ${this.owner} stopped after a tick error; retrying in ${delay}ms`, error);
      this.retryDelayMs = Math.min(delay * 2, 60_000);
      if (this.stopping || this.restartTimer) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopping) this.start(this.intervalMs);
      }, delay);
      this.restartTimer.unref?.();
    });
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) { this.again = true; return this.ticking; }
    const pending = Promise.resolve().then(() => this.runTick()).finally(() => { this.ticking = null; });
    this.ticking = pending;
    return pending;
  }

  private async runTick(): Promise<void> {
    const acquired = new Map<string, StoredTask>();
    try {
      await this.startup;
      do {
        if (this.stopped) break;
        this.again = false;
        // Liveness marker for the panel ("a worker is running").
        if(this.host)this.host.heartbeat(true);
        else this.tasks.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`worker:${this.owner}`, String(Date.now()));
        // Stuck runs first: a run aborted here ends `interrupted` and is queued to resume.
        this.executor.checkWatchdog();
        await this.recoverAsync("expired_only");
        this.onTick();
        const claimed = await this.queueOperation(() => this.queue.claim({ owner: this.owner }));
        for (const task of claimed) acquired.set(this.attemptKey(task.row.id, task.row.run_count, task.row.lease_incarnation), task);
        if (this.stopped) break;
        const taken = new Set<string>();
        for (const task of claimed) {
          if (taken.has(task.row.id)) continue;
          taken.add(task.row.id);
          const profile = this.cfg.profiles[task.spec.profile]!;
          const key = profile.mode === "completion" && profile.batching.enabled && !this.redundant(task) ? projectBatchKey(task) : null;
          if (key) {
            const companions = await this.queueOperation(() => this.queue.claimCompanions({
              owner: this.owner, leader: { taskId: task.row.id, runCount: task.row.run_count, incarnation: task.row.lease_incarnation, project: task.row.project_id }, excludeTaskIds: [...taken],
            }));
            for (const member of companions) acquired.set(this.attemptKey(member.row.id, member.row.run_count, member.row.lease_incarnation), member);
            if (this.stopped) break;
            // Claimed tasks that fit this batch join it instead of running alone.
            const extra = claimed.filter((c) => !taken.has(c.row.id) && projectBatchKey(c) === key && !this.redundant(c)).slice(0, profile.batching.max_items - 1 - companions.length);
            const members = [task, ...companions, ...extra];
            for (const m of members) taken.add(m.row.id);
            await this.dispatch(members, acquired);
          } else {
            await this.dispatch([task], acquired);
          }
        }
      } while (this.again && !this.stopped);
    } catch (error) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if(this.host)this.host.heartbeat(false);
      else this.tasks.db.prepare("DELETE FROM meta WHERE key = ?").run(`worker:${this.owner}`);
      throw error;
    } finally {
      for (const task of acquired.values()) await this.abandon(task, "queue_dispatch_abandoned");
    }
  }

  private attemptKey(id: string, run: number, incarnation?: string): string { return JSON.stringify([id, run, incarnation]); }

  private async abandon(task: StoredTask, reason: string): Promise<void> {
    const lease = capturedLease(task), operationId = leaseOperationId(this.tasks.serverNow());
    await reconcileLeaseOperation(() => this.taskLeases.interrupt({ lease, operationId, reason }));
  }

  /** Local SQLite inventory fences receipt-loss cleanup from older dispatched attempts. */
  private ownedAttempts(): TaskAttempt[] {
    return TaskAttemptSchema.array().parse(this.tasks.db.prepare("SELECT id AS taskId, run_count AS runCount,lease_incarnation AS incarnation,project_id AS project FROM tasks WHERE lease_owner = ? AND state IN ('running','cancel_requested')").all(this.owner));
  }

  private async queueOperation(call: () => Promise<StoredTask[]>): Promise<StoredTask[]> {
    const before = new Set(this.ownedAttempts().map(ref => this.attemptKey(ref.taskId, ref.runCount, ref.incarnation)));
    try {
      const tasks = QueueTasksSchema.parse(await call());
      const keys = new Set(tasks.map(task => this.attemptKey(task.row.id, task.row.run_count, task.row.lease_incarnation)));
      const fresh = this.ownedAttempts().filter(ref => !before.has(this.attemptKey(ref.taskId, ref.runCount, ref.incarnation)));
      if (keys.size !== tasks.length || tasks.some(task => task.row.lease_owner !== this.owner || before.has(this.attemptKey(task.row.id, task.row.run_count, task.row.lease_incarnation))) || fresh.length !== keys.size || fresh.some(ref => !keys.has(this.attemptKey(ref.taskId, ref.runCount, ref.incarnation)))) {
        throw new Error("queue receipt does not match newly acquired SQLite attempts");
      }
      return tasks;
    } catch (error) {
      for (const ref of this.ownedAttempts()) {
        if (!before.has(this.attemptKey(ref.taskId, ref.runCount, ref.incarnation))) {
          const operationId = leaseOperationId(this.tasks.serverNow());
          await reconcileLeaseOperation(() => this.taskLeases.interrupt({ lease: { taskId: ref.taskId, owner: this.owner, runCount: ref.runCount, incarnation: ref.incarnation, project: ref.project }, operationId, reason: "queue_claim_uncertain" }));
        }
      }
      throw error;
    }
  }

  private async dispatch(members: StoredTask[], acquired: Map<string, StoredTask>): Promise<void> {
    if (this.stopped) return;
    // Re-read authority and task contents after every asynchronous queue boundary.
    const live = members.flatMap(member => {
      const current = this.tasks.dispatchable(member.row.id, this.owner, member.row.run_count, member.row.lease_incarnation, member.row.project_id);
      return current ? [StoredTaskDTOSchema.parse(current)] : [];
    });
    if (!live.length) return;
    if(this.host){
      const admitted=await this.host.beforeDispatch(live);
      if(admitted!=="fresh"){
        for(const task of live)acquired.delete(this.attemptKey(task.row.id,task.row.run_count,task.row.lease_incarnation));
        return;
      }
      // Admission can await local/global receipts. Stop, cancellation or expiry may
      // have arrived meanwhile; no executor starts from an earlier observation.
      if(this.stopped||live.some(task=>!this.tasks.dispatchable(task.row.id,this.owner,task.row.run_count,task.row.lease_incarnation,task.row.project_id)||(task.row.deadline_at!==null&&task.row.deadline_at<=this.tasks.serverNow())))return;
    }
    const running = live.length > 1 ? this.executor.runBatch(live) : this.executor.runSingle(live[0]!);
    for (const task of live) acquired.delete(this.attemptKey(task.row.id, task.row.run_count, task.row.lease_incarnation));
    this.track(running);
  }

  /** A plan node asking for redundant runs never joins a prompt batch (it runs as its own pair). */
  private redundant(task: StoredTask): boolean {
    return redundancyFor(this.tasks.db, task.spec) > 1;
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
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.executor.abortAll("shutdown");
    this.stopping = (async () => {
      await this.startup?.catch(() => undefined);
      await this.ticking?.catch(() => undefined);
      await Promise.allSettled([...this.inFlight]);
      while (this.recovering.size) await Promise.allSettled([...this.recovering]);
      if(this.host)this.host.heartbeat(false);
      else if (this.tasks.db.open) this.tasks.db.prepare("DELETE FROM meta WHERE key = ?").run(`worker:${this.owner}`);
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  get busy(): number {
    return this.inFlight.size;
  }
}
