import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";

const Band = z.object({ max: z.number().nullable(), points: z.number() });
const MinBand = z.object({ min: z.number(), points: z.number() });

export const TAG_GROUPS = {
  kind: ["extract", "classify", "locate", "explain", "diagnose", "fix_bug", "add_feature", "refactor", "write_tests", "review", "migrate"],
  reasoning: ["lookup", "single_step", "multi_step", "cross_cutting"],
  novelty: ["existing_pattern", "new_design"],
  risk: ["concurrency", "security", "data_migration", "public_api_change", "build_config"],
  environment: ["needs_tests_run", "needs_browser_lab", "flaky_environment"],
  ambiguity: ["low", "medium", "high"],
} as const;
export type TagGroup = keyof typeof TAG_GROUPS;
export const TagsSchema = z
  .object({
    kind: z.enum(TAG_GROUPS.kind),
    reasoning: z.enum(TAG_GROUPS.reasoning),
    novelty: z.enum(TAG_GROUPS.novelty),
    risk: z.array(z.enum(TAG_GROUPS.risk)).default([]),
    environment: z.array(z.enum(TAG_GROUPS.environment)).default([]),
    ambiguity: z.enum(TAG_GROUPS.ambiguity),
  })
  .strict();
export type Tags = z.infer<typeof TagsSchema>;

/** Groups where several tags may apply at once. */
export const MULTI_GROUPS: ReadonlySet<TagGroup> = new Set(["risk", "environment"]);

export const RulebookSchema = z
  .object({
    version: z.string().min(1),
    features: z
      .object({
        mode: z.object({ completion: z.number(), read_only: z.number(), coding: z.number() }),
        lines_in_scope: z.array(Band).min(1),
        context_tokens: z.array(Band).min(1),
        /** Context estimate above this cannot be delegated whole: the task must be split. */
        split_above_context_tokens: z.number().int().positive(),
        extra_repository: z.number(),
        acceptance_criteria: z.array(MinBand),
        checks_required: z.number(),
        output_schema: z.number(),
        retry_after_failure: z.number(),
        non_text_input: z.number(),
      })
      .strict(),
    tags: z.object(
      Object.fromEntries(
        Object.entries(TAG_GROUPS).map(([g, values]) => [g, z.object(Object.fromEntries(values.map((v) => [v, z.union([z.number(), z.literal("reject")])])))]),
      ) as Record<TagGroup, z.ZodObject<Record<string, z.ZodUnion<[z.ZodNumber, z.ZodLiteral<"reject">]>>>>,
    ),
    /** Classifier confidence below this bumps the tier up by one. */
    low_confidence_threshold: z.number().min(0).max(1),
  })
  .strict();
export type Rulebook = z.infer<typeof RulebookSchema>;

export const DEFAULT_RULEBOOK: Rulebook = {
  version: "2026-10-18.1",
  features: {
    mode: { completion: 0, read_only: 1, coding: 3 },
    lines_in_scope: [
      { max: 200, points: 0 },
      { max: 1000, points: 1 },
      { max: 5000, points: 2 },
      { max: null, points: 4 },
    ],
    context_tokens: [
      { max: 8000, points: 0 },
      { max: 32000, points: 1 },
      { max: 100000, points: 2 },
    ],
    split_above_context_tokens: 100000,
    extra_repository: 1,
    acceptance_criteria: [
      { min: 4, points: 1 },
      { min: 7, points: 2 },
    ],
    checks_required: 1,
    output_schema: 1,
    retry_after_failure: 2,
    non_text_input: 1,
  },
  tags: {
    kind: { extract: 0, classify: 0, locate: 0, explain: 1, diagnose: 2, fix_bug: 1, add_feature: 2, refactor: 2, write_tests: 1, review: 1, migrate: 3 },
    reasoning: { lookup: 0, single_step: 0, multi_step: 1, cross_cutting: 3 },
    novelty: { existing_pattern: 0, new_design: 2 },
    risk: { concurrency: 2, security: 2, data_migration: 2, public_api_change: 1, build_config: 1 },
    environment: { needs_tests_run: 1, needs_browser_lab: 2, flaky_environment: 1 },
    ambiguity: { low: 0, medium: 1, high: "reject" },
  },
  low_confidence_threshold: 0.5,
};

export function loadRulebook(file: string | null): Rulebook {
  if (!file) return DEFAULT_RULEBOOK;
  if (!existsSync(file)) throw new ConfigError(`rulebook not found: ${file}`);
  const parsed = RulebookSchema.safeParse(YAML.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new ConfigError(`invalid rulebook ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function rulebookFingerprint(r: Rulebook): string {
  return `${r.version}:${createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 8)}`;
}

/** Highest number of points tags could add, used to decide whether classifying can matter. */
export function maxTagPoints(r: Rulebook): number {
  let total = 0;
  for (const [group, values] of Object.entries(r.tags) as [TagGroup, Record<string, number | "reject">][]) {
    const nums = Object.values(values).filter((v): v is number => typeof v === "number");
    total += MULTI_GROUPS.has(group) ? nums.reduce((s, v) => s + Math.max(0, v), 0) : Math.max(0, ...nums);
  }
  return total;
}

export function bandPoints(bands: Array<{ max: number | null; points: number }>, value: number): number {
  for (const b of bands) if (b.max === null || value <= b.max) return b.points;
  return bands[bands.length - 1]!.points;
}
