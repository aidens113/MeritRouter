import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { immediate, newId } from "./db.js";
import type { ProfileName } from "../config/schema.js";
import { TaskValidationError } from "../core/errors.js";
import type { TaskState, WorkerResult, WorkerTask } from "../core/task.js";
import { isTerminal } from "../core/task.js";
import { acquireLease, conflictingLease, releaseLeases, writeGlobs } from "./file-leases.js";
import { requiresAcceptedInputs } from "./plans.js";
import { repoKey } from "../projects/context.js";
import { FairClaimOrder, type ProjectClaimLimits } from "./fair-claim.js";

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
  /** `<project>/<alias>` (see `repoKey`); a bare alias only for rows written without a project. */
  writable_repo: string | null;
  result_json: string | null;
  /** The task's project slug ('' only for rows written outside a service, until the next start). */
  project_id: string;
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
  /**
   * Most running tasks per job (`team.max_agents`); counts every task the job delegated,
   * sub-supervisors included. A function receives the job's project (a project may override it).
   */
  maxAgentsPerJob?: number | ((projectId: string) => number);
  /** Per-provider concurrency: a worker task starts only when a platform in its route plan has a free slot. */
  providerSlots?: ClaimAdmission;
  /** A project's fair-share priority and worker-task cap (see `FairClaimOrder`); omitted: priority 1, no cap. */
  projectLimits?: (projectId: string) => ProjectClaimLimits;
}

/**
 * Admission of one queued worker task at claim (supervisors are never held back). `check`
 * returns null when the task may start, else what it waits for; `claimed` is called once it
 * was claimed. Both run inside the claim transaction.
 */
export interface ClaimAdmission {
  check(row: TaskRow, spec: WorkerTask): { wait: string; data: Record<string, unknown> } | null;
  claimed(row: TaskRow, spec: WorkerTask, owner: string): void;
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
 * not_verified and needs_supervisor pass (with a dependency_unverified warning event) unless
 * the dependent requires accepted inputs (see `requiresAcceptedInputs`): then it waits until
 * they are accepted (`met`).
 */
export function dependencySatisfied(t: StoredTask): boolean {
  return t.row.state === "completed" && t.result?.acceptanceStatus !== "unmet";
}

/** Prefix of a waiting task's state reason while it waits for its upstream results to be accepted. */
export const AWAITING_ACCEPTANCE = "awaiting_acceptance";
/** Prefix of a queued coding task's state reason while another task's file lease blocks it. */
export const WAITING_FOR_FILE_LEASE = "waiting_for_file_lease";
/** Prefix of a queued task's state reason while every platform in its route plan is out of slots. */
export const WAITING_FOR_PROVIDER_SLOT = "waiting_for_provider_slot";

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

  /** Newest first; `project` limits the list to one project (all projects when omitted). */
  list(opts: { states?: TaskState[]; limit?: number; project?: string } = {}): StoredTask[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.states?.length) (where.push(`state IN (${opts.states.map(() => "?").join(",")})`), args.push(...opts.states));
    if (opts.project) (where.push("project_id = ?"), args.push(opts.project));
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, opts.limit ?? 200) as TaskRow[];
    return rows.map((r) => this.hydrate(r));
  }

  /** A task's project slug, or null for an unknown task. */
  projectOf(id: string): string | null {
    const row = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(id) as { project_id: string } | undefined;
    return row ? row.project_id : null;
  }

  dependenciesOf(id: string): string[] {
    return (this.db.prepare("SELECT depends_on FROM task_deps WHERE task_id = ?").all(id) as { depends_on: string }[]).map(
      (r) => r.depends_on,
    );
  }

  /**
   * Persist tasks atomically before acknowledging. Idempotency keys return the existing task
   * when the spec matches and reject reuse with a different spec (or from another project).
   * `project` is the tasks' project ('' when written outside a service); a dependency on another
   * project's task is refused.
   */
  submit(specs: WorkerTask[], opts: { project?: string } = {}): SubmitOutcome[] {
    const project = opts.project ?? "";
    return immediate(this.db, () => {
      const now = this.now();
      const outcomes: SubmitOutcome[] = [];
      const fresh: Array<{ id: string; spec: WorkerTask; hash: string }> = [];
      const batchIds = new Set<string>();

      for (const spec of specs) {
        const hash = specHash(spec);
        if (spec.idempotencyKey) {
          const existing = this.db
            .prepare("SELECT id, state, spec_hash, project_id FROM tasks WHERE idempotency_key = ?")
            .get(spec.idempotencyKey) as { id: string; state: TaskState; spec_hash: string; project_id: string } | undefined;
          if (existing) {
            if (project && existing.project_id && existing.project_id !== project) {
              throw new TaskValidationError(`idempotency key ${spec.idempotencyKey} was already used in project ${existing.project_id} (${existing.id})`);
            }
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
          if (batchIds.has(d)) continue;
          const dep = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(d) as { project_id: string } | undefined;
          if (!dep) throw new TaskValidationError(`task ${f.id} depends on unknown task ${d}`);
          if (project && dep.project_id && dep.project_id !== project) throw new TaskValidationError(`task ${f.id} depends on ${d}, which belongs to project ${dep.project_id}`);
        }
        edges.set(f.id, deps);
      }
      assertAcyclic(edges, (id) => (edges.has(id) ? edges.get(id)! : this.dependenciesOf(id)));

      const insert = this.db.prepare(
        `INSERT INTO tasks (id, idempotency_key, spec_hash, profile, spec_json, state, created_at, updated_at, writable_repo, project_id)
         VALUES (@id, @key, @hash, @profile, @spec, @state, @now, @now, @writable, @project)`,
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
          writable: f.spec.writableRepository ? repoKey(project, f.spec.writableRepository) : null,
          project,
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
   * Candidates are offered round-robin across projects, weighted by priority and oldest first
   * within a project (`FairClaimOrder`); a project's `max_concurrent_tasks` and every global
   * cap, provider-slot, and lease check apply to each one.
   */
  claim(owner: string, limits: ClaimLimits): StoredTask[] {
    return immediate(this.db, () => {
      const now = this.now();
      this.resolveDependencyGates(now);

      const sup = new Set(limits.supervisorProfiles ?? []);
      // Sub-supervisors (supervise tasks a job delegated) take neither a top-level job slot nor a
      // worker slot: their parent waits on them, so either would deadlock a full system. They
      // count toward their parent job's agent cap instead (below).
      const runningRows = this.db
        .prepare("SELECT profile, project_id, json_extract(spec_json, '$.parentTaskId') AS parent FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at > ?")
        .all(now) as { profile: string; project_id: string; parent: string | null }[];
      const runningSup = runningRows.filter((r) => sup.has(r.profile) && !r.parent).length;
      const runningSubSup = runningRows.filter((r) => sup.has(r.profile) && r.parent).length;
      let slots = Math.min(limits.maxConcurrent - (runningRows.length - runningSup - runningSubSup), limits.limit ?? Number.MAX_SAFE_INTEGER);
      let supSlots = (limits.maxSupervisors ?? 0) - runningSup;
      // Running worker tasks per project (a project's max_concurrent_tasks counts what `slots` counts).
      const limitCache = new Map<string, ProjectClaimLimits>();
      const limitsOf = (projectId: string): ProjectClaimLimits => {
        let l = limitCache.get(projectId);
        if (!l) limitCache.set(projectId, (l = limits.projectLimits?.(projectId) ?? { priority: 1 }));
        return l;
      };
      const perProject = new Map<string, number>();
      for (const r of runningRows) if (!sup.has(r.profile)) perProject.set(r.project_id, (perProject.get(r.project_id) ?? 0) + 1);

      const candidates = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE cancel_requested = 0
             AND (state = 'queued' OR (state = 'waiting_for_capacity' AND COALESCE(next_attempt_at, 0) <= ?))
           ORDER BY created_at ASC`,
        )
        .all(now) as TaskRow[];

      // Running delegated tasks per job (team.max_agents).
      const perJob = new Map<string, number>();
      if (limits.maxAgentsPerJob !== undefined) {
        for (const r of this.db
          .prepare(
            "SELECT json_extract(spec_json, '$.parentTaskId') AS job, profile FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at > ? AND json_extract(spec_json, '$.parentTaskId') IS NOT NULL",
          )
          .all(now) as { job: string; profile: string }[]) {
          perJob.set(r.job, (perJob.get(r.job) ?? 0) + 1);
        }
      }

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
      const order = new FairClaimOrder(this.db, candidates, limitsOf);
      for (let row = order.next(); row; row = order.next()) {
        const spec = JSON.parse(row.spec_json) as WorkerTask;
        const isSubSup = sup.has(row.profile) && !!spec.parentTaskId;
        const isSup = sup.has(row.profile) && !isSubSup;
        const isWorker = !isSup && !isSubSup;
        if (isSup ? supSlots <= 0 : !isSubSup && slots <= 0) continue;
        const projectCap = isWorker ? limitsOf(row.project_id).maxConcurrent : undefined;
        if (projectCap !== undefined && (perProject.get(row.project_id) ?? 0) >= projectCap) continue;
        const job = !isSup ? (spec.parentTaskId ?? null) : null;
        const agentCap = typeof limits.maxAgentsPerJob === "function" ? limits.maxAgentsPerJob(row.project_id) : limits.maxAgentsPerJob;
        if (job && agentCap !== undefined && (perJob.get(job) ?? 0) >= agentCap) continue;
        // Provider slots: a worker starts only when a platform it can route to has room. A
        // supervisor never waits here (its workers may hold every slot; its requests are served
        // first at the gate instead).
        if (limits.providerSlots && !isSup && !isSubSup) {
          const blocked = limits.providerSlots.check(row, spec);
          if (blocked) {
            const reason = `${WAITING_FOR_PROVIDER_SLOT}:${blocked.wait}`;
            if (row.state_reason !== reason) {
              this.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, row.id);
              this.event(row.id, WAITING_FOR_PROVIDER_SLOT, blocked.data);
            }
            continue;
          }
        }
        if (row.writable_repo && !isSup) {
          // Team-wide file leases: never two live writers on overlapping paths in one repository
          // (checked before the writer count so a blocked task says what it waits for).
          const globs = writeGlobs(spec.constraints.allowedPaths);
          const holder = conflictingLease(this.db, row.writable_repo, globs, now, row.id);
          if (holder) {
            const reason = `${WAITING_FOR_FILE_LEASE}:${holder.taskId}`;
            if (row.state_reason !== reason) {
              this.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, row.id);
              this.event(row.id, "waiting_for_file_lease", { holder: holder.taskId, repository: row.writable_repo, globs, held: holder.globs });
            }
            continue;
          }
          const n = writers.get(row.writable_repo) ?? 0;
          if (n >= limits.maxWritersPerRepo) continue;
          writers.set(row.writable_repo, n + 1);
          acquireLease(this.db, { jobId: spec.parentTaskId ?? null, taskId: row.id, repository: row.writable_repo, globs }, now);
          this.event(row.id, "file_lease_acquired", { repository: row.writable_repo, globs });
        }
        if (job) perJob.set(job, (perJob.get(job) ?? 0) + 1);
        const fallback = isSup || isSubSup ? (limits.supervisorTimeoutMs ?? limits.defaultTimeoutMs) : limits.defaultTimeoutMs;
        const timeoutMs = spec.budget?.timeoutSeconds ? spec.budget.timeoutSeconds * 1000 : fallback;
        update.run(owner, now + limits.leaseMs, now, now + timeoutMs, now, row.id);
        if (limits.providerSlots && !isSup && !isSubSup) limits.providerSlots.claimed(row, spec, owner);
        this.event(row.id, "claimed", { owner, run: row.run_count + 1 });
        claimed.push(this.get(row.id)!);
        order.claimed(row);
        if (isWorker) perProject.set(row.project_id, (perProject.get(row.project_id) ?? 0) + 1);
        if (isSup) supSlots--;
        else if (!isSubSup) slots--;
      }
      order.save();
      return claimed;
    });
  }

  /**
   * Claim queued tasks that can join `leader`'s prompt batch. Batch members share one
   * execution slot, so the concurrency limit is not re-applied. A batch never mixes projects.
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
          `SELECT * FROM tasks WHERE cancel_requested = 0 AND profile = ? AND id != ? AND project_id = ?
             AND (state = 'queued' OR (state = 'waiting_for_capacity' AND COALESCE(next_attempt_at, 0) <= ?))
           ORDER BY created_at ASC`,
        )
        .all(leader.row.profile, leader.row.id, leader.row.project_id, now) as TaskRow[];
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
      releaseLeases(this.db, id, "interrupted", now);
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
        // A dependent that requires accepted inputs waits until every upstream result is met
        // (verified, or accepted by the supervisor or a human); others start with a warning.
        const spec = JSON.parse(row.spec_json) as WorkerTask;
        const strict = requiresAcceptedInputs(this.db, spec);
        const unaccepted = strict ? deps.filter((d) => d.result?.acceptanceStatus !== "met") : [];
        if (unaccepted.length) {
          const reason = `${AWAITING_ACCEPTANCE}:${unaccepted.map((d) => d.row.id).join(",")}`;
          if (row.state_reason !== reason) {
            this.db.prepare("UPDATE tasks SET state_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, row.id);
            this.event(row.id, "dependency_awaiting_acceptance", { dependencies: unaccepted.map((d) => ({ dependency: d.row.id, acceptanceStatus: d.result?.acceptanceStatus ?? null })) });
          }
          continue;
        }
        this.db
          .prepare("UPDATE tasks SET state = 'queued', state_reason = NULL, updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.event(row.id, "dependencies_satisfied", strict ? { acceptedInputs: true } : undefined);
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
    releaseLeases(this.db, row.id, state, now);
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
      releaseLeases(this.db, id, "finished", now);
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
    if (r.changes) {
      releaseLeases(this.db, id, "deferred", now);
      this.event(id, "waiting_for_capacity", { reason, nextAttemptAt });
    }
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
        // File leases expire with the task lease; a resumed run acquires them again at claim.
        releaseLeases(this.db, row.id, "expired", now);
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
