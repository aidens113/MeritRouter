import { z } from "zod";

/** Who made a change. Recorded as Git identity plus attribution trailers. */
export interface Actor {
  agent: string;
  role: string;
  model?: string | null;
  task?: string | null;
  job?: string | null;
  tier?: string | null;
  request?: string | null;
}
const text = z.string().max(4096).refine(value => !value.includes("\0"));
export const ActorSchema = z.object({
  agent: text.min(1), role: text.min(1), model: text.nullish(), task: text.nullish(),
  job: text.nullish(), tier: text.nullish(), request: text.nullish(),
}).strict();
export const TRAILER_KEYS = ["Agent", "Role", "Model", "Task", "Job", "Tier", "Request"] as const;

export function actorIdentity(a: Actor): { name: string; email: string } {
  const slug = a.agent.replace(/[^A-Za-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || "agent";
  const model = a.model ? ` (${a.model})` : "";
  return { name: `${a.agent.replace(":", " ")}${model}`.slice(0, 120), email: `${slug}@meritrouter.local` };
}
export function trailerArgs(a: Actor, extra: Record<string, string> = {}): string[] {
  const t: Record<string, string | null | undefined> = { Agent: a.agent, Role: a.role, Model: a.model, Task: a.task, Job: a.job, Tier: a.tier, Request: a.request, ...extra };
  return Object.entries(t).filter(([, v]) => v !== null && v !== undefined && v !== "")
    .flatMap(([k, v]) => ["--trailer", `${k}: ${String(v).replace(/[\r\n]+/g, " ")}`]);
}
