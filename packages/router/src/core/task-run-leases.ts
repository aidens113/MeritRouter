import type { ResolvedConfig } from "../config/load.js";
import type { StoredTask, TaskStore } from "../storage/tasks.js";
import { canonicalJson } from "../storage/tasks.js";
import { SqliteTaskLeases } from "../storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId, reconcileLeaseOperation, type LeaseRef, type LeaseReceipt, type TaskLeases, receiptApplied } from "../storage/task-leases.js";
import type { AbortReason } from "./disposition.js";
/** Local run identity, serialized renewal and shutdown drain; no provider or session backend authority. */
export class TaskRunLeases {
  readonly controllers = new Map<string, AbortController>();
  readonly port: TaskLeases;
  private readonly leaseRefs = new WeakMap<object, LeaseRef>();
  private readonly controllerRefs = new WeakMap<AbortController, LeaseRef>();
  private readonly pendingLeases = new Set<Promise<unknown>>();
  constructor(private readonly d: {
    cfg: ResolvedConfig;
    tasks: TaskStore;
    now: () => number;
    onSettled: (taskId: string) => void;
    taskLeases?: TaskLeases;
  }) {
    this.port = d.taskLeases ?? new SqliteTaskLeases(d.cfg, d.tasks, d.now);
  }
  async drain(): Promise<void> {
    while (this.pendingLeases.size)
      await Promise.allSettled([...this.pendingLeases]);
    await this.port.drain();
  }
  cancelTasksAsync(ids: string[], project?: string, actorLease?: LeaseRef): Promise<LeaseReceipt[]> {
    // Freeze logical cancellation targets before the first asynchronous port boundary.
    if (ids.length > 500)
      return Promise.reject(new Error("at most 500 cancellation targets"));
    const groups = new Map<string, Array<{
      taskId: string;
      incarnation: string;
      runCount: number;
    }>>();
    for (const id of ids) {
      const task = this.d.tasks.get(id);
      if (!task)
        continue;
      if (project !== undefined && task.row.project_id !== project)
        return Promise.reject(new Error("task cancellation is outside project scope"));
      const targets = groups.get(task.row.project_id) ?? [];
      targets.push({
        taskId: id, incarnation: task.row.lease_incarnation, runCount: task.row.run_count
      });
      groups.set(task.row.project_id, targets);
    }
    return this.trackLease((async () => {
      const receipts: LeaseReceipt[] = [];
      for (const [scope, targets] of groups) {
        const operationId = leaseOperationId(this.d.now());
        const receipt = await reconcileLeaseOperation(() => this.port.cancel({
          operationId, targets, project: scope, actor: actorLease ? "supervisor" : "control", ...(actorLease ? { actorLease } : {})
        }));
        if (receipt.operationId !== operationId || receipt.kind !== "cancel" || receipt.affected.some(item => !targets.some(target => canonicalJson(target) === canonicalJson(item.target))))
          throw new Error("cancellation receipt identity mismatch");
        for (const affected of receipt.affected) {
          const row = this.d.tasks.get(affected.target.taskId)?.row;
          if (row?.lease_incarnation !== affected.target.incarnation || row.run_count !== affected.target.runCount || row.state !== affected.state)
            continue;
          if (affected.state === "cancel_requested" && affected.owner)
            this.abortLease({
              ...affected.target, owner: affected.owner, project: scope
            }, "cancel");
          this.d.onSettled(affected.target.taskId);
        }
        receipts.push(receipt);
      }
      return receipts;
    })());
  }
  lease(task: StoredTask): LeaseRef {
    let lease = this.leaseRefs.get(task.row);
    if (!lease) {
      lease = capturedLease(task);
      this.leaseRefs.set(task.row, lease);
    }
    return lease;
  }
  trackLease<T>(promise: Promise<T>): Promise<T> {
    this.pendingLeases.add(promise);
    void promise.finally(() => this.pendingLeases.delete(promise)).catch(() => undefined);
    return promise;
  }
  abortLease(lease: LeaseRef, reason: AbortReason): void {
    const controller = this.controllers.get(lease.taskId);
    if (controller && canonicalJson(this.controllerRefs.get(controller)) === canonicalJson(lease))
      controller.abort(reason);
  }
  supervise(task: StoredTask, controller: AbortController): () => Promise<void> {
    const lease = this.lease(task);
    this.controllerRefs.set(controller, lease);
    let stopped = false, pending: Promise<void> | null = null;
    const renew = () => {
      if (stopped || pending || controller.signal.aborted)
        return;
      const operationId = leaseOperationId(this.d.now());
      pending = this.trackLease((async () => {
        try {
          const receipt = await reconcileLeaseOperation(() => this.port.renew({
            lease, operationId
          }));
          if (receipt.kind !== "renew" || receipt.operationId !== operationId || canonicalJson(receipt.lease) !== canonicalJson(lease))
            throw new Error("renewal receipt identity mismatch");
          const current = this.d.tasks.dispatchable(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project);
          if (!receiptApplied(receipt) || !current)
            controller.abort(receipt.original === "cancel_requested" ? "cancel" : "lease_lost");
        }
        catch {
          controller.abort("lease_lost");
        }
      })()).finally(() => {
        pending = null;
      });
    };
    const timer = setInterval(renew, Math.max(1000, Math.floor(this.d.cfg.execution.lease_seconds * 1000 / 4)));
    const deadline = task.row.deadline_at;
    const deadlineTimer = deadline ? setTimeout(() => controller.abort("deadline"), Math.max(0, deadline - this.d.now())) : null;
    return async () => {
      stopped = true;
      clearInterval(timer);
      if (deadlineTimer)
        clearTimeout(deadlineTimer);
      await pending;
      if (this.controllers.get(task.row.id) === controller)
        this.controllers.delete(task.row.id);
    };
  }
}
