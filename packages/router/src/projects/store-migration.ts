import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { TERMINAL_STATES } from "../core/task.js";
import { databasePath, immediate, openDatabase, SCHEMA_VERSION, type Db } from "../storage/db.js";
import { assertStoreRole } from "../storage/store-role.js";
import { isProjectMetadataPath } from "./metadata-policy.js";
import { projectRuntimePaths, type ProjectRuntimePaths } from "./runtime-paths.js";
import {
  differingExportFiles, differingExportTables, exportProjectRows, fileDigests, fileSha256, inspectProjectFiles, missingExportTables,
  projectExportClosureViolations, projectExportManifest, projectExportManifestSha256, PROJECT_EXPORT_TABLES, unclassifiedExportTables,
  type ProjectExportManifest, type ProjectFileEntry, type ProjectFileProblem,
} from "./store-export.js";
import { prepareProjectStore, type ProjectStoreProvisionOptions } from "./store-provision.js";
import {
  assertCriticalStoreDurability, createProjectStoreIdentity, ProjectStoreIdentitySchema, ProjectStoreMigrationSchema,
  ProjectStoreRegistrationSchema, readProjectStoreMigration, readProjectStoreRegistration, readStoreIdentity,
  type ProjectStoreIdentity, type ProjectStoreMigration, type ProjectStoreRegistration,
} from "./store-identity.js";

/*
 * Minimal migration of ONE quiescent project from a legacy multi-project store into its own
 * split project store (generation 1 -> 2), with rollback before the first dispatch.
 *
 * Journal (coordination DB) and registration move together:
 *   prepared/migrating -> copying/migrating -> verified/migrating -> committed/registered
 *   any pre-commit failure -> recovery_required/migrating (never registered)
 *   rollback -> rolled_back/retired, then the target <project>/.MeritRouter is removed
 * Legacy rows and files are never written: they stay as history, fenced by the live
 * registration (see legacyProjectFence). Session logs and artifact files the project's rows
 * point at are copied into <project>/.MeritRouter/{sessions,artifacts} and digested with the
 * rows. Brain content (one shared, non-project repository in the legacy layout), broker
 * import, worktree relocation, approval re-issue and legacy purge are out of scope.
 */

const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"), "Expected an absolute path");
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PlanInputSchema = z.object({
  slug: z.string().min(1).max(128).refine(value => PROJECT_SLUG_RE.test(value), "Expected a project slug"),
  projectDirectory: absolute,
  installationRoots: z.array(absolute).min(1).max(64),
  /** The legacy storage folder: it holds the legacy database, `sessions/` and `artifacts/`. */
  legacyStorageDir: absolute,
}).strict();
const MigrateInputSchema = PlanInputSchema.extend({ backupDir: absolute, now: timestamp.optional() }).strict();
const RollbackInputSchema = z.object({ migrationId: z.uuid(), legacyStorageDir: absolute.optional(), now: timestamp.optional() }).strict();
export type PlanProjectMigrationInput = z.input<typeof PlanInputSchema>;
export type MigrateLegacyProjectInput = z.input<typeof MigrateInputSchema>;
export type RollbackProjectMigrationInput = z.input<typeof RollbackInputSchema>;

export interface MigrationBlocker { code: string; message: string; remedy: string; sample: string[] }
export interface ProjectMigrationPlan {
  slug: string; projectDirectory: string; ready: boolean; blockers: MigrationBlocker[];
  source: { storeId: string; generation: 1; schema: number; bound: "coordination" | null };
  manifest: ProjectExportManifest | null; checkpointSha256: string | null;
  /** Payload files to copy, with their legacy locations. */
  files: ProjectFileEntry[];
}
export class ProjectMigrationRefusedError extends Error {
  constructor(readonly slug: string, readonly blockers: MigrationBlocker[]) {
    super(`Project migration refused for "${slug}":\n${blockers.map(b => `- [${b.code}] ${b.message}${b.sample.length ? ` (${b.sample.join(", ")})` : ""}. ${b.remedy}`).join("\n")}`);
    this.name = "ProjectMigrationRefusedError";
  }
}

export type ProjectMigrationPhase = "planned" | "backup" | "prepared" | "store" | "copying" | "exported" | "files" | "verified" | "committed";
export interface ProjectMigrationOptions {
  /** Test seam for crash injection: a throwing hook simulates a crash right after that phase. */
  afterPhase?: (phase: ProjectMigrationPhase) => void | Promise<void>;
  /** Test seam inside the target copy transaction. */
  afterExportTable?: (table: string) => void;
  /** Passed to prepareProjectStore. */
  provision?: ProjectStoreProvisionOptions;
}
export interface ProjectMigrationResult {
  migrationId: string; identity: ProjectStoreIdentity; registration: ProjectStoreRegistration; journal: ProjectStoreMigration;
  paths: ProjectRuntimePaths; backupFile: string; manifestFile: string; backupSha256: string;
  checkpointSha256: string; manifest: ProjectExportManifest;
}
export interface ProjectMigrationRollback {
  migrationId: string; projectId: string; slug: string; previousState: ProjectStoreMigration["state"];
  targetRemoved: boolean; legacyIntact: boolean | null;
}
export interface ProjectMigrationRecoveryEntry {
  migrationId: string | null; projectId: string; slug: string; projectDirectory: string;
  journalState: ProjectStoreMigration["state"] | null; registrationState: ProjectStoreRegistration["state"];
  dispatchable: false; access: "read-only-recovery" | "cleanup"; action: string;
}

const PENDING_STATES = ["prepared", "copying", "verified", "recovery_required"] as const;
const LEGACY_GENERATION = 1;
const TARGET_GENERATION = 2;

const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string) => comparable(a) === comparable(b);
function within(child: string, parent: string): boolean {
  const c = comparable(child), p = comparable(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
const canonical = (value: unknown) => JSON.stringify(value);
const blocker = (code: string, message: string, remedy: string, sample: string[] = []): MigrationBlocker => ({ code, message, remedy, sample });

function coordinationOwner(db: Db) {
  const identity = readStoreIdentity(db);
  if (!identity || identity.role !== "coordination") throw new Error("Project migration requires a bound coordination store");
  assertCriticalStoreDurability(db);
  return identity;
}

// ---------------------------------------------------------------------------------------------
// Quiescence and ownership checks (legacy side). Each returns sample references, at most 10.

const T = "SELECT id FROM tasks WHERE project_id=@slug";
const E = PROJECT_EXPORT_TABLES.executions!;
const TERMINAL = [...TERMINAL_STATES].map(state => `'${state}'`).join(",");
interface SqlCheck { code: string; sql: string; message: string; remedy: string }
const SQL_CHECKS: SqlCheck[] = [
  { code: "tasks_not_terminal", sql: `SELECT id||' ('||state||')' ref FROM tasks WHERE project_id=@slug AND state NOT IN (${TERMINAL})`,
    message: "tasks are not terminal", remedy: "Let these tasks finish or cancel them, then retry." },
  { code: "task_leases_live", sql: `SELECT id ref FROM tasks WHERE project_id=@slug AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)`,
    message: "tasks still carry a worker lease", remedy: "Stop the worker holding the lease and let the task settle, then retry." },
  { code: "labs_present", sql: `SELECT 'lab '||id||' ('||name||', '||state||')' ref FROM labs WHERE project_id=@slug
      UNION ALL SELECT 'lab operation '||id FROM lab_operations WHERE project_id=@slug
      UNION ALL SELECT 'lab command '||id FROM lab_command_owners WHERE project_id=@slug
      UNION ALL SELECT 'lab capacity '||reservation_id FROM lab_capacity_owners WHERE project_id=@slug
      UNION ALL SELECT 'lab team '||lab_id FROM lab_teams WHERE root_job_id IN (${T})
      UNION ALL SELECT 'lab process '||id FROM lab_attempt_processes WHERE attempt_id IN (SELECT id FROM task_workspace_attempts WHERE project_id=@slug)`,
    message: "Labs, Lab operations or Lab processes exist", remedy: "Stop, destroy and purge the project's Labs so no Lab row or process remains, then retry." },
  { code: "worktrees_retained", sql: `SELECT task_id||' at '||worktree_path ref FROM workspaces WHERE task_id IN (${T}) AND status!='removed'`,
    message: "task worktrees are still retained", remedy: "Accept, reject or discard these tasks so their worktrees are removed, then retry." },
  { code: "workspace_attempts_open", sql: `SELECT a.id||' ('||COALESCE(l.phase,'?')||')' ref FROM task_workspace_attempts a JOIN lab_task_attempts l ON l.attempt_id=a.id
      WHERE a.project_id=@slug AND l.phase!='pruned'
      UNION ALL SELECT 'operation '||o.id FROM task_lab_operations o WHERE o.attempt_id IN (SELECT id FROM task_workspace_attempts WHERE project_id=@slug) AND o.state IN ('pending','running')`,
    message: "task workspace attempts are not pruned", remedy: "Let attempt checks finish and prune the attempts, then retry." },
  { code: "merge_pending", sql: `SELECT id||' ('||state||')' ref FROM merge_queue WHERE (task_id IN (${T}) OR job_id IN (${T})) AND state IN ('queued','integrating','picked')`,
    message: "integrations are pending in the merge queue", remedy: "Let the merge queue settle these entries, then retry." },
  { code: "file_leases_held", sql: `SELECT CAST(id AS TEXT)||' ('||task_id||')' ref FROM file_leases WHERE task_id IN (${T}) AND released_at IS NULL`,
    message: "file leases are still held", remedy: "Release the file leases (finish or cancel their jobs), then retry." },
  { code: "job_questions_open", sql: `SELECT CAST(id AS TEXT)||' ('||task_id||')' ref FROM job_questions WHERE task_id IN (${T}) AND answered_at IS NULL`,
    message: "job questions are unanswered", remedy: "Answer or dismiss these questions, then retry." },
  { code: "budget_requests_pending", sql: `SELECT CAST(id AS TEXT)||' ('||task_id||')' ref FROM budget_requests WHERE project_id=@slug AND status='pending'`,
    message: "budget requests are pending", remedy: "Approve or deny the budget requests, then retry." },
  { code: "brain_access_pending", sql: `SELECT CAST(id AS TEXT) ref FROM brain_access_requests WHERE project_id=@slug AND status='pending'`,
    message: "brain access requests are pending", remedy: "Approve or deny the brain access requests, then retry." },
  { code: "sessions_running", sql: `SELECT id ref FROM sessions WHERE project_id=@slug AND status='running'`,
    message: "sessions are still running (their logs may still grow)", remedy: "Restart the service so orphaned sessions are marked interrupted, or let them end, then retry." },
  { code: "requests_unresolved", sql: `SELECT 'model request '||id ref FROM model_requests WHERE project_id=@slug AND status='reserved'
      UNION ALL SELECT 'execution '||id FROM executions WHERE (${E}) AND status='running'
      UNION ALL SELECT 'protocol '||request_id||' ('||phase||')' FROM project_request_protocol WHERE project_id=@slug AND phase NOT IN ('settled','retired','quarantined')
      UNION ALL SELECT 'legacy protocol '||request_id||' ('||state||')' FROM request_protocol WHERE request_id IN (SELECT request_id FROM request_protocol_projects WHERE project_id=@slug) AND state IN ('reserved','dispatch_intent')
      UNION ALL SELECT 'web usage '||CAST(id AS TEXT)||' ('||phase||')' FROM web_usage_protocol WHERE project_id=@slug AND phase!='settled'`,
    message: "model, web or protocol requests are unresolved", remedy: "Let in-flight requests settle (restart the service to run request recovery), then retry." },
  { code: "request_holds_active", sql: `SELECT request_id||' ('||task_id||')' ref FROM project_request_holds WHERE project_id=@slug AND active=1`,
    message: "request holds are still active", remedy: "Let the held requests settle or release, then retry." },
  { code: "execution_claims_unresolved", sql: `SELECT grant_id||' ('||phase||')' ref FROM project_execution_claims WHERE project_id=@slug AND phase!='terminal'`,
    message: "execution claims are unresolved", remedy: "Let the claimed executions reach a terminal state, then retry." },
  { code: "shared_execution", sql: `SELECT DISTINCT execution_id ref FROM execution_members WHERE execution_id IN (SELECT id FROM executions WHERE ${E}) AND task_id NOT IN (${T})
      UNION SELECT DISTINCT execution_id FROM model_requests WHERE execution_id IN (SELECT id FROM executions WHERE ${E}) AND project_id NOT IN (@slug,'')`,
    message: "executions are shared with another project", remedy: "This minimal migration cannot split a shared execution; inspect these executions or leave the project in the legacy store." },
  { code: "shared_protocol_record", sql: `SELECT request_id ref FROM request_protocol_projects WHERE project_id!=@slug AND request_id IN (SELECT request_id FROM request_protocol_projects WHERE project_id=@slug)
      UNION SELECT operation_id FROM task_lease_operation_projects WHERE project_id!=@slug AND operation_id IN (SELECT operation_id FROM task_lease_operation_projects WHERE project_id=@slug)`,
    message: "protocol records are shared with another project", remedy: "Wait until these records expire and are pruned, then retry." },
];

function sqlSample(db: Db, sql: string, slug: string): string[] {
  return z.array(z.object({ ref: z.string().nullable() }).strict()).parse(db.prepare(`SELECT ref FROM (${sql}) LIMIT 10`).all({ slug }))
    .map(row => row.ref ?? "?");
}

/** Rows of scoped tables whose project tag disagrees with the owning task's project. */
function ownershipConflicts(db: Db, slug: string): string[] {
  const conflicts: string[] = [];
  for (const table of Object.keys(PROJECT_EXPORT_TABLES).sort()) {
    const columns = new Set(z.array(z.object({ name: z.string() }).passthrough()).parse(db.prepare("SELECT name FROM pragma_table_info(?)").all(table)).map(c => c.name));
    if (!columns.has("project_id")) continue;
    for (const link of ["task_id", "job_id"]) {
      if (!columns.has(link) || (link === "job_id" && table !== "job_plans")) continue;
      const n = z.object({ n: z.number() }).parse(db.prepare(`SELECT COUNT(*) n FROM "${table}" WHERE
        (${link} IN (${T}) AND project_id IS NOT @slug) OR (project_id=@slug AND ${link} IN (SELECT id FROM tasks WHERE project_id!=@slug))`).get({ slug })).n;
      if (n > 0) conflicts.push(`${table}.${link}: ${n}`);
    }
  }
  return conflicts;
}

/** Filesystem leftovers of the project's worktrees and attempt sources. */
function worktreesOnDisk(db: Db, slug: string): string[] {
  const rows = z.array(z.object({ ref: z.string(), dir: z.string() }).strict()).parse(db.prepare(`
    SELECT task_id ref, worktree_path dir FROM workspaces WHERE task_id IN (${T})
    UNION ALL SELECT id, source_worktree FROM task_workspace_attempts WHERE project_id=@slug`).all({ slug }));
  return rows.filter(row => path.isAbsolute(row.dir) && existsSync(row.dir)).map(row => `${row.ref} at ${row.dir}`).slice(0, 10);
}

function legacyBlockers(db: Db, slug: string): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];
  let identity;
  try { identity = readStoreIdentity(db); } catch { identity = undefined; }
  if (identity === undefined) blockers.push(blocker("legacy_identity_unreadable", "the legacy store identity cannot be read", "Open the legacy store with this build so its schema is current."));
  else if (identity?.role === "project") blockers.push(blocker("legacy_is_project_store", "the source is already a split project store", "Only a legacy multi-project store can be migrated."));
  const schema = z.number().int().parse(db.pragma("user_version", { simple: true }));
  if (schema !== SCHEMA_VERSION) blockers.push(blocker("schema_mismatch", `the legacy store has schema ${schema}, this build expects ${SCHEMA_VERSION}`, "Open the legacy store once with this build (it migrates the schema), then retry."));
  const unknown = unclassifiedExportTables(db), missing = missingExportTables(db);
  if (unknown.length) blockers.push(blocker("unclassified_tables", "the legacy store has tables the export does not classify", "Extend store-export.ts with an ownership rule for these tables.", unknown));
  if (missing.length) blockers.push(blocker("missing_tables", "the legacy store lacks export tables", "Open the legacy store with this build, then retry.", missing));
  if (blockers.length) return blockers;
  if (!db.prepare("SELECT 1 FROM projects WHERE id=@slug UNION ALL SELECT 1 FROM tasks WHERE project_id=@slug LIMIT 1").get({ slug })) {
    blockers.push(blocker("no_legacy_rows", `the legacy store holds no rows for project "${slug}"`, "Provision a new split store instead of migrating."));
  }
  for (const check of SQL_CHECKS) {
    const sample = sqlSample(db, check.sql, slug);
    if (sample.length) blockers.push(blocker(check.code, check.message, check.remedy, sample));
  }
  const onDisk = worktreesOnDisk(db, slug);
  if (onDisk.length) blockers.push(blocker("worktrees_on_disk", "task worktrees or attempt sources still exist on disk", "Remove these worktrees through MeritRouter (discard or prune), then retry.", onDisk));
  const conflicts = ownershipConflicts(db, slug);
  if (conflicts.length) blockers.push(blocker("ownership_conflict", "rows disagree with their task's project", "Run the projects backfill or inspect these rows; the export copies rows by project tag only.", conflicts));
  const closure = projectExportClosureViolations(db, slug);
  if (closure.length) blockers.push(blocker("foreign_key_closure", "exported rows reference rows the export would not carry", "Inspect these references; the project store must be self-contained.",
    closure.map(v => `${v.table}.${v.column} -> ${v.parent}: ${v.rows} (${v.reason})`)));
  return blockers;
}

const FILE_PROBLEMS: Record<ProjectFileProblem["code"], { message: string; remedy: string }> = {
  file_missing: { message: "session logs or artifact files referenced by the project's rows are missing",
    remedy: "Restore them from a backup of the legacy storage folder (and check legacyStorageDir is the folder holding the legacy database), then retry." },
  file_outside_storage: { message: "rows point at files outside the legacy storage folder",
    remedy: "Move these files into the legacy storage folder and correct their rows, or check legacyStorageDir, then retry." },
  file_path_invalid: { message: "rows carry file pointers the split runtime cannot resolve", remedy: "Inspect and correct these rows, then retry." },
  artifact_digest_mismatch: { message: "artifact files do not match their recorded size and sha256",
    remedy: "Restore the artifact files from a backup of the legacy storage folder; a corrupt artifact is never copied." },
};
function fileBlockers(problems: readonly ProjectFileProblem[]): MigrationBlocker[] {
  return (Object.keys(FILE_PROBLEMS) as Array<ProjectFileProblem["code"]>).flatMap(code => {
    const sample = problems.filter(p => p.code === code).map(p => p.ref).slice(0, 10);
    return sample.length ? [blocker(code, FILE_PROBLEMS[code].message, FILE_PROBLEMS[code].remedy, sample)] : [];
  });
}

function coordinationBlockers(db: Db, slug: string, projectDirectory: string): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];
  const rows = z.array(z.object({ projectId: z.string(), slug: z.string(), state: z.string(), projectDirectory: z.string(), migrationId: z.string().nullable() }).strict())
    .parse(db.prepare(`SELECT r.project_uuid projectId,r.slug,r.state,r.project_directory projectDirectory,
      (SELECT m.migration_uuid FROM project_store_migrations m WHERE m.project_uuid=r.project_uuid AND m.state NOT IN ('committed','rolled_back')) migrationId
      FROM project_store_registrations r WHERE r.state!='retired'`).all());
  for (const row of rows) {
    if (row.slug !== slug && !samePath(row.projectDirectory, projectDirectory)) continue;
    if (row.migrationId) {
      blockers.push(blocker("migration_pending", `migration ${row.migrationId} of "${row.slug}" is unfinished (registration ${row.state})`,
        `Run rollbackProjectMigration({ migrationId: "${row.migrationId}" }), then retry.`, [row.projectId]));
    } else {
      blockers.push(blocker("already_registered", `"${row.slug}" at ${row.projectDirectory} already has a ${row.state} split store`,
        "The project is already split; there is nothing to migrate.", [row.projectId]));
    }
  }
  return blockers;
}

function directoryBlockers(paths: ProjectRuntimePaths, installationRoots: readonly string[]): MigrationBlocker[] {
  const blockers: MigrationBlocker[] = [];
  let real: string | null = null;
  try { real = realpathSync(paths.projectDirectory); } catch { real = null; }
  if (real === null || !lstatSync(real).isDirectory()) {
    blockers.push(blocker("project_directory_missing", `${paths.projectDirectory} is not an existing directory`, "Create or restore the project directory, then retry."));
    return blockers;
  }
  if (!samePath(real, paths.projectDirectory)) blockers.push(blocker("project_directory_not_real", `${paths.projectDirectory} resolves to ${real}`, "Pass the project directory by its real path."));
  if (isProjectMetadataPath(paths.projectDirectory)) blockers.push(blocker("project_directory_metadata", `${paths.projectDirectory} lies inside a MeritRouter metadata directory`, "Choose the project's own directory."));
  for (const root of installationRoots) {
    if (within(paths.projectDirectory, root) || within(root, paths.projectDirectory)) {
      blockers.push(blocker("installation_overlap", `${paths.projectDirectory} overlaps the installation directory ${root}`, "Choose a project directory that neither contains nor lies inside the installation."));
    }
  }
  if (existsSync(paths.root)) blockers.push(blocker("target_exists", `${paths.root} already exists`, "Move the existing project metadata directory aside (it was not created by this migration), then retry."));
  return blockers;
}

function legacySource(owner: { installationId: string }, legacyDb: Db): ProjectMigrationPlan["source"] {
  const schema = z.number().int().parse(legacyDb.pragma("user_version", { simple: true }));
  let identity;
  try { identity = readStoreIdentity(legacyDb); } catch { identity = null; }
  if (identity?.role === "coordination") return { storeId: identity.storeId, generation: LEGACY_GENERATION, schema, bound: "coordination" };
  // An unbound legacy store has no identity; derive a stable id from the installation and file.
  const hex = createHash("sha256").update(`meritrouter:legacy-store:v1\0${owner.installationId}\0${comparable(legacyDb.name)}`).digest("hex");
  const storeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { storeId, generation: LEGACY_GENERATION, schema, bound: null };
}

/** `live`: legacyDb is the live legacy store (not its backup), so its file must lie in legacyStorageDir. */
function planOn(coordinationDb: Db, legacyDb: Db, input: z.infer<typeof PlanInputSchema>, live: boolean): ProjectMigrationPlan {
  const owner = coordinationOwner(coordinationDb);
  const paths = projectRuntimePaths(input.projectDirectory);
  const build = (): ProjectMigrationPlan => {
    const blockers = [...directoryBlockers(paths, input.installationRoots), ...coordinationBlockers(coordinationDb, input.slug, paths.projectDirectory)];
    let storageOk = false;
    try { storageOk = lstatSync(input.legacyStorageDir).isDirectory(); } catch { storageOk = false; }
    if (!storageOk) blockers.push(blocker("legacy_storage_missing", `${input.legacyStorageDir} is not an existing directory`, "Pass the legacy storage folder (the folder holding the legacy database)."));
    else if (live && !samePath(path.dirname(path.resolve(legacyDb.name)), input.legacyStorageDir)) {
      blockers.push(blocker("legacy_storage_mismatch", `the legacy database ${legacyDb.name} does not lie in ${input.legacyStorageDir}`, "Pass the folder that holds the legacy database as legacyStorageDir."));
    }
    const legacy = legacyBlockers(legacyDb, input.slug);
    blockers.push(...legacy);
    const identity = (() => { try { return readStoreIdentity(legacyDb); } catch { return null; } })();
    if (identity?.role === "coordination" && identity.installationId !== owner.installationId) {
      blockers.push(blocker("legacy_foreign_installation", "the legacy store belongs to another installation", "Migrate with that installation's coordination store."));
    }
    const schemaOk = !legacy.some(b => ["schema_mismatch", "unclassified_tables", "missing_tables", "legacy_identity_unreadable"].includes(b.code));
    const scan = schemaOk && storageOk ? inspectProjectFiles(legacyDb, input.slug, { legacyStorageDir: input.legacyStorageDir }) : null;
    if (scan) blockers.push(...fileBlockers(scan.problems));
    const manifest = scan ? { ...projectExportManifest(legacyDb, input.slug, "project"), files: fileDigests(scan.files) } : null;
    return {
      slug: input.slug, projectDirectory: paths.projectDirectory, ready: blockers.length === 0, blockers,
      source: legacySource(owner, legacyDb), manifest, checkpointSha256: manifest ? projectExportManifestSha256(manifest) : null, files: scan?.files ?? [],
    };
  };
  // One read snapshot of the legacy store for every check and digest.
  return legacyDb.inTransaction ? build() : legacyDb.transaction(build)();
}

/** Dry run: tables, counts, digests and every blocking reason. Writes nothing anywhere. */
export function planProjectMigration(coordinationDb: Db, legacyDb: Db, input: PlanProjectMigrationInput): ProjectMigrationPlan {
  return planOn(coordinationDb, legacyDb, PlanInputSchema.parse(input), true);
}

// ---------------------------------------------------------------------------------------------
// Journal helpers (coordination DB, IMMEDIATE transactions).

function transition(db: Db, migrationId: string, from: readonly ProjectStoreMigration["state"][], to: ProjectStoreMigration["state"], now: number): void {
  immediate(db, () => {
    const result = db.prepare(`UPDATE project_store_migrations SET state=?,updated_at=? WHERE migration_uuid=? AND state IN (${from.map(() => "?").join(",")})`)
      .run(to, now, migrationId, ...from);
    if (result.changes !== 1) throw new Error(`Migration ${migrationId} is not in state ${from.join("/")}`);
  });
}
function setRegistrationState(db: Db, identity: ProjectStoreIdentity, from: ProjectStoreRegistration["state"], to: "registered" | "migrating" | "retired", now: number): void {
  const result = db.prepare(`UPDATE project_store_registrations SET state=?,updated_at=?,retired_at=? WHERE project_uuid=? AND state=? AND store_uuid=? AND generation=? AND slug=?`)
    .run(to, now, to === "retired" ? now : null, identity.projectId, from, identity.storeId, identity.generation, identity.slug);
  if (result.changes !== 1) throw new Error(`Registration of ${identity.projectId} is not ${from} for this store generation`);
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** SQLite online backup, converted to rollback-journal mode and integrity-checked. */
async function backupLegacy(legacyDb: Db, file: string): Promise<void> {
  if (existsSync(file)) throw new Error(`Backup file ${file} already exists`);
  await legacyDb.backup(file);
  const copy = new Database(file, { fileMustExist: true });
  try {
    copy.pragma("journal_mode = DELETE");
    const check = copy.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`Backup ${file} failed its integrity check: ${String(check)}`);
  } finally { copy.close(); }
  await fsyncFile(file);
}

/** Copy payload files into the runtime root; each copy must reproduce the planned digest. */
async function copyProjectFiles(files: readonly ProjectFileEntry[], runtimeRoot: string): Promise<void> {
  for (const file of files) {
    const destination = path.join(runtimeRoot, ...file.path.split("/"));
    if (!within(destination, runtimeRoot) || samePath(destination, runtimeRoot)) throw new Error(`Payload path ${file.path} escapes the project runtime`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.source, destination, fsConstants.COPYFILE_EXCL);
    await fsyncFile(destination);
    const copied = fileSha256(destination);
    if (!copied || copied.sha256 !== file.sha256 || copied.bytes !== file.bytes) {
      throw new Error(`Copied ${file.path} does not match its planned digest; the legacy file changed during migration`);
    }
  }
}

/** Whole-store rows plus the payload files they resolve to under the runtime root. */
function projectStoreManifest(db: Db, slug: string, paths: ProjectRuntimePaths): { manifest: ProjectExportManifest; problems: ProjectFileProblem[] } {
  const scan = inspectProjectFiles(db, slug, { runtimeRoot: paths.root });
  return { manifest: { ...projectExportManifest(db, slug, "store"), files: fileDigests(scan.files) }, problems: scan.problems };
}

// ---------------------------------------------------------------------------------------------
// Target ownership proof: never delete a store this migration did not create.

const PARTIAL_ROOT_ENTRIES = new Set(["state", "project.json", "project.json.provision.tmp"]);
const PARTIAL_STATE_ENTRIES = new Set(["meritrouter.db-wal", "meritrouter.db-shm", "meritrouter.db-journal"]);
function refuseTarget(message: string): never { throw new Error(`Migration rollback refused: ${message}`); }

/** "owned" when the target root holds this migration's store (or its pre-binding remains). */
function inspectTarget(paths: ProjectRuntimePaths, identity: ProjectStoreIdentity, strict: boolean): "absent" | "owned" {
  let stat;
  try { stat = lstatSync(paths.root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuseTarget(`${paths.root} is linked or is not a directory; inspect it manually`);
  const file = databasePath(paths.state);
  if (existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const bound = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_identity'").get() ? readStoreIdentity(db) : null;
      if (bound) {
        if (canonical(bound) !== canonical(identity)) refuseTarget(`${file} holds another store (${bound.role} ${"projectId" in bound ? bound.projectId : bound.storeId}); inspect it manually`);
        return "owned";
      }
      if (strict) refuseTarget(`${file} has no store identity; inspect it manually`);
      const tables = z.array(z.object({ name: z.string() }).strict()).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all());
      for (const { name } of tables) {
        if (/^brain_fts_/.test(name)) continue;
        if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get()) refuseTarget(`${file} is unbound but holds data (${name}); inspect it manually`);
      }
      return "owned";
    } finally { db.close(); }
  }
  if (strict) refuseTarget(`${paths.root} has no store database to prove ownership; inspect it manually`);
  const unexpected = readdirSync(paths.root).filter(name => !PARTIAL_ROOT_ENTRIES.has(name));
  if (existsSync(paths.state)) unexpected.push(...readdirSync(paths.state).filter(name => !PARTIAL_STATE_ENTRIES.has(name)).map(name => `state/${name}`));
  if (unexpected.length) refuseTarget(`${paths.root} holds unexpected entries (${unexpected.join(", ")}); inspect it manually`);
  if (existsSync(paths.manifest)) {
    let projectId: unknown = null;
    try { projectId = (JSON.parse(readFileSync(paths.manifest, "utf8")) as { projectId?: unknown }).projectId; } catch { projectId = null; }
    if (projectId !== identity.projectId) refuseTarget(`${paths.manifest} names another project; inspect it manually`);
  }
  return "owned";
}

function targetIdentity(journal: ProjectStoreMigration, registration: ProjectStoreRegistration): ProjectStoreIdentity {
  if (registration.storeId !== journal.targetStoreId || registration.generation !== journal.targetGeneration || registration.projectId !== journal.projectId) {
    throw new Error(`Registration of ${registration.projectId} no longer matches migration ${journal.migrationId}`);
  }
  return ProjectStoreIdentitySchema.parse({ version: 1, role: "project", installationId: journal.installationId, projectId: journal.projectId,
    slug: registration.slug, storeId: journal.targetStoreId, generation: journal.targetGeneration });
}

function targetStoreSha256(paths: ProjectRuntimePaths, identity: ProjectStoreIdentity): { sha256: string; manifest: ProjectExportManifest; problems: ProjectFileProblem[] } {
  const db = new Database(databasePath(paths.state), { readonly: true, fileMustExist: true });
  try {
    if (canonical(readStoreIdentity(db)) !== canonical(identity)) throw new Error("Target store identity changed");
    const { manifest, problems } = projectStoreManifest(db, identity.slug, paths);
    return { sha256: projectExportManifestSha256(manifest), manifest, problems };
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------------------------

/**
 * Migrate one quiescent legacy project into a new split store at `<projectDirectory>/.MeritRouter`.
 * Refuses with ProjectMigrationRefusedError (nothing written) when the project is not quiescent.
 * A failure after the journal row exists leaves `recovery_required` + `migrating`; recover with
 * rollbackProjectMigration and migrate again.
 */
export async function migrateLegacyProject(coordinationDb: Db, legacyDb: Db, input: MigrateLegacyProjectInput,
  options: ProjectMigrationOptions = {}): Promise<ProjectMigrationResult> {
  const parsed = MigrateInputSchema.parse(input);
  const clock = () => parsed.now ?? Date.now();
  const hook = async (phase: ProjectMigrationPhase) => { await options.afterPhase?.(phase); };
  const owner = coordinationOwner(coordinationDb);
  const paths = projectRuntimePaths(parsed.projectDirectory);
  if (within(parsed.backupDir, paths.projectDirectory)) throw new Error(`Backup directory ${parsed.backupDir} must lie outside the project directory`);
  const planInput = { slug: parsed.slug, projectDirectory: parsed.projectDirectory, installationRoots: parsed.installationRoots, legacyStorageDir: parsed.legacyStorageDir };
  const live = planOn(coordinationDb, legacyDb, planInput, true);
  if (!live.ready) throw new ProjectMigrationRefusedError(parsed.slug, live.blockers);
  await hook("planned");

  const migrationId = randomUUID();
  await mkdir(parsed.backupDir, { recursive: true });
  const backupFile = path.join(parsed.backupDir, `${parsed.slug}-${migrationId}.legacy.db`);
  const manifestFile = path.join(parsed.backupDir, `${parsed.slug}-${migrationId}.manifest.json`);
  const discardBackup = async () => {
    for (const file of [backupFile, `${backupFile}-journal`, manifestFile, `${manifestFile}.tmp`]) await rm(file, { force: true }).catch(() => {});
  };
  let snapshotDb: Db | null = null;
  let snapshot: ProjectMigrationPlan, backupSha256: string;
  try {
    await backupLegacy(legacyDb, backupFile);
    snapshotDb = new Database(backupFile, { readonly: true, fileMustExist: true });
    // The backup is the export source; it must itself be quiescent and complete.
    snapshot = planOn(coordinationDb, snapshotDb, planInput, false);
    if (!snapshot.ready) throw new ProjectMigrationRefusedError(parsed.slug, snapshot.blockers);
    backupSha256 = await sha256File(backupFile);
    await writeJsonAtomically(manifestFile, { format: 1, migrationId, slug: parsed.slug, installationId: owner.installationId,
      projectDirectory: paths.projectDirectory, legacyStorageDir: parsed.legacyStorageDir, backupFile, backupSha256, source: live.source,
      checkpointSha256: snapshot.checkpointSha256, manifest: snapshot.manifest, fileSources: snapshot.files.map(f => ({ path: f.path, source: f.source })) });
    await hook("backup");
  } catch (error) {
    snapshotDb?.close();
    await discardBackup();
    throw error;
  }
  const db = snapshotDb;
  const manifest = snapshot.manifest!, checkpointSha256 = snapshot.checkpointSha256!;

  const minted = createProjectStoreIdentity(owner.installationId, parsed.slug);
  const identity = ProjectStoreIdentitySchema.parse({ ...minted, generation: TARGET_GENERATION });
  const created = clock();
  const journal = ProjectStoreMigrationSchema.parse({
    migrationId, installationId: owner.installationId, projectId: identity.projectId, sourceStoreId: live.source.storeId, targetStoreId: identity.storeId,
    sourceGeneration: LEGACY_GENERATION, targetGeneration: TARGET_GENERATION, sourceSchema: live.source.schema, targetSchema: SCHEMA_VERSION,
    checkpointSha256, state: "prepared", createdAt: created, updatedAt: created,
  });
  const registration = ProjectStoreRegistrationSchema.parse({ installationId: owner.installationId, projectId: identity.projectId, slug: identity.slug,
    storeId: identity.storeId, generation: identity.generation, projectDirectory: paths.projectDirectory, state: "migrating", createdAt: created, updatedAt: created, retiredAt: null });
  try {
    // Journal before any target file exists, so every artifact on disk is owned by a journal row.
    immediate(coordinationDb, () => {
      const conflicts = coordinationBlockers(coordinationDb, parsed.slug, paths.projectDirectory);
      if (conflicts.length) throw new ProjectMigrationRefusedError(parsed.slug, conflicts);
      coordinationDb.prepare(`INSERT INTO project_store_registrations(project_uuid,installation_uuid,slug,store_uuid,generation,project_directory,state,created_at,updated_at,retired_at)
        VALUES(?,?,?,?,?,?,'migrating',?,?,NULL)`).run(registration.projectId, registration.installationId, registration.slug, registration.storeId,
        registration.generation, registration.projectDirectory, registration.createdAt, registration.updatedAt);
      coordinationDb.prepare(`INSERT INTO project_store_migrations(migration_uuid,project_uuid,installation_uuid,source_store_uuid,target_store_uuid,source_generation,
        target_generation,source_schema,target_schema,checkpoint_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
        .run(journal.migrationId, journal.projectId, journal.installationId, journal.sourceStoreId, journal.targetStoreId, journal.sourceGeneration,
          journal.targetGeneration, journal.sourceSchema, journal.targetSchema, journal.checkpointSha256, journal.createdAt, journal.updatedAt);
    });
  } catch (error) {
    db.close();
    await discardBackup();
    throw error;
  }

  let phase: ProjectMigrationPhase = "prepared";
  try {
    await hook("prepared");
    const prepared = await prepareProjectStore(coordinationDb, { slug: parsed.slug, projectDirectory: parsed.projectDirectory, installationRoots: parsed.installationRoots, ...(parsed.now === undefined ? {} : { now: parsed.now }) }, identity, options.provision);
    if (canonical(prepared.identity) !== canonical(identity)) throw new Error("Prepared store identity differs from the journaled target");
    phase = "store"; await hook("store");

    transition(coordinationDb, migrationId, ["prepared"], "copying", clock());
    phase = "copying"; await hook("copying");

    const target = openDatabase(paths.state, { durability: "full", fileMustExist: true, expectedIdentity: identity });
    try {
      const written = exportProjectRows(db, target, parsed.slug, { afterTable: options.afterExportTable });
      phase = "exported"; await hook("exported");
      await copyProjectFiles(snapshot.files, paths.root);
      phase = "files"; await hook("files");
      const { manifest: stored, problems } = projectStoreManifest(target, parsed.slug, paths);
      if (problems.length) throw new Error(`Target payload files do not resolve (${problems.map(p => p.ref).join("; ")})`);
      const differing = [...new Set([...differingExportTables(manifest, written), ...differingExportTables(manifest, stored), ...differingExportFiles(manifest, stored)])];
      if (differing.length || projectExportManifestSha256(stored) !== checkpointSha256) throw new Error(`Target store does not match the checkpoint (${differing.join(", ") || "manifest"})`);
      if (target.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Target store failed its integrity check");
      if ((target.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("Target store violates a foreign key");
      assertStoreRole(target, identity);
    } finally { target.close(); }
    transition(coordinationDb, migrationId, ["copying"], "verified", clock());
    phase = "verified"; await hook("verified");

    immediate(coordinationDb, () => {
      // The live legacy rows must still equal the backup: nothing ran for the project meanwhile.
      const drift = planOn(coordinationDb, legacyDb, planInput, true);
      const legacyBlocking = drift.blockers.filter(b => !["already_registered", "migration_pending", "target_exists"].includes(b.code));
      if (legacyBlocking.length) throw new ProjectMigrationRefusedError(parsed.slug, legacyBlocking);
      if (drift.checkpointSha256 !== checkpointSha256) throw new Error("The legacy project changed after its backup; roll back and migrate again");
      setRegistrationState(coordinationDb, identity, "migrating", "registered", clock());
      transition(coordinationDb, migrationId, ["verified"], "committed", clock());
    });
    phase = "committed"; await hook("committed");
  } catch (error) {
    const current = (() => { try { return readProjectStoreMigration(coordinationDb, migrationId)?.state ?? null; } catch { return null; } })();
    if (current === "committed") throw error;
    try { transition(coordinationDb, migrationId, PENDING_STATES, "recovery_required", clock()); } catch { /* a hard crash leaves the last journaled state */ }
    throw new Error(`Project migration ${migrationId} of "${parsed.slug}" failed after ${phase}: ${(error as Error).message}. `
      + `Its registration stays 'migrating' and is never dispatched; run rollbackProjectMigration({ migrationId: "${migrationId}" }), then migrate again.`, { cause: error });
  } finally {
    if (db.open) db.close();
  }
  return {
    migrationId, identity, registration: readProjectStoreRegistration(coordinationDb, identity.projectId)!,
    journal: readProjectStoreMigration(coordinationDb, migrationId)!, paths, backupFile, manifestFile, backupSha256, checkpointSha256, manifest,
  };
}

/**
 * Undo a migration before the target's first dispatch: retire the registration, mark the journal
 * `rolled_back` and remove the `<project>/.MeritRouter` it created, copied session logs and
 * artifact files included. Legacy rows and files are never written. A committed migration is
 * rolled back only while every exported table and payload file still equals the checkpoint.
 * `legacyStorageDir` is optional and only feeds `legacyIntact`. Idempotent: re-running a rolled-back migration retries removal of its own store.
 */
export async function rollbackProjectMigration(coordinationDb: Db, legacyDb: Db | null, input: RollbackProjectMigrationInput): Promise<ProjectMigrationRollback> {
  const parsed = RollbackInputSchema.parse(input);
  const clock = () => parsed.now ?? Date.now();
  coordinationOwner(coordinationDb);
  const journal = readProjectStoreMigration(coordinationDb, parsed.migrationId);
  if (!journal) throw new Error(`Migration ${parsed.migrationId} is unknown`);
  const registration = readProjectStoreRegistration(coordinationDb, journal.projectId)!;
  const identity = targetIdentity(journal, registration);
  const paths = projectRuntimePaths(registration.projectDirectory);
  const legacyIntact = () => {
    if (!legacyDb || !parsed.legacyStorageDir) return null;
    try {
      const scan = inspectProjectFiles(legacyDb, identity.slug, { legacyStorageDir: parsed.legacyStorageDir });
      if (scan.problems.length) return false;
      return projectExportManifestSha256({ ...projectExportManifest(legacyDb, identity.slug, "project"), files: fileDigests(scan.files) }) === journal.checkpointSha256;
    } catch { return false; }
  };
  const remove = async (): Promise<boolean> => {
    try { await rm(paths.root, { recursive: true, force: true, maxRetries: 3 }); } catch (error) {
      throw new Error(`Migration ${journal.migrationId} is rolled back, but ${paths.root} could not be removed (${(error as Error).message}); `
        + "close any process using it and run rollbackProjectMigration again", { cause: error });
    }
    return !existsSync(paths.root);
  };

  if (journal.state === "rolled_back") {
    const found = inspectTarget(paths, identity, true);
    return { migrationId: journal.migrationId, projectId: journal.projectId, slug: identity.slug, previousState: journal.state,
      targetRemoved: found === "absent" ? true : await remove(), legacyIntact: legacyIntact() };
  }

  if (journal.state === "committed") {
    if (registration.state === "retired") throw new Error(`Project ${journal.projectId} is retired; migration ${journal.migrationId} cannot be rolled back`);
    // Fence first: a registration that is not `registered` cannot be opened or pinned.
    if (registration.state === "registered") immediate(coordinationDb, () => setRegistrationState(coordinationDb, identity, "registered", "migrating", clock()));
    let proof: { sha256: string; manifest: ProjectExportManifest; problems: ProjectFileProblem[] };
    try {
      if (inspectTarget(paths, identity, true) === "absent") throw new Error(`target store ${paths.state} is missing, so an unchanged state cannot be proven`);
      proof = targetStoreSha256(paths, identity);
    } catch (error) {
      immediate(coordinationDb, () => setRegistrationState(coordinationDb, identity, "migrating", "registered", clock()));
      throw new Error(`Migration rollback refused: ${(error as Error).message}`, { cause: error });
    }
    if (proof.sha256 !== journal.checkpointSha256) {
      immediate(coordinationDb, () => setRegistrationState(coordinationDb, identity, "migrating", "registered", clock()));
      const changed = proof.manifest.tables.filter(t => t.rows > 0).map(t => t.table);
      const files = proof.problems.map(p => p.ref);
      throw new Error(`Migration rollback refused: the project store changed after the export (first dispatch, new records or changed payload files; `
        + `tables with rows: ${changed.join(", ")}${files.length ? `; unresolved files: ${files.join("; ")}` : ""}). Its registration stays 'registered'.`);
    }
  } else {
    if (registration.state !== "migrating") throw new Error(`Registration of ${journal.projectId} is ${registration.state}, expected migrating`);
    inspectTarget(paths, identity, false);
  }

  immediate(coordinationDb, () => {
    setRegistrationState(coordinationDb, identity, "migrating", "retired", clock());
    transition(coordinationDb, journal.migrationId, [journal.state], "rolled_back", clock());
  });
  return { migrationId: journal.migrationId, projectId: journal.projectId, slug: identity.slug, previousState: journal.state,
    targetRemoved: await remove(), legacyIntact: legacyIntact() };
}

const RegistrationStateSchema = z.enum(["registered", "migrating", "retired"]);
const JournalStateSchema = z.enum(["prepared", "copying", "verified", "committed", "rolled_back", "recovery_required"]);
function rolledBackStoreRemains(coordinationDb: Db, migrationId: string): boolean {
  try {
    const journal = readProjectStoreMigration(coordinationDb, migrationId)!;
    const registration = readProjectStoreRegistration(coordinationDb, journal.projectId)!;
    return inspectTarget(projectRuntimePaths(registration.projectDirectory), targetIdentity(journal, registration), true) === "owned";
  } catch { return false; }
}

/**
 * Startup report (read-only): migrations that need recovery. Their registrations are never
 * dispatchable (the runtime registry opens only `registered` stores); the target can be
 * inspected with openProjectMigrationRecoveryStore.
 */
export function listProjectMigrationRecovery(coordinationDb: Db): ProjectMigrationRecoveryEntry[] {
  coordinationOwner(coordinationDb);
  const rows = z.array(z.object({ projectId: z.string(), slug: z.string(), state: z.string(), projectDirectory: z.string(),
    migrationId: z.string().nullable(), journalState: z.string().nullable() }).strict()).parse(coordinationDb.prepare(`
    SELECT r.project_uuid projectId,r.slug,r.state,r.project_directory projectDirectory,m.migration_uuid migrationId,m.state journalState
    FROM project_store_registrations r LEFT JOIN project_store_migrations m ON m.project_uuid=r.project_uuid
    WHERE r.state='migrating' OR m.state IN ('prepared','copying','verified','recovery_required') OR (m.state='rolled_back')
    ORDER BY r.slug,m.created_at`).all());
  const entries: ProjectMigrationRecoveryEntry[] = [];
  for (const row of rows) {
    const registrationState = RegistrationStateSchema.parse(row.state);
    const journalState = row.journalState === null ? null : JournalStateSchema.parse(row.journalState);
    const base = { migrationId: row.migrationId, projectId: row.projectId, slug: row.slug, projectDirectory: row.projectDirectory, journalState, registrationState, dispatchable: false as const };
    if (journalState === "rolled_back") {
      if (registrationState === "retired" && row.migrationId && rolledBackStoreRemains(coordinationDb, row.migrationId)) {
        entries.push({ ...base, access: "cleanup", action: `Run rollbackProjectMigration({ migrationId: "${row.migrationId}" }) to remove the rolled-back store if it is still this migration's.` });
      }
      continue;
    }
    entries.push({ ...base, access: "read-only-recovery", action: row.migrationId
      ? `Inspect read-only, then run rollbackProjectMigration({ migrationId: "${row.migrationId}" }) and migrate again.`
      : "A migrating registration without a journal row: inspect it manually; it is never dispatched." });
  }
  return entries;
}

/** Read-only handle on a migration's target store for inspection. The caller closes it. */
export function openProjectMigrationRecoveryStore(coordinationDb: Db, migrationId: string): Db {
  coordinationOwner(coordinationDb);
  const journal = readProjectStoreMigration(coordinationDb, z.uuid().parse(migrationId));
  if (!journal) throw new Error(`Migration ${migrationId} is unknown`);
  const registration = readProjectStoreRegistration(coordinationDb, journal.projectId)!;
  const identity = targetIdentity(journal, registration);
  const db = new Database(databasePath(projectRuntimePaths(registration.projectDirectory).state), { readonly: true, fileMustExist: true });
  try {
    if (canonical(readStoreIdentity(db)) !== canonical(identity)) throw new Error("Recovery store identity does not match the migration journal");
    return db;
  } catch (error) { db.close(); throw error; }
}

/**
 * Fence for legacy rows: once a project has a live split registration, its legacy rows are
 * history only. Callers that would dispatch, resume or write legacy rows for `slug` must
 * refuse when `fenced` is true.
 */
export function legacyProjectFence(coordinationDb: Db, slug: string): { fenced: boolean; projectId: string | null; state: "registered" | "migrating" | null } {
  coordinationOwner(coordinationDb);
  const row = z.object({ projectId: z.string(), state: z.enum(["registered", "migrating"]) }).strict().optional().parse(coordinationDb.prepare(
    "SELECT project_uuid projectId,state FROM project_store_registrations WHERE slug=? AND state!='retired'").get(z.string().min(1).max(128).parse(slug)));
  return row ? { fenced: true, projectId: row.projectId, state: row.state } : { fenced: false, projectId: null, state: null };
}
