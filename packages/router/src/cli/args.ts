import { z } from "zod";
import { ImportanceSchema } from "../config/schema.js";
import { SwitchyardError } from "../core/errors.js";
import { SessionStatusSchema } from "../sessions/events.js";

// Command-line flag parsing: values are validated with zod, and a bad value is a usage error.

const CountFlag = z.coerce.number().int().nonnegative();

/** Parse a numeric flag with zod; a bad value is a usage error, not NaN. */
export function countFlag(name: string, value: string | undefined, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const r = CountFlag.min(min).safeParse(value);
  if (!r.success) throw new SwitchyardError("usage", `--${name} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  return r.data;
}

/** `--status completed,failed` -> validated statuses. */
export function statusFlag(value: string | undefined) {
  if (value === undefined) return undefined;
  const r = z.array(SessionStatusSchema).min(1).safeParse(value.split(",").map((s) => s.trim()).filter(Boolean));
  if (!r.success) throw new SwitchyardError("usage", `--status takes ${SessionStatusSchema.options.join(", ")} (comma-separated), got ${JSON.stringify(value)}`);
  return r.data.length === 1 ? r.data[0]! : r.data;
}

/** `--importance` fills in tasks that set none; a task's own importance is never overridden. */
export function withImportance(tasks: unknown[], importance: string | undefined, reason: string | undefined): unknown[] {
  if (importance === undefined) {
    if (reason !== undefined) throw new SwitchyardError("usage", "--importance-reason needs --importance");
    return tasks;
  }
  const level = ImportanceSchema.safeParse(importance);
  if (!level.success) throw new SwitchyardError("usage", `--importance takes ${ImportanceSchema.options.join(", ")}, got ${JSON.stringify(importance)}`);
  return tasks.map((t) => {
    if (!t || typeof t !== "object" || Array.isArray(t) || "importance" in t) return t;
    return { ...t, importance: level.data, ...(reason ? { importanceReason: reason } : {}) };
  });
}

/**
 * `--repo <alias>=<path>` (or a bare `<path>`, whose folder name becomes the alias), for
 * `projects create` and `init`. Paths are kept as written (relative to the config file's folder).
 */
export function repoFlags(values: string[] | undefined): Record<string, { path: string }> {
  const out: Record<string, { path: string }> = {};
  for (const v of values ?? []) {
    const eq = v.indexOf("=");
    if (eq === 0) throw new SwitchyardError("usage", `--repo takes <alias>=<path> or <path>, got ${JSON.stringify(v)}`);
    const repoPath = (eq > 0 ? v.slice(eq + 1) : v).trim();
    const alias = (eq > 0 ? v.slice(0, eq) : (repoPath.replace(/[\/]+$/, "").split(/[\/]/).pop() ?? "")).trim();
    if (!alias || !repoPath) throw new SwitchyardError("usage", `--repo takes <alias>=<path> or <path>, got ${JSON.stringify(v)}`);
    if (out[alias]) throw new SwitchyardError("usage", `--repo: alias ${alias} given twice`);
    out[alias] = { path: repoPath };
  }
  return out;
}
