import { z } from "zod";
import type { HarnessEnv } from "./tools.js";
/** Complete values stay in task-scoped artifacts; pages never silently drop output. */
export function boundedOutput(value: unknown, env: HarnessEnv, maxBytes = Math.min(env.inlineOutputBytes ?? 32 * 1024, 128 * 1024)): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes)
    return value;
  const ref = env.ctx.artifacts.write({ taskId: env.ctx.taskId, kind: "tool_output", label: "Harness v2 complete output", content: text, extension: ".json" });
  return { artifact: ref, totalBytes: Buffer.byteLength(text), preview: text.slice(0, Math.floor(maxBytes / 4)), continuation: { operation: "read_output_page", ref, offset: 0 } };
}
export const OutputPageArgs = z.object({ ref: z.string(), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(32768).default(16000) });
