import YAML from "yaml";
import { SwitchyardError } from "../core/errors.js";
import type { Switchyard } from "../core/service.js";
import { PROJECT_CODING_KEYS, PROJECT_SUPERVISOR_KEYS, PROJECT_TEAM_KEYS, ProjectConfigSchema } from "../projects/schema.js";
import { patchConfig, readConfigText } from "./config-edit.js";

// Settings split for the panel (decision D2): global sections (providers, models, routing,
// budgets, profiles, execution, ...) vs one project's settings, which live under
// `projects.<slug>` in the same config file and are edited through the same config editor.

/** Top-level keys of a project's settings (`projects.<slug>.<key>`), read from the project schema. */
export const PROJECT_SETTING_KEYS: readonly string[] = Object.keys(ProjectConfigSchema.shape);

/** Keys a project may set inside each restricted section (the rest of that section is global). */
const RESTRICTED: Record<string, readonly string[]> = {
  brain: ["mounts", "access_approver", "auto_approve"],
  team: PROJECT_TEAM_KEYS,
  coding: PROJECT_CODING_KEYS,
  supervisor: PROJECT_SUPERVISOR_KEYS,
};

/** Project settings that a single-project config holds as top-level sections. */
const LEGACY_TOP_LEVEL = new Set(["repositories", "brain", "verification", "team", "coding", "supervisor", "roles"]);

/** Keys of the resolved config that are not settings (derived at load time). */
const DERIVED = new Set(["configPath", "storageDir", "repositoryPaths", "projectResolution", "modelsPath", "rulebookPath"]);

export interface GlobalSettings {
  configPath: string;
  /** False for a single-project config, whose repositories are still a top-level section. */
  multiProject: boolean;
  /** Effective values (defaults included) of every global section, by top-level key. */
  sections: Record<string, unknown>;
}

/** Every global section's effective values; `projects` (and, with projects, `repositories`) are left out. */
export function globalSettings(sy: Switchyard): GlobalSettings {
  const multiProject = !sy.projects.list().some((c) => c.project.legacy);
  const cfg = sy.cfg as unknown as Record<string, unknown>;
  const sections: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (DERIVED.has(k) || k === "projects" || (multiProject && k === "repositories")) continue;
    sections[k] = v;
  }
  return { configPath: sy.cfg.configPath, multiProject, sections };
}

export interface ProjectSettings {
  slug: string;
  name: string;
  legacy: boolean;
  configPath: string;
  /** Where this project's settings sit in the file: `["projects", slug]`, or `[]` for a single-project config (top level). */
  configKeyPath: string[];
  /** What the file says for this project (no defaults); a single-project config shows its top-level repositories. */
  raw: Record<string, unknown>;
  /** Effective values: the project's repositories and the project-scoped sections after overrides. */
  effective: {
    repositories: Record<string, { path: string; writable: boolean }>;
    repositoryPaths: Record<string, { path: string; writable: boolean }>;
    brain: { project: string; mounts: unknown[]; access_approver: string; auto_approve: unknown[] };
    verification: unknown;
    team: Record<string, unknown>;
    coding: Record<string, unknown>;
    supervisor: Record<string, unknown>;
    roles: unknown;
  };
}

const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** One project's settings, as written and as effective. */
export function projectSettings(sy: Switchyard, slug: string): ProjectSettings {
  const ctx = sy.projects.get(slug);
  if (!ctx) throw new SwitchyardError("not_found", `unknown project ${slug}`);
  const legacy = ctx.project.legacy;
  const doc = YAML.parseDocument(readConfigText(sy));
  const node = (p: string[]) => (doc.getIn(p) as YAML.Node | undefined)?.toJSON?.() ?? (doc.getIn(p) as unknown);
  const raw = legacy ? { repositories: node(["repositories"]) ?? {} } : ((node(["projects", slug]) as Record<string, unknown> | null) ?? {});
  return {
    slug,
    name: ctx.project.name,
    legacy,
    configPath: sy.cfg.configPath,
    configKeyPath: legacy ? [] : ["projects", slug],
    raw,
    effective: {
      repositories: ctx.repositories as Record<string, { path: string; writable: boolean }>,
      repositoryPaths: ctx.repositoryPaths,
      brain: { project: ctx.brain.project, mounts: ctx.brain.mounts, access_approver: ctx.brain.access_approver, auto_approve: ctx.brain.auto_approve },
      verification: ctx.verification,
      team: pick(ctx.team as Record<string, unknown>, PROJECT_TEAM_KEYS),
      coding: pick(ctx.coding as Record<string, unknown>, PROJECT_CODING_KEYS),
      supervisor: pick(ctx.supervisor as Record<string, unknown>, PROJECT_SUPERVISOR_KEYS),
      roles: ctx.roles,
    },
  };
}

export type SettingsPatch = Array<{ path: Array<string | number>; value: unknown }>;

/**
 * Edit one project's settings. Paths are relative to the project (`["repositories", "app",
 * "path"]`, `["team", "max_agents"]`) and are written under `projects.<slug>`; a value of null
 * removes the key (the global value applies again). In a single-project config the project's
 * settings are the top-level sections, so paths are written there. Validated before writing.
 */
export function patchProjectSettings(sy: Switchyard, slug: string, patch: SettingsPatch): { ok: true } | { ok: false; errors: string[] } {
  const ctx = sy.projects.get(slug);
  if (!ctx) return { ok: false, errors: [`unknown project ${slug}`] };
  const errors: string[] = [];
  for (const p of patch) {
    const [head, second] = p.path;
    if (typeof head !== "string" || !PROJECT_SETTING_KEYS.includes(head)) {
      errors.push(`${p.path.join(".") || "<root>"}: not a project setting; project settings are ${PROJECT_SETTING_KEYS.join(", ")} (the rest is global)`);
      continue;
    }
    const allowed = RESTRICTED[head];
    if (allowed && p.path.length === 1 && p.value !== null && p.value !== undefined) {
      const bad = typeof p.value === "object" && !Array.isArray(p.value) ? Object.keys(p.value as object).filter((k) => !allowed.includes(k)) : ["<value>"];
      if (bad.length) errors.push(`${head}: only ${allowed.join(", ")} are project settings (got ${bad.join(", ")})`);
    } else if (allowed && p.path.length > 1 && !allowed.includes(String(second))) errors.push(`${head}.${String(second)}: not a project setting; allowed: ${allowed.join(", ")}`);
    if (ctx.project.legacy && !LEGACY_TOP_LEVEL.has(head)) errors.push(`${head}: a single-project config has no projects section to hold it; add a second project (which moves this one under projects.${slug}) first`);
    if (ctx.project.legacy && head === "brain" && p.path.length === 1) errors.push("brain: set brain.<key> one key at a time in a single-project config (the brain section is global there)");
  }
  if (errors.length) return { ok: false, errors };
  const prefix: Array<string | number> = ctx.project.legacy ? [] : ["projects", slug];
  return patchConfig(sy, patch.map((p) => ({ path: [...prefix, ...p.path], value: p.value })));
}
