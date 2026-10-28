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
  /** Explicit owner, single distinct repository default, or null when ambiguous. No storage relocation. */
  directory: string | null;
  /** Read from the single-project shape (top-level `repositories` and `brain.project`, decision D3). */
  legacy: boolean;
  repositories: RawConfig["repositories"];
  repositoryPaths: ResolvedRepositories;
  overrides: ProjectOverrides;
}

export interface ProjectsResolution {
  projects: ResolvedProject[];
  /**
   * The project that owns rows from before projects existed and system tasks submitted without
   * one. Empty when a split installation has no project configured yet (decision: `setup` writes
   * none; the first one created, by any entry point, becomes primary through the ordinary
   * fallback below).
   */
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

/** Pure lexical ownership metadata; activation must separately verify filesystem containment. */
function projectDirectory(explicit: string | undefined, repositories: ResolvedRepositories, baseDir: string): string | null {
  if (explicit !== undefined) return path.resolve(baseDir, explicit);
  const paths = new Map(Object.values(repositories).map((repo) => [process.platform === "win32" ? repo.path.toLowerCase() : repo.path, repo.path]));
  return paths.size === 1 ? paths.values().next().value! : null;
}

function containsDirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
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
    // A split installation may start with no project at all (no single-project repositories to
    // adopt either): `setup` writes none, and this is not the single-project legacy shape. The
    // first project any entry point creates becomes primary through the ordinary fallback below,
    // once `cfg.projects` holds it.
    if (cfg.storage.layout === "split" && !Object.keys(cfg.repositories).length) {
      return { resolution: { projects: [], primary: "" }, issues: [] };
    }
    const slug = cfg.brain.project;
    const repositoryPaths = resolveRepositories(cfg.repositories, baseDir);
    return {
      resolution: { primary: slug, projects: [{ slug, name: slug, directory: projectDirectory(undefined, repositoryPaths, baseDir), legacy: true, repositories: cfg.repositories, repositoryPaths, overrides: {} }] },
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
    if (p.labs.ephemeral.enabled) {
      if (!p.lab) issues.push({ path: ["projects", slug, "labs", "ephemeral"], message: "enabled task Labs require a project Lab recipe" });
      for (const name of p.labs.ephemeral.checks) if (!p.lab || !Object.hasOwn(p.lab.checks, name)) {
        issues.push({ path: ["projects", slug, "labs", "ephemeral", "checks"], message: `unknown declared Lab check ${name}` });
      }
    }
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
    const repositoryPaths = resolveRepositories(p.repositories, baseDir);
    const directory = projectDirectory(p.directory, repositoryPaths, baseDir);
    projects.push({ slug, name: p.name ?? slug, directory, legacy: false, repositories: p.repositories, repositoryPaths, overrides });
  }
  // Existing inferred roots retain compatibility. Explicit ownership cannot overlap another
  // known owner, even if the other project's owner came from a single repository default.
  for (let i = 0; i < projects.length; i++) {
    for (const other of projects.slice(i + 1)) {
      const current = projects[i]!;
      if (!current.directory || !other.directory) continue;
      const currentExplicit = (cfg.projects[current.slug] as { directory?: string } | undefined)?.directory !== undefined;
      const otherExplicit = (cfg.projects[other.slug] as { directory?: string } | undefined)?.directory !== undefined;
      if ((currentExplicit || otherExplicit) && (containsDirectory(current.directory, other.directory) || containsDirectory(other.directory, current.directory))) {
        issues.push({ path: ["projects", otherExplicit ? other.slug : current.slug, "directory"], message: `project directory ownership overlaps between ${current.slug} and ${other.slug}; choose distinct non-nested directories` });
      }
    }
  }
  const primary = cfg.projects[cfg.brain.project] !== undefined ? cfg.brain.project : entries[0]![0];
  return { resolution: { projects, primary }, issues };
}
