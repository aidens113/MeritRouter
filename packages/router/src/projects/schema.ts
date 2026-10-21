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
export const PROJECT_TEAM_KEYS = ["max_agents", "max_depth", "child_budget_share", "channel_max_posts_per_task", "channel_max_posts_per_supervisor", "channel_max_post_chars"] as const;
/** Keys of `coding` a project may override. */
export const PROJECT_CODING_KEYS = ["allowed_commands", "protected_paths"] as const;
/** Keys of `supervisor` a project may override. */
export const PROJECT_SUPERVISOR_KEYS = ["allowed_commands", "branch_prefix"] as const;

/** An override: only the listed keys, values validated after merging (see `resolveProjects`). */
const overrideOf = (keys: readonly string[]) =>
  z
    .record(z.string(), z.unknown())
    .superRefine((o, ctx) => {
      for (const k of Object.keys(o)) if (!keys.includes(k)) ctx.addIssue({ code: "custom", path: [k], message: `not a project setting; allowed: ${keys.join(", ")} (the rest is global)` });
    })
    .optional();

const MountSchema = z.object({ prefix: z.string().min(1), path: z.string().min(1), commit: z.boolean().default(false) }).strict();

export const ProjectConfigSchema = z
  .object({
    /** Display name (defaults to the slug). */
    name: z.string().min(1).max(80).optional(),
    /** Repositories by alias; users write the bare alias, SwitchYard keys it `<project>/<alias>` internally. */
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
