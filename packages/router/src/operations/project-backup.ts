import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { DB_FILE, SCHEMA_VERSION, databasePath, openDatabase, type Db } from "../storage/db.js";
import { assertStoreRole } from "../storage/store-role.js";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { QUALIFICATION_PROJECT } from "../qualification/registry.js";
import { MeritRouterError } from "../core/errors.js";
import { readProjectStoreRegistration, readStoreIdentity, ProjectStoreIdentitySchema, type ProjectStoreRegistration } from "../projects/store-identity.js";
import { projectRuntimePaths, type ProjectRuntimePaths } from "../projects/runtime-paths.js";
import { liveLeases } from "./backup.js";
import { backupBrain, BrainManifestSchema, planBrainRestore, stageBrainRestore, discardStagedBrainRestore, restoreBrain, type BrainRestoreResult } from "./brain-backup.js";

/**
 * Backup and restore of one project's own store: the SQLite database at
 * `<project>/.MeritRouter/state`, its sessions, artifacts and `project.json`, and its own brain
 * folder (`<project>/.MeritRouter/brain`). Unlike `backupStorage` (the whole installation), this
 * never touches the coordination store or any other project's directory. A restore puts every
 * entry back under the project's *current* registration, never a stale or foreign one.
 */

export const PROJECT_BACKUP_FORMAT = 1;
const MANIFEST_FILE = "manifest.json";
const SESSIONS_DIR = "sessions";
const ARTIFACTS_DIR = "artifacts";
const PROJECT_MANIFEST_FILE = "project.json";
/** Entries restored directly under the project runtime root (brain is handled separately). */
const ROOT_ENTRIES = ["state", SESSIONS_DIR, ARTIFACTS_DIR, PROJECT_MANIFEST_FILE] as const;

const uuid = z.uuid().refine((value) => value === value.toLowerCase(), "UUID must use canonical lowercase");
const slug = z.string().min(1).max(128).refine((value) => PROJECT_SLUG_RE.test(value) || value === QUALIFICATION_PROJECT);

export const ProjectBackupIdentitySchema = z.object({
  installationId: uuid,
  projectId: uuid,
  slug,
  storeId: uuid,
  generation: z.number().int().positive(),
}).strict();
export type ProjectBackupIdentity = z.infer<typeof ProjectBackupIdentitySchema>;

export const ProjectBackupManifestSchema = z.object({
  format: z.literal(PROJECT_BACKUP_FORMAT),
  createdAt: z.string(),
  identity: ProjectBackupIdentitySchema,
  sourceProjectDirectory: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  sessionLogs: z.number().int().nonnegative(),
  artifactFiles: z.number().int().nonnegative(),
  includesMasterKey: z.boolean(),
  missing: z.array(z.string()),
  brain: BrainManifestSchema.nullable(),
  /** sha256 hex digests of the files a restore verifies before swapping anything into place. */
  digests: z.object({ db: z.string().regex(/^[a-f0-9]{64}$/), projectManifest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
}).strict();
export type ProjectBackupManifest = z.infer<typeof ProjectBackupManifestSchema>;

export const ProjectBackupOptionsSchema = z.object({
  projectId: uuid.optional(),
  slug: slug.optional(),
  targetDir: z.string().min(1),
  includeMasterKey: z.boolean().default(false),
}).strict().refine((v) => (v.projectId ? 1 : 0) + (v.slug ? 1 : 0) === 1, "Exactly one of projectId or slug is required");
export type ProjectBackupOptions = z.input<typeof ProjectBackupOptionsSchema>;

export const ProjectRestoreOptionsSchema = z.object({
  backupDir: z.string().min(1),
  force: z.boolean().default(false),
  now: z.number().int().optional(),
}).strict();
export type ProjectRestoreOptions = z.input<typeof ProjectRestoreOptionsSchema>;

export interface ProjectRestoreResult {
  manifest: ProjectBackupManifest;
  projectDirectory: string;
  previousMovedTo: string | null;
  leasesReleased: number;
  schemaVersion: number;
  brain: BrainRestoreResult;
}

const isNonEmptyDir = (dir: string) => existsSync(dir) && readdirSync(dir).length > 0;
function hasTable(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}
function countRows(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}
function copySessionLog(src: string, dst: string): void {
  const data = readFileSync(src);
  const end = data.lastIndexOf(0x0a);
  writeFileSync(dst, end === data.length - 1 || end < 0 ? data : data.subarray(0, end + 1));
}
function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function insideOrEqual(target: string, ancestor: string): boolean {
  const t = path.resolve(target), a = path.resolve(ancestor);
  return t === a || t.startsWith(a + path.sep);
}

/** Tasks a live worker holds (an unexpired lease) in a project's own `project_execution_claims`. */
export function liveExecutionClaims(stateDir: string, now = Date.now()): Array<{ grantId: string; phase: string }> {
  const dbPath = databasePath(stateDir);
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 10000");
    if (!hasTable(db, "project_execution_claims")) return [];
    void now; // claims have no lease TTL of their own: any non-terminal phase is live
    return (db.prepare("SELECT grant_id AS grantId, phase FROM project_execution_claims WHERE phase != 'terminal'").all() as Array<{ grantId: string; phase: string }>);
  } finally {
    db.close();
  }
}

function resolveRegistration(coordinationDb: Db, opts: { projectId?: string; slug?: string }): ProjectStoreRegistration {
  let projectId = opts.projectId;
  if (!projectId) {
    const row = z.object({ id: uuid }).strict().optional().parse(
      coordinationDb.prepare("SELECT project_uuid AS id FROM project_store_registrations WHERE slug=?").get(opts.slug));
    if (!row) throw new MeritRouterError("not_found", `no project store is registered for slug ${opts.slug}`);
    projectId = row.id;
  }
  const registration = readProjectStoreRegistration(coordinationDb, projectId);
  if (!registration) throw new MeritRouterError("not_found", `no project store registration for project ${projectId}`);
  return registration;
}

/**
 * Snapshot one project's store into `targetDir`: the SQLite database (online backup, WAL-safe),
 * sessions, artifacts, `project.json`, and the project's own brain. Refuses a project that is not
 * `registered` (migrating/retired stores are not backed up this way), and a `targetDir` inside
 * the project directory or the installation storage directory.
 */
export async function backupProjectStore(coordinationDb: Db, input: ProjectBackupOptions): Promise<ProjectBackupManifest> {
  const opts = ProjectBackupOptionsSchema.parse(input);
  const registration = resolveRegistration(coordinationDb, opts);
  if (registration.state !== "registered") {
    throw new MeritRouterError("conflict", `refusing to back up project ${registration.slug}: its store is ${registration.state}, not registered`);
  }
  const paths = projectRuntimePaths(registration.projectDirectory);
  const targetDir = path.resolve(opts.targetDir);
  const installationStorageDir = path.dirname(path.resolve(coordinationDb.name));
  if (insideOrEqual(targetDir, paths.root)) throw new MeritRouterError("usage", `backup directory ${targetDir} must be outside the project's own runtime directory ${paths.root}`);
  if (insideOrEqual(targetDir, installationStorageDir)) throw new MeritRouterError("usage", `backup directory ${targetDir} must be outside the installation storage directory ${installationStorageDir}`);
  if (isNonEmptyDir(targetDir)) throw new MeritRouterError("usage", `backup directory ${targetDir} is not empty; choose a new directory`);

  const dbPath = databasePath(paths.state);
  if (!existsSync(dbPath)) throw new MeritRouterError("not_found", `no database at ${dbPath}; nothing to back up`);
  mkdirSync(targetDir, { recursive: true });

  // 1. Online snapshot of the project's own database only.
  const snapshotPath = path.join(targetDir, DB_FILE);
  const source = new Database(dbPath, { fileMustExist: true });
  try {
    source.pragma("busy_timeout = 10000");
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }

  // 2. Make the snapshot self-contained, verify its identity, and read what it indexes.
  const snap = new Database(snapshotPath, { fileMustExist: true });
  let schemaVersion: number;
  let tasks = 0, sessions = 0, artifacts = 0;
  let logPaths: string[] = [], artifactPaths: string[] = [];
  try {
    snap.pragma("journal_mode = DELETE");
    const check = snap.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new MeritRouterError("internal", `snapshot failed its integrity check: ${String(check)}`);
    const identity = readStoreIdentity(snap);
    if (!identity || identity.role !== "project" || identity.projectId !== registration.projectId || identity.storeId !== registration.storeId || identity.generation !== registration.generation || identity.slug !== registration.slug) {
      throw new MeritRouterError("internal", `project database at ${dbPath} does not match its registration (role/identity mismatch)`);
    }
    schemaVersion = snap.pragma("user_version", { simple: true }) as number;
    if (hasTable(snap, "tasks")) tasks = countRows(snap, "tasks");
    if (hasTable(snap, "sessions")) {
      logPaths = (snap.prepare("SELECT log_path FROM sessions").all() as Array<{ log_path: string }>).map((r) => r.log_path);
      sessions = logPaths.length;
    }
    if (hasTable(snap, "artifacts")) {
      artifactPaths = (snap.prepare("SELECT rel_path FROM artifacts").all() as Array<{ rel_path: string }>).map((r) => r.rel_path);
      artifacts = artifactPaths.length;
    }
  } finally {
    snap.close();
  }

  // 3. Session logs after the snapshot: a log can only be ahead of its index, never behind.
  let sessionLogs = 0;
  if (existsSync(paths.sessions)) {
    const dst = path.join(targetDir, SESSIONS_DIR);
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(paths.sessions)) {
      const from = path.join(paths.sessions, name);
      if (!name.endsWith(".jsonl") || !statSync(from).isFile()) continue;
      copySessionLog(from, path.join(dst, name));
      sessionLogs++;
    }
  }

  // 4. Artifacts.
  let artifactFiles = 0;
  if (existsSync(paths.artifacts)) {
    cpSync(paths.artifacts, path.join(targetDir, ARTIFACTS_DIR), { recursive: true });
    artifactFiles = countFiles(path.join(targetDir, ARTIFACTS_DIR));
  }

  // 5. project.json.
  let projectManifestDigest: string | null = null;
  if (existsSync(paths.manifest)) {
    const dst = path.join(targetDir, PROJECT_MANIFEST_FILE);
    copyFileSync(paths.manifest, dst);
    projectManifestDigest = sha256File(dst);
  }

  // 6. This project's own brain (its own folder only: no other project's and no global mounts).
  const brain = backupBrain(paths.brain, targetDir, []);

  const missing = [
    ...logPaths.filter((p) => !path.isAbsolute(p) && !existsSync(path.join(targetDir, ...p.split("/")))),
    ...artifactPaths.filter((p) => !existsSync(path.join(targetDir, ARTIFACTS_DIR, ...p.split("/")))).map((p) => `${ARTIFACTS_DIR}/${p}`),
  ];

  const manifest: ProjectBackupManifest = {
    format: PROJECT_BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    identity: { installationId: registration.installationId, projectId: registration.projectId, slug: registration.slug, storeId: registration.storeId, generation: registration.generation },
    sourceProjectDirectory: paths.projectDirectory,
    schemaVersion, tasks, sessions, artifacts, sessionLogs, artifactFiles,
    includesMasterKey: false,
    missing,
    brain,
    digests: { db: sha256File(snapshotPath), projectManifest: projectManifestDigest },
  };
  writeFileSync(path.join(targetDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read and validate a project backup's manifest. */
export function readProjectBackupManifest(backupDir: string): ProjectBackupManifest {
  const file = path.join(path.resolve(backupDir), MANIFEST_FILE);
  if (!existsSync(file)) throw new MeritRouterError("not_found", `${backupDir} is not a complete project backup (no ${MANIFEST_FILE})`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new MeritRouterError("usage", `cannot parse ${file}: ${(err as Error).message}`);
  }
  const r = ProjectBackupManifestSchema.safeParse(raw);
  if (!r.success) throw new MeritRouterError("usage", `invalid project backup manifest ${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/**
 * Restore a project backup into the project's *current* registration (never a path or identity
 * read from the backup itself). Refuses when the current registration's identity or generation
 * disagrees with the manifest, when it is not `registered` (migrating/retired), when it belongs
 * to another installation, and while a live task lease or execution claim is held. Every refusal
 * happens before anything changes; existing entries are moved aside under `force`, never deleted.
 */
export function restoreProjectStore(coordinationDb: Db, input: ProjectRestoreOptions): ProjectRestoreResult {
  const opts = ProjectRestoreOptionsSchema.parse(input);
  const now = opts.now ?? Date.now();
  const backupDir = path.resolve(opts.backupDir);
  const manifest = readProjectBackupManifest(backupDir);
  const snapshot = path.join(backupDir, DB_FILE);
  if (!existsSync(snapshot)) throw new MeritRouterError("not_found", `backup ${backupDir} has no ${DB_FILE}`);
  if (sha256File(snapshot) !== manifest.digests.db) throw new MeritRouterError("usage", `backup ${backupDir} failed its digest check: the database snapshot does not match the manifest`);
  const manifestFile = path.join(backupDir, PROJECT_MANIFEST_FILE);
  if (manifest.digests.projectManifest && (!existsSync(manifestFile) || sha256File(manifestFile) !== manifest.digests.projectManifest)) {
    throw new MeritRouterError("usage", `backup ${backupDir} failed its digest check: ${PROJECT_MANIFEST_FILE} does not match the manifest`);
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new MeritRouterError("usage", `backup schema version ${manifest.schemaVersion} is newer than this build (${SCHEMA_VERSION}); upgrade MeritRouter first`);
  }

  // The CURRENT registration owns the restore target; a backup never carries its own path.
  const registration = readProjectStoreRegistration(coordinationDb, manifest.identity.projectId);
  if (!registration) throw new MeritRouterError("not_found", `no current registration for project ${manifest.identity.projectId}; it may have been deleted`);
  if (
    registration.installationId !== manifest.identity.installationId ||
    registration.storeId !== manifest.identity.storeId ||
    registration.generation !== manifest.identity.generation ||
    registration.slug !== manifest.identity.slug
  ) {
    throw new MeritRouterError("conflict", `refusing to restore: this backup's identity/generation (installation ${manifest.identity.installationId}, store ${manifest.identity.storeId}, generation ${manifest.identity.generation}, slug ${manifest.identity.slug}) does not match the current registration (installation ${registration.installationId}, store ${registration.storeId}, generation ${registration.generation}, slug ${registration.slug})`);
  }
  if (registration.state !== "registered") {
    throw new MeritRouterError("conflict", `refusing to restore: project ${registration.slug}'s store is ${registration.state}, not registered`);
  }

  const paths = projectRuntimePaths(registration.projectDirectory);
  const live = liveLeases(paths.state, now);
  if (live.length) {
    throw new MeritRouterError("conflict", `refusing to restore: a worker holds live leases on ${live.length} task(s) (${live.slice(0, 5).map((l) => l.id).join(", ")}) in project ${registration.slug}; stop the worker first`);
  }
  const claims = liveExecutionClaims(paths.state, now);
  if (claims.length) {
    throw new MeritRouterError("conflict", `refusing to restore: project ${registration.slug} holds ${claims.length} live execution claim(s) (${claims.slice(0, 5).map((c) => c.grantId).join(", ")}); stop the worker first`);
  }

  const existing = ROOT_ENTRIES.filter((e) => existsSync(path.join(paths.root, e)));
  const occupied = existing.some((e) => e !== SESSIONS_DIR && e !== ARTIFACTS_DIR) || existing.some((e) => {
    const p = path.join(paths.root, e);
    return statSync(p).isDirectory() ? isNonEmptyDir(p) : true;
  });
  if (occupied && !opts.force) {
    throw new MeritRouterError("conflict", `refusing to restore over existing state in ${paths.root} (${existing.join(", ")}); pass --force to move it aside first`);
  }
  // Decided before anything moves: a dirty or occupied brain refuses the whole restore.
  const brainPlan = planBrainRestore(manifest.brain, backupDir, paths.brain, opts.force);

  mkdirSync(paths.root, { recursive: true });
  const staging = mkdtempSync(path.join(paths.root, ".project-restore-"));
  let stagedBrain: ReturnType<typeof stageBrainRestore> | undefined;
  let previousMovedTo: string | null = null;
  let leasesReleased = 0;
  let schemaVersion = 0;
  const moved: string[] = [];
  const installed: string[] = [];
  try {
    const stagedState = path.join(staging, "state");
    mkdirSync(stagedState, { recursive: true });
    copyFileSync(snapshot, path.join(stagedState, DB_FILE));
    for (const dir of [SESSIONS_DIR, ARTIFACTS_DIR]) {
      const from = path.join(backupDir, dir);
      if (existsSync(from)) cpSync(from, path.join(staging, dir), { recursive: true });
    }
    if (existsSync(manifestFile)) copyFileSync(manifestFile, path.join(staging, PROJECT_MANIFEST_FILE));

    const db = openDatabase(stagedState, { durability: "full" });
    try {
      leasesReleased = db.prepare("UPDATE tasks SET lease_expires_at = 0 WHERE state IN ('running','cancel_requested') AND lease_expires_at > 0").run().changes;
      schemaVersion = db.pragma("user_version", { simple: true }) as number;
      const expectedIdentity = ProjectStoreIdentitySchema.parse({ version: 1, role: "project", installationId: registration.installationId, projectId: registration.projectId, storeId: registration.storeId, generation: registration.generation, slug: registration.slug });
      assertStoreRole(db, expectedIdentity);
    } finally {
      db.close();
    }
    stagedBrain = stageBrainRestore(brainPlan, manifest.brain, backupDir);

    if (existing.length) {
      previousMovedTo = mkdtempSync(path.join(paths.root, `pre-restore-${new Date(now).toISOString().replace(/[:.]/g, "-")}-`));
      for (const entry of existing) {
        renameSync(path.join(paths.root, entry), path.join(previousMovedTo, entry));
        moved.push(entry);
      }
    }
    for (const entry of readdirSync(staging)) {
      renameSync(path.join(staging, entry), path.join(paths.root, entry));
      installed.push(entry);
    }
    const brain = restoreBrain(brainPlan, manifest.brain, backupDir, now, stagedBrain);
    return { manifest, projectDirectory: paths.projectDirectory, previousMovedTo, leasesReleased, schemaVersion, brain };
  } catch (error) {
    try {
      for (const entry of installed.reverse()) renameSync(path.join(paths.root, entry), path.join(staging, entry));
      for (const entry of moved.reverse()) renameSync(path.join(previousMovedTo!, entry), path.join(paths.root, entry));
      if (previousMovedTo) rmSync(previousMovedTo, { recursive: true, force: true });
    } catch (rollback) {
      throw new MeritRouterError("conflict", `project restore failed (${(error as Error).message}); rollback failed (${(rollback as Error).message}). Previous entries remain at ${previousMovedTo ?? paths.root}; recover them before restarting`);
    }
    throw error;
  } finally {
    if (stagedBrain) discardStagedBrainRestore(stagedBrain);
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* A locked staging folder may be cleaned up later. */ }
  }
}

export type { ProjectRuntimePaths };
