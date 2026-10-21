import path from "node:path";
import { SwitchyardError } from "../core/errors.js";

// Which project a CLI command or the MCP server works in (docs/working/projects.md, D8 and the
// CLI design): an explicit flag, then SWITCHYARD_PROJECT, then the only project, then the
// project whose repository contains the working directory. Archived projects are never chosen
// implicitly, but an explicit flag may still name one (its data stays readable).

export const PROJECT_ENV = "SWITCHYARD_PROJECT";

/** What the selection needs to know about a project. */
export interface SelectableProject {
  slug: string;
  repositoryPaths: Record<string, { path: string }>;
  archived?: boolean;
}

export type ProjectChoiceSource = "flag" | "env" | "only" | "cwd";

export interface ProjectChoice {
  slug: string;
  source: ProjectChoiceSource;
}

export interface SelectOptions {
  /** `--project <slug>`. */
  flag?: string | undefined;
  /** `SWITCHYARD_PROJECT` (pass `undefined` to ignore the environment). */
  env?: string | undefined;
  /** The working directory to infer from. */
  cwd: string;
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

/** Depth of `dir` inside `root` (0 = the root itself), or -1 when it is outside. */
function depthInside(root: string, dir: string): number {
  const rel = path.relative(norm(root), norm(dir));
  if (rel === "") return 0;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return -1;
  return rel.split(path.sep).length;
}

/**
 * The projects whose repositories contain `cwd`, deepest repository first. A directory inside a
 * nested repository belongs to the project of the innermost one.
 */
export function projectsContaining(projects: SelectableProject[], cwd: string): Array<{ slug: string; alias: string; root: string }> {
  const hits: Array<{ slug: string; alias: string; root: string }> = [];
  for (const p of projects) {
    for (const [alias, repo] of Object.entries(p.repositoryPaths)) if (depthInside(repo.path, cwd) >= 0) hits.push({ slug: p.slug, alias, root: norm(repo.path) });
  }
  return hits.sort((a, b) => b.root.length - a.root.length);
}

/** Every project, for error messages: `alpha, beta (archived)`. */
export function describeProjects(projects: SelectableProject[]): string {
  return projects.length ? projects.map((p) => `${p.slug}${p.archived ? " (archived)" : ""}`).join(", ") : "none";
}

/**
 * Choose a project, or return null when none can be chosen without guessing (several projects
 * and the working directory is in none of their repositories, or in repositories of several).
 * A flag or environment value naming an unknown project is an error.
 */
export function chooseProject(projects: SelectableProject[], opts: SelectOptions): ProjectChoice | null {
  const known = (slug: string, from: string): string => {
    if (!projects.some((p) => p.slug === slug)) throw new SwitchyardError("usage", `unknown project ${slug} (from ${from}); projects: ${describeProjects(projects)}`);
    return slug;
  };
  if (opts.flag) return { slug: known(opts.flag, "--project"), source: "flag" };
  if (opts.env) return { slug: known(opts.env, PROJECT_ENV), source: "env" };
  const live = projects.filter((p) => !p.archived);
  if (live.length === 1) return { slug: live[0]!.slug, source: "only" };
  const hits = projectsContaining(live, opts.cwd);
  if (!hits.length) return null;
  // The innermost repository wins; the same directory in two projects is ambiguous.
  const slugs = [...new Set(hits.filter((h) => h.root === hits[0]!.root).map((h) => h.slug))];
  return slugs.length === 1 ? { slug: slugs[0]!, source: "cwd" } : null;
}

/** `chooseProject`, but a missing choice is an error that lists the projects and how to pick one. */
export function requireProject(projects: SelectableProject[], opts: SelectOptions): ProjectChoice {
  const c = chooseProject(projects, opts);
  if (c) return c;
  const inside = projectsContaining(projects.filter((p) => !p.archived), opts.cwd);
  const why = inside.length ? `the working directory is inside repositories of several projects (${[...new Set(inside.map((h) => h.slug))].join(", ")})` : "the working directory is not inside any project's repository";
  throw new SwitchyardError("usage", `this install has several projects and ${why}; pass --project <slug> or set ${PROJECT_ENV}. Projects: ${describeProjects(projects)}`);
}
