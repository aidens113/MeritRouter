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
import { Catalog } from "../models/catalog.js";
import { Scanner, type ScanSummary } from "../models/scanner.js";
import { TaskRouter } from "../routing/router.js";
import { ProviderSlotAdmission } from "../routing/claim-capacity.js";
import { Qualifier } from "../qualification/runner.js";
import { KeyVault } from "../providers/vault.js";
import { Brain } from "../brain/brain.js";
import { BrainAccess } from "../brain/access.js";
import { PaidSpend } from "../paid/spend.js";
import { SessionStore } from "../sessions/store.js";
import { ContractStore, type StoredContract } from "../verification/contract.js";
import { Auditor } from "../verification/audit.js";
import { PROMOTION_REVIEW_PURPOSE, PromotionReviewer } from "../verification/promotion-review.js";
import type { PromotionRecord, PromotionStatus } from "../brain/promotion.js";
import type { AcceptanceDecisionInput, AcceptanceDecisionOutcome } from "../runners/types.js";
import { parentImportance, recordAcceptanceDecision, verificationBudgetShortfall } from "./acceptance.js";
import { paidEndpoints, paidFingerprint, refreshPaidPrices } from "../paid/catalog.js";
import { createProviderClient, type ProviderClient } from "../providers/client.js";
import { ProviderRuntime } from "../providers/runtime.js";
import { runProviderDiscovery, type DiscoveryRun } from "../providers/discovery-run.js";
import { dailyProbeBudget, type ProbeBudget } from "../providers/enrich.js";
import type { FetchLike } from "../providers/transport.js";
import { createCodingRunner } from "../runners/coding/index.js";
import { SupervisorRunner } from "../runners/supervisor.js";
import { TaskValidationError } from "./errors.js";
import { validateTask } from "./validate.js";
import { DELEGATED_BY_SESSION, Executor, type CodingRunner, type ProjectDeps } from "./executor.js";
import { ProjectRegistry } from "../projects/registry.js";
import type { ProjectContext } from "../projects/context.js";
import { Scheduler } from "./scheduler.js";
import { isTerminal, type TaskState, type WorkerResult, type WorkerTask } from "./task.js";

export interface SwitchyardOptions {
  coding?: CodingRunner | null;
  /** Runner for supervise tasks (standalone supervisor jobs). */
  supervisor?: CodingRunner | null;
  /** Provider client override for every provider (tests). */
  providerClient?: ProviderClient;
  /** Fetch for providers and their discovery (tests use a fake provider). */
  providerFetch?: FetchLike;
  now?: () => number;
  /** Run the in-process worker loop (MCP server and `switchyard worker`). */
  worker?: boolean;
  pollIntervalMs?: number;
}

export interface TaskStatus {
  taskId: string;
  /** The task's project slug. */
  project: string;
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

/** Task purposes SwitchYard submits itself; without a named project they go to the primary one. */
const SYSTEM_PURPOSES = new Set(["qualification", "comparison", "audit"]);

/** Library entry point shared by the CLI, the MCP server, and the web panel. */
export class Switchyard {
  readonly db: Db;
  readonly tasks: TaskStore;
  readonly artifacts: ArtifactStore;
  readonly admission: Admission;
  readonly catalog: Catalog;
  readonly health: ProviderHealth;
  readonly gate: Gate;
  readonly router: TaskRouter;
  readonly scanner: Scanner;
  readonly owner: string;
  readonly qualifier: Qualifier;
  /** Audit sampling: background reviews of passed results, recorded for calibration only. */
  readonly auditor: Auditor;
  /** The independent reviewer of supervisors' global promotions (decision D9). */
  readonly promotionReviewer: PromotionReviewer;
  readonly vault: KeyVault;
  /** Providers: registry, credentials, key state, limits, client, health. */
  readonly providers: ProviderRuntime;
  /** The projects of this install (`projects.<slug>`, or the single-project shape). */
  readonly projects: ProjectRegistry;
  /** The primary project's brain (see `brainFor` for any project). */
  readonly brain: Brain;
  /** The primary project's brain access (see `brainAccessFor`). */
  readonly brainAccess: BrainAccess;
  private readonly brains = new Map<string, { brain: Brain; access: BrainAccess }>();
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
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discovering: Promise<DiscoveryRun | null> | null = null;
  private readonly probeBudget: ProbeBudget;
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
    this.projects = new ProjectRegistry(cfg);
    this.projects.attach(this.db, this.now);
    this.brain = this.brainFor(this.projects.primary.project.slug);
    this.brainAccess = this.brainAccessFor(this.projects.primary.project.slug);
    this.vault = new KeyVault(this.db, cfg.storageDir, this.now);
    this.spend = new PaidSpend(this.db, cfg, this.vault, this.now);
    this.providers = new ProviderRuntime(cfg, this.db, this.vault, {
      client: opts.providerClient ?? createProviderClient({ ...(opts.providerFetch ? { fetch: opts.providerFetch } : {}), now: this.now }),
      ...(opts.providerFetch ? { fetch: opts.providerFetch } : {}),
      now: this.now,
    });
    this.probeBudget = dailyProbeBudget(cfg.discovery.max_probe_requests_per_day, this.now);
    this.catalog = new Catalog(this.db, cfg.modelsPath, {
      requireConfirmationForHeuristicParams: cfg.discovery.require_confirmation_for_heuristic_params,
      extra: {
        list: () => paidEndpoints(this.cfg, this.db, (p) => this.providers.credentials().usable(p).filter((c) => c.billingClass !== "free_tier").length, this.now()),
        key: () => paidFingerprint(this.cfg, this.db),
      },
    });
    this.owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

    this.health = new ProviderHealth(
      this.now,
      () => this.providers.statuses(),
      (platform) => this.providers.statusPlatform(platform),
    );
    this.gate = new Gate(this.db, cfg, this.admission, this.health, { providers: this.providers, spend: this.spend });
    this.router = new TaskRouter(cfg, this.db, this.catalog, this.gate, this.artifacts, this.now);
    this.scanner = new Scanner({
      db: this.db,
      catalog: this.catalog,
      discover: () => this.discover(),
      refreshPrices: () => refreshPaidPrices(this.db, this.cfg),
      anyProvider: () => this.providers.discoverable().length > 0 || Object.keys(this.cfg.paid.providers).length > 0,
      now: this.now,
    });
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
      project: (task) => this.projectDeps(task.row.project_id),
    });
    this.qualifier = new Qualifier(this);
    this.auditor = new Auditor(
      { cfg, db: this.db, tasks: this.tasks, artifacts: this.artifacts, admission: this.admission, catalog: this.catalog, router: this.router, contracts: this.contracts, submitTasks: (raw, o) => this.submitTasks(raw, o) },
      this.now,
    );
    this.promotionReviewer = new PromotionReviewer({ cfg, tasks: this.tasks, catalog: this.catalog, router: this.router, admission: this.admission, submitTasks: (raw, o) => this.submitTasks(raw, o) });
    this.events.on("settled", (id: string) => this.settlePromotionReview(id));
    this.scheduler = new Scheduler(
      cfg,
      this.tasks,
      this.executor,
      this.owner,
      () => {
        this.projects.syncRuntimeRepositories();
        void this.qualifier.gradePending().catch(() => undefined);
        void this.auditor.sweep().catch(() => undefined);
      },
      this.sessions,
      new ProviderSlotAdmission(cfg, this.router, this.health.capacity, this.now),
      (slug) => this.projects.get(slug),
    );
    if (opts.worker) this.startWorker(opts.pollIntervalMs);
  }

  /** A project's brain (one per project, over the shared brain repository). */
  brainFor(project: string): Brain {
    return this.projectBrain(project).brain;
  }

  /** A project's brain access (grants and requests scoped to that project's brain). */
  brainAccessFor(project: string): BrainAccess {
    return this.projectBrain(project).access;
  }

  private projectBrain(project: string): { brain: Brain; access: BrainAccess } {
    let b = this.brains.get(project);
    if (!b) {
      const ctx = this.projects.require(project);
      b = { brain: new Brain(ctx, this.db, this.now, { reviewer: () => this.promotionReviewer }), access: new BrainAccess(this.db, ctx, this.now) };
      this.brains.set(project, b);
    }
    return b;
  }

  /**
   * Supervisors' promotions to global knowledge (decision D9), newest first: every project's, or
   * one project's. Pending ones (`pending_review`, `pending_approval`) are what a person may decide.
   */
  promotions(opts: { project?: string; status?: PromotionStatus } = {}): PromotionRecord[] {
    const slugs = opts.project ? [this.projectContext(opts.project).project.slug] : this.projects.slugs();
    return slugs.flatMap((p) => this.brainFor(p).promotions.list(opts.status ? { status: opts.status } : {})).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Collect finished promotion reviews and retry waiting ones (also runs when a review task settles). */
  async settlePromotions(project?: string): Promise<number> {
    let n = 0;
    for (const p of project ? [this.projectContext(project).project.slug] : this.projects.slugs()) n += await this.brainFor(p).promotions.settle();
    return n;
  }

  /** A person approves or rejects a waiting promotion (`by` names them; a rejection needs a reason). */
  async decidePromotion(project: string, id: string, approve: boolean, by: string, reason = ""): Promise<PromotionRecord> {
    const brain = this.brainFor(this.projectContext(project).project.slug);
    const who = { kind: "human" as const, name: by };
    return approve ? brain.promotions.approve(who, id, reason || undefined) : brain.promotions.reject(who, id, reason);
  }

  /** When a promotion review task settles, move its project's promotions on. */
  private settlePromotionReview(taskId: string): void {
    const row = this.db.prepare("SELECT purpose, project_id FROM tasks WHERE id = ?").get(taskId) as { purpose: string; project_id: string } | undefined;
    if (row?.purpose !== PROMOTION_REVIEW_PURPOSE) return;
    // On a later turn of the event loop: settling may start another review task.
    setTimeout(() => void this.settlePromotions(row.project_id || undefined).catch(() => undefined), 0).unref?.();
  }

  /** A task's project dependencies (its context, brain, brain access); throws for an unconfigured project. */
  private projectDeps(project: string): ProjectDeps {
    const cfg = this.projectContext(project);
    const b = this.projectBrain(cfg.project.slug);
    return { cfg, brain: b.brain, access: b.access };
  }

  /**
   * The context a project's tasks run under. A row without a project (written outside a service
   * since this one started) belongs to the primary project, as at start (see `backfillProjects`).
   */
  projectContext(project: string): ProjectContext {
    if (!project) return this.projects.primary;
    const c = this.projects.get(project);
    if (!c) throw new TaskValidationError(`project ${project} is not configured (configured: ${this.projects.slugs().join(", ")})`);
    return c;
  }

  /** The context of a task's project. */
  private contextOfTask(id: string): ProjectContext {
    const project = this.tasks.projectOf(id);
    if (project === null) throw new TaskValidationError(`unknown task ${id}`);
    return this.projectContext(project);
  }

  /** Refuse an id-based write when the caller named a project the task is not in. */
  private assertInProject(id: string, project: string | undefined): void {
    if (!project) return;
    const actual = this.tasks.projectOf(id);
    if (actual !== null && actual !== project) throw new TaskValidationError(`task ${id} belongs to project ${actual}, not ${project}`);
  }

  private startWorker(pollIntervalMs?: number): void {
    this.scheduler.start(pollIntervalMs);
    this.reloadTimer = setInterval(() => this.reloadIfChanged(), 2000);
    this.reloadTimer.unref?.();
    const minutes = this.cfg.discovery.interval_minutes;
    if (minutes > 0) {
      // List each provider with a usable key on the interval, refresh free daily quotas and paid
      // prices, and record the scan (nothing to list while no key is configured; a key added
      // later is picked up on the next run).
      const run = () => void this.scan().catch(() => undefined);
      const last = this.lastDiscovery();
      if (this.providers.discoverable().length && (last === null || this.now() - last > minutes * 60_000)) setTimeout(run, 2000).unref?.();
      this.discoveryTimer = setInterval(run, minutes * 60_000);
      this.discoveryTimer.unref?.();
    }
  }

  private lastDiscovery(): number | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'provider_discovery_last'").get() as { value: string } | undefined;
    return r ? Number(r.value) : null;
  }

  /**
   * Discover the models of providers with usable keys (all, or `only` these, e.g. right
   * after a key was added) and save them per provider. Null when no provider has a usable key.
   * One run at a time: a call during a run waits for that run.
   */
  async discover(opts: { only?: string[] } = {}): Promise<DiscoveryRun | null> {
    if (this.discovering) return this.discovering;
    const only = opts.only ?? this.providers.discoverable();
    if (!only.length) return null;
    this.discovering = runProviderDiscovery({
      runtime: this.providers,
      catalog: this.catalog,
      config: this.cfg.discovery,
      only,
      probeClient: this.gate.probeClient(),
      probeBudget: this.probeBudget,
    })
      .then((run) => {
        this.db.prepare("INSERT INTO meta (key, value) VALUES ('provider_discovery_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(run.startedAt));
        this.tasks.event(null, "provider_discovery", { added: run.added.length, saved: run.saved, providers: run.providers.map((p) => ({ provider: p.provider, status: p.status, kept: p.kept, errors: p.errors.length })), warnings: run.warnings });
        return run;
      })
      .finally(() => {
        this.discovering = null;
      });
    return this.discovering;
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
      this.projects.refresh();
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
   * The project a submission goes to: the named one; else the project of the job (parentTaskId)
   * or dependency the tasks name; else, for SwitchYard's own purposes (qualification, audits,
   * comparisons), the primary project; else the only project. With several projects and nothing
   * to infer from, a project must be named.
   */
  private submissionProject(raw: unknown[], opts: { purpose?: string; project?: string }): ProjectContext {
    const linked = new Set<string>();
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const t = r as { parentTaskId?: unknown; dependsOn?: unknown };
      const ids = [t.parentTaskId, ...(Array.isArray(t.dependsOn) ? t.dependsOn : [])].filter((x): x is string => typeof x === "string");
      for (const id of ids) {
        const p = this.tasks.projectOf(id);
        if (p) linked.add(p);
      }
    }
    if (opts.project) {
      const ctx = this.projects.require(opts.project);
      const other = [...linked].find((p) => p !== opts.project);
      if (other) throw new TaskValidationError(`the tasks name a job or dependency in project ${other}, not ${opts.project}`);
      return ctx;
    }
    if (linked.size > 1) throw new TaskValidationError(`the tasks name jobs or dependencies in several projects (${[...linked].join(", ")})`);
    if (linked.size === 1) return this.projectContext([...linked][0]!);
    if (opts.purpose && SYSTEM_PURPOSES.has(opts.purpose)) return this.projects.primary;
    return this.projects.forWrite();
  }

  /**
   * Validate every task, then persist them atomically before acknowledging. `parentSessionId`
   * names the agent session delegating the tasks; their sessions record it as their parent.
   * `project` names the tasks' project (see `submissionProject` for when it may be omitted);
   * their repository aliases are that project's.
   */
  async submitTasks(raw: unknown[], opts: { purpose?: string; parentSessionId?: string; project?: string } = {}): Promise<SubmitOutcome[]> {
    if (!Array.isArray(raw) || raw.length === 0) throw new TaskValidationError("submit at least one task");
    const project = this.submissionProject(raw, opts);
    const specs: WorkerTask[] = [];
    const errors: string[] = [];
    this.projects.syncRuntimeRepositories();
    const largestContext = this.largestContext();
    for (const [i, r] of raw.entries()) {
      try {
        specs.push(
          await validateTask(project, r, this.artifacts, {
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
      const shortfall = verificationBudgetShortfall(project, spec, parentImportance(this.tasks, this.contracts, spec));
      if (shortfall) errors.push(`task[${i}]: ${shortfall}`);
    });
    if (errors.length) throw new TaskValidationError(errors.join("\n"), errors);
    const outcomes = this.tasks.submit(specs, { project: project.project.slug });
    this.projects.touch(project.project.slug);
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

  /** Status of tasks by id; with `project`, a task of another project reads as unknown. */
  getStatus(ids: string[], project?: string): Array<TaskStatus | { taskId: string; state: "unknown" }> {
    return ids.map((id) => {
      const t = this.tasks.get(id);
      return t && (!project || t.row.project_id === project) ? this.status(t) : { taskId: id, state: "unknown" as const };
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
      project: t.row.project_id,
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

  /** Newest tasks first; `project` limits them to one project (all projects when omitted). */
  listTasks(states?: TaskState[], limit = 50, project?: string): TaskStatus[] {
    return this.tasks.list({ ...(states ? { states } : {}), limit, ...(project ? { project } : {}) }).map((t) => this.status(t));
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

  /** Cancel tasks; with `project`, a task of another project is refused. */
  cancelTasks(ids: string[], project?: string): Array<{ taskId: string; state: TaskState | "unknown" }> {
    for (const id of ids) this.assertInProject(id, project);
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
    /** The job's project (required when the install has several). */
    project?: string;
  }): Promise<SubmitOutcome> {
    if (!this.cfg.profiles.supervise) throw new TaskValidationError("this configuration has no supervise task type; use a standalone preset or add profiles.supervise");
    const project = this.projects.forWrite(input.project).project.slug;
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
    ], { project });
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
  acceptTask(id: string, input: AcceptanceDecisionInput, project?: string): AcceptanceDecisionOutcome {
    this.assertInProject(id, project);
    const out = recordAcceptanceDecision({ cfg: this.contextOfTask(id), tasks: this.tasks, contracts: this.contracts, now: this.now }, id, "accept", input);
    this.events.emit("settled", id);
    return out;
  }

  /** Reject a finished task's result (a reason is required); it becomes unmet. */
  rejectTask(id: string, input: AcceptanceDecisionInput, project?: string): AcceptanceDecisionOutcome {
    this.assertInProject(id, project);
    const out = recordAcceptanceDecision({ cfg: this.contextOfTask(id), tasks: this.tasks, contracts: this.contracts, now: this.now }, id, "reject", input);
    this.events.emit("settled", id);
    return out;
  }

  /** Questions supervisors are waiting on; `project` limits them to one project's jobs (all when omitted). */
  questions(opts: { pendingOnly?: boolean; taskId?: string; project?: string } = {}): Array<{ id: number; taskId: string; project: string; question: string; options: string[] | null; answer: string | null; askedAt: number; answeredAt: number | null }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.pendingOnly ?? true) where.push("q.answer IS NULL");
    if (opts.taskId) (where.push("q.task_id = ?"), args.push(opts.taskId));
    if (opts.project) (where.push("t.project_id = ?"), args.push(opts.project));
    const rows = this.db.prepare(`SELECT q.*, t.project_id FROM job_questions q JOIN tasks t ON t.id = q.task_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY q.id DESC LIMIT 100`).all(...args) as Array<{ id: number; task_id: string; project_id: string; question: string; options_json: string | null; answer: string | null; asked_at: number; answered_at: number | null }>;
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, project: r.project_id, question: r.question, options: r.options_json ? (JSON.parse(r.options_json) as string[]) : null, answer: r.answer, askedAt: r.asked_at, answeredAt: r.answered_at }));
  }

  /** Answer a supervisor's question; with `project`, a question of another project's job is refused. */
  answerQuestion(id: number, answer: string, by = "user", project?: string): void {
    if (project) {
      const q = this.db.prepare("SELECT task_id FROM job_questions WHERE id = ?").get(id) as { task_id: string } | undefined;
      if (q) this.assertInProject(q.task_id, project);
    }
    const r = this.db.prepare("UPDATE job_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(answer, by, this.now(), id);
    if (r.changes === 0) throw new TaskValidationError(`question ${id} does not exist or was already answered`);
  }

  /**
   * Re-queue an interrupted task. Agent-loop roles continue their latest interrupted session;
   * a coding task starts over in a fresh worktree (the old one stays as evidence).
   */
  resumeTask(id: string, project?: string): TaskState {
    this.assertInProject(id, project);
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
  resumeSession(sessionId: string, project?: string): { taskId: string; state: TaskState } {
    let s = this.sessions.get(sessionId);
    if (!s) throw new TaskValidationError(`unknown session ${sessionId}`);
    if (!s.taskId) throw new TaskValidationError(`session ${sessionId} belongs to no task`);
    this.assertInProject(s.taskId, project);
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

  /** Usage in a window; `project` limits it to one project's tasks and requests (all when omitted). */
  usage(sinceMs: number, untilMs?: number, project?: string): UsageSummary {
    return usageSummary(this.db, sinceMs, untilMs ?? this.now(), project);
  }

  /**
   * Scan models now: list every provider with a usable key (discovery), refresh free daily quotas
   * and configured paid prices, and record the scan.
   */
  async scan(): Promise<ScanSummary> {
    return this.scanner.scan();
  }

  /** Run recovery once (expired leases, auto-resume of side-effect-free work). */
  recover(): string[] {
    return this.scheduler.recover();
  }

  get activeWorkers(): number {
    return this.scheduler.busy;
  }

  async close(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    await this.discovering?.catch(() => undefined);
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
