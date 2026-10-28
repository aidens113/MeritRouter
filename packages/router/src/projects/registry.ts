import type { ResolvedConfig } from "../config/load.js";
import { MeritRouterError, TaskValidationError } from "../core/errors.js";
import type { Db } from "../storage/db.js";
import { QUALIFICATION_PROJECT, qualificationOverlay, syncRepositoryRegistry } from "../qualification/registry.js";
import { backfillProjects } from "./backfill.js";
import { projectContext, type ProjectContext, type ProjectInfo } from "./context.js";
import type { ResolvedProject } from "./resolve.js";

/** A project's lifecycle row (settings live in the config). */
export interface ProjectRow {
  id: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
  lastActiveAt: number | null;
}

/**
 * The projects of one install, read from the global config (`projects.<slug>`, or the
 * single-project shape). Holds one `ProjectContext` per project; contexts keep their identity
 * across config reloads (`refresh`), so components may cache them.
 */
export class ProjectRegistry {
  private readonly entries = new Map<string, { ctx: ProjectContext; overlay: Record<string, unknown> }>();
  /** The reserved qualification project (not listed among the projects; see `QUALIFICATION_PROJECT`). */
  private internal: { ctx: ProjectContext; overlay: Record<string, unknown> } | null = null;
  private db: Db | null = null;
  private now: () => number = Date.now;
  /** Project-local runtime roots of split projects (storage directory, brain), kept across reloads. */
  private readonly runtime = new Map<string, { storageDir: string; brainPath: string }>();

  constructor(private readonly cfg: ResolvedConfig) {
    this.refresh();
  }

  /** Rebuild every context from the (possibly reloaded) global config, in place. */
  refresh(): void {
    const seen = new Set<string>();
    for (const p of this.cfg.projectResolution.projects) {
      seen.add(p.slug);
      const next = overlayFor(p, this.cfg, this.runtime.get(p.slug));
      const existing = this.entries.get(p.slug);
      if (existing) {
        for (const k of Object.keys(existing.overlay)) delete existing.overlay[k];
        Object.assign(existing.overlay, next);
      } else {
        this.entries.set(p.slug, { ctx: projectContext(this.cfg, next), overlay: next });
      }
    }
    for (const slug of [...this.entries.keys()]) if (!seen.has(slug)) this.entries.delete(slug);
    const internal = qualificationOverlay(this.cfg);
    internal.projectDirectory = null;
    if (this.internal) {
      // Keep the runtime-registered fixtures; take the rest (the brain section) from the reloaded config.
      internal.repositoryPaths = this.internal.overlay.repositoryPaths;
      for (const k of Object.keys(this.internal.overlay)) delete this.internal.overlay[k];
      Object.assign(this.internal.overlay, internal);
    } else {
      this.internal = { ctx: projectContext(this.cfg, internal), overlay: internal };
    }
    if (this.db) {
      this.syncRuntimeRepositories();
      this.recordRows();
    }
  }

  /**
   * Bind to the store: record each configured project, give unassigned rows to the primary
   * project (see `backfillProjects`), and merge runtime-registered repositories.
   */
  attach(db: Db, now: () => number = Date.now, opts: { backfill?: boolean } = {}): void {
    this.db = db;
    this.now = now;
    this.recordRows();
    // A split installation's coordination store holds no project rows to assign.
    if (opts.backfill !== false) backfillProjects(db, this.primary.project.slug);
    this.syncRuntimeRepositories();
  }

  /**
   * Point a split project's context at its project-local runtime (`storageDir`, brain path), or
   * back at the installation (null). Kept across `refresh`; the project need not be configured yet.
   */
  bindRuntime(slug: string, roots: { storageDir: string; brainPath: string } | null): void {
    if (roots) this.runtime.set(slug, { ...roots });
    else this.runtime.delete(slug);
    this.refresh();
  }

  private recordRows(): void {
    const up = this.db!.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name");
    for (const c of this.list()) up.run(c.project.slug, c.project.name, this.now());
  }

  /**
   * Repositories registered at runtime (qualification and comparison fixtures) belong to the
   * qualification project only: user projects, and the global config, never list them.
   */
  syncRuntimeRepositories(): void {
    if (!this.db) return;
    syncRepositoryRegistry(this.db, this.qualification);
  }

  /**
   * The reserved project qualification runs and eval-goal comparisons work in. It is not one of
   * the projects (`list`, `slugs`, `get`, `require`, and `forWrite` never return it); tasks reach it
   * through their stored project (`context`).
   */
  get qualification(): ProjectContext {
    return this.internal!.ctx;
  }

  /** A stored project id's context: a configured project, or the qualification project. */
  context(slug: string): ProjectContext | undefined {
    return slug === QUALIFICATION_PROJECT ? this.qualification : this.get(slug);
  }

  list(): ProjectContext[] {
    return [...this.entries.values()].map((e) => e.ctx);
  }

  slugs(): string[] {
    return [...this.entries.keys()];
  }

  get(slug: string): ProjectContext | undefined {
    return this.entries.get(slug)?.ctx;
  }

  require(slug: string): ProjectContext {
    const c = this.get(slug);
    if (!c) throw new TaskValidationError(`unknown project ${slug}; configured: ${this.slugs().join(", ") || "none"}`);
    return c;
  }

  /**
   * The project for rows from before projects existed and for system tasks (qualification,
   * comparisons). Throws when the install has no project yet (a fresh split installation); a
   * caller reachable before the first project exists must check `list().length` (or
   * `slugs().length`) first and degrade instead of relying on this getter.
   */
  get primary(): ProjectContext {
    const p = this.get(this.cfg.projectResolution.primary) ?? this.list()[0];
    if (!p) throw new MeritRouterError("no_project", "this installation has no project yet: create a project first");
    return p;
  }

  /** The project a write goes to: the named one, or the only one; with several, a project must be named. */
  forWrite(slug?: string | null): ProjectContext {
    if (slug) return this.require(slug);
    const all = this.list();
    if (all.length === 1) return all[0]!;
    throw new TaskValidationError(`this install has ${all.length} projects (${this.slugs().join(", ")}); name the project`);
  }

  /** Lifecycle rows of every project known to the store (configured or not). */
  rows(): ProjectRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare("SELECT id, name, created_at, archived_at, last_active_at FROM projects ORDER BY created_at, id").all() as Array<{ id: string; name: string; created_at: number; archived_at: number | null; last_active_at: number | null }>;
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, archivedAt: r.archived_at, lastActiveAt: r.last_active_at }));
  }

  /** Stamp a project's last activity (a submission). */
  touch(slug: string): void {
    this.db?.prepare("UPDATE projects SET last_active_at = ? WHERE id = ?").run(this.now(), slug);
  }
}

/** The keys of a project's context that differ from the global config. */
function overlayFor(p: ResolvedProject, cfg: ResolvedConfig, runtime?: { storageDir: string; brainPath: string }): Record<string, unknown> {
  const project: ProjectInfo = { slug: p.slug, name: p.name, legacy: p.legacy };
  // A split project's private state lives under its own directory, never the installation's.
  const local = runtime ? { storageDir: runtime.storageDir, brain: { ...((p.overrides.brain as ResolvedConfig["brain"] | undefined) ?? cfg.brain), path: runtime.brainPath, project: p.slug } } : {};
  // A single-project config is its own project: nothing differs, so the context reads the global
  // config throughout (runtime-registered repositories included).
  if (p.legacy) return { project, projectDirectory: p.directory, ...local };
  return { project, projectDirectory: p.directory, repositories: p.repositories, repositoryPaths: { ...p.repositoryPaths }, ...p.overrides, ...local };
}
