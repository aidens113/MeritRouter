import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { immediate, newId } from "./db.js";
import type { ProfileName } from "../config/schema.js";
import { TaskValidationError } from "../core/errors.js";
import type { TaskState, WorkerResult, WorkerTask } from "../core/task.js";
import { isTerminal } from "../core/task.js";

export interface TaskRow {
  id: string;
  idempotency_key: string | null;
  spec_hash: string;
  profile: ProfileName;
  spec_json: string;
  state: TaskState;
  state_reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  deadline_at: number | null;
  finished_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  run_count: number;
  cancel_requested: number;
  next_attempt_at: number | null;
  writable_repo: string | null;
  result_json: string | null;
}

export interface StoredTask {
  row: TaskRow;
  spec: WorkerTask;
  result: WorkerResult | null;
}

export interface SubmitOutcome {
  taskId: string;
  state: TaskState;
  deduplicated: boolean;
}

export interface ClaimLimits {
  maxConcurrent: number;
  maxWritersPerRepo: number;
  leaseMs: number;
  /** Deadline applied when a task sets no budget.timeoutSeconds. */
  defaultTimeoutMs: number;
  limit?: number;
  /** Supervisor task types run under their own concurrency limit and deadline. */
  supervisorProfiles?: string[];
  maxSupervisors?: number;
  supervisorTimeoutMs?: number;
}

/** Canonical JSON (sorted keys) so equivalent specs hash identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

export function specHash(spec: WorkerTask): string {
  const { id: _id, ...rest } = spec;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/**
 * Successful under the dependency acceptance policy: completed and not explicitly unmet.
 * not_verified and needs_supervisor pass (with a dependency_unverified warning event).
 */
export function dependencySatisfied(t: StoredTask): boolean {
  return t.row.state === "completed" && t.result?.acceptanceStatus !== "unmet";
}

export class TaskStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private hydrate(row: TaskRow): StoredTask {
    return {
      row,
      spec: JSON.parse(row.spec_json) as WorkerTask,
      result: row.result_json ? (JSON.parse(row.result_json) as WorkerResult) : null,
    };
  }

  get(id: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row && this.hydrate(row);
  }

  getMany(ids: string[]): StoredTask[] {
    return ids.map((id) => this.get(id)).filter((t): t is StoredTask => t !== undefined);
  }

  list(opts: { states?: TaskState[]; limit?: number } = {}): StoredTask[] {
    const where = opts.states?.length ? `WHERE state IN (${opts.states.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(opts.states ?? []), opts.limit ?? 200) as TaskRow[];
    return rows.map((r) => this.hydrate(r));
  }

  dependenciesOf(id: string): string[] {
    return (this.db.prepare("SELECT depends_on FROM task_deps WHERE task_id = ?").all(id) as { depends_on: string }[]).map(
      (r) => r.depends_on,
    );
  }

  /**
   * Persist tasks atomically before acknowledging. Idempotency keys return the existing task
   * when the spec matches and reject reuse with a different spec.
   */
  submit(specs: WorkerTask[]): SubmitOutcome[] {
    return immediate(this.db, () => {
      const now = this.now();
      const outcomes: SubmitOutcome[] = [];
      const fresh: Array<{ id: string; spec: WorkerTask; hash: string }> = [];
      const batchIds = new Set<string>();

      for (const spec of specs) {
        const hash = specHash(spec);
        if (spec.idempotencyKey) {
          const existing = this.db
            .prepare("SELECT id, state, spec_hash FROM tasks WHERE idempotency_key = ?")
            .get(spec.idempotencyKey) as { id: string; state: TaskState; spec_hash: string } | undefined;
          if (existing) {
            if (existing.spec_hash !== hash) {
              throw new TaskValidationError(
                `idempotency key ${spec.idempotencyKey} was already used for a different task (${existing.id})`,
              );
            }
            outcomes.push({ taskId: existing.id, state: existing.state, deduplicated: true });
            continue;
          }
        }
        const id = spec.id ?? newId("t");
        if (batchIds.has(id) || this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) {
          throw new TaskValidationError(`task id ${id} already exists`);
        }
        batchIds.add(id);
        fresh.push({ id, spec: { ...spec, id }, hash });
        outcomes.push({ taskId: id, state: "queued", deduplicated: false });
      }

      // Dependencies must exist (already stored or in this submission) and be acyclic.
      const edges = new Map<string, string[]>();
      for (const f of fresh) {
        const deps = f.spec.dependsOn ?? [];
        for (const d of deps) {
          if (d === f.id) throw new TaskValidationError(`task ${f.id} depends on itself`);
          if (!batchIds.has(d) && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(d)) {
            throw new TaskValidationError(`task ${f.id} depends on unknown task ${d}`);
          }
        }
        edges.set(f.id, deps);
      }
      assertAcyclic(edges, (id) => (edges.has(id) ? edges.get(id)! : this.dependenciesOf(id)));

      const insert = this.db.prepare(
        `INSERT INTO tasks (id, idempotency_key, spec_hash, profile, spec_json, state, created_at, updated_at, writable_repo)
         VALUES (@id, @key, @hash, @profile, @spec, @state, @now, @now, @writable)`,
      );
      const insertDep = this.db.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)");
      for (const f of fresh) {
        const state: TaskState = f.spec.dependsOn?.length ? "waiting_for_dependencies" : "queued";
        insert.run({
          id: f.id,
          key: f.spec.idempotencyKey ?? null,
          hash: f.hash,
          profile: f.spec.profile,
          spec: JSON.stringify(f.spec),
          state,
          now,
          writable: f.spec.writableRepository ?? null,
        });
        for (const d of f.spec.dependsOn ?? []) insertDep.run(f.id, d);
        this.event(f.id, "submitted", { state });
        const o = outcomes.find((x) => x.taskId === f.id)!;
        o.state = state;
      }
      return outcomes;
    });
  }

  event(taskId: string | null, type: string, data?: unknown): void {
    this.db
      .prepare("INSERT INTO events (task_id, ts, type, data_json) VALUES (?, ?, ?, ?)")
      .run(taskId, this.now(), type, data === undefined ? null : JSON.stringify(data));
  }

  events(taskId: string, limit = 50): Array<{ ts: number; type: string; data: unknown }> {
    const rows = this.db
      .prepare("SELECT ts, type, data_json FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, limit) as { ts: number; type: string; data_json: string | null }[];
    return rows.reverse().map((r) => ({ ts: r.ts, type: r.type, data: r.data_json ? JSON.parse(r.data_json) : null }));
  }

  /**
   * Resolve dependency gates, then claim up to `limit` runnable tasks under one lease owner.
   * Runs in a single IMMEDIATE transaction so two processes cannot claim the same task.
   */
  claim(owner: string, limits: ClaimLimits): StoredTask[] {
    return immediate(this.db, () => {
      const now = this.now();
      this.resolveDependencyGates(now);

      const sup = new Set(limits.supervisorProfiles ?? []);
      const runningRows = this.db
        .prepare("SELECT profile FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at > ?")
        .all(now) as { profile: string }[];
      const runningSup = runningRows.filter((r) => sup.has(r.profile)).length;
      let slots = Math.min(limits.maxConcurrent - (runningRows.length - runningSup), limits.limit ?? Number.MAX_SAFE_INTEGER);
      let supSlots = (limits.maxSupervisors ?? 0) - runningSup;
      if (slots <= 0 && supSlots <= 0) return [];

      const candidates = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE cancel_requested = 0
             AND (state = 'queued' OR (state = 'waiting_for_capacity' AND COALESCE(next_attempt_at, 0) <= ?))
           ORDER BY created_at ASC`,
        )
        .all(now) as TaskRow[];

      const writers = new Map<string, number>();
      for (const r of this.db
        .prepare(
          "SELECT writable_repo, COUNT(*) AS n FROM tasks WHERE writable_repo IS NOT NULL AND state IN ('running','cancel_requested') AND lease_expires_at > ? GROUP BY writable_repo",
        )
        .all(now) as { writable_repo: string; n: number }[]) {
        writers.set(r.writable_repo, r.n);
      }

      const claimed: StoredTask[] = [];
      const update = this.db.prepare(
        `UPDATE tasks SET state = 'running', state_reason = NULL, lease_owner = ?, lease_expires_at = ?,
           started_at = COALESCE(started_at, ?), deadline_at = COALESCE(deadline_at, ?), run_count = run_count + 1,
           next_attempt_at = NULL, updated_at = ?
         WHERE id = ?`,
      );
      for (const row of candidates) {
        const isSup = sup.has(row.profile);
        if (isSup ? supSlots <= 0 : slots <= 0) continue;
        if (row.writable_repo && !isSup) {
          const n = writers.get(row.writable_repo) ?? 0;
          if (n >= limits.maxWritersPerRepo) continue;
          writers.set(row.writable_repo, n + 1);
        }
        const spec = JSON.parse(row.spec_json) as WorkerTask;
        const fallback = isSup ? (limits.supervisorTimeoutMs ?? limits.defaultTimeoutMs) : limits.defaultTimeoutMs;
        const timeoutMs = spec.budget?.timeoutSeconds ? spec.budget.timeoutSeconds * 1000 : fallback;
        update.run(owner, now + limits.leaseMs, now, now + timeoutMs, now, row.id);
        this.event(row.id, "claimed", { owner, run: row.run_count + 1 });
        claimed.push(this.get(row.id)!);
        if (isSup) supSlots--;
        else slots--;
      }
      return claimed;
    });
  }

  /**
   * Claim queued tasks that can join `leader`'s prompt batch. Batch members share one
   * execution slot, so the concurrency limit is not re-applied.
   */
  claimCompanions(
    owner: string,
    leader: StoredTask,
    accept: (t: StoredTask) => boolean,
    max: number,
    leaseMs: number,
    defaultTimeoutMs: number,
  ): StoredTask[] {
    if (max <= 0) return [];
    return immediate(this.db, () => {
      const now = this.now();
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE cancel_requested = 0 AND profile = ? AND id != ?
             AND (state = 'queued' OR (state = 'waiting_for_capacity' AND COALESCE(next_attempt_at, 0) <= ?))
           ORDER BY created_at ASC`,
        )
        .all(leader.row.profile, leader.row.id, now) as TaskRow[];
      const out: StoredTask[] = [];
      for (const row of rows) {
        if (out.length >= max) break;
        const t = this.hydrate(row);
        if (!accept(t)) continue;
        const timeoutMs = t.spec.budget?.timeoutSeconds ? t.spec.budget.timeoutSeconds * 1000 : defaultTimeoutMs;
        this.db
          .prepare(
            `UPDATE tasks SET state = 'running', state_reason = 'batched', lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?),
               deadline_at = COALESCE(deadline_at, ?), run_count = run_count + 1, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(owner, now + leaseMs, now, now + timeoutMs, now, row.id);
        this.event(row.id, "claimed", { owner, batchedWith: leader.row.id });
        out.push(this.get(row.id)!);
      }
      return out;
    });
  }

  /** Graceful shutdown: mark a task this owner holds as interrupted. */
  interrupt(id: string, owner: string, reason: string): boolean {
    return immediate(this.db, () => {
      const now = this.now();
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (!row || row.lease_owner !== owner || !["running", "cancel_requested"].includes(row.state)) return false;
      if (row.cancel_requested) {
        this.finalizeWithoutRun(row, "cancelled", "cancelled during shutdown", now);
        return true;
      }
      this.db
        .prepare(
          "UPDATE tasks SET state = 'interrupted', state_reason = ?, result_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(reason, JSON.stringify(syntheticResult(id, "interrupted", reason)), now, id);
      this.event(id, "interrupted", { reason });
      return true;
    });
  }

  /** Release dependents whose prerequisites succeeded; fail those whose prerequisites failed. */
  private resolveDependencyGates(now: number): void {
    const waiting = this.db.prepare("SELECT * FROM tasks WHERE state = 'waiting_for_dependencies'").all() as TaskRow[];
    for (const row of waiting) {
      if (row.cancel_requested) continue;
      const deps = this.getMany(this.dependenciesOf(row.id));
      const failed = deps.find(
        (d) => (isTerminal(d.row.state) && !dependencySatisfied(d)),
      );
      if (failed) {
        const reason = `dependency_failed:${failed.row.id}:${failed.row.state}${
          failed.result?.acceptanceStatus === "unmet" ? ":acceptance_unmet" : ""
        }`;
        this.finalizeWithoutRun(row, "failed", reason, now);
        continue;
      }
      if (deps.every(dependencySatisfied)) {
        this.db
          .prepare("UPDATE tasks SET state = 'queued', state_reason = NULL, updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.event(row.id, "dependencies_satisfied");
        // V1 lets results nobody verified through, with a warning; the task graph tightens this.
        for (const d of deps) {
          const status = d.result?.acceptanceStatus;
          if (status === "not_verified" || status === "needs_supervisor") this.event(row.id, "dependency_unverified", { dependency: d.row.id, acceptanceStatus: status });
        }
      }
      // Interrupted or still-running prerequisites keep the dependent blocked.
    }
  }

  private finalizeWithoutRun(row: TaskRow, state: TaskState, reason: string, now: number): void {
    const result = syntheticResult(row.id, state === "cancelled" ? "cancelled" : "failed", reason);
    this.db
      .prepare(
        "UPDATE tasks SET state = ?, state_reason = ?, result_json = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
      )
      .run(state, reason, JSON.stringify(result), now, now, row.id);
    this.event(row.id, state, { reason });
  }

  /** Extend a lease. Returns false when the lease was lost; the caller must stop dispatching. */
  heartbeat(id: string, owner: string, leaseMs: number): boolean {
    const now = this.now();
    const r = this.db
      .prepare(
        "UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND state IN ('running','cancel_requested') AND lease_expires_at > ?",
      )
      .run(now + leaseMs, now, id, owner, now);
    return r.changes === 1;
  }

  /** Does some process hold a live lease on this task (running and not expired)? */
  leaseLive(id: string): boolean {
    const row = this.db.prepare("SELECT state, lease_expires_at FROM tasks WHERE id = ?").get(id) as Pick<TaskRow, "state" | "lease_expires_at"> | undefined;
    return !!row && ["running", "cancel_requested"].includes(row.state) && (row.lease_expires_at ?? 0) > this.now();
  }

  /** Lease holder still active and not asked to cancel? Checked before every dispatch. */
  activeStatus(id: string, owner: string): "active" | "cancel_requested" | "lease_lost" | "not_active" {
    const row = this.db
      .prepare("SELECT state, lease_owner, lease_expires_at, cancel_requested FROM tasks WHERE id = ?")
      .get(id) as Pick<TaskRow, "state" | "lease_owner" | "lease_expires_at" | "cancel_requested"> | undefined;
    if (!row) return "not_active";
    if (row.cancel_requested || row.state === "cancel_requested") return "cancel_requested";
    if (row.state !== "running") return "not_active";
    if (row.lease_owner !== owner || (row.lease_expires_at ?? 0) <= this.now()) return "lease_lost";
    return "active";
  }

  /**
   * Record a terminal outcome. A pending cancellation always wins: a late successful response
   * cannot turn a cancelled task into a completed one.
   */
  finish(id: string, owner: string, result: WorkerResult, state: TaskState): TaskState {
    return immediate(this.db, () => {
      const now = this.now();
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (!row) throw new Error(`unknown task ${id}`);
      if (row.lease_owner !== owner || !["running", "cancel_requested"].includes(row.state)) {
        this.event(id, "finish_rejected", { owner, state: row.state, attempted: state });
        return row.state;
      }
      let finalState = state;
      let finalResult = result;
      if (row.cancel_requested) {
        finalState = "cancelled";
        finalResult = {
          ...result,
          executionStatus: "cancelled",
          acceptanceStatus: result.acceptanceStatus === "met" ? "not_verified" : result.acceptanceStatus,
          stopReason: `cancelled (late outcome was: ${result.executionStatus}/${result.stopReason})`,
        };
      }
      this.db
        .prepare(
          "UPDATE tasks SET state = ?, state_reason = ?, result_json = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
        )
        .run(finalState, finalResult.stopReason, JSON.stringify(finalResult), now, now, id);
      this.event(id, finalState, { stopReason: finalResult.stopReason });
      return finalState;
    });
  }

  /**
   * Replace a finished task's result in one transaction (acceptance decisions). `apply` sees the
   * current row and returns the new result, the event to record, and a value to return; it may
   * throw to refuse, and then nothing changes.
   */
  updateResult<T>(id: string, apply: (t: StoredTask) => { result: WorkerResult; event: { type: string; data?: unknown }; value: T }): T {
    return immediate(this.db, () => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (!row) throw new TaskValidationError(`unknown task ${id}`);
      const out = apply(this.hydrate(row));
      this.db.prepare("UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(out.result), this.now(), id);
      this.event(id, out.event.type, out.event.data);
      return out.value;
    });
  }

  /** Release a task back to the queue to wait for capacity. Keeps budgets and deadline. */
  deferForCapacity(id: string, owner: string, nextAttemptAt: number, reason: string): boolean {
    const now = this.now();
    const r = this.db
      .prepare(
        "UPDATE tasks SET state = 'waiting_for_capacity', state_reason = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running' AND cancel_requested = 0",
      )
      .run(reason, nextAttemptAt, now, id, owner);
    if (r.changes) this.event(id, "waiting_for_capacity", { reason, nextAttemptAt });
    return r.changes === 1;
  }

  /** Persist cancellation intent. Unstarted tasks cancel immediately; running ones on next check. */
  requestCancel(ids: string[]): Array<{ taskId: string; state: TaskState | "unknown" }> {
    return immediate(this.db, () => {
      const now = this.now();
      return ids.map((id) => {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
        if (!row) return { taskId: id, state: "unknown" as const };
        if (isTerminal(row.state)) return { taskId: id, state: row.state };
        if (row.state === "running" || row.state === "cancel_requested") {
          this.db
            .prepare("UPDATE tasks SET cancel_requested = 1, state = 'cancel_requested', updated_at = ? WHERE id = ?")
            .run(now, id);
          this.event(id, "cancel_requested");
          return { taskId: id, state: "cancel_requested" as const };
        }
        this.db.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ?").run(id);
        this.finalizeWithoutRun(row, "cancelled", "cancelled before dispatch", now);
        return { taskId: id, state: "cancelled" as const };
      });
    });
  }

  /**
   * Expired leases mean the worker process died. Mark those tasks interrupted (cancelled if a
   * cancellation was pending). Interrupted tasks are not replayed automatically here.
   */
  recoverExpiredLeases(): string[] {
    return immediate(this.db, () => {
      const now = this.now();
      const rows = this.db
        .prepare("SELECT * FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at <= ?")
        .all(now) as TaskRow[];
      for (const row of rows) {
        if (row.cancel_requested) {
          this.finalizeWithoutRun(row, "cancelled", "cancelled; worker lease expired before confirmation", now);
          continue;
        }
        const result = syntheticResult(row.id, "interrupted", "worker lease expired");
        this.db
          .prepare(
            "UPDATE tasks SET state = 'interrupted', state_reason = ?, result_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run("worker lease expired", JSON.stringify(result), now, row.id);
        this.event(row.id, "interrupted", { previousOwner: row.lease_owner });
      }
      return rows.map((r) => r.id);
    });
  }

  /**
   * Resume an interrupted task. Budgets already consumed stay consumed. `directive` is recorded
   * on the `resumed` event for the next run: `sessionId` resumes that session, `freshWorkspace`
   * starts a coding task over in a new worktree (see `ResumeDirectiveSchema` in the executor).
   */
  resume(id: string, directive: { sessionId?: string; freshWorkspace?: boolean } = {}): TaskState {
    return immediate(this.db, () => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      if (!row) throw new TaskValidationError(`unknown task ${id}`);
      if (row.state !== "interrupted") throw new TaskValidationError(`task ${id} is ${row.state}, not interrupted`);
      this.db
        .prepare("UPDATE tasks SET state = 'queued', state_reason = 'resumed', result_json = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), id);
      this.event(id, "resumed", Object.keys(directive).length ? directive : undefined);
      return "queued";
    });
  }

  /** Tasks a job (supervisor task) delegated, oldest first. */
  childrenOf(parentTaskId: string): StoredTask[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE json_extract(spec_json, '$.parentTaskId') = ? ORDER BY created_at ASC, rowid ASC")
      .all(parentTaskId) as TaskRow[];
    return rows.map((r) => this.hydrate(r));
  }
}

function assertAcyclic(roots: Map<string, string[]>, depsOf: (id: string) => string[]): void {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) throw new TaskValidationError(`dependency cycle: ${[...trail, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of depsOf(id)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of roots.keys()) visit(id, []);
}

export function syntheticResult(
  taskId: string,
  executionStatus: WorkerResult["executionStatus"],
  stopReason: string,
): WorkerResult {
  return {
    taskId,
    executionStatus,
    acceptanceStatus: "not_verified",
    stopReason,
    summary: "",
    findings: [],
    artifactRefs: [],
    patchRefs: [],
    baseCommits: {},
    checks: [],
    unresolvedCriteria: [],
    usage: {
      modelRequests: 0,
      providerAttempts: 0,
      providerAttemptsExact: true,
      tokenUsageBasis: "unknown",
      batchId: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reportedCostUsd: null,
      estimatedCostUsd: null,
    },
    servedEndpoints: [],
    classification: null,
    routing: null,
  };
}
