import { readStoreIdentity,StoreIdentitySchema,type StoreIdentity } from "../projects/store-identity.js";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Db = Database.Database;

export const DB_FILE = "meritrouter.db";
/** Legacy explicit-storage compatibility; never discover or move an old installation. */
export const LEGACY_DB_FILE = "switchyard.db";
export function databasePath(storageDir: string): string {
  const canonical = path.join(storageDir, DB_FILE);
  const legacy = path.join(storageDir, LEGACY_DB_FILE);
  return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
}

/**
 * `storage.durability`: `normal` (SQLite `synchronous=NORMAL`; in WAL mode a power loss can drop
 * the last commits but never corrupts) or `full` (`synchronous=FULL`; every commit is on disk
 * before it returns). Session logs are fsynced per event either way.
 */
export type Durability = "normal" | "full";

export interface OpenDatabaseOptions {
  /** Existing registered stores must never be replaced by an empty database. */
  fileMustExist?: boolean;
  /** Verify immutable role/owner before any writable pragma or schema migration. Requires fileMustExist. */
  expectedIdentity?: StoreIdentity;
  readonly?: boolean;
  /** Defaults to `normal`. */
  durability?: Durability;
}

export function openDatabase(storageDir: string, opts: OpenDatabaseOptions = {}): Db {
  if(opts.expectedIdentity&&!opts.fileMustExist)throw new Error("Expected store identity requires existing-only open");
  if(!opts.fileMustExist)mkdirSync(storageDir, { recursive: true });
  const db = new Database(databasePath(storageDir), { readonly: opts.readonly ?? false,fileMustExist:opts.fileMustExist??false });
  try {
  if(opts.expectedIdentity){const expected=StoreIdentitySchema.parse(opts.expectedIdentity),actual=readStoreIdentity(db);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error("Existing store identity changed before migration");}
  db.pragma("busy_timeout = 10000");
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applyDurability(db, opts.durability ?? "normal");
    migrate(db);
  }
  return db;
  }catch(error){db.close();throw error;}
}

/** Set the connection's `synchronous` level (a per-connection pragma). */
export function applyDurability(db: Db, durability: Durability): void {
  db.pragma(`synchronous = ${durability === "full" ? "FULL" : "NORMAL"}`);
}

/** The schema version this build migrates to; a database with a higher `user_version` is newer. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
}

/** Run `fn` inside BEGIN IMMEDIATE so concurrent processes serialize on the write lock. */
export function immediate<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${t}${randomBytes(6).toString("hex")}`;
}
