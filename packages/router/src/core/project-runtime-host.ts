import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type ResolvedConfig } from "../config/load.js";
import { applyDurability, immediate, type Db } from "../storage/db.js";
import { initializeStoreRole } from "../storage/store-role.js";
import { ProjectExecutionGrants, type ExecutionGrantLimits } from "../storage/project-execution-grants.js";
import { ProjectQueueBindings } from "../storage/sqlite-task-queue.js";
import type { LeaseRef } from "../storage/task-leases.js";
import { SqliteRequestAccountingBroker } from "../admission/sqlite-accounting-broker.js";
import type { GlobalEndpointAuthority } from "../admission/accounting-broker.js";
import { ProviderHealth } from "../gateway/gate.js";
import { ProviderSlotAdmission } from "../routing/claim-capacity.js";
import type { Catalog } from "../models/catalog.js";
import type { ProviderRuntime } from "../providers/runtime.js";
import { limitScopes } from "../providers/limits.js";
import type { FetchLike } from "../providers/transport.js";
import type { PaidSpend } from "../paid/spend.js";
import { Brain } from "../brain/brain.js";
import { BrainAccess } from "../brain/access.js";
import type { PromotionReviewPort } from "../brain/promotion.js";
import { LabManager } from "../labs/lab.js";
import { ProjectLabPortReservations } from "../labs/port-reservations.js";
import { WebAccess, WebBackendState, type PageTransport, type Resolver } from "../web/index.js";
import { WebUsageReservations } from "../web/usage-reservations.js";
import { ProjectRegistry } from "../projects/registry.js";
import { projectLimits } from "../projects/schema.js";
import { ProjectRuntimeRegistry, type ProjectRuntimeBundle, type ProjectRuntimeConstruction } from "../projects/runtime-registry.js";
import { createProjectRuntimeServices } from "../projects/runtime-services.js";
import { provisionProjectStore } from "../projects/store-provision.js";
import { createCoordinationStoreIdentity, readProjectStoreRegistration, readStoreIdentity, retireProjectStoreRegistration, type ProjectStoreIdentity } from "../projects/store-identity.js";
import { projectRuntimePaths, type ProjectRuntimePaths } from "../projects/runtime-paths.js";
import { sourceCheckoutForModule } from "../projects/source-checkout.js";
import { taskLabAuthority, taskLabEvidenceProblem } from "../runners/coding/task-lab.js";
import { legacyProjectFence } from "../projects/store-migration.js";
import { projectContext } from "../projects/context.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { ensureQualificationStore, qualificationStoreDirectory } from "../qualification/store.js";
import type { SessionStore } from "../sessions/store.js";
import type { SupervisorServices } from "../runners/types.js";
import type { CodingRunner } from "./executor.js";
import { MeritRouterError, TaskValidationError } from "./errors.js";
import { ProjectScheduler } from "./project-scheduler.js";
import { recoverProjectSettlements } from "../admission/project-request-recovery.js";
import { createProjectRunServices, createProjectWorkerReadServices } from "./project-services.js";
import { taskLabSelectionIssues } from "./task-lab-validation.js";

/** Where an installation keeps project-owned data: its own store (legacy) or each project's directory (split). */
export type InstallationLayout = "legacy" | "split";
const LAYOUT_KEY = "installation_layout";
/** Tables whose rows mean a legacy service already stored project data here. */
const PROJECT_DATA_TABLES = ["projects", "tasks", "sessions", "artifacts", "model_requests", "executions", "labs", "job_plans",
  "brain_grants", "brain_access_requests", "brain_files", "web_requests", "workspaces", "classifications"] as const;

const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * Decide (and on first open, bind) the installation layout from `storage.layout`. A coordination
 * store marked split stays split, and one bound without the mark (a legacy migration) stays
 * legacy, regardless of the current config. Otherwise: `legacy` leaves an unbound store alone;
 * `split` on an empty store binds it as the coordination store (forcing `synchronous=FULL`) and
 * marks it split; `split` on a store that already holds rows from a legacy service throws, since
 * switching an installation with existing data to split storage needs an explicit migration.
 */
export function openInstallationLayout(db: Db, layout: "split" | "legacy"): InstallationLayout {
  const identity = readStoreIdentity(db);
  if (identity?.role === "project") throw new MeritRouterError("store_role_mismatch", "The installation storage directory holds a project store");
  const marked = () => (db.prepare("SELECT value FROM meta WHERE key=?").get(LAYOUT_KEY) as { value: string } | undefined)?.value === "split";
  if (identity?.role === "coordination") {
    applyDurability(db, "full");
    return marked() ? "split" : "legacy";
  }
  if (layout !== "split") return "legacy";
  const empty = () => PROJECT_DATA_TABLES.every(table => !db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  if (!empty()) {
    throw new MeritRouterError("split_layout_unavailable",
      "storage.layout is \"split\" but this installation store already holds data from a legacy service; set storage.layout: legacy, or start a fresh installation directory for split project storage");
  }
  applyDurability(db, "full");
  // The mark goes first: a crash before binding leaves an empty unbound store that rebinds next open.
  const bind = immediate(db, () => {
    if (readStoreIdentity(db) || !empty()) return false;
    db.prepare("INSERT INTO meta(key,value) VALUES(?, 'split') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(LAYOUT_KEY);
    return true;
  });
  if (!bind) return openInstallationLayout(db, layout);
  try {
    initializeStoreRole(db, createCoordinationStoreIdentity());
  } catch (error) {
    // Another process bound it first.
    if (readStoreIdentity(db)?.role !== "coordination") throw error;
  }
  return "split";
}

/**
 * The physical identity of a task's writable repository (its real path), so writer limits hold
 * across projects that share a checkout. Trusted host data: never taken from the task's own paths.
 */
function writerDigests(cfg: ResolvedConfig, alias: string | undefined): string[] {
  const repo = alias ? cfg.repositoryPaths[alias] : undefined;
  if (!repo) return [];
  let real: string;
  try { real = realpathSync.native(repo.path); } catch { real = path.resolve(repo.path); }
  return [createHash("sha256").update(process.platform === "win32" ? real.toLowerCase() : real).digest("hex")];
}

/** Execution-grant limits for one project, from the live installation config. */
function grantLimits(cfg: ResolvedConfig, slug: string): ExecutionGrantLimits {
  return {
    maxTasks: cfg.execution.max_concurrent_tasks, maxSupervisors: cfg.supervisor.max_concurrent_jobs,
    maxWritersPerRepository: cfg.execution.max_concurrent_writers_per_repository,
    projectMaxTasks: projectLimits(cfg, slug).max_concurrent_tasks ?? null,
  };
}

export interface ProjectRuntimeHostOptions {
  /** The installation's bound coordination store. */
  db: Db;
  cfg: ResolvedConfig;
  projects: ProjectRegistry;
  catalog: Catalog;
  providers: ProviderRuntime;
  spend: PaidSpend;
  owner: string;
  now: () => number;
  coding: CodingRunner | null;
  supervisor: CodingRunner | null;
  webFetch?: FetchLike;
  webPage?: { transport?: PageTransport; resolve?: Resolver };
  labsMonitor: boolean;
  reviewer: () => PromotionReviewPort | null;
  /** A task of some project reached a new state. */
  onSettled(taskId: string): void;
}

/** A split project's store identity and runtime paths (`<directory>/.MeritRouter`); B2 removes these files after retirement. */
export interface SplitProjectRuntime { identity: ProjectStoreIdentity; paths: ProjectRuntimePaths }

/**
 * The split installation's project runtimes: one pinned local service graph per registered project
 * (its store, executor, Brain, Labs and web port) over shared coordination services, and the fair
 * scheduler over their local queues. The installation store never receives a project's private rows.
 */
export class ProjectRuntimeHost {
  readonly health: ProviderHealth;
  readonly grants: ProjectExecutionGrants;
  readonly bindings: ProjectQueueBindings;
  readonly broker: SqliteRequestAccountingBroker;
  readonly registry: ProjectRuntimeRegistry;
  readonly scheduler: ProjectScheduler;
  private readonly webState: WebBackendState;
  private readonly webUsage: WebUsageReservations;
  private readonly labs = new Map<string, LabManager>();
  private readonly webs = new Map<string, WebAccess>();
  private readonly sourceCheckout = sourceCheckoutForModule(import.meta.url);
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recovering: Promise<string[]> | null = null;

  constructor(private readonly o: ProjectRuntimeHostOptions) {
    if (readStoreIdentity(o.db)?.role !== "coordination") throw new Error("Project runtimes require the bound coordination store");
    // A legacy Gate owns the installation's health; every project bundle shares this separate one.
    this.health = new ProviderHealth(o.now, () => o.providers.statuses(), platform => o.providers.statusPlatform(platform));
    let bindings!: ProjectQueueBindings;
    this.grants = new ProjectExecutionGrants(o.db, project => grantLimits(o.cfg, project.slug), o.now,
      (grant, proof) => bindings.renewalAuthority(grant, proof), input => bindings.delegationAuthority(input));
    this.bindings = bindings = new ProjectQueueBindings(this.grants);
    this.broker = new SqliteRequestAccountingBroker(o.db, { cfg: o.cfg, spend: o.spend, now: o.now, authorize: (id, keyRef) => this.endpointAuthority(id, keyRef) });
    this.webState = new WebBackendState(o.db, o.now);
    this.webUsage = new WebUsageReservations(o.db, { web: () => o.cfg.web, now: o.now,
      authorize: (backend, keyRef) => keyRef === null || keyRef === backend || keyRef.startsWith(`${backend}:`) });
    // The qualification project is never configured (`projects.require` would refuse it) and its
    // registry context always reads `projectDirectory: null` (it is not a user project); give the
    // runtime registry its installation-owned directory instead, since `openRegistered` requires one.
    this.registry = new ProjectRuntimeRegistry(o.db, {
      context: slug => slug === QUALIFICATION_PROJECT
        ? projectContext(o.projects.qualification, { projectDirectory: qualificationStoreDirectory(o.cfg) })
        : o.projects.require(slug),
      build: input => this.build(input),
      forbiddenProjectDirectories: this.sourceCheckout ? [this.sourceCheckout] : [],
    });
    this.scheduler = new ProjectScheduler(o.cfg, this.registry, this.bindings, { owner: o.owner, now: o.now });
    for (const row of this.registrations()) {
      const paths = projectRuntimePaths(row.directory);
      o.projects.bindRuntime(row.slug, { storageDir: paths.state, brainPath: paths.brain });
    }
  }

  /** Free-tier endpoints only: paid routes are not yet authorized for split projects. */
  private endpointAuthority(endpointId: string, keyRef: string | null): GlobalEndpointAuthority | null {
    const endpoint = this.o.catalog.get(endpointId);
    if (!endpoint || endpoint.origin === "paid") return null;
    const providerId = endpoint.route.provider, provider = this.o.providers.provider(providerId);
    const credential = keyRef ? this.o.providers.credentials().get(keyRef) : null;
    if (!provider || (keyRef && (!credential || credential.provider !== providerId || credential.billingClass !== "free_tier"))) return null;
    return { endpointId, keyRef, provider: providerId, platform: providerId, enabled: provider.enabled && (credential?.enabled ?? true),
      providerUsageScopes: credential ? limitScopes(provider, credential, { model: endpoint.route.model }).map(scope => scope.id) : [], paid: null };
  }

  private build(input: ProjectRuntimeConstruction): ProjectRuntimeBundle {
    const o = this.o, slug = input.identity.slug, id = input.identity.projectId;
    let labs: LabManager | null = null, web: WebAccess | null = null, bundle: ProjectRuntimeBundle | null = null;
    try {
      bundle = createProjectRuntimeServices(input, {
        coordinationDb: o.db, coordinationConfig: o.cfg, catalog: o.catalog, health: this.health, direct: { providers: o.providers, spend: o.spend },
        grants: this.grants, broker: this.broker, owner: o.owner, now: o.now,
        executionGrants: (local, request) => this.bindings.forProject(local.identity).refsForRequest(request.participants.map(p => p.lease)),
        privateServices: local => {
          const scope = (name: string) => { if (name !== slug) throw new TaskValidationError(`project ${name} is not served by the ${slug} runtime`); return local.cfg; };
          labs = new LabManager({ db: local.db, storageDir: local.cfg.storageDir, cfg: local.cfg, project: scope, monitor: o.labsMonitor,
            portAuthority: new ProjectLabPortReservations(o.db, local.db, local.identity, { assertCurrent: input.assertCurrent, assertPinned: input.assertPinned ?? input.assertCurrent }, o.now) });
          const port = this.bindings.bindLocal(local, { providerSlots: new ProviderSlotAdmission(local.cfg, local.router, this.health.capacity, o.now),
            repositoryDigests: task => writerDigests(local.cfg, task.spec.writableRepository) });
          const project = { identity: local.identity, assertRuntime: input.assertCurrent };
          web = new WebAccess({ cfg: o.cfg, db: local.db, providers: o.providers, project: { ...project, usage: this.webUsage, backendState: this.webState },
            ...(o.webFetch ? { fetch: o.webFetch } : {}), ...(o.webPage ? { page: o.webPage } : {}),
            event: (taskId, type, data) => local.tasks.event(taskId, type, data), now: o.now });
          const manager = labs;
          if (!web) throw new Error("Project web access is not constructed");
          return {
            coding: o.coding, supervisor: o.supervisor, services: null, onSettled: o.onSettled, taskLeases: port.taskLeases, web, labs: manager,
            // The project's own task Labs are drained in this process (`labs serve` supervises the installation's manager).
            ensureLabsSupervisor: () => manager.superviseTaskAttempts(),
            brain: new Brain(local.cfg, local.db, o.now, { project, reviewer: o.reviewer }),
            access: new BrainAccess(local.db, local.cfg, o.now, project),
            servicesForLease: lease => this.servicesForLease(bundle, local, manager, lease),
          };
        },
      });
      if (labs) this.labs.set(id, labs);
      if (web) this.webs.set(id, web);
      return bundle;
    } catch (error) {
      void (labs as LabManager | null)?.close({ stopServices: false }).catch(() => undefined);
      throw error;
    }
  }

  /** Supervisors get lease-bound graph services over their own store; other roles read only their own scope. */
  private servicesForLease(bundle: ProjectRuntimeBundle | null, local: Parameters<typeof createProjectWorkerReadServices>[0], labs: LabManager, lease: LeaseRef): SupervisorServices {
    if (!bundle) throw new Error("Project runtime is not constructed");
    const task = bundle.tasks.get(lease.taskId), slug = bundle.identity.slug, o = this.o;
    if (!task || bundle.cfg.profiles[task.spec.profile]?.mode !== "supervisor") return createProjectWorkerReadServices(local, lease);
    return createProjectRunServices(bundle, lease, {
      knownEndpoint: id => o.catalog.get(id) !== undefined,
      beforeSubmit: spec => {
        if (spec.supervisionScope === "project") throw new TaskValidationError("A child task cannot declare project supervision scope");
        if (!spec.constraints.labChecks?.length) return;
        const current = new ProjectRegistry(loadConfig(o.cfg.configPath)).get(slug);
        if (!current) throw new TaskValidationError("the task Lab project is no longer configured");
        const problems = taskLabSelectionIssues(current, spec);
        if (problems.length) throw new TaskValidationError(problems.join("; "), problems);
      },
      bindSubmitted: child => { labs.bindTask(slug, child.row.id, child.spec, bundle.tasks); },
      beforeAccept: current => {
        if (!current.spec.constraints.labChecks?.length) return;
        const evidence = current.result?.taskLab, problem = taskLabEvidenceProblem(current.spec, evidence, taskLabAuthority(labs, current.row.id, evidence));
        if (problem) throw new MeritRouterError("acceptance_refused", problem);
      },
      changed: ids => { for (const id of ids) o.onSettled(id); this.scheduler.kick(); },
    });
  }

  /** Registered (live) project stores. */
  private registrations(): Array<{ id: string; slug: string; directory: string }> {
    return z.array(z.object({ id: z.uuid(), slug: z.string(), directory: z.string() }).strict()).parse(this.o.db.prepare(
      "SELECT project_uuid id,slug,project_directory directory FROM project_store_registrations WHERE state='registered' ORDER BY slug").all());
  }

  /** Whether a project has a live project-local store. */
  registered(slug: string): boolean {
    return this.registrations().some(row => row.slug === slug);
  }

  /** The project's runtime; throws when it has no live store or the store cannot be opened. */
  bundle(slug: string): ProjectRuntimeBundle {
    if (!this.registered(slug)) throw new TaskValidationError(`project ${slug} has no project-local store; create it as a split project first`);
    return this.registry.forSlug(slug);
  }

  /**
   * The installation-owned qualification store's runtime, provisioning and registering it (once,
   * idempotently) on first use. Unlike `create`, this never needs a configured project or a
   * directory outside the installation: qualification is not a user project.
   */
  qualificationBundle(): ProjectRuntimeBundle {
    ensureQualificationStore(this.o.db, this.o.cfg, this.o.now());
    return this.bundle(QUALIFICATION_PROJECT);
  }

  /** Every registered project's runtime that opens (an unavailable store is skipped). */
  bundles(): ProjectRuntimeBundle[] {
    const out: ProjectRuntimeBundle[] = [];
    for (const row of this.registrations()) {
      try { out.push(this.registry.openRegistered(row.id)); } catch { /* reported by admin reads as unavailable */ }
    }
    return out;
  }

  /** The project's Lab manager (over its own store). */
  labsFor(bundle: ProjectRuntimeBundle): LabManager {
    const labs = this.labs.get(bundle.identity.projectId);
    if (!labs) throw new Error("Project Lab manager is not constructed");
    return labs;
  }

  /** The project's web access (its own request ledger over the shared coordination quota). */
  webFor(bundle: ProjectRuntimeBundle): WebAccess {
    const web = this.webs.get(bundle.identity.projectId);
    if (!web) throw new Error("Project web access is not constructed");
    return web;
  }

  /** The installation's web view in a split installation: the primary project's, else the first live one's. */
  primaryWeb(primary: string): WebAccess {
    const bundles = this.bundles(), bundle = bundles.find(b => b.project === primary) ?? bundles[0];
    if (!bundle) throw new MeritRouterError("web_unavailable", "web access belongs to project stores; create a split project first");
    return this.webFor(bundle);
  }

  /**
   * Provision and register a configured project's local store (`<directory>/.MeritRouter`) and open
   * its runtime. Idempotent for the same directory; refuses another directory or an unconfigured slug.
   */
  async create(input: { slug: string; directory: string; installationRoots: readonly string[] }): Promise<ProjectRuntimeBundle> {
    const ctx = this.o.projects.get(input.slug);
    if (!ctx) throw new TaskValidationError(`project ${input.slug} is not configured; add projects.${input.slug} with its directory first`);
    if (!ctx.projectDirectory || !samePath(ctx.projectDirectory, input.directory)) throw new TaskValidationError(`project ${input.slug} is configured with directory ${ctx.projectDirectory ?? "(none)"}, not ${input.directory}`);
    if (this.sourceCheckout && samePath(this.sourceCheckout, input.directory)) throw new TaskValidationError("the router source checkout cannot own a project runtime");
    const live = this.registrations().find(row => row.slug === input.slug);
    if (live && !samePath(live.directory, input.directory)) throw new TaskValidationError(`project ${input.slug} already has a store in ${live.directory}`);
    const out = await provisionProjectStore(this.o.db, { slug: input.slug, projectDirectory: input.directory, installationRoots: [...input.installationRoots], now: this.o.now() });
    this.o.projects.bindRuntime(input.slug, { storageDir: out.paths.state, brainPath: out.paths.brain });
    const bundle = this.registry.openRegistered(out.identity.projectId);
    this.scheduler.kick();
    return bundle;
  }

  /**
   * Stop dispatching a project, interrupt and drain its in-flight work, close its Labs and store,
   * then retire its registration. Files stay where they are; the caller removes them.
   */
  async retire(slug: string): Promise<SplitProjectRuntime> {
    const row = this.registrations().find(value => value.slug === slug);
    if (!row) throw new TaskValidationError(`project ${slug} has no project-local store`);
    const loaded = this.registry.loaded().find(bundle => bundle.identity.projectId === row.id);
    await this.registry.release(row.id, async () => {
      await this.scheduler.forget(row.id);
      if (loaded) {
        await loaded.drain();
        await this.bindings.forProject(loaded.identity).drain();
      }
      const labs = this.labs.get(row.id);
      this.labs.delete(row.id);
      this.webs.delete(row.id);
      await labs?.close();
    });
    const registration = readProjectStoreRegistration(this.o.db, row.id)!;
    const identity: ProjectStoreIdentity = { version: 1, role: "project", installationId: registration.installationId, projectId: registration.projectId,
      storeId: registration.storeId, generation: registration.generation, slug: registration.slug };
    retireProjectStoreRegistration(this.o.db, identity, this.o.now());
    this.o.projects.bindRuntime(slug, null);
    return { identity, paths: projectRuntimePaths(row.directory) };
  }

  start(intervalMs?: number): void {
    this.scheduler.start(intervalMs);
    if (this.recoveryTimer) return;
    // A worker process finishes what a stopped owner left durable: at start, then about once per task lease.
    this.recoveryTimer = setInterval(() => { void this.recoverSettlements().catch(() => undefined); }, Math.max(1000, this.o.cfg.execution.lease_seconds * 1000));
    this.recoveryTimer.unref?.();
    void this.recoverSettlements().catch(() => undefined);
  }

  /**
   * Settle every registered project's requests that a stopped owner left with durable evidence (a saved local
   * outcome, or a settled global receipt not yet projected), then free split slots whose receipts are terminal.
   * Single-flight; never reserves, dispatches or touches execution grants. Returns the settled request IDs.
   */
  recoverSettlements(): Promise<string[]> {
    if (this.recovering) return this.recovering;
    const run = (async () => {
      const settled: string[] = [];
      for (const bundle of this.bundles()) {
        settled.push(...await recoverProjectSettlements({ db: bundle.db, identity: bundle.identity, ledger: bundle.ledger, broker: this.broker, now: () => bundle.admission.serverNow() }));
      }
      this.health.capacity.releaseSettled();
      return settled;
    })().finally(() => { this.recovering = null; });
    this.recovering = run;
    return run;
  }
  kick(): void { this.scheduler.kick(); }
  get busy(): number { return this.scheduler.busy; }
  reloadConfig(): void { for (const labs of this.labs.values()) labs.reloadConfig(); }

  async close(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.scheduler.stop();
    await this.recovering?.catch(() => undefined);
    await Promise.allSettled(this.registry.loaded().map(async bundle => {
      await bundle.drain();
      await this.bindings.forProject(bundle.identity).drain();
    }));
    await Promise.allSettled([...this.labs.values()].map(labs => labs.close()));
    this.labs.clear();
    this.webs.clear();
    await this.registry.close();
  }
}

/** The stores one task lives in: the installation's (legacy layout) or a split project's. */
export type TaskStores = Pick<ProjectRuntimeBundle, "db" | "tasks" | "artifacts" | "contracts" | "admission"> & { sessions: SessionStore; bundle: ProjectRuntimeBundle | null };

/** Resolves which store holds a project's, task's or session's rows, so service methods never guess. */
export class ProjectStoreRouter {
  constructor(private readonly host: ProjectRuntimeHost | null, readonly local: TaskStores, private readonly projects: ProjectRegistry) {}

  /** The split runtime that owns a project's private data, or null (legacy installation). */
  runtimeOf(project: string): ProjectRuntimeBundle | null {
    if (!this.host) return null;
    if (project === QUALIFICATION_PROJECT) return this.host.qualificationBundle();
    return this.host.bundle(project || this.projects.primary.project.slug);
  }

  /** A project's stores (the installation's in a legacy installation). */
  of(project: string): TaskStores {
    const b = this.runtimeOf(project);
    return b ? { db: b.db, tasks: b.tasks, sessions: b.sessions!, artifacts: b.artifacts, contracts: b.contracts, admission: b.admission, bundle: b } : this.local;
  }

  /** Every store that can hold project rows (each live split project's, or the installation's). */
  all(): TaskStores[] {
    return this.host ? this.host.bundles().map(b => this.of(b.project)) : [this.local];
  }

  /** The stores holding a task: the named project's, else the one store that has it (ambiguous ids need a project). */
  ofTask(id: string, project?: string): TaskStores {
    if (project) return this.of(project);
    if (!this.host) return this.local;
    const found = this.all().filter(s => s.tasks.projectOf(id) !== null);
    if (found.length > 1) throw new TaskValidationError(`task ${id} exists in several projects (${found.map(s => s.bundle!.project).join(", ")}); name the project`);
    return found[0] ?? this.local;
  }

  /** Tasks grouped by the store holding them (one group in a legacy installation). */
  groupTasks(ids: readonly string[], project?: string): Map<TaskStores, string[]> {
    const groups = new Map<TaskStores, string[]>();
    for (const id of ids) { const s = this.ofTask(id, project); groups.set(s, [...(groups.get(s) ?? []), id]); }
    return groups;
  }

  /** The stores holding an open supervisor question (question ids are per store). */
  ofQuestion(id: number, project?: string): TaskStores {
    const stores = project ? [this.of(project)] : this.all();
    const open = stores.filter(s => s.db.prepare("SELECT 1 FROM job_questions WHERE id = ? AND answer IS NULL").get(id));
    if (open.length > 1) throw new TaskValidationError(`question ${id} exists in several projects; name the project`);
    return open[0] ?? stores[0] ?? this.local;
  }

  /** The stores holding a session. */
  ofSession(sessionId: string, project?: string): TaskStores {
    const stores = (project ? [this.of(project)] : this.all()).filter(s => s.sessions.get(sessionId));
    if (stores.length > 1) throw new TaskValidationError(`session ${sessionId} exists in several projects; name the project`);
    return stores[0] ?? this.local;
  }

  /** Refuse a legacy write for a project whose data moved to its own store (A3 migration). */
  fence(slug: string): void {
    if (this.host || readStoreIdentity(this.local.db)?.role !== "coordination") return;
    const fence = legacyProjectFence(this.local.db, slug);
    if (fence.fenced) throw new MeritRouterError("project_migrated", `project ${slug} moved to its own store (${fence.state}); its installation rows are read-only history`);
  }
}
