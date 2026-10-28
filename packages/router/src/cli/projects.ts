import path from "node:path";
import YAML from "yaml";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { loadConfig } from "../config/load.js";
import { MeritRouterError } from "../core/errors.js";
import type { MeritRouter } from "../core/service.js";
import { archiveProject, createProject, deleteProject, previewProjectDeletion, projectsGrid, selectableProjects, unarchiveProject } from "../admin/insights.js";
import { backupProjectStore, readProjectBackupManifest, restoreProjectStore } from "../operations/project-backup.js";
import { migrateLegacyProject, planProjectMigration, ProjectMigrationRefusedError, rollbackProjectMigration } from "../projects/store-migration.js";
import { openDatabase, type Db } from "../storage/db.js";
import { repoFlags } from "./args.js";
import { chooseProject, type SelectOptions } from "./project-select.js";
import { out, stamp, table } from "./terminal.js";

// `meritrouter projects list|create|archive|unarchive`, and the config `init` writes (a global
// config plus a first project in the `projects` shape).

export interface ProjectsFlags {
  all?: boolean;
  name?: string;
  repo?: string[];
  /** `projects delete <slug> --confirm <slug>`: the slug again, to confirm. */
  confirm?: string;
  /** `projects create <slug> --directory <path>`: the positional form keeps working too. */
  directory?: string;
  /** `projects restore <slug> <source> --force`. */
  force?: boolean;
  /** `projects migrate <slug> --from-config <legacy-config>`: the legacy installation's config. */
  "from-config"?: string;
  /** `projects migrate <slug> --dry-run`: plan only, write nothing. */
  "dry-run"?: boolean;
  /** `projects migrate <slug> --rollback`: undo its most recent migration. */
  rollback?: boolean;
}

const USAGE = 'usage: meritrouter projects [list [--all]] | create <slug> [<directory>] [--directory <path>] [--name "<name>"] [--repo <alias>=<path> ...] | archive <slug> | unarchive <slug> | delete <slug> [--confirm <slug>] | backup <slug> <target> | restore <slug> <source> [--force] | migrate <slug> --from-config <legacy-config> [--dry-run] [--rollback]';

/** The coordination store's most recently journaled migration for a slug (CLI convenience: the library keys recovery by migrationId, not slug). */
function latestMigrationId(db: Db, slug: string): string | null {
  const row = db.prepare(`SELECT m.migration_uuid AS id FROM project_store_migrations m
    JOIN project_store_registrations r ON r.project_uuid = m.project_uuid
    WHERE r.slug = ? ORDER BY m.created_at DESC LIMIT 1`).get(slug) as { id: string } | undefined;
  return row?.id ?? null;
}

export async function projectsCommand(sy: MeritRouter, args: string[], values: ProjectsFlags, json: boolean, select: SelectOptions): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const current = (() => {
      try {
        return chooseProject(selectableProjects(sy), select)?.slug ?? null;
      } catch {
        return null;
      }
    })();
    const cards = projectsGrid(sy, { includeArchived: values.all ?? false });
    const rows = cards.map((p) => ({
      "": p.slug === current ? "*" : "",
      project: p.slug,
      name: p.name,
      repositories: p.repositories.map((r) => `${r.alias}${r.exists ? "" : " (missing)"}`).join(", "),
      jobs: `${p.runningJobs} running, ${p.queuedJobs} queued`,
      tasks: `${p.runningTasks} running, ${p.queuedTasks} queued`,
      "last activity": p.lastActivityAt ? stamp(p.lastActivityAt) : "",
      attention: p.attention || "",
      ...(values.all ? { archived: p.archived ? "yes" : "" } : {}),
    }));
    out(json ? cards : table(rows), json);
    return 0;
  }
  if (sub === "create") {
    const slug = args[1];
    // The project's folder: required in a split installation (its private store goes in
    // <directory>/.MeritRouter); absolute, or relative to the config file's folder. The
    // positional form and --directory both work; not both at once.
    const positionalDirectory = args[2];
    if (positionalDirectory !== undefined && values.directory !== undefined) {
      throw new MeritRouterError("usage", "pass the project's directory as the positional argument or --directory, not both");
    }
    const directory = values.directory ?? positionalDirectory;
    if (!slug || args.length > 3) throw new MeritRouterError("usage", USAGE);
    const r = await createProject(sy, { slug, ...(values.name ? { name: values.name } : {}), ...(directory !== undefined ? { directory } : {}), repositories: repoFlags(values.repo) });
    if (!r.ok) throw new MeritRouterError("usage", `project ${slug} was not created:\n  ${r.errors.join("\n  ")}`);
    out(
      json
        ? r
        : [
            `created project ${r.project.slug} (${r.project.repositories.length} repositor${r.project.repositories.length === 1 ? "y" : "ies"}) in ${sy.cfg.configPath}`,
            ...r.prepared,
            ...(r.runtimeRoot ? [`its private store is ${r.runtimeRoot}`] : []),
            ...(r.convertedLegacy ? [`the single-project config was converted: its repositories moved under projects.${r.convertedLegacy}`] : []),
            `work in it with --project ${r.project.slug}, or from inside one of its repositories`,
          ].join("\n"),
      json,
    );
    return 0;
  }
  if (sub === "archive" || sub === "unarchive") {
    const slug = args[1];
    if (!slug) throw new MeritRouterError("usage", USAGE);
    const p = sub === "archive" ? archiveProject(sy, slug) : unarchiveProject(sy, slug);
    out(json ? p : `${p.slug}: ${p.archived ? "archived (hidden; its settings, tasks, sessions, and brain are kept)" : "active"}`, json);
    return 0;
  }
  if (sub === "delete") {
    const slug = args[1];
    if (!slug) throw new MeritRouterError("usage", USAGE);
    if (values.confirm === undefined) {
      // Without --confirm: what deleting would remove and keep, and how to confirm.
      const p = await previewProjectDeletion(sy, slug);
      out(
        json
          ? p
          : [
              `Deleting project ${p.slug} (${p.name}) removes:`,
              ...p.removes.map((l) => `  - ${l}`),
              "It keeps:",
              ...p.keeps.map((l) => `  - ${l}`),
              p.blockers.length ? `It cannot be deleted now: ${p.blockers.join("; ")}.` : `This cannot be undone. To delete it: meritrouter projects delete ${p.slug} --confirm ${p.slug}`,
            ].join("\n"),
        json,
      );
      return p.blockers.length ? 1 : 0;
    }
    const r = await deleteProject(sy, slug, { confirm: values.confirm });
    const c = r.removed;
    out(
      json
        ? r
        : [
            `deleted project ${r.slug}: ${c.tasks} task(s), ${c.sessions} session(s), ${c.artifacts} artifact(s), ${c.worktrees} worktree(s), and its brain folder (${c.brainEntries} file(s))${r.brainCommit ? ` in brain commit ${r.brainCommit.slice(0, 7)}` : ""}; repository folders and branches were not touched`,
            ...(r.runtimeRoot ? [`removed its store ${r.runtimeRoot}; nothing else in its folder was touched`] : []),
            ...(r.newPrimary ? [`${r.newPrimary} is now the primary project (brain.project)`] : []),
            ...r.problems.map((p) => `warning: ${p}`),
          ].join("\n"),
      json,
    );
    return 0;
  }
  if (sub === "backup") {
    const slug = args[1], target = args[2];
    if (!slug || !target || args.length > 3) throw new MeritRouterError("usage", USAGE);
    const manifest = await backupProjectStore(sy.db, { slug, targetDir: path.resolve(target) });
    out(
      json
        ? manifest
        : `backed up project ${slug} to ${path.resolve(target)}: ${manifest.tasks} task(s), ${manifest.sessions} session(s), ${manifest.artifacts} artifact(s)${manifest.brain ? ", with its brain" : ""}`,
      json,
    );
    return 0;
  }
  if (sub === "restore") {
    const slug = args[1], source = args[2];
    if (!slug || !source || args.length > 3) throw new MeritRouterError("usage", USAGE);
    const manifest = readProjectBackupManifest(path.resolve(source));
    if (manifest.identity.slug !== slug) throw new MeritRouterError("usage", `${source} is a backup of project ${manifest.identity.slug}, not ${slug}`);
    const r = restoreProjectStore(sy.db, { backupDir: path.resolve(source), force: values.force ?? false });
    out(
      json
        ? r
        : [
            `restored project ${slug} from ${path.resolve(source)} into ${r.projectDirectory}`,
            ...(r.previousMovedTo ? [`its previous state was moved aside to ${r.previousMovedTo} (not removed)`] : []),
            ...(r.leasesReleased ? [`released ${r.leasesReleased} stale task lease(s) carried over from the backup`] : []),
          ].join("\n"),
      json,
    );
    return 0;
  }
  if (sub === "migrate") {
    const slug = args[1];
    if (!slug || args.length > 2) throw new MeritRouterError("usage", USAGE);
    const fromConfig = values["from-config"];
    if (!fromConfig) throw new MeritRouterError("usage", "projects migrate requires --from-config <legacy-config>");
    const legacyCfg = loadConfig(path.resolve(fromConfig));
    const legacyDb = openDatabase(legacyCfg.storageDir);
    try {
      if (values.rollback) {
        const migrationId = latestMigrationId(sy.db, slug);
        if (!migrationId) throw new MeritRouterError("not_found", `no migration is recorded for project ${slug}`);
        const r = await rollbackProjectMigration(sy.db, legacyDb, { migrationId, legacyStorageDir: legacyCfg.storageDir });
        out(
          json
            ? r
            : `migration ${r.migrationId} of ${r.slug} rolled back from ${r.previousState}; its store ${r.targetRemoved ? "was removed" : "could not be removed (see the error for what to do)"}`
              + (r.legacyIntact === null ? "" : r.legacyIntact ? "; the legacy project is unchanged" : "; warning: the legacy project no longer matches the migration's checkpoint"),
          json,
        );
        return 0;
      }
      const ctx = sy.projects.get(slug);
      const projectDirectory = ctx?.projectDirectory;
      if (!projectDirectory) {
        throw new MeritRouterError(
          "usage",
          `project ${slug} has no configured directory; add projects.${slug}.directory to ${sy.cfg.configPath} (its store is created there as <directory>/.MeritRouter), then retry`,
        );
      }
      const installationRoots = [path.dirname(sy.cfg.configPath), sy.cfg.storageDir];
      const planInput = { slug, projectDirectory, installationRoots, legacyStorageDir: legacyCfg.storageDir };
      const describeBlockers = (blockers: Array<{ code: string; message: string; remedy: string; sample: string[] }>) =>
        blockers.map((b) => `  - [${b.code}] ${b.message}${b.sample.length ? ` (${b.sample.join(", ")})` : ""}. ${b.remedy}`);
      if (values["dry-run"]) {
        const plan = planProjectMigration(sy.db, legacyDb, planInput);
        out(
          json
            ? plan
            : [plan.ready ? `project ${slug} is ready to migrate from ${legacyCfg.storageDir}` : `project ${slug} cannot migrate yet:`, ...describeBlockers(plan.blockers)].join("\n"),
          json,
        );
        return plan.ready ? 0 : 1;
      }
      const backupDir = path.join(sy.cfg.storageDir, "migration-backups", `${slug}-${Date.now()}`);
      try {
        const result = await migrateLegacyProject(sy.db, legacyDb, { ...planInput, backupDir });
        out(
          json ? result : `migrated project ${slug} into ${result.paths.root} (migration ${result.migrationId}); its legacy backup is at ${result.backupFile}`,
          json,
        );
        return 0;
      } catch (error) {
        if (error instanceof ProjectMigrationRefusedError) {
          out(json ? { ok: false, blockers: error.blockers } : [`project ${slug} was not migrated:`, ...describeBlockers(error.blockers)].join("\n"), json);
          return 1;
        }
        throw error;
      }
    } finally {
      legacyDb.close();
    }
  }
  throw new MeritRouterError("usage", USAGE);
}

/**
 * The config `init` writes: the preset with its first project named `slug` (and `brain.project`,
 * the primary project, set to it). A preset in the single-project shape has its top-level
 * repositories moved under `projects.<slug>`. `repositories` replaces the preset's placeholder.
 */
export function initConfigText(presetText: string, opts: { slug: string; name?: string; repositories?: Record<string, { path: string }> }): string {
  if (!PROJECT_SLUG_RE.test(opts.slug)) throw new MeritRouterError("usage", `--project ${JSON.stringify(opts.slug)}: lower-case letters, digits, '.', '_', '-', starting with a letter or digit`);
  const doc = YAML.parseDocument(presetText);
  const projects = doc.get("projects");
  if (YAML.isMap(projects) && projects.items.length) {
    const first = projects.items[0]!;
    if (YAML.isScalar(first.key)) first.key.value = opts.slug;
    else first.key = doc.createNode(opts.slug);
  } else {
    const repos = (doc.get("repositories") as YAML.Node | undefined)?.toJSON?.() ?? {};
    doc.delete("repositories");
    doc.setIn(["projects", opts.slug], doc.createNode({ repositories: repos }));
  }
  // Without --name the display name is the slug, never the preset's placeholder.
  doc.setIn(["projects", opts.slug, "name"], opts.name ?? opts.slug);
  if (opts.repositories && Object.keys(opts.repositories).length) doc.setIn(["projects", opts.slug, "repositories"], doc.createNode(opts.repositories));
  doc.setIn(["brain", "project"], opts.slug);
  return doc.toString();
}
