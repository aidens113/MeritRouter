import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema, type ProfileConfig, type ProfileName, type RawConfig } from "./schema.js";
import { ConfigError } from "../core/errors.js";
import { loadEndpointCatalog, type EndpointCatalog } from "../models/catalog.js";

export interface ResolvedConfig extends RawConfig {
  /** Absolute path of the loaded config file. */
  configPath: string;
  /** Absolute storage directory. */
  storageDir: string;
  /** Absolute repository paths keyed by alias. */
  repositoryPaths: Record<string, { path: string; writable: boolean }>;
  catalog: EndpointCatalog;
}

export const CONFIG_ENV = "SWITCHYARD_CONFIG";
export const DEFAULT_CONFIG_NAME = "switchyard.config.yaml";

/**
 * Resolve the config path explicitly: an argument, then SWITCHYARD_CONFIG, then
 * ./switchyard.config.yaml. Never depends on incidental subprocess state beyond that.
 */
export function resolveConfigPath(explicit?: string, cwd = process.cwd()): string {
  const candidate = explicit ?? process.env[CONFIG_ENV] ?? path.join(cwd, DEFAULT_CONFIG_NAME);
  return path.resolve(cwd, candidate);
}

export function parseConfig(raw: unknown, configPath: string): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new ConfigError(`invalid config ${configPath}:\n  ${issues.join("\n  ")}`);
  }
  const cfg = parsed.data;
  const baseDir = path.dirname(configPath);

  const repositoryPaths: ResolvedConfig["repositoryPaths"] = {};
  for (const [alias, repo] of Object.entries(cfg.repositories)) {
    repositoryPaths[alias] = { path: path.resolve(baseDir, repo.path), writable: repo.writable };
  }

  const catalog = loadEndpointCatalog(path.resolve(baseDir, cfg.models.file));
  for (const [name, profile] of Object.entries(cfg.profiles) as [ProfileName, ProfileConfig][]) {
    if (profile.max_model_requests > cfg.execution.max_model_requests_per_task) {
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
    catalog,
  };
}

export function loadConfig(explicit?: string, cwd?: string): ResolvedConfig {
  const configPath = resolveConfigPath(explicit, cwd);
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `config not found at ${configPath}; pass --config, set ${CONFIG_ENV}, or create ${DEFAULT_CONFIG_NAME}`,
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new ConfigError(`cannot parse ${configPath}: ${(err as Error).message}`);
  }
  return parseConfig(raw, configPath);
}

export function getProfile(cfg: ResolvedConfig, name: ProfileName): ProfileConfig {
  const profile = cfg.profiles[name];
  if (!profile) throw new ConfigError(`profile ${name} is not configured`);
  return profile;
}
