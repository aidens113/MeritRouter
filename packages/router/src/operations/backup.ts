import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { DB_FILE, SCHEMA_VERSION, openDatabase, type Db } from "../storage/db.js";
import { SwitchyardError } from "../core/errors.js";
import { logsDirFor, readDaemonLock } from "./daemon.js";
import { backupBrain, BrainManifestSchema, planBrainRestore, stageBrainRestore, discardStagedBrainRestore, restoreBrain, type BrainMountNote, type BrainRestoreResult } from "./brain-backup.js";

/**
 * Backup and restore of an install: an online SQLite snapshot of the store (consistent while a
 * worker runs; every project's rows), the session logs and artifacts it indexes, and the brain
 * repository as a git bundle (every project's folder and `global/`; see brain-backup.ts).
 * Worktrees, agent homes, qualification scratch, logs, and brain mounts are never included. The
 * vault's master key is included only on request, because a backup holding both the key and the
 * encrypted paid keys is a secret in itself.
 */

export const MANIFEST_FILE = "manifest.json";
/** 2 added the brain bundle; format 1 backups (store only) still restore. */
export const BACKUP_FORMAT = 2;
/** Storage entries a backup carries (relative to the storage directory). */
const SESSIONS_DIR = "sessions";
const ARTIFACTS_DIR = "artifacts";
const MASTER_KEY_FILE = ".master-key";
const DB_SIDECARS = [`${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`];

export const BackupManifestSchema = z
  .object({
    format: z.union([z.literal(1), z.literal(BACKUP_FORMAT)]),
    createdAt: z.string(),
    sourceStorageDir: z.string(),
    schemaVersion: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    sessionLogs: z.number().int().nonnegative(),
    artifactFiles: z.number().int().nonnegative(),
    includesMasterKey: z.boolean(),
    /** Indexed files the snapshot references but the copy could not find. */
    missing: z.array(z.string()),
    /** The brain repository (format 2; absent in format 1, null when no brain path was given). */
    brain: BrainManifestSchema.nullable().optional(),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const BackupOptionsSchema = z
  .object({
    storageDir: z.string().min(1),
    targetDir: z.string().min(1),
    includeMasterKey: z.boolean().default(false),
    /** The brain repository to bundle (omitted: the backup has no brain). */
    brainPath: z.string().min(1).optional(),
    /** Brain mounts to list in the manifest as not included. */
    brainMounts: z.array(z.object({ prefix: z.string(), path: z.string(), project: z.string().nullable() }).strict()).default([]),
  })
  .strict();
export type BackupOptions = z.input<typeof BackupOptionsSchema>;

export const RestoreOptionsSchema = z
  .object({
    backupDir: z.string().min(1),
    storageDir: z.string().min(1),
    force: z.boolean().default(false),
    /** Where to restore the backup's brain (omitted: the brain is left alone). */
    brainPath: z.string().min(1).optional(),
    now: z.number().int().optional(),
  })
  .strict();
export type RestoreOptions = z.input<typeof RestoreOptionsSchema>;

export interface RestoreResult {
  manifest: BackupManifest;
  storageDir: string;
  /** Where the replaced storage entries were moved, when anything was replaced. */
  previousMovedTo: string | null;
  /** Running tasks whose leases were expired so the next worker recovers them. */
  leasesReleased: number;
  schemaVersion: number;
  /** What happened to the brain (restored, already current, or skipped and why). */
  brain: BrainRestoreResult;
}

const isNonEmptyDir = (dir: string) => existsSync(dir) && readdirSync(dir).length > 0;

function countRows(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function hasTable(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** Copy one file, keeping only whole lines of a log that a writer may be appending to. */
function copySessionLog(src: string, dst: string): void {
  const data = readFileSync(src);
  const end = data.lastIndexOf(0x0a);
  writeFileSync(dst, end === data.length - 1 || end < 0 ? data : data.subarray(0, end + 1));
}

function fsyncFile(file: string): void {
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Snapshot `storageDir` into `targetDir` (created when missing; refused when not empty). The
 * database is copied first with SQLite's online backup, then the session logs and artifacts, so
 * every session and artifact the snapshot indexes has its file. The manifest is written last: a
 * directory without one is an incomplete backup.
 */
export async function backupStorage(input: BackupOptions): Promise<BackupManifest> {
  const opts = BackupOptionsSchema.parse(input);
  const storageDir = path.resolve(opts.storageDir);
  const targetDir = path.resolve(opts.targetDir);
  const dbPath = path.join(storageDir, DB_FILE);
  if (!existsSync(dbPath)) throw new SwitchyardError("not_found", `no database at ${dbPath}; nothing to back up`);
  if (targetDir === storageDir || targetDir.startsWith(storageDir + path.sep)) {
    throw new SwitchyardError("usage", `backup directory ${targetDir} must be outside the storage directory ${storageDir}`);
  }
  if (isNonEmptyDir(targetDir)) throw new SwitchyardError("usage", `backup directory ${targetDir} is not empty; choose a new directory`);
  mkdirSync(targetDir, { recursive: true });

  // 1. Online snapshot. A plain connection (no migrations) so the backup never changes the source.
  const snapshotPath = path.join(targetDir, DB_FILE);
  const source = new Database(dbPath, { fileMustExist: true });
  try {
    source.pragma("busy_timeout = 10000");
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }

  // 2. Make the snapshot a self-contained file and read what it indexes.
  const snap = new Database(snapshotPath, { fileMustExist: true });
  let schemaVersion: number;
  let tasks = 0;
  let sessions = 0;
  let artifacts = 0;
  let logPaths: string[] = [];
  let artifactPaths: string[] = [];
  try {
    snap.pragma("journal_mode = DELETE");
    const check = snap.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new SwitchyardError("internal", `snapshot failed its integrity check: ${String(check)}`);
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
  const sessionsSrc = path.join(storageDir, SESSIONS_DIR);
  if (existsSync(sessionsSrc)) {
    const dst = path.join(targetDir, SESSIONS_DIR);
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(sessionsSrc)) {
      const from = path.join(sessionsSrc, name);
      if (!name.endsWith(".jsonl") || !statSync(from).isFile()) continue;
      copySessionLog(from, path.join(dst, name));
      sessionLogs++;
    }
  }

  // 4. Artifacts (written before their row, so a snapshot row always has its file).
  let artifactFiles = 0;
  const artifactsSrc = path.join(storageDir, ARTIFACTS_DIR);
  if (existsSync(artifactsSrc)) {
    cpSync(artifactsSrc, path.join(targetDir, ARTIFACTS_DIR), { recursive: true });
    artifactFiles = countFiles(path.join(targetDir, ARTIFACTS_DIR));
  }

  const masterKey = path.join(storageDir, MASTER_KEY_FILE);
  const includesMasterKey = opts.includeMasterKey && existsSync(masterKey);
  if (includesMasterKey) copyFileSync(masterKey, path.join(targetDir, MASTER_KEY_FILE));

  const brainMounts: BrainMountNote[] = opts.brainMounts;
  const brain = opts.brainPath ? backupBrain(opts.brainPath, targetDir, brainMounts) : null;

  const missing = [
    ...logPaths.filter((p) => !path.isAbsolute(p) && !existsSync(path.join(targetDir, ...p.split("/")))),
    ...artifactPaths.filter((p) => !existsSync(path.join(targetDir, ARTIFACTS_DIR, ...p.split("/")))).map((p) => `${ARTIFACTS_DIR}/${p}`),
  ];

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    sourceStorageDir: storageDir,
    schemaVersion,
    tasks,
    sessions,
    artifacts,
    sessionLogs,
    artifactFiles,
    includesMasterKey,
    missing,
    brain,
  };
  const manifestPath = path.join(targetDir, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fsyncFile(snapshotPath);
  fsyncFile(manifestPath);
  return manifest;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

/** Read and validate a backup's manifest. */
export function readBackupManifest(backupDir: string): BackupManifest {
  const file = path.join(path.resolve(backupDir), MANIFEST_FILE);
  if (!existsSync(file)) throw new SwitchyardError("not_found", `${backupDir} is not a complete SwitchYard backup (no ${MANIFEST_FILE})`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new SwitchyardError("usage", `cannot parse ${file}: ${(err as Error).message}`);
  }
  const r = BackupManifestSchema.safeParse(raw);
  if (!r.success) throw new SwitchyardError("usage", `invalid backup manifest ${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** Tasks a live worker holds (an unexpired lease) in the database under `storageDir`. */
export function liveLeases(storageDir: string, now = Date.now()): Array<{ id: string; owner: string | null; expiresAt: number }> {
  const dbPath = path.join(storageDir, DB_FILE);
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 10000");
    if (!hasTable(db, "tasks")) return [];
    return (
      db
        .prepare("SELECT id, lease_owner, lease_expires_at FROM tasks WHERE state IN ('running','cancel_requested') AND lease_expires_at > ?")
        .all(now) as Array<{ id: string; lease_owner: string | null; lease_expires_at: number }>
    ).map((r) => ({ id: r.id, owner: r.lease_owner, expiresAt: r.lease_expires_at }));
  } finally {
    db.close();
  }
}

/** Storage entries a restore replaces. */
const RESTORED_ENTRIES = [DB_FILE, ...DB_SIDECARS, SESSIONS_DIR, ARTIFACTS_DIR];

/**
 * Restore a backup into `storageDir` and, given `brainPath`, its brain. Refused while a worker
 * holds live leases on the current database or a daemon runs for it, over a brain with
 * uncommitted changes (always), and over existing state unless `force` is set; with `force`, the
 * replaced storage entries are moved to `<storage>/pre-restore-<time>/` and a replaced brain to
 * `<brain>.pre-restore-<time>`, never deleted. Every refusal happens before anything changes. The
 * restored database is migrated to this build's schema, and tasks that were running at backup
 * time have their leases expired so the next worker recovers them.
 */
export function restoreStorage(input: RestoreOptions): RestoreResult {
  const opts = RestoreOptionsSchema.parse(input);
  const now = opts.now ?? Date.now();
  const backupDir = path.resolve(opts.backupDir);
  const storageDir = path.resolve(opts.storageDir);
  const manifest = readBackupManifest(backupDir);
  const snapshot = path.join(backupDir, DB_FILE);
  if (!existsSync(snapshot)) throw new SwitchyardError("not_found", `backup ${backupDir} has no ${DB_FILE}`);
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new SwitchyardError("usage", `backup schema version ${manifest.schemaVersion} is newer than this build (${SCHEMA_VERSION}); upgrade SwitchYard first`);
  }

  const daemon = readDaemonLock(logsDirFor(storageDir));
  if (daemon?.alive && daemon.pid !== process.pid) {
    throw new SwitchyardError("conflict", `refusing to restore: a daemon (pid ${daemon.pid}) is running for ${storageDir}; stop it first`);
  }
  const live = liveLeases(storageDir, now);
  if (live.length) {
    throw new SwitchyardError(
      "conflict",
      `refusing to restore: a worker holds live leases on ${live.length} task(s) (${live.slice(0, 5).map((l) => l.id).join(", ")}); stop the worker, MCP server, and daemon first`,
    );
  }
  const existing = RESTORED_ENTRIES.filter((e) => existsSync(path.join(storageDir, e)));
  const occupied = existing.some((e) => e !== SESSIONS_DIR && e !== ARTIFACTS_DIR) || existing.some((e) => isNonEmptyDir(path.join(storageDir, e)));
  if (occupied && !opts.force) {
    throw new SwitchyardError("conflict", `refusing to restore over existing state in ${storageDir} (${existing.join(", ")}); pass --force to move it aside first`);
  }
  // Decided before anything moves: a dirty or occupied brain refuses the whole restore.
  const brainPlan = planBrainRestore(manifest.brain, backupDir, opts.brainPath, opts.force);

  // Stage migration, copied files and the verified brain before any live entry moves.
  mkdirSync(path.dirname(storageDir), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(storageDir), ".switchyard-restore-"));
  let stagedBrain: ReturnType<typeof stageBrainRestore> | undefined;
  let previousMovedTo: string | null = null;
  let leasesReleased = 0;
  let schemaVersion = 0;
  const moved: string[] = [];
  const installed: string[] = [];
  const storageExisted = existsSync(storageDir);
  try {
    copyFileSync(snapshot, path.join(staging, DB_FILE));
    for (const dir of [SESSIONS_DIR, ARTIFACTS_DIR]) {
      const from = path.join(backupDir, dir);
      if (existsSync(from)) cpSync(from, path.join(staging, dir), { recursive: true });
    }
    const key = path.join(backupDir, MASTER_KEY_FILE);
    if (manifest.includesMasterKey && existsSync(key) && !existsSync(path.join(storageDir, MASTER_KEY_FILE))) copyFileSync(key, path.join(staging, MASTER_KEY_FILE));
    const db = openDatabase(staging);
    try {
      leasesReleased = db.prepare("UPDATE tasks SET lease_expires_at = 0 WHERE state IN ('running','cancel_requested') AND lease_expires_at > 0").run().changes;
      schemaVersion = db.pragma("user_version", { simple: true }) as number;
    } finally { db.close(); }
    stagedBrain = stageBrainRestore(brainPlan, manifest.brain, backupDir);

    mkdirSync(storageDir, { recursive: true });
    if (existing.length) {
      previousMovedTo = mkdtempSync(path.join(storageDir, `pre-restore-${new Date(now).toISOString().replace(/[:.]/g, "-")}-`));
      for (const entry of existing) {
        renameSync(path.join(storageDir, entry), path.join(previousMovedTo, entry));
        moved.push(entry);
      }
    }
    for (const entry of readdirSync(staging)) {
      renameSync(path.join(staging, entry), path.join(storageDir, entry));
      installed.push(entry);
    }
    const brain = restoreBrain(brainPlan, manifest.brain, backupDir, now, stagedBrain);
    return { manifest, storageDir, previousMovedTo, leasesReleased, schemaVersion, brain };
  } catch (error) {
    // Move only entries installed by this attempt, then return each original entry. Never
    // delete the previous-state directory if rollback cannot complete; report its location.
    try {
      for (const entry of installed.reverse()) renameSync(path.join(storageDir, entry), path.join(staging, entry));
      for (const entry of moved.reverse()) renameSync(path.join(previousMovedTo!, entry), path.join(storageDir, entry));
      if (previousMovedTo) rmdirSync(previousMovedTo);
      if (!storageExisted && existsSync(storageDir) && !readdirSync(storageDir).length) rmdirSync(storageDir);
    } catch (rollback) {
      throw new SwitchyardError("conflict", `restore failed (${(error as Error).message}); store rollback failed (${(rollback as Error).message}). Previous entries remain at ${previousMovedTo ?? storageDir}; recover them before restarting`);
    }
    throw error;
  } finally {
    if (stagedBrain) discardStagedBrainRestore(stagedBrain);
    // A cleanup failure must not turn a successfully committed restore into a partial rollback.
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* A locked staging folder may be cleaned up later. */ }
  }
}
