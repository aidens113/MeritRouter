import type { Db } from "../storage/db.js";
import type { ResolvedConfig } from "../config/load.js";
import type { ProjectInfo } from "../projects/context.js";

/**
 * The reserved internal project that qualification runs and eval-goal comparison runs work in.
 * Its fixture repositories live only in its context, so no user project lists them, and its
 * tasks, sessions, and brain folder (`projects/_qualification/`) stay out of every user project.
 * A user project's slug starts with a letter or digit, so this one never collides with it.
 */
export const QUALIFICATION_PROJECT = "_qualification";
export const SUPERVISOR_EVAL_INPUT_TOKENS = 16000;
export const SUPERVISOR_EVAL_OUTPUT_TOKENS = 8000;
export const SUPERVISOR_EVAL_CONTEXT_TOKENS = SUPERVISOR_EVAL_INPUT_TOKENS + SUPERVISOR_EVAL_OUTPUT_TOKENS;

/** Fixed internal inspect lane. This overlay never changes the user's inspect profile. */
export const SUPERVISOR_EVAL_PROFILE = {
  mode: "read_only" as const, min_total_parameters_b: 0.001, max_model_requests: 1,
  max_input_tokens: SUPERVISOR_EVAL_INPUT_TOKENS, max_output_tokens: SUPERVISOR_EVAL_OUTPUT_TOKENS, tools: "none" as const,
  workspace: "none" as const, requires_structured_output: false, classify: "never" as const,
  min_tier: "T1" as const, batching: { enabled: false, max_items: 2, per_item_output_tokens: SUPERVISOR_EVAL_OUTPUT_TOKENS },
};

/** The overlay of the qualification project's context: no configured repositories, its own brain folder. */
export function qualificationOverlay(cfg: ResolvedConfig): Record<string, unknown> {
  const project: ProjectInfo = { slug: QUALIFICATION_PROJECT, name: "Qualification", legacy: false };
  return { project, repositories: {}, repositoryPaths: {}, brain: { ...cfg.brain, project: QUALIFICATION_PROJECT } };
}

/**
 * Register a repository at runtime (a qualification or comparison fixture) in `cfg`, the
 * qualification project's context, and in the store, from which every process sharing it merges
 * the registry into its own qualification context (`syncRepositoryRegistry`).
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
