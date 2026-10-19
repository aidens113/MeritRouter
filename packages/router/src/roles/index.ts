import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config/load.js";
import type { ProfileName, RoleName } from "../config/schema.js";

const ROLE_BY_PROFILE: Record<ProfileName, RoleName> = {
  summarize: "summarizer",
  inspect: "inspector",
  analyze: "analyst",
  implement: "implementer",
  review: "reviewer",
  supervise: "supervisor",
};

export function roleForProfile(profile: ProfileName): RoleName {
  return ROLE_BY_PROFILE[profile];
}

export function chartersDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "charters");
}

function builtIn(name: string): string {
  return readFileSync(path.join(chartersDir(), `${name}.md`), "utf8").trim();
}

/**
 * The rules text for a role: the configured override file if set, otherwise the built-in
 * charter (workers get the shared worker charter plus their specialisation), then any extra
 * rules from config.
 */
export function charterFor(cfg: ResolvedConfig, role: RoleName): string {
  const rc = cfg.roles[role];
  let text: string;
  if (rc?.charter_file) {
    const file = path.resolve(path.dirname(cfg.configPath), rc.charter_file);
    if (!existsSync(file)) throw new Error(`charter for ${role} not found: ${file}`);
    text = readFileSync(file, "utf8").trim();
  } else if (role === "supervisor" || role === "classifier") {
    text = builtIn(role);
  } else {
    text = `${builtIn("worker")}\n\n${builtIn(role)}`;
  }
  if (rc?.extra_rules.length) text += `\n\n## Additional rules\n\n${rc.extra_rules.map((r) => `- ${r}`).join("\n")}`;
  return text;
}

export function agentLabel(role: RoleName, taskId: string): string {
  return `${role}:${taskId}`;
}
