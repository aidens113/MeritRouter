import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema, type ProfileConfig, type ProfileName, type RawConfig } from "./schema.js";
import { ConfigError } from "../core/errors.js";
import { resolveProjects, resolveRepositories, type ProjectsResolution } from "../projects/resolve.js";

export interface ResolvedConfig extends RawConfig {
  /** Absolute path of the loaded config file. */
  configPath: string;
  /** Absolute storage directory. */
  storageDir: string;
  /**
   * Absolute paths of the top-level (single-project) repositories keyed by alias. Task work reads
   * its project's repositories from its `ProjectContext` instead (src/projects/context.ts).
   */
  repositoryPaths: Record<string, { path: string; writable: boolean }>;
  /** The projects this config defines (one, named `brain.project`, for a single-project config). */
  projectResolution: ProjectsResolution;
  /** Absolute models YAML (manual endpoints and overrides), if configured. */
  modelsPath: string | null;
  /** Absolute rulebook YAML, if configured. */
  rulebookPath: string | null;
}

export const CONFIG_ENV = "SWITCHYARD_CONFIG";
export const DEFAULT_CONFIG_NAME = "switchyard.config.yaml";

/**
 * Resolve the config path explicitly: an argument, then SWITCHYARD_CONFIG, then
 * ./switchyard.config.yaml. Relative paths inside the file resolve against its directory.
 */
export function resolveConfigPath(explicit?: string, cwd = process.cwd()): string {
  const candidate = explicit ?? process.env[CONFIG_ENV] ?? path.join(cwd, DEFAULT_CONFIG_NAME);
  return path.resolve(cwd, candidate);
}

export function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`);
}

export function parseConfig(raw: unknown, configPath: string): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`invalid config ${configPath}:\n  ${formatIssues(parsed.error.issues).join("\n  ")}`);
  const cfg = parsed.data;
  const baseDir = path.dirname(configPath);

  const repositoryPaths = resolveRepositories(cfg.repositories, baseDir);
  const projects = resolveProjects(cfg, baseDir);
  if (projects.issues.length) throw new ConfigError(`invalid config ${configPath}:\n  ${formatIssues(projects.issues).join("\n  ")}`);
  for (const [name, profile] of Object.entries(cfg.profiles) as [ProfileName, ProfileConfig][]) {
    // Supervisors have their own (larger) request budget; the per-task cap applies to workers.
    if (profile.mode !== "supervisor" && profile.max_model_requests > cfg.execution.max_model_requests_per_task) {
      throw new ConfigError(
        `profile ${name}: max_model_requests (${profile.max_model_requests}) exceeds execution.max_model_requests_per_task (${cfg.execution.max_model_requests_per_task})`,
      );
    }
  }
  return {
    ...cfg,
    configPath,
    storageDir: path.resolve(baseDir, cfg.storage.directory),
    repositoryPaths,
    projectResolution: projects.resolution,
    modelsPath: cfg.models.file ? path.resolve(baseDir, cfg.models.file) : null,
    rulebookPath: cfg.scoring.rulebook_file ? path.resolve(baseDir, cfg.scoring.rulebook_file) : null,
  };
}

export function readConfigFile(configPath: string): unknown {
  if (!existsSync(configPath)) {
    throw new ConfigError(`config not found at ${configPath}; pass --config, set ${CONFIG_ENV}, or create ${DEFAULT_CONFIG_NAME}`);
  }
  try {
    return YAML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new ConfigError(`cannot parse ${configPath}: ${(err as Error).message}`);
  }
}

export function loadConfig(explicit?: string, cwd?: string): ResolvedConfig {
  const configPath = resolveConfigPath(explicit, cwd);
  return parseConfig(readConfigFile(configPath), configPath);
}

export function getProfile(cfg: ResolvedConfig, name: ProfileName): ProfileConfig {
  const profile = cfg.profiles[name];
  if (!profile) throw new ConfigError(`profile ${name} is not configured`);
  return profile;
}
