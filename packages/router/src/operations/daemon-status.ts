import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ResolvedConfig } from "../config/load.js";
import { databasePath } from "../storage/db.js";
import { logsDirFor, readDaemonLock, type DaemonLock } from "./daemon.js";

/**
 * `meritrouter daemon status`: the install's daemon (from its lock file) and, per project, the
 * tasks its one worker has queued and running. Read straight from the store, read-only, so it
 * works whether or not a daemon runs and never opens a MeritRouter.
 */

/** The same state groups the panel's project cards count (admin/projects.ts). */
const RUNNING = ["running", "cancel_requested"];
const QUEUED = ["queued", "waiting_for_dependencies", "waiting_for_capacity"];

export interface ProjectQueue {
  project: string;
  name: string | null;
  /** Not in the config: the reserved `_qualification` project, or rows of a removed project. */
  configured: boolean;
  archived: boolean;
  queued: number;
  running: number;
}

export interface DaemonStatus {
  storageDir: string;
  configPath: string;
  daemon: (DaemonLock & { alive: boolean }) | null;
  projects: ProjectQueue[];
  totals: { queued: number; running: number };
}

export function daemonStatus(cfg: Pick<ResolvedConfig, "storageDir" | "configPath" | "projectResolution">): DaemonStatus {
  const configured = new Map(cfg.projectResolution.projects.map((p) => [p.slug, p.name]));
  const counts = new Map<string, { queued: number; running: number }>();
  const archived = new Set<string>();
  const dbPath = databasePath(cfg.storageDir);
  if (existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const hasProjectColumn = has("tasks") && (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "project_id");
      if (has("tasks")) {
        const marks = (xs: string[]) => xs.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT ${hasProjectColumn ? "project_id" : "''"} AS project, SUM(state IN (${marks(QUEUED)})) AS queued, SUM(state IN (${marks(RUNNING)})) AS running
             FROM tasks WHERE state IN (${marks([...QUEUED, ...RUNNING])}) GROUP BY 1`,
          )
          .all(...QUEUED, ...RUNNING, ...QUEUED, ...RUNNING) as Array<{ project: string; queued: number; running: number }>;
        for (const r of rows) {
          // Rows from before projects belong to the primary project (the next start backfills them).
          const slug = r.project || cfg.projectResolution.primary;
          const c = counts.get(slug) ?? { queued: 0, running: 0 };
          counts.set(slug, { queued: c.queued + (r.queued ?? 0), running: c.running + (r.running ?? 0) });
        }
      }
      if (has("projects")) {
        for (const r of db.prepare("SELECT id FROM projects WHERE archived_at IS NOT NULL").all() as Array<{ id: string }>) archived.add(r.id);
      }
    } finally {
      db.close();
    }
  }
  const slugs = [...configured.keys(), ...[...counts.keys()].filter((s) => !configured.has(s)).sort()];
  const projects = slugs.map((slug) => ({
    project: slug,
    name: configured.get(slug) ?? null,
    configured: configured.has(slug),
    archived: archived.has(slug),
    queued: counts.get(slug)?.queued ?? 0,
    running: counts.get(slug)?.running ?? 0,
  }));
  return {
    storageDir: cfg.storageDir,
    configPath: cfg.configPath,
    daemon: readDaemonLock(logsDirFor(cfg.storageDir)),
    projects,
    totals: { queued: projects.reduce((n, p) => n + p.queued, 0), running: projects.reduce((n, p) => n + p.running, 0) },
  };
}
