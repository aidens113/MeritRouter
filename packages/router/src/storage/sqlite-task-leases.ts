import { StoredTaskDTOSchema } from "./task-queue.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { immediate } from "./db.js";
import { canonicalJson, type StoredTask, type TaskStore } from "./tasks.js";
import { LEASE_RECEIPT_WINDOW_MS, RECOVERY_RECEIPT_WINDOW_MS, LEASE_RECEIPT_CAPACITY, RECOVERY_RECEIPT_CAPACITY, RECOVERY_TOTAL_THRESHOLD, LeaseReceiptSchema, RenewLeaseSchema, FinishLeaseSchema, InterruptLeaseSchema, DeferLeaseSchema, RecoverLeasesSchema, CancelLeasesSchema, type LeaseRef, type LeaseReceipt, type TaskLeases } from "./task-leases.js";
/** Local SQLite server-time authority. All mutation and receipt writes share one immediate transaction. */
export class SqliteTaskLeases implements TaskLeases {
  constructor(private readonly cfg: ResolvedConfig, readonly tasks: TaskStore, private readonly now: () => number = () => tasks.serverNow()) {
  }
  async drain(): Promise<void> {
  }
  private read(id: string): StoredTask | undefined {
    const task = this.tasks.get(id);
    return task ? StoredTaskDTOSchema.parse(task) : undefined;
  }
  private mutate(kind: LeaseReceipt["kind"], input: {
    operationId: string;
    lease?: LeaseRef;
    targets?: Array<{
      taskId: string;
      incarnation: string;
    }>;
  }, change: (now: number, scopes: Set<string>) => Omit<LeaseReceipt, "operationId" | "kind" | "serverNow">): LeaseReceipt {
    // Cleanup must commit even when the subsequent authority transaction refuses at quota.
    // Nested transactions are savepoints and could roll that progress back with the caller.
    if (this.tasks.db.inTransaction)
      throw new Error("async task lease mutations require an independent transaction");
    const recovery = kind === "recover";
    const window = recovery ? RECOVERY_RECEIPT_WINDOW_MS : LEASE_RECEIPT_WINDOW_MS;
    const issued = Number.parseInt(input.operationId.split("_")[1]!, 36);
    const validateKey = (now: number) => {
      const pattern = recovery ? /^trecover_[a-z0-9]{1,12}_[a-f0-9]{24}$/ : /^tlease_[a-z0-9]{1,12}_[a-f0-9]{24}$/;
      if (!pattern.test(input.operationId) || !Number.isSafeInteger(issued) || issued > now + 60000 || issued < now - window)
        throw new Error("task lease operation key is outside its retry window");
    };
    validateKey(this.now());
    immediate(this.tasks.db, () => {
      this.tasks.db.prepare("DELETE FROM task_lease_operation_keys WHERE id IN (SELECT id FROM task_lease_operation_keys WHERE expires_at<? ORDER BY expires_at,id LIMIT 500)").run(this.now());
    });
    return immediate(this.tasks.db, () => {
      const now = this.now();
      validateKey(now);
      if (Buffer.byteLength(canonicalJson(input), "utf8") > 2 * 1024 * 1024)
        throw new Error("task lease input exceeds size limit");
      const digest = createHash("sha256").update(canonicalJson({
        kind, input
      })).digest("hex");
      const known = z.object({ request_digest: z.string() }).optional().parse(this.tasks.db.prepare("SELECT request_digest FROM task_lease_operation_keys WHERE id=?").get(input.operationId));
      if (known && known.request_digest !== digest)
        throw new Error("task lease operation key reused with a different payload");
      const existing = z.object({
        request_digest: z.string(), response_json: z.string()
      }).optional().parse(this.tasks.db.prepare("SELECT request_digest,response_json FROM task_lease_operations WHERE id=?").get(input.operationId));
      if (existing) {
        if (existing.request_digest !== digest)
          throw new Error("task lease operation key reused with a different payload");
        return LeaseReceiptSchema.parse({
          ...LeaseReceiptSchema.parse(JSON.parse(existing.response_json)), disposition: "replayed"
        });
      }
      if (known)
        return LeaseReceiptSchema.parse({
          operationId: input.operationId, kind, disposition: "replayed", original: "stale", serverNow: now, ...(input.lease ? { lease: input.lease } : {}), affected: []
        });
      const count = z.object({ n: z.number() }).parse(this.tasks.db.prepare("SELECT COUNT(*) n FROM task_lease_operation_keys").get()).n;
      if (count >= LEASE_RECEIPT_CAPACITY)
        throw new Error("task lease receipt capacity exhausted");
      if (recovery) {
        const maintenance = z.object({ n: z.number() }).parse(this.tasks.db.prepare("SELECT COUNT(*) n FROM task_lease_operation_keys WHERE id GLOB 'trecover_*'").get()).n;
        if (count >= RECOVERY_TOTAL_THRESHOLD || maintenance >= RECOVERY_RECEIPT_CAPACITY)
          throw new Error("task recovery receipt capacity exhausted");
      }
      this.tasks.db.prepare("INSERT INTO task_lease_operation_keys(id,request_digest,expires_at) VALUES(?,?,?)").run(input.operationId, digest, issued + window);
      const scopes = new Set<string>();
      const receipt = LeaseReceiptSchema.parse({
        ...change(now, scopes), operationId: input.operationId, kind, serverNow: now
      });
      const exists = (taskId: string, incarnation: string) => this.read(taskId)?.row.lease_incarnation === incarnation;
      const privateScopeExists = input.lease ? exists(input.lease.taskId, input.lease.incarnation) : input.targets ? input.targets.some(target => exists(target.taskId, target.incarnation)) : true;
      if (!privateScopeExists)
        return receipt;
      const serialized = JSON.stringify(receipt);
      if (Buffer.byteLength(serialized, "utf8") > 1048576)
        throw new Error("task lease receipt exceeds size limit");
      this.tasks.db.prepare("INSERT INTO task_lease_operations(id,kind,request_digest,response_json,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(input.operationId, kind, digest, serialized, now, issued + window);
      for (const project of scopes)
        this.tasks.db.prepare("INSERT INTO task_lease_operation_projects(operation_id,project_id) VALUES(?,?)").run(input.operationId, project);
      return receipt;
    });
  }
  private owned(lease: LeaseRef, now: number, scopes: Set<string>, expiredAllowed = false): {
    task?: StoredTask;
    outcome: LeaseReceipt["original"];
  } {
    const task = this.read(lease.taskId), row = task?.row;
    scopes.add(lease.project);
    if (!row || row.project_id !== lease.project || row.lease_incarnation !== lease.incarnation || row.run_count !== lease.runCount || row.lease_owner !== lease.owner)
      return { outcome: "stale" };
    if (!["running", "cancel_requested"].includes(row.state))
      return { outcome: "not_active" };
    if (!expiredAllowed && (row.lease_expires_at ?? 0) <= now)
      return { outcome: "expired" };
    return {
      task, outcome: "applied"
    };
  }
  async renew(raw: z.input<typeof RenewLeaseSchema>): Promise<LeaseReceipt> {
    const input = RenewLeaseSchema.parse(raw);
    return this.mutate("renew", input, (now, scopes) => {
      const owned = this.owned(input.lease, now, scopes), row = owned.task?.row;
      let outcome = owned.outcome;
      if (row?.cancel_requested)
        outcome = "cancel_requested";
      else if (row && row.deadline_at !== null && row.deadline_at <= now)
        outcome = "deadline_exceeded";
      if (outcome === "applied")
        this.tasks.db.prepare("UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=?").run(now + this.cfg.execution.lease_seconds * 1000, now, input.lease.taskId);
      return {
        lease: input.lease, disposition: outcome, original: outcome, leaseExpiresAt: outcome === "applied" ? now + this.cfg.execution.lease_seconds * 1000 : row?.lease_expires_at ?? null, affected: []
      };
    });
  }
  async finish(raw: z.input<typeof FinishLeaseSchema>): Promise<LeaseReceipt> {
    const input = FinishLeaseSchema.parse(raw);
    return this.mutate("finish", input, (now, scopes) => {
      const owned = this.owned(input.lease, now, scopes);
      if (owned.task && input.state === "completed" && !owned.task.row.cancel_requested && owned.task.row.deadline_at !== null && owned.task.row.deadline_at <= now) {
        return { lease: input.lease, disposition: "deadline_exceeded", original: "deadline_exceeded", affected: [] };
      }
      const state = owned.task ? this.tasks.finish(input.lease.taskId, input.lease.owner, input.result, input.state) : undefined;
      return {
        lease: input.lease, disposition: owned.outcome, original: owned.outcome, ...(state ? {
          state, resultDigest: createHash("sha256").update(canonicalJson(this.read(input.lease.taskId)!.result)).digest("hex")
        } : {}), affected: []
      };
    });
  }
  async interrupt(raw: z.input<typeof InterruptLeaseSchema>): Promise<LeaseReceipt> {
    const input = InterruptLeaseSchema.parse(raw);
    return this.mutate("interrupt", input, (now, scopes) => {
      const owned = this.owned(input.lease, now, scopes, true);
      if (owned.task) {
        this.tasks.interrupt(input.lease.taskId, input.lease.owner, input.reason, input.lease.runCount);
        if (input.resume && this.read(input.lease.taskId)?.row.state === "interrupted" && input.lease.runCount < 3)
          this.tasks.resume(input.lease.taskId, input.sessionId ? { sessionId: input.sessionId } : {});
      }
      return {
        lease: input.lease, disposition: owned.outcome, original: owned.outcome, ...(owned.task ? { state: this.read(input.lease.taskId)!.row.state } : {}), affected: []
      };
    });
  }
  async defer(raw: z.input<typeof DeferLeaseSchema>): Promise<LeaseReceipt> {
    const input = DeferLeaseSchema.parse(raw);
    return this.mutate("defer", input, (now, scopes) => {
      const owned = this.owned(input.lease, now, scopes);
      let state = owned.task?.row.state;
      if (owned.task && !owned.task.row.cancel_requested) {
        this.tasks.deferForCapacity(input.lease.taskId, input.lease.owner, input.nextAttemptAt, input.reason);
        state = "waiting_for_capacity";
      }
      else if (owned.task) {
        this.tasks.interrupt(input.lease.taskId, input.lease.owner, "cancelled while waiting for capacity", input.lease.runCount);
        state = "cancelled";
      }
      return {
        lease: input.lease, disposition: owned.outcome, original: owned.outcome, ...(state ? { state } : {}), affected: []
      };
    });
  }
  async recover(raw: z.input<typeof RecoverLeasesSchema>): Promise<LeaseReceipt> {
    const input = RecoverLeasesSchema.parse(raw);
    return this.mutate("recover", input, (now, scopes) => {
      const expired = z.array(z.object({ id: z.string(), lease_owner: z.string().nullable() })).parse(this.tasks.db.prepare("SELECT id,lease_owner FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at<=? ORDER BY rowid LIMIT 500").all(now));
      const previousOwners = new Map(expired.map(row => [row.id, row.lease_owner]));
      const ids = this.tasks.recoverExpiredLeases(500, now), affected: LeaseReceipt["affected"] = [];
      const observe = (task: StoredTask) => {
        scopes.add(task.row.project_id);
        affected.push({
          target: {
            taskId: task.row.id, incarnation: task.row.lease_incarnation, runCount: task.row.run_count
          }, owner: previousOwners.get(task.row.id) ?? task.row.lease_owner, state: task.row.state
        });
      };
      for (const id of ids)
        observe(this.read(id)!);
      if (input.mode === "startup")
        for (const task of this.tasks.list({
          states: ["interrupted"], limit: 500
        })) {
          if (this.cfg.profiles[task.spec.profile]?.mode && task.row.run_count < 3) {
            this.tasks.resume(task.row.id);
            observe(this.read(task.row.id)!);
          }
        }
      return {
        disposition: "applied", original: "applied", affected
      };
    });
  }
  async cancel(raw: z.input<typeof CancelLeasesSchema>): Promise<LeaseReceipt> {
    const input = CancelLeasesSchema.parse(raw);
    return this.mutate("cancel", input, (now, scopes) => {
      scopes.add(input.project);
      if (input.actor === "supervisor") {
        if (!input.actorLease)
          throw new Error("supervisor cancellation requires its captured lease");
        const actor = this.owned(input.actorLease, now, scopes).task;
        if (!actor || actor.row.project_id !== input.project || (actor.row.deadline_at !== null && actor.row.deadline_at <= now) || actor.row.cancel_requested || this.cfg.profiles[actor.spec.profile]?.mode !== "supervisor")
          throw new Error("supervisor cancellation authority lost");
        for (const target of input.targets) {
          let task = this.read(target.taskId), found = false;
          const seen = new Set<string>();
          while (task?.spec.parentTaskId && !seen.has(task.row.id)) {
            if (task.row.project_id !== input.project)
              throw new Error("supervisor cancellation crosses a project ancestry bridge");
            seen.add(task.row.id);
            if (task.spec.parentTaskId === actor.row.id) {
              found = true;
              break;
            }
            task = this.read(task.spec.parentTaskId);
          }
          if (!found)
            throw new Error("supervisor cancellation is outside its task ancestry");
        }
      }
      const affected: LeaseReceipt["affected"] = [];
      for (const target of input.targets) {
        const task = this.read(target.taskId);
        if (!task || task.row.lease_incarnation !== target.incarnation || task.row.run_count !== target.runCount) {
          affected.push({
            target, owner: null, state: "unknown"
          });
          continue;
        }
        if (task.row.project_id !== input.project)
          throw new Error("task cancellation is outside project scope");
        const outcome = this.tasks.requestCancel([target.taskId])[0]!;
        affected.push({
          target, owner: task.row.lease_owner, state: outcome.state
        });
      }
      return {
        disposition: "applied", original: "applied", affected
      };
    });
  }
}
