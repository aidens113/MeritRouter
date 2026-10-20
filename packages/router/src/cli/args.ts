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
