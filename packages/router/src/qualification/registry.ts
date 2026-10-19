import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";

/**
 * Repositories registered at runtime (qualification fixtures). They are merged into the
 * config's alias table by every process that shares the store; configured aliases win.
 */
export function registerRepository(db: Db, cfg: ResolvedConfig, repo: { alias: string; path: string; writable: boolean; origin: string }): void {
  if (cfg.repositories[repo.alias]) throw new Error(`alias ${repo.alias} is already configured`);
  db.prepare("INSERT OR REPLACE INTO repository_registry (alias, path, writable, origin, created_at) VALUES (?, ?, ?, ?, ?)").run(repo.alias, repo.path, repo.writable ? 1 : 0, repo.origin, Date.now());
  cfg.repositoryPaths[repo.alias] = { path: repo.path, writable: repo.writable };
}

export function syncRepositoryRegistry(db: Db, cfg: ResolvedConfig): void {
  for (const r of db.prepare("SELECT alias, path, writable FROM repository_registry").all() as Array<{ alias: string; path: string; writable: number }>) {
    if (cfg.repositories[r.alias]) continue;
    cfg.repositoryPaths[r.alias] = { path: r.path, writable: r.writable === 1 };
  }
}
