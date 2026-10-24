import { z } from "zod";
import type { HarnessEnv } from "./tools.js";
import type { ToolSideEffect } from "../sessions/events.js";
export const HARNESS_VERSION = "2";
export const DeadlineArgs = { timeout_ms: z.number().int().min(1).max(300000).optional() };
export const RepositoryArgs = { alias: z.string().optional() };
export const OperationResultSchema = z.object({ version: z.literal("2"), operationId: z.string(), status: z.enum(["succeeded", "failed", "denied", "waiting_approval", "timed_out", "cancelled", "unknown_effect"]), durationMs: z.number(), workspace: z.object({alias:z.string(),revision:z.string().nullable(),mode:z.enum(["pinned","worktree"])}).optional(), data: z.unknown().optional(), diagnostics: z.array(z.string()).default([]) });
export type OperationResult = z.infer<typeof OperationResultSchema>;
export interface OperationDefinition {
  name: string;
  description: string;
  args: z.ZodObject;
  /** Portable model-facing shape; args remains the strict execution validator. */
  modelArgs?: z.ZodObject;
  sideEffect: ToolSideEffect;
  available?: (env: HarnessEnv) => boolean;
  run(args: Record<string, unknown>, env: HarnessEnv): Promise<unknown>;
}
export function resolveReader(env: HarnessEnv, alias?: unknown) {
  const name = typeof alias === "string" ? alias : env.workspace?.alias ?? (env.readers.size === 1 ? env.readers.keys().next().value : undefined);
  const reader = name ? env.readers.get(name) : undefined;
  if (!reader)
    throw new Error(`Choose alias from: ${[...env.readers.keys()].join(", ")}; omitted alias requires a sole repository or explicit writable default.`);
  return reader;
}
