import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { parseConfig, readConfigFile, type ResolvedConfig } from "../config/load.js";
import type { ProfileName, TierName } from "../config/schema.js";
import { openDatabase, type Db } from "../storage/db.js";
import { TaskStore, type StoredTask, type SubmitOutcome } from "../storage/tasks.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { usageSummary, type UsageSummary } from "../storage/usage.js";
import { Admission } from "../admission/admission.js";
import { Gate, ProviderHealth } from "../gateway/gate.js";
import { FreeLlmApiClient } from "../gateway/freellmapi.js";
import { FreeLlmApiAdmin } from "../gateway/freellmapi-admin.js";
import type { InferenceClient } from "../gateway/types.js";
import { Catalog } from "../models/catalog.js";
import { ChainManager } from "../models/chains.js";
import { Scanner, type ScanSummary } from "../models/scanner.js";
import { TaskRouter } from "../routing/router.js";
import { Qualifier } from "../qualification/runner.js";
import { syncRepositoryRegistry } from "../qualification/registry.js";
import { KeyVault } from "../paid/vault.js";
import { PaidSpend } from "../paid/spend.js";
import { paidEndpoints, paidFingerprint, refreshPaidPrices } from "../paid/catalog.js";
import { httpDirectClient, type DirectClient } from "../paid/direct.js";
import { GatewayError, TaskValidationError } from "./errors.js";
import { validateTask } from "./validate.js";
import { Executor, type CodingRunner } from "./executor.js";
import { Scheduler } from "./scheduler.js";
import { isTerminal, type TaskState, type WorkerResult, type WorkerTask } from "./task.js";

export interface SwitchyardOptions {
  /** Inference client override (tests, alternative gateways). */
  client?: InferenceClient;
  /** Admin client override; null disables chain management and scanning. */
  admin?: FreeLlmApiAdmin | null;
  coding?: CodingRunner | null;
  /** Direct paid-provider client override (tests). */
  directClient?: DirectClient;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Run the in-process worker loop (MCP server and `switchyard worker`). */
  worker?: boolean;
  pollIntervalMs?: number;
}

export interface TaskStatus {
  taskId: string;
  profile: ProfileName;
  purpose: string;
  state: TaskState;
  stateReason: string | null;
  tier: string | null;
  dependsOn: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  modelRequestsUsed: number;
  maxModelRequests: number;
  goal: string;
  recentEvents: Array<{ at: string; type: string; data: unknown }>;
}

export interface AwaitOutcome {
  completed: WorkerResult[];
  pending: Array<{ taskId: string; state: TaskState | "unknown" }>;
  timedOut: boolean;
  waitedSeconds: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Library entry point shared by the CLI, the MCP server, and the web panel. */
export class Switchyard {
  readonly db: Db;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly admission: Admission;
  readonly catalog: Catalog;
  readonly chains: ChainManager;
  readonly health: ProviderHealth;
  readonly gate: Gate;
  readonly router: TaskRouter;
  readonly scanner: Scanner;
  readonly admin: FreeLlmApiAdmin | null;
  readonly client: InferenceClient;
  readonly owner: string;
  readonly qualifier: Qualifier;
  readonly vault: KeyVault;
  readonly spend: PaidSpend;
  private readonly executor: Executor;
  private readonly scheduler: Scheduler;
  private readonly events = new EventEmitter();
  private readonly now: () => number;
  private configMtime = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly cfg: ResolvedConfig,
    opts: SwitchyardOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.configMtime = mtime(cfg.configPath);
    this.db = openDatabase(cfg.storageDir);
    this.tasks = new TaskStore(this.db, this.now);
    this.artifacts = new ArtifactStore(this.db, cfg.storageDir, this.now);
    this.admission = new Admission(this.db, this.tasks, cfg, this.now);
    this.vault = new KeyVault(this.db, cfg.storageDir, this.now);
    this.spend = new PaidSpend(this.db, cfg, this.vault, this.now);
    this.catalog = new Catalog(this.db, cfg.modelsPath, {
      requireConfirmationForHeuristicParams: cfg.discovery.require_confirmation_for_heuristic_params,
      extra: { list: () => paidEndpoints(this.cfg, this.db, this.vault, this.now()), key: () => paidFingerprint(this.cfg, this.db) },
    });
    this.owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

    this.client = opts.client ?? createGatewayClient(cfg);
    this.admin = opts.admin === undefined ? createAdminClient(cfg) : opts.admin;
    this.chains = new ChainManager(this.db, cfg, this.catalog, this.admin, this.now);
    this.health = new ProviderHealth(this.client, this.now);
    this.gate = new Gate(this.db, cfg, this.client, this.admission, this.chains, this.health, { vault: this.vault, spend: this.spend, client: opts.directClient ?? httpDirectClient });
    this.router = new TaskRouter(cfg, this.db, this.catalog, this.gate, this.artifacts, this.now);
    this.scanner = new Scanner(this.db, cfg, this.catalog, this.chains, this.admin, opts.fetchImpl ?? fetch, this.now);
    this.events.setMaxListeners(0);
    this.executor = new Executor({
      cfg,
      db: this.db,
      gate: this.gate,
      catalog: this.catalog,
      router: this.router,
      tasks: this.tasks,
      artifacts: this.artifacts,
      owner: this.owner,
      now: this.now,
      coding: opts.coding ?? null,
      onSettled: (id) => this.events.emit("settled", id),
    });
    syncRepositoryRegistry(this.db, cfg);
    this.qualifier = new Qualifier(this);
    this.scheduler = new Scheduler(cfg, this.tasks, this.executor, this.owner, () => {
      syncRepositoryRegistry(this.db, this.cfg);
      void this.qualifier.gradePending().catch(() => undefined);
    });
    if (opts.worker) this.startWorker(opts.pollIntervalMs);
  }

  private startWorker(pollIntervalMs?: number): void {
    this.scheduler.start(pollIntervalMs);
    this.reloadTimer = setInterval(() => this.reloadIfChanged(), 2000);
    this.reloadTimer.unref?.();
    const minutes = this.cfg.discovery.interval_minutes;
    if (minutes > 0 && this.admin) {
      const run = () => void this.scanner.scan().catch(() => undefined);
      const last = this.scanner.lastScan();
      if (!last || this.now() - last.startedAt > minutes * 60_000) setTimeout(run, 2000).unref?.();
      this.scanTimer = setInterval(run, minutes * 60_000);
      this.scanTimer.unref?.();
    }
  }

  /**
   * Re-read the config file when it changes (panel edits) and apply it in place, so every
   * component sharing this config object sees the new values. Invalid edits are ignored.
   */
  reloadIfChanged(): { reloaded: boolean; error?: string } {
    const m = mtime(this.cfg.configPath);
    if (!m || m === this.configMtime) return { reloaded: false };
    this.configMtime = m;
    try {
      const next = parseConfig(readConfigFile(this.cfg.configPath), this.cfg.configPath);
      if (next.storageDir !== this.cfg.storageDir) throw new Error("storage.directory cannot change while running; restart instead");
      Object.assign(this.cfg, next);
      syncRepositoryRegistry(this.db, this.cfg);
      this.tasks.event(null, "config_reloaded", { at: this.now() });
      return { reloaded: true };
    } catch (err) {
      this.tasks.event(null, "config_reload_failed", { error: (err as Error).message });
      return { reloaded: false, error: (err as Error).message };
    }
  }

  private largestContext(): number | undefined {
    const ctx = this.catalog
      .endpoints()
      .filter((e) => e.status === "active")
      .map((e) => e.contextLimitTokens ?? 0);
    return ctx.length ? Math.max(...ctx) : undefined;
  }

  /** Validate every task, then persist them atomically before acknowledging. */
  async submitTasks(raw: unknown[], opts: { purpose?: string } = {}): Promise<SubmitOutcome[]> {
    if (!Array.isArray(raw) || raw.length === 0) throw new TaskValidationError("submit at least one task");
    const specs: WorkerTask[] = [];
    const errors: string[] = [];
    syncRepositoryRegistry(this.db, this.cfg);
    const largestContext = this.largestContext();
    for (const [i, r] of raw.entries()) {
      try {
        specs.push(
          await validateTask(this.cfg, r, this.artifacts, {
            ...(largestContext !== undefined ? { largestContext } : {}),
            knownEndpoint: (id) => this.catalog.get(id) !== undefined,
          }),
        );
      } catch (err) {
        errors.push(`task[${i}]: ${(err as Error).message}`);
      }
    }
    if (errors.length) throw new TaskValidationError(errors.join("\n"), errors);
    const outcomes = this.tasks.submit(specs);
    if (opts.purpose && opts.purpose !== "work") {
      for (const o of outcomes) if (!o.deduplicated) this.db.prepare("UPDATE tasks SET purpose = ? WHERE id = ?").run(opts.purpose, o.taskId);
    }
    this.scheduler.kick();
    return outcomes;
  }

  getStatus(ids: string[]): Array<TaskStatus | { taskId: string; state: "unknown" }> {
    return ids.map((id) => {
      const t = this.tasks.get(id);
      return t ? this.status(t) : { taskId: id, state: "unknown" as const };
    });
  }

  private status(t: StoredTask): TaskStatus {
    const row = t.row as StoredTask["row"] & { tier?: string | null; purpose?: string };
    const tierCfg = row.tier && row.tier in this.cfg.tiers ? this.cfg.tiers[row.tier as TierName] : null;
    const budget = Math.min(
      this.cfg.profiles[t.spec.profile]?.max_model_requests ?? 0,
      tierCfg ? tierCfg.max_model_requests : Infinity,
      this.cfg.execution.max_model_requests_per_task,
      t.spec.budget?.maxModelRequests ?? Infinity,
    );
    return {
      taskId: t.row.id,
      profile: t.row.profile,
      purpose: row.purpose ?? "work",
      state: t.row.state,
      stateReason: t.row.state_reason,
      tier: row.tier ?? null,
      dependsOn: this.tasks.dependenciesOf(t.row.id),
      createdAt: iso(t.row.created_at)!,
      startedAt: iso(t.row.started_at),
      finishedAt: iso(t.row.finished_at),
      modelRequestsUsed: this.admission.taskTotals(t.row.id).requests,
      maxModelRequests: budget,
      goal: t.spec.goal.slice(0, 300),
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

  async scan(): Promise<ScanSummary> {
    const summary = await this.scanner.scan();
    summary.errors.push(...(await refreshPaidPrices(this.db, this.cfg)).map((e) => `paid prices ${e}`));
    return summary;
  }

  /** Run recovery once (expired leases, auto-resume of side-effect-free work). */
  recover(): string[] {
    return this.scheduler.recover();
  }

  get activeWorkers(): number {
    return this.scheduler.busy;
  }

  async close(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    await this.scheduler.stop();
    this.db.close();
  }
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function createGatewayClient(cfg: ResolvedConfig): InferenceClient {
  const key = process.env[cfg.gateway.api_key_env];
  if (!key) {
    // Offline operation (status, usage, validation) works without a key; dispatch fails clearly.
    return {
      name: "unconfigured",
      complete: () => Promise.reject(new GatewayError("auth", `gateway key missing: set ${cfg.gateway.api_key_env}`, undefined, undefined, false)),
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
