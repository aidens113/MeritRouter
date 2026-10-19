import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Db = Database.Database;

export const DB_FILE = "switchyard.db";

export function openDatabase(storageDir: string, opts: { readonly?: boolean } = {}): Db {
  mkdirSync(storageDir, { recursive: true });
  const db = new Database(path.join(storageDir, DB_FILE), { readonly: opts.readonly ?? false });
  db.pragma("busy_timeout = 10000");
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    migrate(db);
  }
  return db;
}

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
