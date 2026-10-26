import type { ResolvedConfig } from "../config/load.js";

/** Who a project is. */
export interface ProjectInfo {
  slug: string;
  name: string;
  /** Read from the single-project config shape (decision D3). */
  legacy: boolean;
}

/**
 * The configuration a task of one project runs under: the global `ResolvedConfig` overlaid with
 * the project's repositories (`repositories`, `repositoryPaths`), its brain scope
 * (`brain.project`, mounts, access), and its overrides of `verification`, `team`, `coding`,
 * `supervisor`, and `roles`. Everything not overridden is read live from the global config, so a
 * config reload reaches every project. Runners, validation, context sources, and the brain read
 * project fields from here, never from the global config.
 */
export type ProjectContext = ResolvedConfig & { readonly project: ProjectInfo; readonly projectDirectory: string | null };

/**
 * Build a project context over `global`. `overlay` holds the keys that differ from the global
 * config (always `project`); the registry replaces its contents in place on reload, so a context
 * object stays valid for the life of the service.
 */
export function projectContext(global: ResolvedConfig, overlay: Record<string, unknown>): ProjectContext {
  if (!Object.prototype.hasOwnProperty.call(overlay, "projectDirectory")) overlay.projectDirectory = null;
  const has = (k: PropertyKey) => Object.prototype.hasOwnProperty.call(overlay, k);
  return new Proxy(global, {
    get: (t, k) => (has(k) ? overlay[k as string] : Reflect.get(t, k)),
    set: (t, k, v) => (has(k) ? ((overlay[k as string] = v), true) : Reflect.set(t, k, v)),
    has: (t, k) => has(k) || Reflect.has(t, k),
    ownKeys: (t) => [...new Set([...Reflect.ownKeys(t), ...Reflect.ownKeys(overlay)])],
    getOwnPropertyDescriptor: (t, k) => (has(k) ? { value: overlay[k as string], writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
  }) as ProjectContext;
}

/**
 * A repository's internal key (decision D6): `<project>/<alias>`, used in `tasks.writable_repo`,
 * `file_leases.repository`, and merge locks, so two projects may both have an `app` alias. Aliases
 * and slugs never contain `/`. An empty project (rows written outside a service) keeps the bare alias.
 */
export function repoKey(project: string, alias: string): string {
  return project ? `${project}/${alias}` : alias;
}

/** Split a repository key back into its project (null for a bare alias) and alias. */
export function splitRepoKey(key: string): { project: string | null; alias: string } {
  const i = key.indexOf("/");
  return i < 0 ? { project: null, alias: key } : { project: key.slice(0, i), alias: key.slice(i + 1) };
}
