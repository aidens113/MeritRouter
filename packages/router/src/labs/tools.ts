import { z } from "zod";
import type { HarnessEnv, HarnessTool } from "../harness/tools.js";
import { LabHttpInputSchema } from "./http.js";
import { mediateOutsideOperation, withOutsideAuthority } from "../harness/outside-operation.js";
function binding(env: HarnessEnv) {
  const lab = env.ctx.lab;
  if (!lab)
    throw new Error("this task is not bound to a lab");
  const team = z.object({ root_job_id: z.string() }).optional().parse(lab.manager.options.db.prepare("SELECT root_job_id FROM lab_teams WHERE lab_id=?").get(lab.labId));
  if (team?.root_job_id !== lab.rootJobId)
    throw new Error("this task no longer belongs to the lab's active root team");
  lab.manager.touch(lab.project, lab.name);
  return lab;
}
/** Scope comes from the persisted task binding, never model-provided project/name. */
export function labHarnessTools(): HarnessTool[] {
  const make = (name: string, description: string, properties: Record<string, unknown>, required: string[], sideEffect: HarnessTool["sideEffect"], run: HarnessTool["run"]): HarnessTool => ({
    def: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } },
    sideEffect, available: (env) => !!env.ctx.lab,
    ...(name === "lab_check" ? { repeatBehavior: "execute" as const } : {}),
    ...(name === "lab_http" ? { repeatBehavior: (args: Record<string, unknown>) => ["GET", "HEAD"].includes(String(args.method ?? "GET")) ? "observe" as const : undefined } : {}),
    run: async (args, env) => {
      // Scoped status/log reads expose only the assigned Lab through its service. Every
      // operation that contacts a service or starts a process requires outside authority.
      if (!["lab_status", "lab_logs"].includes(name)) {
        binding(env);
        const mediated = await mediateOutsideOperation(env, name, args);
        if (mediated !== null) return mediated;
        return withOutsideAuthority(env, signal => run(args, { ...env, ctx: { ...env.ctx, signal } }));
      }
      return run(args, env);
    },
  });
  const empty = z.object({}).strict();
  return [
    make("lab_status", "Read this team's lab services, heads and declared checks.", {}, [], "read", async (a, e) => {
      empty.parse(a);
      const l = binding(e);
      return JSON.stringify(l.manager.publicStatus(l.project, l.name));
    }),
    make("lab_logs", "Read bounded logs of a declared service in this team's lab.", { service: { type: "string" }, tail: { type: "integer", minimum: 1, maximum: 1000 } }, ["service"], "read", async (a, e) => {
      const v = z.object({ service: z.string().min(1), tail: z.number().int().min(1).max(1000).default(200) }).strict().parse(a);
      const l = binding(e);
      return l.manager.logs(l.project, l.name, v.service, v.tail);
    }),
    make("lab_restart", "Restart one declared service, or all services, through the current lab owner.", { service: { type: "string" } }, [], "external", async (a, e) => {
      const v = z.object({ service: z.string().min(1).optional() }).strict().parse(a);
      const l = binding(e);
      await l.manager.control(l.project, l.name, { kind: "restart", ...v }, `task:${e.ctx.taskId}`, { signal: e.ctx.signal, taskLease: e.ctx.taskLease });
      return JSON.stringify(l.manager.publicStatus(l.project, l.name));
    }),
    make("lab_check", "Run one declared lab check and record its exact revision.", { name: { type: "string" } }, ["name"], "external", async (a, e) => {
      const v = z.object({ name: z.string().min(1) }).strict().parse(a);
      const l = binding(e);
      const op = await l.manager.control(l.project, l.name, { kind: "check", name: v.name }, `task:${e.ctx.taskId}`, { signal: e.ctx.signal, taskLease: e.ctx.taskLease });
      return JSON.stringify(l.manager.publicOperation(l.project, l.name, op.id)?.result);
    }),
    make("lab_http", "Request a path on a declared running lab HTTP service. Cross-origin redirects and arbitrary headers are refused.", { service: { type: "string" }, path: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }, headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" }, timeoutMs: { type: "integer" } }, ["service"], "external", async (a, e) => {
      const v = LabHttpInputSchema.parse(a);
      const l = binding(e);
      const response = await l.manager.http(l.project, l.name, v, { signal: e.ctx.signal });
      return JSON.stringify({ ...response, body: l.manager.redact(l.project, l.name, response.body), headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, l.manager.redact(l.project, l.name, value)])) });
    }),
    { ...make("lab_promote", "Root supervisor only: refresh, verify and promote this lab under its configured policy. Manual policy returns commands without changing targets.", { reason: { type: "string" } }, [], "external", async (a, e) => {
        const v = z.object({ reason: z.string().optional() }).strict().parse(a);
        const l = binding(e);
        if (e.role !== "supervisor" || e.ctx.taskId !== l.rootJobId)
          throw new Error("only the lab root supervisor may promote");
        const op = await l.manager.control(l.project, l.name, { kind: "promote", by: "supervisor", reason: v.reason }, `task:${e.ctx.taskId}`, { signal: e.ctx.signal, taskLease: e.ctx.taskLease });
        return JSON.stringify(l.manager.publicOperation(l.project, l.name, op.id)?.result);
      }), available: (e) => !!e.ctx.lab && e.role === "supervisor" && e.ctx.lab.rootJobId === e.ctx.taskId },
  ];
}
