import { validateRecipe } from "../labs/recipe.js";
import path from "node:path";
import type { z } from "zod";
import { CodingConfigSchema, SupervisorConfigSchema, TeamConfigSchema, VerificationConfigSchema, type RawConfig } from "../config/schema.js";
import { ProjectConfigSchema } from "./schema.js";

/** A repository resolved against the config file's directory. */
export type ResolvedRepositories = Record<string, { path: string; writable: boolean }>;

/** Project-scoped sections that differ from the global ones (only these are overlaid). */
export type ProjectOverrides = Partial<Pick<RawConfig, "brain" | "verification" | "team" | "coding" | "supervisor" | "roles">>;

/** One project as read from the config: its identity, repositories, and section overrides. */
export interface ResolvedProject {
  slug: string;
  name: string;
  /** Read from the single-project shape (top-level `repositories` and `brain.project`, decision D3). */
  legacy: boolean;
  repositories: RawConfig["repositories"];
  repositoryPaths: ResolvedRepositories;
  overrides: ProjectOverrides;
}

export interface ProjectsResolution {
  projects: ResolvedProject[];
  /** The project that owns rows from before projects existed and system tasks submitted without one. */
  primary: string;
}

export interface ProjectIssue {
  path: PropertyKey[];
  message: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Merge `over` onto `base`: plain objects merge key by key, anything else (arrays included) replaces. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function resolveRepositories(repos: RawConfig["repositories"], baseDir: string): ResolvedRepositories {
  const out: ResolvedRepositories = {};
  for (const [alias, repo] of Object.entries(repos)) out[alias] = { path: path.resolve(baseDir, repo.path), writable: repo.writable };
  return out;
}

/**
 * Read the projects of a parsed config. With no `projects` section the config is one project
 * named `brain.project` that owns the top-level repositories (users of a single-project config
 * notice nothing). With `projects`, each entry's overrides are merged onto the global sections
 * and validated with their schemas; problems are returned as issues, never thrown.
 */
export function resolveProjects(cfg: RawConfig, baseDir: string): { resolution: ProjectsResolution; issues: ProjectIssue[] } {
  const entries = Object.entries(cfg.projects);
  if (!entries.length) {
    const slug = cfg.brain.project;
    return {
      resolution: { primary: slug, projects: [{ slug, name: slug, legacy: true, repositories: cfg.repositories, repositoryPaths: resolveRepositories(cfg.repositories, baseDir), overrides: {} }] },
      issues: [],
    };
  }
  const issues: ProjectIssue[] = [];
  if (Object.keys(cfg.repositories).length) {
    issues.push({ path: ["repositories"], message: "top-level repositories cannot be combined with projects; move them under projects.<slug>.repositories" });
  }
  const projects: ResolvedProject[] = [];
  for (const [slug, raw] of entries) {
    const parsed = ProjectConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      for (const i of parsed.error.issues) issues.push({ path: ["projects", slug, ...i.path], message: i.message });
      continue;
    }
    const p = parsed.data;
    if (p.lab) {
      try {
        validateRecipe(p.lab, Object.keys(p.repositories));
      } catch (err) {
        issues.push({ path: ["projects", slug, "lab"], message: (err as Error).message });
      }
    }
    const overrides: ProjectOverrides = {
      brain: {
        ...cfg.brain,
        project: slug,
        mounts: [...cfg.brain.mounts, ...p.brain.mounts],
        access_approver: p.brain.access_approver ?? cfg.brain.access_approver,
        auto_approve: p.brain.auto_approve ?? cfg.brain.auto_approve,
      },
    };
    const section = <S extends z.ZodType>(name: "verification" | "team" | "coding" | "supervisor", schema: S, override: Record<string, unknown> | undefined): z.output<S> | undefined => {
      if (!override) return undefined;
      const merged = schema.safeParse(deepMerge(cfg[name], override));
      if (merged.success) return merged.data;
      for (const i of merged.error.issues) issues.push({ path: ["projects", slug, name, ...i.path], message: i.message });
      return undefined;
    };
    const verification = section("verification", VerificationConfigSchema, p.verification);
    const team = section("team", TeamConfigSchema, p.team);
    const coding = section("coding", CodingConfigSchema, p.coding);
    const supervisor = section("supervisor", SupervisorConfigSchema, p.supervisor);
    if (verification) overrides.verification = verification;
    if (team) overrides.team = team;
    if (coding) overrides.coding = coding;
    if (supervisor) overrides.supervisor = supervisor;
    if (p.roles) overrides.roles = { ...cfg.roles, ...p.roles };
    projects.push({ slug, name: p.name ?? slug, legacy: false, repositories: p.repositories, repositoryPaths: resolveRepositories(p.repositories, baseDir), overrides });
  }
  const primary = cfg.projects[cfg.brain.project] !== undefined ? cfg.brain.project : entries[0]![0];
  return { resolution: { projects, primary }, issues };
}
