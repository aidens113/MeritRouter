import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { REPOSITORY_ALIAS_RE, ROLE_NAMES } from "../config/schema.js";
import { MeritRouterError } from "../core/errors.js";
import type { MeritRouter } from "../core/service.js";
import { PROJECT_CODING_KEYS, PROJECT_SUPERVISOR_KEYS, PROJECT_TEAM_KEYS, ProjectConfigSchema } from "../projects/schema.js";
import { expandHome } from "../brain/brain.js";
import { patchConfig, readConfigText } from "./config-edit.js";
import { TERMINAL_STATES } from "../core/task.js";
import { prepareRepositoryFolders, projectActivity, projectInfo } from "./projects.js";
import { folderState, preparationHint, type FolderState } from "../workspaces/repository-prepare.js";

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
export function globalSettings(sy: MeritRouter): GlobalSettings {
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
export function projectSettings(sy: MeritRouter, slug: string): ProjectSettings {
  const ctx = sy.projects.get(slug);
  if (!ctx) throw new MeritRouterError("not_found", `unknown project ${slug}`);
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
export function patchProjectSettings(sy: MeritRouter, slug: string, patch: SettingsPatch): { ok: true } | { ok: false; errors: string[] } {
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
  errors.push(...repositoryRemovalErrors(sy, slug, removedAliases(Object.keys(ctx.repositories), patch)), ...mountFolderErrors(sy, patch));
  if (errors.length) return { ok: false, errors };
  const prefix: Array<string | number> = ctx.project.legacy ? [] : ["projects", slug];
  return patchConfig(sy, patch.map((p) => ({ path: [...prefix, ...p.path], value: p.value })));
}

/** The repository aliases a patch removes, given the project's current aliases (patches apply in order). */
export function removedAliases(current: string[], patch: SettingsPatch): string[] {
  const now = new Set(current);
  for (const p of patch) {
    if (p.path[0] !== "repositories") continue;
    if (p.path.length === 1) {
      const next = new Set(p.value && typeof p.value === "object" ? Object.keys(p.value) : []);
      for (const a of [...now]) if (!next.has(a)) now.delete(a);
      for (const a of next) now.add(a);
    } else if (p.path.length === 2 && (p.value === null || p.value === undefined)) now.delete(String(p.path[1]));
    else now.add(String(p.path[1]));
  }
  return current.filter((a) => !now.has(a));
}

/**
 * Unfinished tasks of a project that name a repository alias (read or written): queued, running,
 * waiting, and interrupted ones, since an interrupted task can be resumed.
 */
export function tasksUsingRepository(sy: MeritRouter, slug: string, alias: string): string[] {
  const states = [...TERMINAL_STATES];
  const rows = sy.db
    .prepare(
      `SELECT id FROM tasks WHERE project_id = ? AND state NOT IN (${states.map(() => "?").join(",")})
          AND (json_extract(spec_json, '$.writableRepository') = ? OR EXISTS (SELECT 1 FROM json_each(tasks.spec_json, '$.repositoryAliases') WHERE value = ?))
        ORDER BY created_at`,
    )
    .all(slug, ...states, alias, alias) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Removing a repository is refused while unfinished tasks of the project use its alias: they
 * would fail when they run or resume. Each message names the tasks (or, past five, how many).
 */
export function repositoryRemovalErrors(sy: MeritRouter, slug: string, aliases: string[]): string[] {
  return aliases.flatMap((alias) => {
    const ids = tasksUsingRepository(sy, slug, alias);
    if (!ids.length) return [];
    const named = ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`;
    return [`repositories.${alias}: repository ${alias} is used by ${ids.length} unfinished task${ids.length === 1 ? "" : "s"} (${named}); cancel them or let them finish before removing it`];
  });
}

/** The brain mounts a patch writes, each with the field it came from (`brain.mounts.<i>.path`). */
function patchedMounts(patch: SettingsPatch): Array<{ field: string; path: unknown }> {
  const out: Array<{ field: string; path: unknown }> = [];
  const list = (v: unknown) => (Array.isArray(v) ? v : []).forEach((m, i) => out.push({ field: `brain.mounts.${i}.path`, path: (m as { path?: unknown } | null)?.path }));
  for (const p of patch) {
    if (p.path[0] !== "brain" || p.value === null || p.value === undefined) continue;
    if (p.path.length === 1) list((p.value as { mounts?: unknown }).mounts);
    else if (p.path[1] !== "mounts") continue;
    else if (p.path.length === 2) list(p.value);
    else if (p.path.length === 3) out.push({ field: `brain.mounts.${String(p.path[2])}.path`, path: (p.value as { path?: unknown }).path });
    else if (p.path.length === 4 && p.path[3] === "path") out.push({ field: `brain.mounts.${String(p.path[2])}.path`, path: p.value });
  }
  return out;
}

/** Brain mount folders must exist when they are saved (relative paths resolve against the config file's folder). */
export function mountFolderErrors(sy: MeritRouter, patch: SettingsPatch): string[] {
  const base = path.dirname(sy.cfg.configPath);
  return patchedMounts(patch).flatMap(({ field, path: p }) => {
    if (typeof p !== "string" || !p.trim()) return []; // the config schema reports a missing path
    const abs = path.resolve(base, expandHome(p.trim()));
    let dir = false;
    try {
      dir = statSync(abs).isDirectory();
    } catch {
      dir = false;
    }
    return dir ? [] : [`${field}: ${abs} does not exist or is not a folder; create it first`];
  });
}

// ---------------------------------------------------------------------------------------------
// The project settings page (J2): one read model with every value the page shows (each override
// beside the inherited global value), repository checks with errors keyed by field, and the
// mapping of config validation messages back onto project-relative fields.

/** What the server finds at a repository folder (relative paths resolve against the config file). */
export interface RepositoryPathCheck {
  input: string;
  resolved: string;
  exists: boolean;
  isDirectory: boolean;
  /** The folder has `.git` (it may still have no commits; see `state`). */
  isGit: boolean;
  state: FolderState;
  /**
   * What MeritRouter will do when the repository is saved (a missing folder is created and set up
   * with git; a folder without git is set up and its files committed), or null when nothing is needed.
   */
  hint: string | null;
  /** Plain-language problem MeritRouter cannot fix itself (no folder given, a file), or null. */
  problem: string | null;
}

export function inspectRepositoryPath(sy: MeritRouter, input: string): RepositoryPathCheck {
  const trimmed = input.trim();
  const resolved = path.resolve(path.dirname(sy.cfg.configPath), trimmed || ".");
  const state = folderState(resolved);
  const exists = state !== "missing";
  const isDirectory = exists && state !== "file";
  const isGit = isDirectory && existsSync(path.join(resolved, ".git"));
  let problem = !trimmed ? "enter the repository's folder" : state === "file" ? `${resolved} is a file, not a folder` : null;
  const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  if (!problem && (samePath(resolved, path.parse(resolved).root) || samePath(resolved, homedir()))) problem = `${resolved} is a drive root or your home folder; choose the project's own folder`;
  if (!problem && state === "folder") {
    try {
      const options = { cwd: resolved, encoding: "utf8" as const, windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
      if (root && !samePath(root, resolved) && execFileSync("git", ["ls-files", "-z", "--", "."], options).length) problem = `${resolved} holds files tracked by the enclosing repository ${root}; use that repository's root or a folder outside it`;
    } catch {
      // Save performs the authoritative Git/permission check; inspection never mutates a folder.
    }
  }
  return { input, resolved, exists, isDirectory, isGit, state, hint: problem ? null : preparationHint(state), problem };
}

export interface ProjectRepositoryInput {
  alias: string;
  path: string;
  writable: boolean;
}

/** Problems keyed by project-relative field (`repositories.0.path`, `team.max_agents`); `form` holds the rest. */
export type FieldErrors = Record<string, string[]>;

export type SettingsSaveResult = { ok: true } | { ok: false; errors: string[]; fieldErrors: FieldErrors };

function addError(errors: FieldErrors, key: string, msg: string): void {
  (errors[key] ??= []).push(msg);
}

const flatErrors = (fe: FieldErrors) => Object.entries(fe).flatMap(([k, v]) => v.map((m) => (k === "form" ? m : `${k}: ${m}`)));

/**
 * Check a project's repository rows: aliases valid and unique, a folder given that is not a file.
 * A folder that does not exist or has no git is fine: saving prepares it.
 */
export function validateProjectRepositories(sy: MeritRouter, rows: ProjectRepositoryInput[]): FieldErrors {
  const errors: FieldErrors = {};
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const alias = r.alias.trim();
    if (!alias) addError(errors, `repositories.${i}.alias`, "enter an alias");
    else if (!REPOSITORY_ALIAS_RE.test(alias)) addError(errors, `repositories.${i}.alias`, "letters, digits, '.', '_', '-' only");
    else if (seen.has(alias)) addError(errors, `repositories.${i}.alias`, `alias ${alias} is already used by row ${seen.get(alias)! + 1}`);
    else seen.set(alias, i);
    const check = inspectRepositoryPath(sy, r.path);
    if (check.problem) addError(errors, `repositories.${i}.path`, check.problem);
  });
  return errors;
}

/**
 * Replace a project's repositories with `rows` (add, remove, change folder or writable). Each
 * folder is prepared first (created, set up with git, first snapshot committed, as needed); what
 * MeritRouter cannot fix comes back keyed by row and field. Other entries of the file, and
 * comments around them, are kept.
 */
export async function saveProjectRepositories(sy: MeritRouter, slug: string, rows: ProjectRepositoryInput[]): Promise<SettingsSaveResult> {
  if (!sy.projects.get(slug)) return { ok: false, errors: [`unknown project ${slug}`], fieldErrors: { form: [`unknown project ${slug}`] } };
  // A removed repository has no row left to mark, so its refusal is a form-level error.
  const current = Object.keys((projectSettings(sy, slug).raw.repositories ?? {}) as Record<string, unknown>);
  const keep = new Set(rows.map((r) => r.alias.trim()));
  const inUse = repositoryRemovalErrors(sy, slug, current.filter((a) => !keep.has(a))).map((e) => e.replace(/^repositories\.[^:]+: /, ""));
  if (inUse.length) return { ok: false, errors: inUse, fieldErrors: { form: inUse } };
  const fieldErrors = validateProjectRepositories(sy, rows);
  if (Object.keys(fieldErrors).length) return { ok: false, errors: flatErrors(fieldErrors), fieldErrors };
  const base = path.dirname(sy.cfg.configPath);
  const { problems } = await prepareRepositoryFolders(
    sy,
    slug,
    rows.map((r) => ({ alias: r.alias.trim(), path: path.resolve(base, r.path.trim()) })),
  );
  rows.forEach((r, i) => {
    const p = problems.get(r.alias.trim());
    if (p) addError(fieldErrors, `repositories.${i}.path`, p);
  });
  if (Object.keys(fieldErrors).length) return { ok: false, errors: flatErrors(fieldErrors), fieldErrors };
  const patch: SettingsPatch = rows.length
    ? [
        ...current.filter((a) => !keep.has(a)).map((a) => ({ path: ["repositories", a], value: null })),
        ...rows.map((r) => ({ path: ["repositories", r.alias.trim()], value: { path: r.path.trim(), ...(r.writable ? {} : { writable: false }) } })),
      ]
    : [{ path: ["repositories"], value: {} }];
  return withFieldErrors(sy, slug, patchProjectSettings(sy, slug, patch));
}

/**
 * Map validation messages onto project-relative fields: config messages name
 * `projects.<slug>.team.max_agents` (inside an "invalid config" block), and
 * `patchProjectSettings`'s own refusals name `team.max_agents`. Anything else goes under `form`.
 */
export function projectFieldErrors(sy: MeritRouter, slug: string, errors: string[]): FieldErrors {
  const legacy = sy.projects.get(slug)?.project.legacy ?? false;
  const prefix = `projects.${slug}.`;
  const out: FieldErrors = {};
  const lines = errors.flatMap((e) => e.split("\n").map((l) => l.trim())).filter((l) => l && !/^invalid config /.test(l));
  for (const line of lines) {
    const m = /^([\w.-]+):\s*(.*)$/.exec(line);
    let key = m?.[1] ?? "";
    if (!legacy && key.startsWith(prefix)) key = key.slice(prefix.length);
    if (m && PROJECT_SETTING_KEYS.includes(key.split(".")[0]!)) addError(out, key, m[2] || line);
    else addError(out, "form", line);
  }
  return out;
}

function withFieldErrors(sy: MeritRouter, slug: string, r: { ok: true } | { ok: false; errors: string[] }): SettingsSaveResult {
  return r.ok ? r : { ok: false, errors: r.errors, fieldErrors: projectFieldErrors(sy, slug, r.errors) };
}

/** `patchProjectSettings` with its errors also keyed by project-relative field, for forms. */
export function saveProjectSettings(sy: MeritRouter, slug: string, patch: SettingsPatch): SettingsSaveResult {
  return withFieldErrors(sy, slug, patchProjectSettings(sy, slug, patch));
}

/** One overridable setting: the install-wide value, this project's own value (if any), and the result. */
export interface ProjectOverrideView {
  /** Project-relative path joined with dots (`team.max_agents`, `roles.reviewer`). */
  id: string;
  path: string[];
  section: "verification" | "team" | "coding" | "supervisor" | "roles" | "brain";
  /** The install-wide value (undefined when the global config leaves it unset). */
  global: unknown;
  /** True when the project sets its own value. */
  overridden: boolean;
  /** The project's own value as written (undefined when inherited). */
  override: unknown;
  /** The value this project's agents use. */
  effective: unknown;
}

type Budgets = { per_day_usd: number | null; per_week_usd: number | null; per_month_usd: number | null };
type MountRow = { prefix: string; path: string; commit: boolean };

export interface ProjectSettingsView extends ProjectSettings {
  archived: boolean;
  archivedAt: number | null;
  /** Running and queued tasks: archiving is refused while either is above zero. */
  activity: { runningTasks: number; queuedTasks: number };
  /** The repositories as written, each with what the server finds at its folder. */
  repositoryRows: Array<ProjectRepositoryInput & { resolved: string; isGit: boolean; hint: string | null; problem: string | null }>;
  /** Fair-share and budget fields as written (null = no per-project limit), with the global caps they divide. */
  limits: {
    priority: number | null;
    max_concurrent_tasks: number | null;
    paid_budgets: Budgets;
    request_share: number | null;
    global: { maxConcurrentTasks: number; paidEnabled: boolean; paidBudgets: Budgets; requestsPerHour: number | null; requestsPerDay: number | null };
  };
  /** Brain mounts: the install-wide ones (every project gets them) and this project's own. */
  mounts: { global: MountRow[]; project: MountRow[] };
  overrides: ProjectOverrideView[];
}

const hasOwn = (o: unknown, k: string) => typeof o === "object" && o !== null && Object.prototype.hasOwnProperty.call(o, k);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const budgetsOf = (o: unknown): Budgets => {
  const b = (o ?? {}) as Record<string, unknown>;
  return { per_day_usd: num(b.per_day_usd), per_week_usd: num(b.per_week_usd), per_month_usd: num(b.per_month_usd) };
};
const mountRows = (ms: Array<{ prefix: string; path: string; commit?: boolean }>): MountRow[] => ms.map((m) => ({ prefix: m.prefix, path: m.path, commit: m.commit ?? false }));

/** Everything the project settings page shows, each override beside the value it would inherit. */
export function projectSettingsView(sy: MeritRouter, slug: string): ProjectSettingsView {
  const base = projectSettings(sy, slug);
  const info = projectInfo(sy, slug);
  const act = projectActivity(sy, slug);
  const raw = base.raw as Record<string, unknown>;
  const g = sy.cfg as unknown as Record<string, Record<string, unknown> | undefined>;
  const legacy = base.legacy;
  const eff = base.effective;
  const overrides: ProjectOverrideView[] = [];
  const item = (section: ProjectOverrideView["section"], key: string, global: unknown, effective: unknown) => {
    const own = raw[section] as Record<string, unknown> | undefined;
    // A single-project config has no overrides: its sections are the global ones.
    const overridden = !legacy && hasOwn(own, key);
    overrides.push({ id: `${section}.${key}`, path: [section, key], section, global, overridden, override: overridden ? own![key] : undefined, effective });
  };
  for (const k of Object.keys(g.verification ?? {})) item("verification", k, g.verification![k], (eff.verification as Record<string, unknown>)[k]);
  for (const k of PROJECT_TEAM_KEYS) item("team", k, g.team?.[k], eff.team[k]);
  for (const k of PROJECT_CODING_KEYS) item("coding", k, g.coding?.[k], eff.coding[k]);
  for (const k of PROJECT_SUPERVISOR_KEYS) item("supervisor", k, g.supervisor?.[k], eff.supervisor[k]);
  for (const k of ROLE_NAMES) item("roles", k, g.roles?.[k], (eff.roles as Record<string, unknown> | undefined)?.[k]);
  item("brain", "access_approver", g.brain?.access_approver, eff.brain.access_approver);
  item("brain", "auto_approve", g.brain?.auto_approve, eff.brain.auto_approve);

  const ownMounts = ((raw.brain as { mounts?: unknown } | undefined)?.mounts ?? []) as Array<{ prefix: string; path: string; commit?: boolean }>;
  return {
    ...base,
    archived: info.archived,
    archivedAt: info.archivedAt,
    activity: { runningTasks: act.runningTasks, queuedTasks: act.queuedTasks },
    repositoryRows: Object.entries((raw.repositories ?? {}) as Record<string, { path: string; writable?: boolean }>).map(([alias, r]) => {
      const check = inspectRepositoryPath(sy, r.path);
      return { alias, path: r.path, writable: r.writable !== false, resolved: check.resolved, isGit: check.isGit, hint: check.hint, problem: check.problem };
    }),
    limits: {
      priority: legacy ? null : num(raw.priority),
      max_concurrent_tasks: legacy ? null : num(raw.max_concurrent_tasks),
      paid_budgets: legacy ? budgetsOf(null) : budgetsOf(raw.paid_budgets),
      request_share: legacy ? null : num(raw.request_share),
      global: {
        maxConcurrentTasks: sy.cfg.execution.max_concurrent_tasks,
        paidEnabled: sy.cfg.paid.enabled,
        paidBudgets: budgetsOf(sy.cfg.paid.budgets),
        requestsPerHour: sy.cfg.allocation.max_model_requests_per_hour ?? null,
        requestsPerDay: sy.cfg.allocation.max_model_requests_per_day ?? null,
      },
    },
    // In a single-project config the brain section (and its mounts) is the project's own.
    mounts: legacy ? { global: [], project: mountRows(sy.cfg.brain.mounts) } : { global: mountRows(sy.cfg.brain.mounts), project: mountRows(ownMounts) },
    overrides,
  };
}
