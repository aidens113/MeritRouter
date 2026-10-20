import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { ConfigSchema } from "../config/schema.js";
import { formatIssues, parseConfig } from "../config/load.js";
import type { Switchyard } from "../core/service.js";

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
