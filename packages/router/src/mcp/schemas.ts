// Tool input shapes that every MCP client can read, OpenAI's (Codex, ChatGPT) included.
//
// Codex turns a tool's JSON Schema into a function definition and keeps only type, properties,
// required, items, enum, and additionalProperties; a schema node without `type` becomes a string.
// So a free-form object must not be `z.record` (which emits `propertyNames` and an empty
// `additionalProperties: {}` schema, read as "string values"): it is a loose object that names
// its main fields and says `additionalProperties: true`. These shapes only describe; the service
// validates each task in full (core/task.ts), so unknown or misspelled keys still fail there.
import { z } from "zod";
import { ImportanceSchema, PROFILE_NAMES, ProfileNameSchema, TierNameSchema, VerificationLevelSchema } from "../config/schema.js";

/** An object that keeps unknown keys and says so in its schema (`additionalProperties: true`). */
function open<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape).meta({ additionalProperties: true });
}

const strings = z.array(z.string());

/** One task as submit_tasks takes it: the main fields of core/task.ts's WorkerTaskSchema. */
export const TaskArgumentSchema = open({
  profile: ProfileNameSchema.describe(PROFILE_NAMES.join(" | ")),
  goal: z.string().describe("What the worker must achieve."),
  idempotencyKey: z.string().optional().describe("Resubmitting the same key returns the same task."),
  repositoryAliases: strings.optional().describe("Repository aliases of the project the task may read."),
  writableRepository: z.string().optional().describe("Coding tasks: the one repository the worker may edit."),
  context: open({
    fileRefs: strings.optional().describe("'<alias>:<path>[#Lstart-Lend]' references the worker loads itself."),
    artifactRefs: strings.optional().describe("'artifact:<id>' references."),
    inlineText: z.string().optional(),
  }).optional(),
  constraints: open({
    acceptanceCriteria: z
      .array(z.union([z.string(), open({ id: z.string(), text: z.string(), verify: z.enum(["check", "review", "evidence"]).optional(), checks: strings.optional() })]))
      .describe("Strings (ids c1..cn) or { id, text, verify?, checks? }."),
    allowedPaths: strings.optional().describe("Coding tasks: paths the worker may change."),
    checks: strings.optional().describe("Commands run in the task worktree to verify a coding result."),
  }),
  importance: ImportanceSchema.optional(),
  importanceReason: z.string().optional().describe("Required for high and critical."),
  verification: open({ atLeast: VerificationLevelSchema.optional(), addChecks: strings.optional() }).optional(),
  dependsOn: strings.optional().describe("Task ids that must finish first."),
  label: z.string().optional().describe("Short agent label (lowercase, digits, hyphens)."),
  hints: open({
    difficulty: z.enum(["T1", "T2", "T3", "T4"]).optional(),
    web: z.boolean().optional().describe("true: needs the web (models that search inside the call are preferred); false: must not touch the web."),
  }).optional(),
  routing: open({ tier: TierNameSchema.optional(), endpointId: z.string().optional() }).optional(),
});
