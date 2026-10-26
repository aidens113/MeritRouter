import { z } from "zod";
import type { LabManager } from "./lab.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { TaskAttemptPruner, TASK_PRUNE_OPERATION } from "./task-attempt-prune.js";
import { immediate, newId } from "../storage/db.js";
import { MeritRouterError } from "../core/errors.js";
import { LabNameSchema, validateRecipe } from "./recipe.js";
import { TaskAttemptProcesses, type TaskProcessRecord } from "./task-attempt-processes.js";
import { TaskAttemptRunner } from "./task-attempt-runner.js";
import { TaskAttemptSource, taskHash } from "./task-attempt-source.js";
import { SubmitTaskAttemptSchema, TaskLabEvidenceSchema, type RegisterTaskAttempt, type TaskAttemptHandle, type TaskLabEvidence } from "./task-attempt-schema.js";
const Operation = z.object({ id: z.string(), attempt_id: z.string(), kind: z.enum(["check", "cleanup"]), state: z.enum(["pending", "running", "completed", "failed"]), owner_id: z.string().nullable(), lease_until: z.number(), result_json: z.string().nullable(), error: z.string().nullable() });
export interface TaskLabOperation {
  id: string;
  attemptId: string;
  state: "pending" | "running" | "completed" | "failed";
}
/** Internal queue, drained only by the explicit Labs supervisor. */
export class TaskLabLifecycle {
  readonly source: TaskAttemptSource;
  readonly processes: TaskAttemptProcesses;
  readonly runner: TaskAttemptRunner;
  private readonly active = new Map<string, AbortController>();
  private readonly work = new Set<Promise<unknown>>();
  private closed = false;
  private drain: Promise<void> | null = null;
  constructor(readonly manager: LabManager, barrier?: (phase: string, row: TaskProcessRecord) => Promise<void>) {
    this.source = new TaskAttemptSource(manager);
    this.processes = new TaskAttemptProcesses(manager.options.db, manager.options.storageDir, barrier, (id) => this.assertRunning(id), (project, name, root) => manager.labStorageDirectory(project, name, root));
    this.runner = new TaskAttemptRunner(manager, this.source, this.processes);
  }
  private assertRunning(id: string): void {
    if (this.closed || this.active.get(id)?.signal.aborted)
      throw new MeritRouterError("lab_scope_denied", "task lifecycle is stopping");
    this.source.identity(this.store.get(id));
    if (this.store.lab(id)?.desiredState !== "running" || !this.store.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND owner_id=? AND state='running' AND lease_until>?").get(id, this.manager.owner, Date.now()))
      throw new MeritRouterError("lab_scope_denied", "task operation owner generation was lost");
  }
  get store() {
    return this.source.store;
  }
  register(input: RegisterTaskAttempt) {
    return this.source.register(input);
  }
  submit(handle: TaskAttemptHandle, input: z.input<typeof SubmitTaskAttemptSchema>) {
    return this.source.submit(handle, input);
  }
  get(handle: TaskAttemptHandle) {
    return this.source.get(handle);
  }
  requestCheck(handle: TaskAttemptHandle, input: {
    checks: string[];
  }): TaskLabOperation {
    const record = this.get(handle), task = this.source.identity(record);
    if (record.state !== "submitted")
      throw new MeritRouterError("lab_invalid_state", "submit attempt before runtime checks");
    const checks = z.object({ checks: z.array(LabNameSchema).min(1).max(10) }).strict().parse(input).checks, project = ProjectConfigSchema.parse(this.manager.options.cfg.projects[record.project]), policy = project.labs.ephemeral;
    if (!policy.enabled || new Set(checks).size !== checks.length || checks.some(name => !policy.checks.includes(name)))
      throw new MeritRouterError("lab_scope_denied", "runtime check is outside human project allowlist");
    if (!project.lab)
      throw new MeritRouterError("lab_not_configured", "project has no Lab recipe");
    const recipe = validateRecipe(project.lab, record.repositories.map(r => r.alias));
    const needsDefault = recipe.setup.some(step => typeof step === "string") || checks.some(name => {
      const check = recipe.checks[name];
      return typeof check === "string" || (check && !("kind" in check) && !check.repo);
    });
    const defaultAlias = Object.keys(this.manager.options.project(record.project).repositoryPaths)[0];
    if (needsDefault && record.repositories[0]?.alias !== defaultAlias)
      throw new MeritRouterError("lab_scope_denied", "task scope must include the recipe's configured default repository");
    for (const name of checks) {
      const check = recipe.checks[name];
      if (!check)
        throw new MeritRouterError("not_found", "unknown runtime check");
      if (typeof check !== "string" && "kind" in check)
        throw new MeritRouterError("lab_invalid_state", "task browser checks require durable browser recovery; not enabled");
    }
    const id = newId("tlo"), now = Date.now();
    immediate(this.store.db, () => {
      this.source.identity(record);
      if (this.store.lab(record.id))
        throw new MeritRouterError("lab_invalid_state", "attempt runtime check already requested");
      this.store.db.prepare("INSERT INTO lab_task_attempts(attempt_id,desired_state,phase,checks_json,recipe_json,recipe_digest,deadline_at,created_at,updated_at) VALUES(?,'running','queued',?,?,?,?,?,?)").run(record.id, JSON.stringify(checks), JSON.stringify(recipe), taskHash(JSON.stringify(recipe)), task.deadline_at, now, now);
      this.enqueue(id, record.id, "check");
    });
    return { id, attemptId: record.id, state: "pending" };
  }
  cleanup(handle: TaskAttemptHandle, reason = "task completed"): TaskLabOperation {
    const record = this.get(handle), lab = this.store.lab(record.id);
    if (!lab)
      throw new MeritRouterError("not_found", "attempt has no task Lab");
    z.string().max(2000).parse(reason);
    const id = newId("tlo");
    immediate(this.store.db, () => {
      lab.desiredState = "stopped";
      this.store.save(lab);
      this.enqueue(id, record.id, "cleanup");
    });
    this.active.get(record.id)?.abort("cleanup requested");
    return { id, attemptId: record.id, state: "pending" };
  }
  private enqueue(id: string, attemptId: string, kind: "check" | "cleanup") {
    const now = Date.now();
    this.store.db.prepare("INSERT INTO task_lab_operations(id,attempt_id,kind,state,created_at,updated_at) VALUES(?,?,?,'pending',?,?)").run(id, attemptId, kind, now, now);
  }
  async wait(handle: TaskAttemptHandle, id: string, opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<TaskLabEvidence> {
    const record = this.get(handle), deadline = Date.now() + (opts.timeoutMs ?? 300000);
    for (;;) {
      if (opts.signal?.aborted) {
        this.cleanup(handle, "wait cancelled");
        throw new MeritRouterError("lab_invalid_state", "task wait cancelled");
      }
      const op = Operation.optional().parse(this.store.db.prepare("SELECT * FROM task_lab_operations WHERE id=? AND attempt_id=?").get(id, record.id));
      if (!op)
        throw new MeritRouterError("not_found", "unknown task runtime operation");
      if (op.state === "failed")
        throw new MeritRouterError("lab_invalid_state", op.error ?? "task runtime operation failed");
      if (op.state === "completed")
        return TaskLabEvidenceSchema.parse(JSON.parse(op.result_json!));
      if (Date.now() >= deadline) {
        this.cleanup(handle, "wait timed out");
        throw new MeritRouterError("lab_invalid_state", "task runtime operation wait timed out");
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }
  async process(): Promise<void> {
    if (this.closed)
      return;
    await this.recover();
    if (this.closed) return;
    const ids = z.array(z.object({ id: z.string() })).parse(this.store.db.prepare("SELECT id FROM task_lab_operations WHERE state='pending' ORDER BY created_at LIMIT 20").all());
    await Promise.all(ids.map(async ({ id }) => {
      if (this.closed) return;
      const op = immediate(this.store.db, () => {
        const row = Operation.parse(this.store.db.prepare("SELECT * FROM task_lab_operations WHERE id=?").get(id));
        if (row.state !== "pending" || this.store.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND state='running' AND lease_until>?").get(row.attempt_id, Date.now()))
          return null;
        this.store.db.prepare("UPDATE task_lab_operations SET state='running',owner_id=?,lease_until=?,updated_at=? WHERE id=?").run(this.manager.owner, Date.now() + 30000, Date.now(), id);
        return row;
      });
      if (!op)
        return;
      const work = this.execute(op);
      this.work.add(work);
      try {
        await work;
      }
      finally {
        this.work.delete(work);
      }
    }));
  }
  /** Start one tracked drain without blocking the retained-service monitoring tick. */
  schedule(): void {
    if (this.closed || this.drain) return;
    this.drain = this.process().catch(() => {
      // Durable queued/leased rows remain available for the next recovery pass.
    }).finally(() => { this.drain = null; });
  }
  private quarantine(attemptId: string): void {
    const request = this.store.lab(attemptId);
    if (!request || request.phase === "pruned")
      return;
    request.desiredState = "stopped";
    request.phase = "cleanup_blocked";
    request.cleanupError = "Operation lease expired before durable settlement; recovery required";
    if (request.result) {
      request.result.cleanup = "blocked";
      if (request.result.status === "passed")
        request.result.status = "environment_failure";
    }
    this.store.save(request);
  }
  private async execute(op: z.infer<typeof Operation>): Promise<void> {
    const controller = new AbortController();
    this.active.set(op.attempt_id, controller);
    const heartbeat = setInterval(() => {
      const now = Date.now();
      const renewed = this.store.db.prepare("UPDATE task_lab_operations SET lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run(now + 30000, now, op.id, this.manager.owner, now);
      if (!renewed.changes)
        controller.abort("operation ownership lost");
      try {
        this.source.identity(this.store.get(op.attempt_id));
        if (this.store.lab(op.attempt_id)?.desiredState === "stopped")
          controller.abort("stop requested");
      }
      catch {
        controller.abort("task generation expired");
      }
    }, 250);
    heartbeat.unref();
    try {
      const result = op.kind === "check" ? await this.runner.run(this.store.get(op.attempt_id), controller.signal) : await this.runner.stop(this.store.get(op.attempt_id));
      const now = Date.now(), settled = this.store.db.prepare("UPDATE task_lab_operations SET state='completed',result_json=?,lease_until=0,updated_at=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run(JSON.stringify(result), now, op.id, this.manager.owner, now);
      if (!settled.changes)
        this.quarantine(op.attempt_id);
    }
    catch {
      const now = Date.now(), settled = this.store.db.prepare("UPDATE task_lab_operations SET state='failed',error=?,lease_until=0,updated_at=? WHERE id=? AND owner_id=? AND state='running' AND lease_until>?").run("Task Lab failed; private ownership evidence retained", now, op.id, this.manager.owner, now);
      if (!settled.changes)
        this.quarantine(op.attempt_id);
    }
    finally {
      clearInterval(heartbeat);
      this.active.delete(op.attempt_id);
    }
  }
  async recover(): Promise<void> {
    for (const request of this.store.all()) {
      if (request.phase === "pruned" || this.active.has(request.attemptId))
        continue;
      // A prune has its own immutable removal intent. Ordinary stop cannot adopt it.
      // A fresh fenced prune retries an expired intent; retain its proof in the meantime.
      this.store.db.prepare("UPDATE task_lab_operations SET state='failed',lease_until=0,updated_at=? WHERE attempt_id=? AND error=? AND state='running' AND lease_until<=?").run(Date.now(), request.attemptId, TASK_PRUNE_OPERATION, Date.now());
      const stale = this.store.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND state='running' AND lease_until<=?").get(request.attemptId, Date.now());
      const pending = this.store.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND kind='cleanup' AND state='pending'").get(request.attemptId);
      if (request.phase === "retained" && !stale && !pending)
        continue;
      let live = true;
      try {
        this.source.identity(this.store.get(request.attemptId));
      }
      catch {
        live = false;
      }
      if (live && !stale && request.desiredState === "running" && request.phase !== "cleanup_blocked")
        continue;
      const claimed = immediate(this.store.db, () => {
        const now = Date.now();
        if (this.store.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND state='running' AND lease_until>?").get(request.attemptId, now))
          return null;
        let op = Operation.optional().parse(this.store.db.prepare("SELECT * FROM task_lab_operations WHERE attempt_id=? AND (state='pending' OR(state='running' AND lease_until<=?)) ORDER BY created_at LIMIT 1").get(request.attemptId, now));
        if (!op) {
          const id = newId("tlo");
          this.enqueue(id, request.attemptId, "cleanup");
          op = Operation.parse(this.store.db.prepare("SELECT * FROM task_lab_operations WHERE id=?").get(id));
        }
        if (op.state === "running" && op.kind === "check")
          this.quarantine(request.attemptId);
        const latest = this.store.lab(request.attemptId)!;
        latest.desiredState = "stopped";
        this.store.save(latest);
        this.store.db.prepare("UPDATE task_lab_operations SET state='running',owner_id=?,lease_until=?,updated_at=? WHERE id=? AND (state='pending' OR(state='running' AND lease_until<=?))").run(this.manager.owner, now + 30000, now, op.id, now);
        return { ...op, kind: "cleanup" as const };
      });
      if (claimed) {
        const work = this.execute(claimed);
        this.work.add(work);
        try {
          await work;
        }
        finally {
          this.work.delete(work);
        }
      }
    }
  }
  private async runPrune(project?: string, now = Date.now()) {
    if (this.closed) return { removed: [] as string[], blocked: 0 };
    const work = new TaskAttemptPruner(this.manager, this.source, this.runner, () => !this.closed).run(project, now);
    this.work.add(work);
    try { return await work; }
    finally { this.work.delete(work); }
  }
  async prune(now = Date.now()): Promise<string[]> {
    return (await this.runPrune(undefined, now)).removed;
  }
  /** Internal confirmed-project-deletion cleanup; never relaxes task Lab ownership. */
  async pruneProject(project: string): Promise<{ removed: string[]; blocked: number }> {
    if (this.closed) throw new MeritRouterError("unavailable", "Task Lab lifecycle is closed; project cleanup is unavailable");
    return this.runPrune(z.string().min(1).parse(project));
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values())
      controller.abort("manager closed");
    await this.drain;
    await Promise.allSettled([...this.work]);
  }
}
