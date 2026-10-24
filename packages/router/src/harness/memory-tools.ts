import { z } from "zod";
import { MemoryPreferences } from "../brain/preferences.js";
import type { HarnessTool } from "./tools.js";

export const ProjectMemoryToolInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/),
  kind: z.enum(["project_fact", "decision", "empirical_lesson"]),
  body: z.string().trim().min(1).max(20_000),
  sourceRef: z.string().trim().min(1).max(20_000),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

/** Scoped supervisor capability; preferences/global memory have a separate initiating authority. */
export function projectMemoryTool(): HarnessTool {
  return {
    def: { type: "function", function: {
      name: "write_project_memory",
      description: "Maintain a typed fact, decision or empirical lesson in this project's memory. Cite an observation/source. expectedDigest null creates a new record; updating requires the current full document SHA-256 from brain_read. Workers propose memory in reports. This tool cannot write user preferences or global knowledge; those require initiating user authority or independent promotion.",
      parameters: z.toJSONSchema(ProjectMemoryToolInputSchema),
    } },
    sideEffect: "brain",
    available: env => env.role === "supervisor" && !!env.brain,
    run: async (args, env) => {
      if (env.role !== "supervisor" || !env.brain) throw new Error("Only an authenticated supervisor with project Brain access may maintain memory");
      const parsed = ProjectMemoryToolInputSchema.parse(args);
      env.ctx.signal.throwIfAborted();
      const result = await new MemoryPreferences(env.brain.brain, () => null, env.ctx.now).writeProject(env.brain.principal(), env.brain.actor, { id: parsed.id, kind: parsed.kind, body: parsed.body, source: { kind: parsed.kind === "decision" ? "decision" : "observation", ref: parsed.sourceRef } }, parsed.expectedDigest);
      return JSON.stringify({ ...result, scope: { kind: "project", project: env.brain.brain.project } });
    },
  };
}
