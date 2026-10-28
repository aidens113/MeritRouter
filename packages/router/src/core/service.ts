import path from "node:path";
import { projectRuntimePaths } from "../projects/runtime-paths.js";
import { installationUsage } from "../admin/project-usage.js";
import { openInstallationLayout, ProjectRuntimeHost, ProjectStoreRouter, type InstallationLayout, type SplitProjectRuntime, type TaskStores } from "./project-runtime-host.js";
import { readClientSupervision } from "../config/client-supervision.js";
import { RepositoryMutationError } from "../workspaces/repository-mutation.js";
import { EventEmitter } from "node:events";
import { WebAccess, type PageTransport, type Resolver } from "../web/index.js";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { loadConfig, parseConfig, readConfigFile, type ResolvedConfig } from "../config/load.js";
import { UNLIMITED_REQUESTS, type ProfileName, type TierName } from "../config/schema.js";
import { immediate, openDatabase, type Db } from "../storage/db.js";
import { TaskStore, canonicalJson, type StoredTask, type SubmitOutcome } from "../storage/tasks.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { usageSummary, type UsageSummary } from "../storage/usage.js";
import { Admission, effectiveBudget, heldRequests } from "../admission/admission.js";
import { extraRequests } from "../admission/job-pool.js";
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
import { DeliveryRepairContinuationSchema, ProductDeliveries } from "../verification/product-delivery.js";
import { validateTask } from "./validate.js";
import { DELEGATED_BY_SESSION, Executor, type CodingRunner, type ProjectDeps } from "./executor.js";
import { ProjectRegistry } from "../projects/registry.js";
import { createProjectRuntimeStore, type ProjectRuntimeStore } from "../projects/runtime-store.js";
import { retainedLabConfigErrors } from "../projects/lab-config-guard.js";
import { LabManager } from "../labs/lab.js";
import { LabNameSchema } from "../labs/recipe.js";
import { taskLabSelectionIssues } from "./task-lab-validation.js";
import { taskLabAuthority, taskLabEvidenceProblem } from "../runners/coding/task-lab.js";
import { MeritRouterError } from "./errors.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { prepareProjectRepositories, type RepositoryPreparation } from "../projects/repository-setup.js";
import type { ProjectContext } from "../projects/context.js";
import { Scheduler } from "./scheduler.js";
import { isTerminal, type TaskState, type WorkerResult, type WorkerTask } from "./task.js";

export interface MeritRouterOptions {
  coding?: CodingRunner | null;
  /** Runner for supervise tasks (standalone supervisor jobs). */
  supervisor?: CodingRunner | null;
  /** Provider client override for every provider (tests). */
  providerClient?: ProviderClient;
  /** Fetch for providers and their discovery (tests use a fake provider). */
  providerFetch?: FetchLike;
  /** Fetch for the web search and fetch APIs (tests use a fake). */
  webFetch?: FetchLike;
  /** The built-in page fetch's transport and DNS resolver (tests use fakes). */
  webPage?: { transport?: PageTransport; resolve?: Resolver };
  now?: () => number;
  /** Run the in-process worker loop (MCP server and `meritrouter worker`). */
  worker?: boolean;
  /** Supervise lab services independently of model workers; off for ordinary API instances. */
  labsMonitor?: boolean;
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
  maxModelRequests: number | null;
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

/**
 * Task purposes MeritRouter submits itself. Without a named project, qualification and comparison
 * runs go to the reserved qualification project (their fixture repositories live only there);
 * audits go to the primary project (the auditor names the audited task's project).
 */
const SYSTEM_PURPOSES = new Set(["qualification", "comparison", "audit"]);
const QUALIFICATION_PURPOSES = new Set(["qualification", "comparison"]);

/** Library entry point shared by the CLI, the MCP server, and the web panel. */
export class MeritRouter {
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
  /** Agents' web search and fetch: backends, budgets, and the request record (split: the primary project's). */
  get web(): WebAccess {
    return this.legacyWeb ?? this.host!.primaryWeb(this.projects.primary.project.slug);
  }
  private readonly legacyWeb: WebAccess | null;
  /** Where project-owned data lives: this installation's store (`legacy`) or each project's directory (`split`). */
  readonly layout: InstallationLayout;
  private readonly host: ProjectRuntimeHost | null;
  /** Which store (installation or split project) holds a project's, task's or session's rows. */
  private readonly stores: ProjectStoreRouter;
  /** The projects of this install (`projects.<slug>`, or the single-project shape). */
  readonly projects: ProjectRegistry;
  readonly labs: LabManager;
  /** The primary project's brain (see `brainFor` for any project); follows the primary after a config reload or a deletion. */
  get brain(): Brain {
    return this.brainFor(this.projects.primary.project.slug);
  }
  /** The primary project's brain access (see `brainAccessFor`). */
  get brainAccess(): BrainAccess {
    return this.brainAccessFor(this.projects.primary.project.slug);
  }
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
  private workerStarted = false;
  private preparing: Promise<RepositoryPreparation[]> | null = null;
  private closing = false;
  private readonly promotionTimers = new Set<NodeJS.Timeout>();
  private readonly promotionSettles = new Set<Promise<number>>();

  constructor(
    readonly cfg: ResolvedConfig,
    opts: MeritRouterOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.configMtime = mtime(cfg.configPath);
    this.db = openDatabase(cfg.storageDir, { durability: cfg.storage.durability });
    // Nothing else holds this handle until the constructor returns: a failure below must close
    // it, or the database file stays open (and locked on Windows) for the life of the process.
    try {
      this.layout = openInstallationLayout(this.db, cfg.storage.layout);
      this.tasks = new TaskStore(this.db, this.now);
      this.artifacts = new ArtifactStore(this.db, cfg.storageDir, this.now);
      this.sessions = new SessionStore(this.db, cfg.storageDir, this.now);
      this.contracts = new ContractStore(this.db);
      this.admission = new Admission(this.db, this.tasks, cfg, this.now);
      this.projects = new ProjectRegistry(cfg);
      this.projects.attach(this.db, this.now, { backfill: this.layout === "legacy" });
      this.labs = new LabManager({ db: this.db, storageDir: cfg.storageDir, cfg, project: slug => this.projectContext(slug), monitor: opts.labsMonitor === true && this.layout === "legacy" });
      this.vault = new KeyVault(this.db, cfg.storageDir, this.now);
      this.spend = new PaidSpend(this.db, cfg, this.vault, this.now);
      this.providers = new ProviderRuntime(cfg, this.db, this.vault, {
        client: opts.providerClient ?? createProviderClient({ ...(opts.providerFetch ? { fetch: opts.providerFetch } : {}), now: this.now }),
        ...(opts.providerFetch ? { fetch: opts.providerFetch } : {}),
        now: this.now,
      });
      this.legacyWeb = this.layout === "split" ? null : new WebAccess({
        cfg,
        db: this.db,
        providers: this.providers,
        ...(opts.webFetch ? { fetch: opts.webFetch } : {}),
        ...(opts.webPage ? { page: opts.webPage } : {}),
        event: (taskId, type, data) => this.tasks.event(taskId, type, data),
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
      const coding = opts.coding === undefined ? createCodingRunner(cfg) : opts.coding, supervisor = opts.supervisor === undefined ? new SupervisorRunner() : opts.supervisor;
      this.host = this.layout === "split" ? new ProjectRuntimeHost({ db: this.db, cfg, projects: this.projects, catalog: this.catalog, providers: this.providers, spend: this.spend,
        owner: this.owner, now: this.now, coding, supervisor, labsMonitor: opts.labsMonitor === true, reviewer: () => this.promotionReviewer,
        ...(opts.webFetch ? { webFetch: opts.webFetch } : {}), ...(opts.webPage ? { webPage: opts.webPage } : {}), onSettled: (id) => this.events.emit("settled", id) }) : null;
      this.stores = new ProjectStoreRouter(this.host, { db: this.db, tasks: this.tasks, sessions: this.sessions, artifacts: this.artifacts, contracts: this.contracts, admission: this.admission, bundle: null }, this.projects);
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
        coding,
        supervisor,
        brain: this.host ? null : this.brain,
        access: this.host ? null : this.brainAccess,
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
        web: this.legacyWeb,
        labs: this.labs,
        ensureLabsSupervisor: async () => {
          const { ensureLabSupervisor } = await import("../operations/lab-supervisor.js");
          await ensureLabSupervisor(this);
        },
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
    } catch (error) {
      this.abandonConstruction();
      throw error;
    }
  }

  /**
   * Undo a constructor that threw after opening the installation database: stop what may have
   * started (timers, Lab monitor, schedulers) and close the handle. Background cleanup that
   * needs the database fails quietly once it is closed.
   */
  private abandonConstruction(): void {
    this.closing = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    // Fields assigned after the failure point are still undefined here.
    const self = this as unknown as { labs?: LabManager; scheduler?: Scheduler; host?: ProjectRuntimeHost | null };
    for (const pending of [self.labs?.close({ stopServices: false }), self.scheduler?.stop(), self.host?.close()]) void pending?.catch(() => undefined);
    if (this.db.open) this.db.close();
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
    const bundle = this.stores.runtimeOf(this.projectContext(project).project.slug);
    if (bundle) return { brain: bundle.brain!, access: bundle.access! };
    let b = this.brains.get(project);
    if (!b) {
      const ctx = this.projects.context(project) ?? this.projects.require(project);
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
    if (this.closing) return 0;
    const run = (async () => {
      let n = 0;
      for (const p of project ? [this.projectContext(project).project.slug] : this.projects.slugs()) n += await this.brainFor(p).promotions.settle();
      return n;
    })();
    this.promotionSettles.add(run);
    try { return await run; }
    finally { this.promotionSettles.delete(run); }
  }

  /** A person approves or rejects a waiting promotion (`by` names them; a rejection needs a reason). */
  async decidePromotion(project: string, id: string, approve: boolean, by: string, reason = ""): Promise<PromotionRecord> {
    const brain = this.brainFor(this.projectContext(project).project.slug);
    const who = { kind: "human" as const, name: by };
    return approve ? brain.promotions.approve(who, id, reason || undefined) : brain.promotions.reject(who, id, reason);
  }

  /** When a promotion review task settles, move its project's promotions on. */
  private settlePromotionReview(taskId: string): void {
    if (this.closing) return;
    let row: { purpose: string; project_id: string } | undefined;
    try { row = this.stores.ofTask(taskId).db.prepare("SELECT purpose, project_id FROM tasks WHERE id = ?").get(taskId) as typeof row; } catch { return; }
    if (row?.purpose !== PROMOTION_REVIEW_PURPOSE) return;
    // Review results are already durable. Transient writer contention must not lose
    // the only settlement notification; retry publication, never the model request.
    const schedule = (attempt: number): void => {
      if (this.closing) return;
      const timer = setTimeout(() => {
        this.promotionTimers.delete(timer);
        if (this.closing) return;
        void this.settlePromotions(row!.project_id || undefined).catch(error => {
          if (error instanceof RepositoryMutationError && error.detail.kind === "lock_busy" && attempt < 5)
            schedule(attempt + 1);
          // Unresolved publication/command evidence requires explicit recovery.
        });
      }, attempt === 0 ? 0 : Math.min(4000, 250 * 2 ** (attempt - 1)));
      this.promotionTimers.add(timer);
      timer.unref?.();
    };
    schedule(0);
  }

  /** A task's project dependencies (its context, brain, brain access); throws for an unconfigured project. */
  private projectDeps(project: string): ProjectDeps {
    const cfg = this.projectContext(project);
    this.stores.fence(cfg.project.slug);
    // Split projects run in their own runtimes; this executor serves only installation-store tasks.
    if (this.host) throw new TaskValidationError(`project ${cfg.project.slug} has no installation-store runtime in a split installation`);
    const b = this.projectBrain(cfg.project.slug);
    return { cfg, brain: b.brain, access: b.access, stores: this.projectStores(cfg.project.slug) };
  }

  /** A project's stores: its own isolated store (split installation), or the installation's shared one. */
  projectStores(project: string): ProjectRuntimeStore {
    const cfg = this.projectContext(project);
    const bundle = this.stores.runtimeOf(cfg.project.slug);
    if (bundle) return bundle;
    return createProjectRuntimeStore(cfg.project.slug, {
      db: this.db, tasks: this.tasks, sessions: this.sessions, artifacts: this.artifacts, contracts: this.contracts,
    });
  }

  /** A project's Lab manager: its own (split installation) or the installation manager. */
  labsFor(project: string): LabManager {
    const bundle = this.stores.runtimeOf(this.projectContext(project).project.slug);
    return bundle ? this.host!.labsFor(bundle) : this.labs;
  }

  /**
   * Create a configured project's local store in `directory` (`<directory>/.MeritRouter`) and start
   * its runtime. `projects.<slug>.directory` must already name `directory`; `name`, when given, must
   * match the configured name. Idempotent for the same directory. Legacy installations refuse.
   */
  async createSplitProject(input: { slug: string; name?: string; directory: string }): Promise<SplitProjectRuntime> {
    const host = this.splitHost();
    if (!this.projects.get(input.slug)) { this.configMtime = 0; this.reloadIfChanged(); }
    const ctx = this.projects.require(input.slug);
    if (input.name !== undefined && input.name !== ctx.project.name) throw new TaskValidationError(`project ${input.slug} is configured as ${ctx.project.name}, not ${input.name}`);
    const bundle = await host.create({ slug: input.slug, directory: input.directory, installationRoots: [path.dirname(this.cfg.configPath), this.cfg.storageDir] });
    return { identity: bundle.identity, paths: bundle.paths };
  }

  /**
   * Stop a split project's dispatch, interrupt and drain its work, close its store and Labs, and
   * retire its registration. Its files stay in place for the caller to remove.
   */
  async retireProject(slug: string): Promise<SplitProjectRuntime> {
    return this.splitHost().retire(slug);
  }

  private kick(s: TaskStores): void {
    if (s.bundle) this.host!.kick();
    else this.scheduler.kick();
  }

  private splitHost(): ProjectRuntimeHost {
    if (!this.host) throw new MeritRouterError("split_projects_unavailable", "this installation keeps project data in its own store (legacy layout); split projects cannot be mixed into it");
    return this.host;
  }

  /**
   * The context a project's tasks run under. A row without a project (written outside a service
   * since this one started) belongs to the primary project, as at start (see `backfillProjects`).
   */
  projectContext(project: string): ProjectContext {
    if (!project) return this.projects.primary;
    const c = this.projects.context(project);
    if (!c) throw new TaskValidationError(`project ${project} is not configured (configured: ${this.projects.slugs().join(", ")})`);
    return c;
  }

  /** The context of a task's project. */
  private contextOfTask(id: string, s: TaskStores = this.stores.local): ProjectContext {
    const project = s.tasks.projectOf(id);
    if (project === null) throw new TaskValidationError(`unknown task ${id}`);
    return s.bundle?.cfg ?? this.projectContext(project);
  }

  /** Refuse an id-based write when the caller named a project the task is not in. */
  private assertInProject(id: string, project: string | undefined, s: TaskStores = this.stores.local): void {
    if (!project) return;
    const actual = s.tasks.projectOf(id);
    if (actual !== null && actual !== project) throw new TaskValidationError(`task ${id} belongs to project ${actual}, not ${project}`);
  }

  private startWorker(pollIntervalMs?: number): void {
    this.workerStarted = true;
    // Every configured repository is made a usable git repository (created, initialised, or given a
    // first snapshot as needed); failures are recorded and shown on the project overview.
    void this.prepareRepositories().catch(() => undefined);
    // A split installation's store holds no project tasks: only the project runtimes dispatch.
    if (this.host) this.host.start(pollIntervalMs);
    else this.scheduler.start(pollIntervalMs);
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
      const labErrors = retainedLabConfigErrors(this.db, next);
      if (labErrors.length) throw new Error(labErrors.join("; "));
      Object.assign(this.cfg, next);
      this.labs.reloadConfig();
      this.host?.reloadConfig();
      this.projects.refresh();
      this.tasks.event(null, "config_reloaded", { at: this.now() });
      // A running service prepares repositories added or moved by the edit.
      if (this.workerStarted) void this.prepareRepositories().catch(() => undefined);
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
   * or dependency the tasks name; else, for qualification and comparison runs, the reserved
   * qualification project, and for audits the primary project; else the only project. With
   * several projects and nothing to infer from, a project must be named.
   */
  private submissionProject(raw: unknown[], opts: { purpose?: string; project?: string }): ProjectContext {
    const linked = new Set<string>();
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const t = r as { parentTaskId?: unknown; dependsOn?: unknown };
      const ids = [t.parentTaskId, ...(Array.isArray(t.dependsOn) ? t.dependsOn : [])].filter((x): x is string => typeof x === "string");
      for (const id of ids) {
        const p = this.stores.ofTask(id, opts.project).tasks.projectOf(id);
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
    if (opts.purpose && QUALIFICATION_PURPOSES.has(opts.purpose)) return this.projects.qualification;
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
    const project = this.submissionProject(raw, opts), slug = project.project.slug;
    const s = this.stores.of(slug), labs = s.bundle ? this.host!.labsFor(s.bundle) : this.labs, router = s.bundle?.router ?? this.router, projectCfg = s.bundle?.cfg ?? project;
    if (!s.bundle) this.stores.fence(slug);
    const specs: WorkerTask[] = [];
    const errors: string[] = [];
    this.projects.syncRuntimeRepositories();
    const largestContext = this.largestContext();
    for (const [i, r] of raw.entries()) {
      try {
        const lab = typeof r === "object" && r !== null && "lab" in r && r.lab !== undefined ? LabNameSchema.parse(r.lab) : undefined;
        const taskConfig = lab ? labs.configuration(slug, lab) : projectCfg;
        specs.push(
          await validateTask(taskConfig, r, s.artifacts, {
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
      const shortfall = verificationBudgetShortfall(projectCfg, spec, parentImportance(s.tasks, s.contracts, spec));
      if (shortfall) errors.push(`task[${i}]: ${shortfall}`);
    });
    if (errors.length) throw new TaskValidationError(errors.join("\n"), errors);
    const outcomes = immediate(s.db, () => {
      if (specs.some(spec => spec.constraints.labChecks?.length)) {
        // Read by content under the config writer lock; a rapid revocation may share an mtime.
        const current = new ProjectRegistry(loadConfig(this.cfg.configPath)).get(project.project.slug);
        if (!current) throw new TaskValidationError("the task Lab project is no longer configured");
        for (const spec of specs) {
          const problems = taskLabSelectionIssues(current, spec);
          if (problems.length) throw new TaskValidationError(problems.join("; "), problems);
        }
      }
      // Explicit external authority is checked at insertion, under the config writer's DB lock.
      // Validation above awaits filesystem work; a human may revoke policy while it is running.
      const scoped = specs.filter(spec => spec.supervisionScope !== undefined);
      if (scoped.length) {
        this.reloadIfChanged();
        const current = this.projectContext(project.project.slug);
        const policy = readClientSupervision(this.cfg.configPath);
        for (const spec of scoped) {
          if (current.profiles[spec.profile]?.mode !== "supervisor") throw new TaskValidationError("supervisionScope applies only to supervisor-mode tasks");
          if (spec.parentTaskId) {
            const parent = s.tasks.get(spec.parentTaskId);
            if (!parent || parent.row.project_id !== project.project.slug || current.profiles[parent.spec.profile]?.mode !== "supervisor") throw new TaskValidationError("parentTaskId must name a real same-project supervisor");
            if (spec.supervisionScope === "project") throw new TaskValidationError("A child task cannot declare project supervision scope");
          }
          if (spec.supervisionScope === "project" && !policy.dispatch_final_supervisor) throw new TaskValidationError("Dispatching a final project supervisor is disabled; use bounded subtask supervision");
        }
      }
      const submitted = s.tasks.submit(specs, { project: slug });
      // Refuse impossible supervisor routes in the same transaction as submission. A
      // retry of an existing idempotent task remains readable even if its route changed.
      // Match TaskRouter.prepare without classification or a provider request.
      for (const outcome of submitted) {
        if (outcome.deduplicated) continue;
        const task = s.tasks.get(outcome.taskId)!;
        if (this.cfg.profiles[task.spec.profile]?.mode !== "supervisor") continue;
        const chosen = this.cfg.supervisor.endpoints.map(endpointId => ({
          profile: task.spec.profile, tier: null, kind: "force" as const,
          endpointId, allowBelowFloor: true, enabled: true,
        }));
        const plan = router.plan(task.spec.profile, "T3", router.inputModalities(task),
          task.spec.routing?.endpointId, false, this.cfg.supervisor.paid_policy, chosen, task.spec.hints?.web);
        if (!plan.candidates.length) {
          const exclusions = plan.explanations.filter(candidate => !candidate.eligible)
            .map(candidate => `${candidate.endpointId}: ${candidate.reasons.join("; ")}`).join(" | ");
          throw new MeritRouterError(plan.blocker?.code ?? "no_eligible_endpoint",
            `${plan.blocker?.message ?? "No eligible supervisor endpoint is configured."} ` +
            `Supervisor task was not submitted. Check the model catalog, supervisor routing policy, credentials and endpoint exclusions; paid routing remains subject to its configured policy.` +
            (exclusions ? ` Exclusions: ${exclusions}` : " The model catalog has no candidate endpoints."));
        }
      }
      for (const outcome of submitted) {
        if (outcome.deduplicated) continue;
        labs.bindTask(slug, outcome.taskId, s.tasks.get(outcome.taskId)!.spec, s.tasks);
      }
      return submitted;
    });
    this.projects.touch(slug);
    if (opts.purpose && opts.purpose !== "work") {
      for (const o of outcomes) if (!o.deduplicated) s.db.prepare("UPDATE tasks SET purpose = ? WHERE id = ?").run(opts.purpose, o.taskId);
    }
    // Recorded before the scheduler can claim the tasks, so their first session sees it.
    if (opts.parentSessionId) {
      for (const o of outcomes) if (!o.deduplicated) s.tasks.event(o.taskId, DELEGATED_BY_SESSION, { sessionId: opts.parentSessionId });
    }
    this.kick(s);
    return outcomes;
  }

  /** Status of tasks by id; with `project`, a task of another project reads as unknown. */
  getStatus(ids: string[], project?: string): Array<TaskStatus | { taskId: string; state: "unknown" }> {
    return ids.map((id) => {
      const s = this.stores.ofTask(id, project), t = s.tasks.get(id);
      return t && (!project || t.row.project_id === project) ? this.status(t, s) : { taskId: id, state: "unknown" as const };
    });
  }

  private status(t: StoredTask, s: TaskStores): TaskStatus {
    const row = t.row as StoredTask["row"] & { tier?: string | null; purpose?: string };
    const tierCfg = row.tier && row.tier in this.cfg.tiers ? this.cfg.tiers[row.tier as TierName] : null;
    // With a contract, "allowed" is its total: execution, review, and repair all count against it.
    let contractBudget: { total: number; unallocated: number | null } | null = null;
    try {
      contractBudget = s.contracts.get(t.row.id)?.contract.budget ?? null;
    } catch {
      contractBudget = null; // a corrupt contract is reported where it is read, not in a status line
    }
    const configuredBudget = contractBudget
      ? contractBudget.unallocated === null ? null : contractBudget.total
      : this.cfg.profiles[t.spec.profile] ? effectiveBudget(this.cfg, t.spec, tierCfg ? (row.tier as TierName) : null).maxModelRequests : 0;
    const budget = configuredBudget === null || configuredBudget === UNLIMITED_REQUESTS ? null : configuredBudget + extraRequests(s.db, t.row.id);
    return {
      taskId: t.row.id,
      project: t.row.project_id,
      profile: t.row.profile,
      purpose: row.purpose ?? "work",
      state: t.row.state,
      stateReason: t.row.state_reason,
      tier: row.tier ?? null,
      dependsOn: s.tasks.dependenciesOf(t.row.id),
      createdAt: iso(t.row.created_at)!,
      startedAt: iso(t.row.started_at),
      finishedAt: iso(t.row.finished_at),
      modelRequestsUsed: s.admission.taskTotals(t.row.id).requests,
      maxModelRequests: budget,
      goal: t.spec.goal.slice(0, 300),
      recentEvents: s.tasks.events(t.row.id, 10).map((e) => ({ at: iso(e.ts)!, type: e.type, data: e.data })),
    };
  }

  /** Newest tasks first; `project` limits them to one project (all projects when omitted). */
  listTasks(states?: TaskState[], limit = 50, project?: string): TaskStatus[] {
    const all = (project ? [this.stores.of(project)] : this.stores.all()).flatMap(s => s.tasks.list({ ...(states ? { states } : {}), limit, ...(project ? { project } : {}) }).map((t) => this.status(t, s)));
    return all.length > limit ? all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit) : all;
  }

  /** Results for tasks that have reached a terminal (or interrupted) state. */
  collectResults(ids: string[], project?: string): AwaitOutcome {
    const completed: WorkerResult[] = [];
    const pending: AwaitOutcome["pending"] = [];
    for (const id of ids) {
      const t = this.stores.ofTask(id, project).tasks.get(id);
      if (!t || (project !== undefined && t.row.project_id !== project)) pending.push({ taskId: id, state: "unknown" });
      else if ((isTerminal(t.row.state) || t.row.state === "interrupted") && t.result) completed.push(t.result);
      else pending.push({ taskId: id, state: t.row.state });
    }
    return { completed, pending, timedOut: false, waitedSeconds: 0 };
  }

  /**
   * Wait inside the package until every task settles or the bounded wait elapses, so the
   * supervisor spends one tool call rather than repeated polling turns.
   */
  async awaitResults(ids: string[], opts: { timeoutSeconds?: number; signal?: AbortSignal; uncapped?: boolean; project?: string } = {}): Promise<AwaitOutcome> {
    // The cap bounds MCP tool calls; in-process supervisors may wait longer (it costs no requests).
    const cap = opts.uncapped ? 3600 : this.cfg.execution.await_max_seconds;
    const limit = Math.min(opts.timeoutSeconds ?? cap, cap);
    const start = this.now();
    const until = start + limit * 1000;
    for (;;) {
      const r = this.collectResults(ids, opts.project);
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
    const groups = this.stores.groupTasks(ids, project);
    for (const [s, group] of groups) for (const id of group) this.assertInProject(id, project, s);
    const out = [...groups].flatMap(([s, group]) => s.tasks.requestCancel(group).map(o => ({ o, executor: s.bundle?.executor ?? this.executor })));
    for (const { o, executor } of out) {
      if (o.state === "cancel_requested") executor.controllers.get(o.taskId)?.abort("cancel");
      this.events.emit("settled", o.taskId);
    }
    return out.map(({ o }) => o);
  }

  /** Awaited logical cancellation with immutable target generations and durable receipts. */
  async cancelTasksAsync(ids: string[], project?: string) {
    if (this.closing) throw new TaskValidationError("service is closing");
    const groups = [...this.stores.groupTasks(ids, project).keys()];
    if (groups.length > 1) throw new TaskValidationError("cancel tasks of one project at a time");
    const s = groups[0] ?? this.stores.local;
    for (const id of ids) this.assertInProject(id, project, s);
    return (s.bundle?.executor ?? this.executor).cancelTasksAsync(ids, project);
  }

  async recoverAsync(): Promise<string[]> {
    if (this.closing) throw new TaskValidationError("service is closing");
    return this.scheduler.recoverAsync();
  }

  /**
   * Start a standalone job: a supervisor (the models you configured for the role) plans,
   * delegates to workers, verifies, and integrates onto a job branch.
   */
  async startJob(input: {
    goal: string;
    supervisionScope?: "subtask" | "project";
    repositories: string[];
    acceptanceCriteria?: string[];
    checks?: string[];
    label?: string;
    idempotencyKey?: string;
    maxModelRequests?: number;
    maxPaidUsd?: number;
    /** The job's project (required when the install has several). */
    project?: string;
    /** Use this project's retained Lab as the team's integration workspace. */
    lab?: string;
  }): Promise<SubmitOutcome> {
    if (!this.cfg.profiles.supervise) throw new TaskValidationError("this configuration has no supervise task type; use a standalone preset or add profiles.supervise");
    const project = this.projects.forWrite(input.project).project.slug;
    const maxModelRequests = input.maxModelRequests ?? (this.cfg.client_supervision.workflow === "delegated_delivery"
      ? Math.min(this.cfg.supervisor.delivery_budget.total_requests, this.cfg.profiles.supervise.max_model_requests ?? Infinity)
      : undefined);
    const [out] = await this.submitTasks([
      {
        profile: "supervise",
        ...(this.cfg.client_supervision.workflow === "delegated_delivery" ? {deliveryVersion:2 as const} : {}),
        ...(input.supervisionScope ? { supervisionScope: input.supervisionScope } : {}),
        goal: input.goal,
        repositoryAliases: input.repositories,
        ...(input.lab ? { lab: input.lab } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        constraints: { acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : ["The goal is achieved and the supervisor verified it"], ...(input.checks?.length ? { checks: input.checks } : {}) },
        ...(maxModelRequests !== undefined || input.maxPaidUsd !== undefined ? { budget: { ...(maxModelRequests !== undefined ? { maxModelRequests } : {}), ...(input.maxPaidUsd !== undefined ? { maxPaidUsd: input.maxPaidUsd } : {}) } } : {}),
      },
    ], { project });
    return out!;
  }

  /** A task's acceptance contract, or null when it has none yet (or is a supervisor job). */
  contract(id: string): StoredContract | null {
    return this.stores.ofTask(id).contracts.get(id);
  }

  /**
   * Accept a finished task's result on behalf of its job's supervisor or a human. Who accepted
   * and why are recorded on the result. Unmet results are refused, not_verified and
   * needs_supervisor ones need a reason, and with `verification.strict_acceptor: human` only a
   * human accepts a strict result. Throws a MeritRouterError with the refusal code.
   */
  acceptTask(id: string, input: AcceptanceDecisionInput, project?: string): AcceptanceDecisionOutcome {
    const s = this.stores.ofTask(id, project), labs = s.bundle ? this.host!.labsFor(s.bundle) : this.labs;
    this.assertInProject(id, project, s);
    const task = s.tasks.get(id);
    if (task && !s.bundle) this.stores.fence(task.row.project_id);
    const evidence = task?.result?.taskLab;
    const authority = task?.spec.constraints.labChecks?.length ? taskLabAuthority(labs, id, evidence) : null;
    if (task?.spec.constraints.labChecks?.length) {
      // A human/reviewer decision cannot waive exact, current runtime-check evidence.
      // Bounded Git inspection happens before the acceptance writer's DB transaction.
      const problem = taskLabEvidenceProblem(task.spec, evidence, authority);
      if (problem) throw new MeritRouterError("acceptance_refused", problem);
    }
    const beforeAccept = (current: StoredTask) => {
      if (!task?.spec.constraints.labChecks?.length) return;
      if (!authority || current.row.run_count !== task.row.run_count || current.row.project_id !== task.row.project_id
        || canonicalJson(current.spec) !== canonicalJson(task.spec) || canonicalJson(current.result) !== canonicalJson(task.result)
        || canonicalJson(labs.taskAttempts.store.get(authority.attempt.id)) !== canonicalJson(authority.attempt)
        || canonicalJson(labs.taskAttempts.store.lab(authority.attempt.id)) !== canonicalJson(authority.request)
        || canonicalJson(labs.store.byId(authority.lab.id)) !== canonicalJson(authority.lab)) {
        throw new MeritRouterError("acceptance_refused", "Task Lab authority changed during acceptance; inspect and retry");
      }
      const fresh = new ProjectRegistry(loadConfig(this.cfg.configPath)).get(current.row.project_id);
      const sameStore = s.bundle ? fresh?.projectDirectory != null && projectRuntimePaths(fresh.projectDirectory).projectDirectory === s.bundle.paths.projectDirectory : fresh?.storageDir === this.cfg.storageDir;
      if (!fresh || !sameStore || taskLabSelectionIssues(fresh, current.spec).length
        || canonicalJson(Object.keys(fresh.repositoryPaths).filter(alias => current.spec.repositoryAliases.includes(alias))) !== canonicalJson(authority.attempt.repositories.map(repo => repo.alias))
        || authority.attempt.repositories.some(repo => fresh.repositoryPaths[repo.alias]?.path !== repo.sourcePath)
        || canonicalJson(ProjectConfigSchema.parse(fresh.projects[current.row.project_id]).lab) !== canonicalJson(authority.request.recipe)) {
        throw new MeritRouterError("acceptance_refused", "Task Lab authorization or recipe changed during acceptance");
      }
      const lab = authority.lab.id;
      if (s.db.prepare("SELECT 1 FROM task_lab_operations WHERE attempt_id=? AND state IN ('pending','running') LIMIT 1").get(authority.attempt.id)
        || s.db.prepare("SELECT 1 FROM lab_ports WHERE lab_id=? LIMIT 1").get(lab)
        || s.db.prepare("SELECT 1 FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped' LIMIT 1").get(lab)
        || s.db.prepare("SELECT 1 FROM lab_services WHERE lab_id=? AND (state!='stopped' OR pid IS NOT NULL OR token IS NOT NULL) LIMIT 1").get(lab)) {
        throw new MeritRouterError("acceptance_refused", "Task Lab resources changed during acceptance");
      }
    };
    const out = recordAcceptanceDecision({ cfg: this.contextOfTask(id, s), tasks: s.tasks, contracts: s.contracts, now: this.now, beforeAccept }, id, "accept", input);
    this.events.emit("settled", id);
    return out;
  }

  /** Reject a finished task's result (a reason is required); it becomes unmet. */
  rejectTask(id: string, input: AcceptanceDecisionInput, project?: string): AcceptanceDecisionOutcome {
    const s = this.stores.ofTask(id, project);
    this.assertInProject(id, project, s);
    if (!s.bundle) this.stores.fence(s.tasks.projectOf(id) ?? "");
    const out = recordAcceptanceDecision({ cfg: this.contextOfTask(id, s), tasks: s.tasks, contracts: s.contracts, now: this.now }, id, "reject", input);
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
    const stores = opts.project ? [this.stores.of(opts.project)] : this.stores.all();
    const rows = stores.flatMap(s => s.db.prepare(`SELECT q.*, t.project_id FROM job_questions q JOIN tasks t ON t.id = q.task_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY q.id DESC LIMIT 100`).all(...args) as Array<{ id: number; task_id: string; project_id: string; question: string; options_json: string | null; answer: string | null; asked_at: number; answered_at: number | null }>);
    if (stores.length > 1) rows.sort((a, b) => b.asked_at - a.asked_at).splice(100);
    return rows.map((r) => ({ id: r.id, taskId: r.task_id, project: r.project_id, question: r.question, options: r.options_json ? (JSON.parse(r.options_json) as string[]) : null, answer: r.answer, askedAt: r.asked_at, answeredAt: r.answered_at }));
  }

  /** Answer a supervisor's question; with `project`, a question of another project's job is refused. */
  answerQuestion(id: number, answer: string, by = "user", project?: string): void {
    const s = this.stores.ofQuestion(id, project);
    const q = s.db.prepare("SELECT task_id FROM job_questions WHERE id = ?").get(id) as { task_id: string } | undefined;
    if (q && project) this.assertInProject(q.task_id, project, s);
    if (q && !s.bundle) this.stores.fence(s.tasks.projectOf(q.task_id) ?? "");
    const r = s.db.prepare("UPDATE job_questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(answer, by, this.now(), id);
    if (r.changes === 0) throw new TaskValidationError(`question ${id} does not exist or was already answered`);
  }

  /**
   * Re-queue an interrupted task, or explicitly repair a completed FINAL-rejected delivery.
   * Delivery repair opens a fresh linked supervisor session in its retained workspace.
   * Agent-loop roles continue their latest interrupted session;
   * a coding task starts over in a fresh worktree (the old one stays as evidence).
   */
  resumeTask(id: string, project?: string): TaskState {
    const st = this.stores.ofTask(id, project);
    this.assertInProject(id, project, st);
    const t = st.tasks.get(id);
    if (t && !st.bundle) this.stores.fence(t.row.project_id);
    const coding = t ? this.cfg.profiles[t.spec.profile]?.mode === "coding" : false;
    let s:TaskState;
    if (t?.row.state === "failed") {
      s = st.db.transaction(() => {
        const current = st.tasks.get(id)!;
        const cfg = st.bundle?.cfg ?? this.projectContext(current.row.project_id);
        const previous = st.sessions.forTask(id).at(-1);
        const cap = effectiveBudget(cfg, current.spec, previous?.tier ?? null).maxModelRequests;
        const allowed = cap === UNLIMITED_REQUESTS ? cap : cap + extraRequests(st.db, id);
        if (cfg.profiles[current.spec.profile]?.mode !== "supervisor" || !previous || previous.role !== "supervisor" || previous.status !== "failed" || previous.stopReason !== "repeated_tool_call:task_result" || !previous.workspace?.repos.length ||
          st.admission.taskTotals(id).requests + heldRequests(st.db, id) >= allowed)
          throw new TaskValidationError(`task ${id} is not a recoverable supervisor observation stall with remaining budget`);
        for (const repo of previous.workspace.repos) {
          if (!current.spec.repositoryAliases.includes(repo.alias) || !cfg.repositoryPaths[repo.alias]?.writable || !repo.baseCommit || !statSync(repo.worktree, { throwIfNoEntry: false })?.isDirectory())
            throw new TaskValidationError(`task ${id} recovery workspace is unavailable or outside its assigned repositories`);
        }
        const log = st.sessions.events(previous.id, { limit: 1 });
        const plan = st.sessions.planResume(previous.id, { recoverEdits: cfg.sessions.recover_edits });
        if (!log || log.corrupt.length || !plan?.messages.length || plan.actions.length || !plan.workspace?.repos.length)
          throw new TaskValidationError(`task ${id} recovery transcript is unavailable or corrupt`);
        return st.tasks.resumeObservationStall(id, previous.id);
      }).immediate();
    } else if(t?.row.state==="completed"){
      s=st.db.transaction(()=>{
        const rejected=new ProductDeliveries(st.db,this.now).rejectedCompleted(id,t.row.project_id);
        const previous=st.sessions.forTask(id).filter(session=>session.role==="supervisor").at(-1);
        if(!rejected||!previous||previous.status!=="completed"||!previous.workspace?.repos.length)throw new TaskValidationError(`task ${id} is not a completed FINAL-rejected delivery with a retained supervisor workspace`);
        const repair=DeliveryRepairContinuationSchema.parse({...rejected,previousSessionId:previous.id,workspace:previous.workspace});
        const projectConfig=st.bundle?.cfg??this.projectContext(t.row.project_id);
        if(projectConfig.profiles[t.spec.profile]?.mode!=="supervisor")throw new TaskValidationError(`task ${id} no longer has current supervisor authority`);
        for(const repo of repair.workspace.repos){
          if(!t.spec.repositoryAliases.includes(repo.alias)||!projectConfig.repositoryPaths[repo.alias]?.writable||!repo.baseCommit||!statSync(repo.worktree,{throwIfNoEntry:false})?.isDirectory())throw new TaskValidationError(`task ${id} repair workspace is unavailable or outside its assigned repositories`);
        }
        return st.tasks.resume(id,{},repair);
      }).immediate();
    }else s = st.tasks.resume(id, coding ? { freshWorkspace: true } : {});
    this.kick(st);
    return s;
  }

  /**
   * Re-queue the task of an interrupted session so its next run continues that session (a
   * coding task in the same worktree). Completion and batch work re-runs fresh, linked to it.
   */
  resumeSession(sessionId: string, project?: string): { taskId: string; state: TaskState } {
    const st = this.stores.ofSession(sessionId, project);
    let s = st.sessions.get(sessionId);
    if (!s) throw new TaskValidationError(`unknown session ${sessionId}`);
    if (!s.taskId) throw new TaskValidationError(`session ${sessionId} belongs to no task`);
    this.assertInProject(s.taskId, project, st);
    if (!st.bundle) this.stores.fence(st.tasks.projectOf(s.taskId) ?? "");
    if (s.status === "running" && !st.tasks.leaseLive(s.taskId)) {
      // Left running by a process that died: settle the task and the session first.
      st.tasks.recoverExpiredLeases();
      st.sessions.markDeadRunning((x) => x.id !== sessionId);
      s = st.sessions.get(sessionId)!;
    }
    if (s.status !== "interrupted") throw new TaskValidationError(`session ${sessionId} is ${s.status}; only interrupted sessions can be resumed`);
    const taskId = s.taskId!;
    const state = st.tasks.resume(taskId, { sessionId });
    this.kick(st);
    return { taskId, state };
  }

  /** Usage in a window; `project` limits it to one project's tasks and requests (all when omitted). */
  usage(sinceMs: number, untilMs?: number, project?: string): UsageSummary {
    const until = untilMs ?? this.now();
    if (!this.host) return usageSummary(this.db, sinceMs, until, project);
    return project ? usageSummary(this.stores.of(project).db, sinceMs, until, project) : installationUsage(this, sinceMs, until);
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
    // Split layout: the installation store holds no tasks or sessions; each project's own
    // scheduler recovers its store when it starts (Scheduler.start -> recoverAsync).
    if (this.layout === "split") return [];
    return this.scheduler.recover();
  }

  get activeWorkers(): number {
    return this.scheduler.busy + (this.host?.busy ?? 0);
  }

  /**
   * Prepare every project's configured repositories (or `projects`'), recording each preparation
   * as a `repository_prepare` event. Runs at service start and after a config reload in a running
   * service; one run at a time per instance (a call during a run starts after it).
   */
  async prepareRepositories(opts: { projects?: string[] } = {}): Promise<RepositoryPreparation[]> {
    const prev = this.preparing ?? Promise.resolve([]);
    const run = prev.catch(() => []).then(() => prepareProjectRepositories({ db: this.db, tasks: this.tasks, projects: this.projects }, opts));
    this.preparing = run;
    try {
      return await run;
    } finally {
      if (this.preparing === run) this.preparing = null;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const gateDrained = this.gate.close();
    const projectRuntimesDrained = Promise.allSettled(this.host ? [this.host.close()] : []);
    for (const timer of this.promotionTimers) clearTimeout(timer);
    this.promotionTimers.clear();
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    await this.preparing?.catch(() => undefined);
    await this.discovering?.catch(() => undefined);
    await this.scheduler.stop();
    await this.executor.flush();
    await this.labs.close();
    // Review settlement owns brain writes and Git children independently of executor reports.
    await Promise.allSettled([...this.promotionSettles]);
    await gateDrained;
    const projectRuntimeResults=await projectRuntimesDrained;
    const projectRuntimeFailure=projectRuntimeResults.find((result):result is PromiseRejectedResult=>result.status==="rejected");
    if(projectRuntimeFailure?.status==="rejected")throw projectRuntimeFailure.reason;
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
