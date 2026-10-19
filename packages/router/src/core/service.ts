import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName } from "../config/schema.js";
import { openDatabase, type Db } from "../storage/db.js";
import { TaskStore, type StoredTask, type SubmitOutcome } from "../storage/tasks.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { usageSummary, type UsageSummary } from "../storage/usage.js";
import { Admission } from "../admission/admission.js";
import { Gate } from "../gateway/gate.js";
import { FreeLlmApiClient } from "../gateway/freellmapi.js";
import { FreeLlmApiAdmin } from "../gateway/freellmapi-admin.js";
import type { InferenceClient } from "../gateway/types.js";
import { PoolVerifier, type PoolVerification } from "../models/pool-verify.js";
import type { PoolAssessment } from "../models/eligibility.js";
import { GatewayError, TaskValidationError } from "./errors.js";
import { validateTask } from "./validate.js";
import { Executor, type CodingRunner } from "./executor.js";
import { Scheduler } from "./scheduler.js";
import { isTerminal, type TaskState, type WorkerResult, type WorkerTask } from "./task.js";

export interface SwitchyardOptions {
  /** Inference client override (tests, alternative gateways). */
  client?: InferenceClient;
  /** Admin client override; null disables pool verification lookups. */
  admin?: FreeLlmApiAdmin | null;
  coding?: CodingRunner | null;
  now?: () => number;
  /** Run the in-process worker loop (MCP server and `switchyard worker`). */
  worker?: boolean;
  pollIntervalMs?: number;
}

export interface TaskStatus {
  taskId: string;
  profile: ProfileName;
  state: TaskState;
  stateReason: string | null;
  dependsOn: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  modelRequestsUsed: number;
  maxModelRequests: number;
  recentEvents: Array<{ at: string; type: string; data: unknown }>;
}

export interface AwaitOutcome {
  completed: WorkerResult[];
  pending: Array<{ taskId: string; state: TaskState | "unknown" }>;
  timedOut: boolean;
  waitedSeconds: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Library entry point shared by the CLI and the MCP server. */
export class Switchyard {
  readonly db: Db;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly admission: Admission;
  readonly gate: Gate;
  readonly verifier: PoolVerifier;
  readonly owner: string;
  private readonly executor: Executor;
  private readonly scheduler: Scheduler;
  private readonly events = new EventEmitter();
  private readonly now: () => number;

  constructor(
    readonly cfg: ResolvedConfig,
    opts: SwitchyardOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.db = openDatabase(cfg.storageDir);
    this.tasks = new TaskStore(this.db, this.now);
    this.artifacts = new ArtifactStore(this.db, cfg.storageDir, this.now);
    this.admission = new Admission(this.db, this.tasks, cfg, this.now);
    this.owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

    const client = opts.client ?? createGatewayClient(cfg);
    const admin = opts.admin === undefined ? createAdminClient(cfg) : opts.admin;
    this.verifier = new PoolVerifier(this.db, cfg, admin, this.now);
    this.gate = new Gate(this.db, cfg, client, this.admission, this.verifier, this.now);
    this.events.setMaxListeners(0);
    this.executor = new Executor({
      cfg,
      db: this.db,
      gate: this.gate,
      tasks: this.tasks,
      artifacts: this.artifacts,
      owner: this.owner,
      now: this.now,
      coding: opts.coding ?? null,
      onSettled: (id) => this.events.emit("settled", id),
    });
    this.scheduler = new Scheduler(cfg, this.tasks, this.executor, this.owner);
    if (opts.worker) this.scheduler.start(opts.pollIntervalMs);
  }

  /** Validate every task, then persist them atomically before acknowledging. */
  async submitTasks(raw: unknown[]): Promise<SubmitOutcome[]> {
    if (!Array.isArray(raw) || raw.length === 0) throw new TaskValidationError("submit at least one task");
    const specs: WorkerTask[] = [];
    const errors: string[] = [];
    for (const [i, r] of raw.entries()) {
      try {
        specs.push(await validateTask(this.cfg, r, this.artifacts));
      } catch (err) {
        errors.push(`task[${i}]: ${(err as Error).message}`);
      }
    }
    if (errors.length) throw new TaskValidationError(errors.join("\n"), errors);
    const outcomes = this.tasks.submit(specs);
    this.scheduler.kick();
    return outcomes;
  }

  getStatus(ids: string[]): Array<TaskStatus | { taskId: string; state: "unknown" }> {
    return ids.map((id) => {
      const t = this.tasks.get(id);
      if (!t) return { taskId: id, state: "unknown" as const };
      return this.status(t);
    });
  }

  private status(t: StoredTask): TaskStatus {
    const budget = Math.min(
      this.cfg.profiles[t.spec.profile]?.max_model_requests ?? 0,
      this.cfg.execution.max_model_requests_per_task,
      t.spec.budget?.maxModelRequests ?? Infinity,
    );
    return {
      taskId: t.row.id,
      profile: t.row.profile,
      state: t.row.state,
      stateReason: t.row.state_reason,
      dependsOn: this.tasks.dependenciesOf(t.row.id),
      createdAt: iso(t.row.created_at)!,
      startedAt: iso(t.row.started_at),
      finishedAt: iso(t.row.finished_at),
      modelRequestsUsed: this.admission.taskTotals(t.row.id).requests,
      maxModelRequests: budget,
      recentEvents: this.tasks.events(t.row.id, 10).map((e) => ({ at: iso(e.ts)!, type: e.type, data: e.data })),
    };
  }

  listTasks(states?: TaskState[], limit = 50): TaskStatus[] {
    return this.tasks.list({ ...(states ? { states } : {}), limit }).map((t) => this.status(t));
  }

  /** Results for tasks that have reached a terminal (or interrupted) state. */
  collectResults(ids: string[]): AwaitOutcome {
    const completed: WorkerResult[] = [];
    const pending: AwaitOutcome["pending"] = [];
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (!t) pending.push({ taskId: id, state: "unknown" });
      else if ((isTerminal(t.row.state) || t.row.state === "interrupted") && t.result) completed.push(t.result);
      else pending.push({ taskId: id, state: t.row.state });
    }
    return { completed, pending, timedOut: false, waitedSeconds: 0 };
  }

  /**
   * Wait inside the package until every task settles or the bounded wait elapses, so the
   * supervisor spends one tool call rather than repeated polling turns.
   */
  async awaitResults(ids: string[], opts: { timeoutSeconds?: number; signal?: AbortSignal } = {}): Promise<AwaitOutcome> {
    const limit = Math.min(opts.timeoutSeconds ?? this.cfg.execution.await_max_seconds, this.cfg.execution.await_max_seconds);
    const start = this.now();
    const until = start + limit * 1000;
    for (;;) {
      const r = this.collectResults(ids);
      const waiting = r.pending.filter((p) => p.state !== "unknown");
      if (waiting.length === 0 || this.now() >= until || opts.signal?.aborted) {
        return { ...r, timedOut: waiting.length > 0, waitedSeconds: Math.round((this.now() - start) / 1000) };
      }
      await new Promise<void>((resolve) => {
        const onSettled = () => done();
        const t = setTimeout(() => done(), Math.min(1000, Math.max(0, until - this.now())));
        const done = () => {
          clearTimeout(t);
          this.events.off("settled", onSettled);
          resolve();
        };
        this.events.on("settled", onSettled);
      });
    }
  }

  cancelTasks(ids: string[]): Array<{ taskId: string; state: TaskState | "unknown" }> {
    const out = this.tasks.requestCancel(ids);
    for (const o of out) {
      if (o.state === "cancel_requested") this.executor.controllers.get(o.taskId)?.abort("cancel");
      this.events.emit("settled", o.taskId);
    }
    return out;
  }

  resumeTask(id: string): TaskState {
    const s = this.tasks.resume(id);
    this.scheduler.kick();
    return s;
  }

  usage(sinceMs: number, untilMs?: number): UsageSummary {
    return usageSummary(this.db, sinceMs, untilMs ?? this.now());
  }

  pools(): Array<PoolAssessment & { verification: PoolVerification | null; verificationFresh: boolean }> {
    return (Object.keys(this.cfg.profiles) as ProfileName[]).map((p) => {
      const a = this.gate.pool(p);
      const f = this.verifier.freshness(a.gatewayModel);
      return { ...a, verification: f.verification, verificationFresh: f.fresh };
    });
  }

  async verifyPools(): Promise<PoolVerification[]> {
    const out: PoolVerification[] = [];
    for (const p of Object.keys(this.cfg.profiles) as ProfileName[]) out.push(await this.verifier.verify(p));
    return out;
  }

  /** Run recovery once (expired leases, auto-resume of side-effect-free work). */
  recover(): string[] {
    return this.scheduler.recover();
  }

  get activeWorkers(): number {
    return this.scheduler.busy;
  }

  async close(): Promise<void> {
    await this.scheduler.stop();
    this.db.close();
  }
}

export function createGatewayClient(cfg: ResolvedConfig): InferenceClient {
  const key = process.env[cfg.gateway.api_key_env];
  if (!key) {
    // Offline operation (status, usage, validation) works without a key; dispatch fails clearly.
    return {
      name: "unconfigured",
      complete: () =>
        Promise.reject(new GatewayError("auth", `gateway key missing: set ${cfg.gateway.api_key_env}`, undefined, undefined, false)),
    };
  }
  return new FreeLlmApiClient({
    baseUrl: cfg.gateway.base_url,
    apiKey: key,
    timeoutMs: cfg.gateway.request_timeout_seconds * 1000,
    bypassCache: cfg.gateway.bypass_cache,
  });
}

export function createAdminClient(cfg: ResolvedConfig): FreeLlmApiAdmin | null {
  const token = process.env[cfg.gateway.admin_token_env];
  return token ? new FreeLlmApiAdmin(cfg.gateway.base_url, token) : null;
}
