import { z } from "zod";
import { operationRegistry } from "./operation-registry.js";
import { executeOperation } from "./operation-lifecycle.js";
import type { HarnessEnv, HarnessTool } from "./tools.js";
import { platform } from "node:os";
export function harnessV2Tools(env: HarnessEnv): HarnessTool[] {
  return operationRegistry().filter(def => !def.available || def.available(env)).map(def => ({
    def: { type: "function", function: { name: def.name, description: def.description, parameters: z.toJSONSchema(def.args) as Record<string, unknown> } },
    sideEffect: def.sideEffect, repeatBehavior: def.sideEffect === "read" ? "observe" as const : def.name === "run_recipe" ? "execute" as const : def.name === "batch" ? (args: Record<string, unknown>) => {
      const registry = new Map(operationRegistry().map(operation => [operation.name, operation]));
      return Array.isArray(args.items) && args.items.every(item => item && typeof item === "object" && registry.get((item as {
        operation: string;
      }).operation)?.sideEffect === "read") ? "observe" as const : undefined;
    } : undefined,
    outputSucceeded: output => {
      try {
        return JSON.parse(output).status === "succeeded";
      }
      catch {
        return false;
      }
    },
    observationOutput: output => {
      try {
        return JSON.stringify(JSON.parse(output), (key, value) => key === "operationId" || key === "durationMs" ? undefined : value);
      }
      catch {
        return output;
      }
    },
    run: async (args, context) => JSON.stringify(await executeOperation(def, args, context)),
  }));
}
export function harnessV2StartupContext(env: HarnessEnv): string {
  return `${HARNESS_V2_GUIDANCE}\nStartup workspace facts: ${JSON.stringify({ platform: platform(), repositories: [...env.readers].map(([alias, reader]) => ({ alias, base: reader.commit })), defaultAlias: env.workspace?.alias ?? (env.readers.size === 1 ? env.readers.keys().next().value : null), writable: env.workspace?.allowedPaths ?? null, recipes: env.checks?.commands.map((command, index) => ({ id: `check:${index + 1}`, command })) ?? [], defaultTimeoutMs: 30000, maximumTimeoutMs: 300000 })}`;
}
export const HARNESS_V2_GUIDANCE = `Harness v2: inspect workspace_info for OS, aliases, writable scope and declared recipe IDs. Prefer read_files or batch for independent observations (64 items, 4 concurrent reads); one missing file does not erase other results. Use apply_edits with read_files sha256 for surgical patches; never replace implementations with omission placeholders. Use run_recipe check:N rather than inventing shell text. timeout_ms defaults to 30000 and can be increased up to 300000 within task/check deadlines. Oversized output returns a complete scoped artifact and read_output_page continuation. Report actual tested criteria and unresolved defects; a successful tool call is not product acceptance.`;
