import { LabRecipeSchema, ProjectLabsSchema } from "../labs/recipe.js";
import { z } from "zod";
import { BrainModeSchema, REPOSITORY_ALIAS_RE, RepositorySchema, RoleNameSchema, RoleSchema, TierNameSchema } from "../config/schema.js";

/**
 * `projects.<slug>` in the global config (decision D2 of docs/working/projects.md): a project's
 * repositories, its brain mounts and access settings, and overrides of the project-scoped
 * settings. Every other section (providers, models, routing, budgets, profiles, execution) is
 * global. Overrides are merged onto the global section and the result is validated with that
 * section's own schema (see `resolveProjects`).
 */

/** Keys of `team` a project may override (provider concurrency stays global). */
export const PROJECT_TEAM_KEYS = ["max_agents", "max_depth", "child_budget_share", "channel_max_posts_per_task", "channel_max_posts_per_supervisor", "channel_max_post_chars", "default_task_requests", "supervisor_reserve_requests", "budget_approver", "budget_request_wait_seconds", "max_budget_requests_per_task", "auto_grant_max"] as const;
/** Keys of `coding` a project may override. */
export const PROJECT_CODING_KEYS = ["allowed_commands", "protected_paths", "max_check_runs_per_task"] as const;
/** Keys of `supervisor` a project may override. */
export const PROJECT_SUPERVISOR_KEYS = ["allowed_commands", "branch_prefix", "implementation", "coordination_paths"] as const;

/** An override: only the listed keys, values validated after merging (see `resolveProjects`). */
const overrideOf = (keys: readonly string[]) =>
  z
    .record(z.string(), z.unknown())
    .superRefine((o, ctx) => {
      for (const k of Object.keys(o)) if (!keys.includes(k)) ctx.addIssue({ code: "custom", path: [k], message: `not a project setting; allowed: ${keys.join(", ")} (the rest is global)` });
    })
    .optional();

const MountSchema = z.object({ prefix: z.string().min(1), path: z.string().min(1), commit: z.boolean().default(false) }).strict();

/**
 * A project's share of the one worker and of the global budgets (decisions D5 and D7). Every
 * field is optional; unset means no per-project limit. Global caps (`execution`, `allocation`,
 * `paid.budgets`), provider slots, and leases always apply on top.
 */
export const ProjectLimitsSchema = z.object({
  /** Fair-share weight when claiming tasks: a project of priority 2 is served twice as often as one of 1 while both have ready tasks. */
  priority: z.number().positive().max(100).default(1),
  /** Most worker tasks of this project running at once (supervisors are bounded by `supervisor.max_concurrent_jobs`). */
  max_concurrent_tasks: z.number().int().positive().optional(),
  /** Paid spend this project may use, in USD per rolling window, within the global `paid.budgets`. */
  paid_budgets: z
    .object({
      per_day_usd: z.number().min(0).optional(),
      per_week_usd: z.number().min(0).optional(),
      per_month_usd: z.number().min(0).optional(),
    })
    .strict()
    .optional(),
  /** Fraction of the package allocation (`allocation.max_model_requests_per_hour`/`_per_day`) this project may use. */
  request_share: z.number().gt(0).max(1).optional(),
});
export type ProjectLimits = z.infer<typeof ProjectLimitsSchema>;

const NO_LIMITS: ProjectLimits = { priority: 1 };

/**
 * A project's limits read from the raw `projects.<slug>` entry (validated at load by
 * `ProjectConfigSchema`). A project with no entry (the single-project shape, or rows of a
 * project no longer configured) has no limits and priority 1.
 */
export function projectLimits(cfg: { projects: Record<string, unknown> }, slug: string): ProjectLimits {
  const raw = cfg.projects[slug];
  if (!raw || typeof raw !== "object") return NO_LIMITS;
  const parsed = ProjectLimitsSchema.safeParse(raw);
  return parsed.success ? parsed.data : NO_LIMITS;
}

export const ProjectConfigSchema = z
  .object({
    ...ProjectLimitsSchema.shape,
    /** Display name (defaults to the slug). */
    name: z.string().min(1).max(80).optional(),
    /** Owner directory for project runtime data; relative to the config file. Does not activate relocation. */
    directory: z.string().trim().min(1).max(4096).refine((value) => !/[\u0000-\u001f]/.test(value), "project directory cannot contain control characters").optional(),
    lab: LabRecipeSchema.optional(),
    labs: ProjectLabsSchema.prefault({}),
    /** Repositories by alias; users write the bare alias, MeritRouter keys it `<project>/<alias>` internally. */
    repositories: z.record(z.string().regex(REPOSITORY_ALIAS_RE), RepositorySchema).default({}),
    brain: z
      .object({
        /** Brain path prefixes mapped to folders for this project (added to the global brain.mounts). */
        mounts: z.array(MountSchema).default([]),
        access_approver: z.enum(["supervisor", "human", "auto"]).optional(),
        auto_approve: z.array(z.object({ pattern: z.string().min(1), mode: BrainModeSchema, min_tier: TierNameSchema.default("T1") }).strict()).optional(),
      })
      .strict()
      .prefault({}),
    /** Deep-merged onto the global `verification` section (arrays replace). */
    verification: z.record(z.string(), z.unknown()).optional(),
    team: overrideOf(PROJECT_TEAM_KEYS),
    coding: overrideOf(PROJECT_CODING_KEYS),
    supervisor: overrideOf(PROJECT_SUPERVISOR_KEYS),
    /** Per-role charters and brain grants; a role given here replaces the global entry for that role. */
    roles: z.partialRecord(RoleNameSchema, RoleSchema).optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
