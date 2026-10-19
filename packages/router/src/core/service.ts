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
import { Brain } from "../brain/brain.js";
import { BrainAccess } from "../brain/access.js";
import { PaidSpend } from "../paid/spend.js";
import { SessionStore } from "../sessions/store.js";
import { ContractStore, type StoredContract } from "../verification/contract.js";
import type { AcceptanceDecisionInput, AcceptanceDecisionOutcome } from "../runners/types.js";
import { parentImportance, recordAcceptanceDecision, verificationBudgetShortfall } from "./acceptance.js";
import { paidEndpoints, paidFingerprint, refreshPaidPrices } from "../paid/catalog.js";
import { httpDirectClient, type DirectClient } from "../paid/direct.js";
import { createCodingRunner } from "../runners/coding/index.js";
import { SupervisorRunner } from "../runners/supervisor.js";
import { GatewayError, TaskValidationError } from "./errors.js";
import { validateTask } from "./validate.js";
import { DELEGATED_BY_SESSION, Executor, type CodingRunner } from "./executor.js";
import { Scheduler } from "./scheduler.js";
import { isTerminal, type TaskState, type WorkerResult, type WorkerTask } from "./task.js";

export interface SwitchyardOptions {
  /** Inference client override (tests, alternative gateways). */
  client?: InferenceClient;
  /** Admin client override; null disables chain management and scanning. */
  admin?: FreeLlmApiAdmin | null;
  coding?: CodingRunner | null;
  /** Runner for supervise tasks (standalone supervisor jobs). */
  supervisor?: CodingRunner | null;
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
  readonly brain: Brain;
  readonly brainAccess: BrainAccess;
  readonly spend: PaidSpend;
  /** Agent sessions: per-run event logs (transcript, model calls, tool journal). */
  readonly sessions: SessionStore;
  /** Acceptance contracts: one immutable contract per task, compiled before its first run. */
  readonly contracts: ContractStore;
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
    this.db = openDatabase(cfg.storageDir, { durability: cfg.storage.durability });
    this.tasks = new TaskStore(this.db, this.now);
    this.artifacts = new ArtifactStore(this.db, cfg.storageDir, this.now);
    this.sessions = new SessionStore(this.db, cfg.storageDir, this.now);
    this.contracts = new ContractStore(this.db);
    this.admission = new Admission(this.db, this.tasks, cfg, this.now);
    this.brain = new Brain(cfg, this.db, this.now);
    this.brainAccess = new BrainAccess(this.db, cfg, this.now);
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
      coding: opts.coding === undefined ? createCodingRunner(cfg) : opts.coding,
      supervisor: opts.supervisor === undefined ? new SupervisorRunner() : opts.supervisor,
      brain: this.brain,
      access: this.brainAccess,
      sessions: this.sessions,
      contracts: this.contracts,
      services: {
        submitTasks: (raw, o) => this.submitTasks(raw, o),
        awaitResults: (ids, o) => this.awaitResults(ids, o),
        getTask: (id) => {
          const t = this.tasks.get(id);
          return t ? { spec: t.spec, state: t.row.state, result: t.result } : null;
        },
        cancelTasks: (ids) => this.cancelTasks(ids),
        acceptTask: (id, input) => this.acceptTask(id, input),
        rejectTask: (id, input) => this.rejectTask(id, input),
      },
      onSettled: (id) => this.events.emit("settled", id),
    });
    syncRepositoryRegistry(this.db, cfg);
    this.qualifier = new Qualifier(this);
    this.scheduler = new Scheduler(
      cfg,
      this.tasks,
      this.executor,
      this.owner,
      () => {
        syncRepositoryRegistry(this.db, this.cfg);
        void this.qualifier.gradePending().catch(() => undefined);
      },
      this.sessions,
    );
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

  /**
   * Validate every task, then persist them atomically before acknowledging. `parentSessionId`
   * names the agent session delegating the tasks; their sessions record it as their parent.
   */
  async submitTasks(raw: unknown[], opts: { purpose?: string; parentSessionId?: string } = {}): Promise<SubmitOutcome[]> {
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
    // A task whose verification policy cannot fit its request budget is refused now.
    if (!errors.length) specs.forEach((spec, i) => {
      const shortfall = verificationBudgetShortfall(this.cfg, spec, parentImportance(this.tasks, this.contracts, spec));
      if (shortfall) errors.push(`task[${i}]: ${shortfall}`);
    });
    if (errors.length) throw new TaskValidationError(errors.join("\n"), errors);
    const outcomes = this.tasks.submit(specs);
    if (opts.purpose && opts.purpose !== "work") {
      for (const o of outcomes) if (!o.deduplicated) this.db.prepare("UPDATE tasks SET purpose = ? WHERE id = ?").run(opts.purpose, o.taskId);
    }
    // Recorded before the scheduler can claim the tasks, so their first session sees it.
    if (opts.parentSessionId) {
      for (const o of outcomes) if (!o.deduplicated) this.tasks.event(o.taskId, DELEGATED_BY_SESSION, { sessionId: opts.parentSessionId });
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
    // With a contract, "allowed" is its total: execution, review, and repair all count against it.
    let contractTotal: number | null = null;
    try {
      contractTotal = this.contracts.get(t.row.id)?.contract.budget.total ?? null;
    } catch {
      contractTotal = null; // a corrupt contract is reported where it is read, not in a status line
    }
    const budget =
      contractTotal ??
      Math.min(
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
  async awaitResults(ids: string[], opts: { timeoutSeconds?: number; signal?: AbortSignal; uncapped?: boolean } = {}): Promise<AwaitOutcome> {
    // The cap bounds MCP tool calls; in-process supervisors may wait longer (it costs no requests).
    const cap = opts.uncapped ? 3600 : this.cfg.execution.await_max_seconds;
    const limit = Math.min(opts.timeoutSeconds ?? cap, cap);
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

  /**
   * Start a standalone job: a supervisor (the models you configured for the role) plans,
   * delegates to workers, verifies, and integrates onto a job branch.
   */
  async startJob(input: {
    goal: string;
    repositories: string[];
    acceptanceCriteria?: string[];
    checks?: string[];
    label?: string;
    idempotencyKey?: string;
    maxModelRequests?: number;
    maxPaidUsd?: number;
  }): Promise<SubmitOutcome> {
    if (!this.cfg.profiles.supervise) throw new TaskValidationError("this configuration has no supervise task type; use a standalone preset or add profiles.supervise");
    const [out] = await this.submitTasks([
      {
        profile: "supervise",
        goal: input.goal,
        repositoryAliases: input.repositories,
        ...(input.label ? { label: input.label } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        constraints: { acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : ["The goal is achieved and the supervisor verified it"], ...(input.checks?.length ? { checks: input.checks } : {}) },
        ...(input.maxModelRequests || input.maxPaidUsd !== undefined ? { budget: { ...(input.maxModelRequests ? { maxModelRequests: input.maxModelRequests } : {}), ...(input.maxPaidUsd !== undefined ? { maxPaidUsd: input.maxPaidUsd } : {}) } } : {}),
      },
    ]);
    return out!;
  }

  /** A task's acceptance contract, or null when it has none yet (or is a supervisor job). */
  contract(id: string): StoredContract | null {
    return this.contracts.get(id);
  }

  /**
   * Accept a finished task's result on behalf of its job's supervisor or a human. Who accepted
   * and why are recorded on the result. Unmet results are refused, not_verified and
   * needs_supervisor ones need a reason, and with `verification.strict_acceptor: human` only a
   * human accepts a strict result. Throws a SwitchyardError with the refusal code.
   */
  acceptTask(id: string, input: AcceptanceDecisionInput): AcceptanceDecisionOutcome {
    const out = recordAcceptanceDecision({ cfg: this.cfg, tasks: this.tasks, contracts: this.contracts, now: this.now }, id, "accept", input);
    this.events.emit("settled", id);
    return out;
  }

  /** Reject a finished task's result (a reason is required); it becomes unmet. */
  rejectTask(id: string, input: AcceptanceDecisionInput): AcceptanceDecisionOutcome {
    const out = recordAcceptanceDecision({ cfg: this.cfg, tasks: this.tasks, contracts: this.contracts, now: this.now }, id, "reject", input);
    this.events.emit("settled", id);
    return out;
  }

  /** Questions supervisors are waiting on. */
  questions(opts: { pendingOnly?: boolean; taskId?: string } = {}): Array<{ id: number; taskId: string; question: string; options: string[] | null; answer: string | null; askedAt: number; answeredAt: number | null }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.pendingOnly ?? true) where.push("answer IS NULL");
    if (opts.taskId) (where.push("task_id = ?"), args.push(opts.taskId));
    const rows = this.db.prepare(`SELECT * FROM job_questions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 100`).all(...args) as Array<{ id: number; task_id: string; question: string; options_json: string | null; answer: string | null; asked_at: number; answered_at: number | null }>;
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, question: r.question, options: r.options_json ? (JSON.parse(r.options_json) as string[]) : null, answer: r.answer, askedAt: r.asked_at, answeredAt: r.answered_at }));
  }

  answerQuestion(id: number, answer: string, by = "user"): void {
    const r = this.db.prepare("UPDATE job_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(answer, by, this.now(), id);
    if (r.changes === 0) throw new TaskValidationError(`question ${id} does not exist or was already answered`);
  }

  /**
   * Re-queue an interrupted task. Agent-loop roles continue their latest interrupted session;
   * a coding task starts over in a fresh worktree (the old one stays as evidence).
   */
  resumeTask(id: string): TaskState {
    const t = this.tasks.get(id);
    const coding = t ? this.cfg.profiles[t.spec.profile]?.mode === "coding" : false;
    const s = this.tasks.resume(id, coding ? { freshWorkspace: true } : {});
    this.scheduler.kick();
    return s;
  }

  /**
   * Re-queue the task of an interrupted session so its next run continues that session (a
   * coding task in the same worktree). Completion and batch work re-runs fresh, linked to it.
   */
  resumeSession(sessionId: string): { taskId: string; state: TaskState } {
    let s = this.sessions.get(sessionId);
    if (!s) throw new TaskValidationError(`unknown session ${sessionId}`);
    if (!s.taskId) throw new TaskValidationError(`session ${sessionId} belongs to no task`);
    if (s.status === "running" && !this.tasks.leaseLive(s.taskId)) {
      // Left running by a process that died: settle the task and the session first.
      this.tasks.recoverExpiredLeases();
      this.sessions.markDeadRunning((x) => x.id !== sessionId);
      s = this.sessions.get(sessionId)!;
    }
    if (s.status !== "interrupted") throw new TaskValidationError(`session ${sessionId} is ${s.status}; only interrupted sessions can be resumed`);
    const taskId = s.taskId!;
    const state = this.tasks.resume(taskId, { sessionId });
    this.scheduler.kick();
    return { taskId, state };
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
    await this.executor.flush();
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
