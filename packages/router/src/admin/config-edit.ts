import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { ConfigSchema } from "../config/schema.js";
import { formatIssues, parseConfig } from "../config/load.js";
import type { Switchyard } from "../core/service.js";
import { ProjectRegistry } from "../projects/registry.js";
import { recordPreparation } from "../projects/repository-setup.js";
import { prepareRepository } from "../workspaces/repository-prepare.js";

/**
 * Editing the config file from the panel: validate, back up the previous file, write, and let
 * running processes reload it. Used by Settings, the rulebook editor, and Provider keys (custom
 * providers).
 */

export function readConfigText(sy: Switchyard): string {
  return readFileSync(sy.cfg.configPath, "utf8");
}

export function validateConfigText(text: string, configPath: string): { ok: true } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    return { ok: false, errors: [`YAML: ${(err as Error).message}`] };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error.issues) };
  try {
    parseConfig(raw, configPath);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  return { ok: true };
}

/** Validate, back up the previous file, and write. Running workers reload it automatically. */
export function writeConfigText(sy: Switchyard, text: string): { ok: true } | { ok: false; errors: string[] } {
  const v = validateConfigText(text, sy.cfg.configPath);
  if (!v.ok) return v;
  copyFileSync(sy.cfg.configPath, `${sy.cfg.configPath}.bak`);
  writeFileSync(sy.cfg.configPath, text);
  sy.reloadIfChanged();
  return { ok: true };
}

/** Apply a structured patch (e.g. from a settings form) to the YAML, preserving comments. */
export function patchConfig(sy: Switchyard, patch: Array<{ path: Array<string | number>; value: unknown }>): { ok: true } | { ok: false; errors: string[] } {
  const doc = YAML.parseDocument(readConfigText(sy));
  for (const p of patch) {
    if (p.value === undefined || p.value === null) doc.deleteIn(p.path);
    else doc.setIn(p.path, p.value);
  }
  return writeConfigText(sy, doc.toString());
}

/** Generic panel saves prepare changed/new repository paths before acknowledging the config. */
export async function writePreparedConfigText(sy: Switchyard, text: string): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const validation = validateConfigText(text, sy.cfg.configPath);
  if (!validation.ok) return validation;
  const original = readConfigText(sy);
  const candidate = new ProjectRegistry(parseConfig(YAML.parse(text), sy.cfg.configPath));
  const errors: string[] = [];
  for (const project of candidate.list()) {
    const previous = sy.projects.get(project.project.slug);
    for (const [alias, repository] of Object.entries(project.repositoryPaths)) {
      if (previous?.repositoryPaths[alias]?.path === repository.path) continue;
      const result = await prepareRepository(repository.path);
      recordPreparation(sy.db, sy.tasks, { project: project.project.slug, alias, result });
      if (!result.ok) errors.push(`projects.${project.project.slug}.repositories.${alias}.path: ${result.message}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  if (readConfigText(sy) !== original) return { ok: false, errors: ["The config changed while repository folders were being prepared; reload it and retry your edit."] };
  return writeConfigText(sy, text);
}

/** The async generic settings patch path; synchronous internal config editing stays compatible. */
export async function patchPreparedConfig(sy: Switchyard, patch: Array<{ path: Array<string | number>; value: unknown }>): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const doc = YAML.parseDocument(readConfigText(sy));
  for (const item of patch) {
    if (item.value === undefined || item.value === null) doc.deleteIn(item.path);
    else doc.setIn(item.path, item.value);
  }
  return writePreparedConfigText(sy, doc.toString());
}
