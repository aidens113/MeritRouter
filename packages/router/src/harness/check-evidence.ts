import { z } from "zod";
import type { HarnessEnv } from "./tools.js";
import { workerSourceIdentity } from "./worker-actions.js";

export function scopedArtifact(env: HarnessEnv, ref: string) {
  const row = env.ctx.artifacts.get(ref);
  if (!row) throw new Error("unknown artifact");
  const explicit = env.ctx.spec.context.artifactRefs?.includes(`artifact:${row.id}`) || env.universe.refs.has(`artifact:${row.id}`);
  if (env.ctx.spec.profile !== "supervise" && row.task_id !== env.ctx.taskId && !explicit) throw new Error("artifact is outside this task's granted context");
  const artifact = env.ctx.artifacts.readScoped(ref, env.ctx.taskProject ?? env.ctx.cfg.brain.project);
  return artifact;
}

const CheckEvent = z.object({ command: z.string().min(1), exitCode: z.number().int().nullable(), logRef: z.string().regex(/^artifact:[\w-]+$/),
  source: z.string().regex(/^[a-f0-9]{64}$/).optional(), sessionId: z.string().nullable().optional(), actionId: z.string().optional() });

/** Filter before paging, so unrelated task events cannot evict completed checks from resume. */
export async function restoreCheckEvidence(env: HarnessEnv): Promise<void> {
  const rows = env.ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type='worker_check_run' ORDER BY id LIMIT 10000").all(env.ctx.taskId);
  const source = env.checks ? await workerSourceIdentity(env.checks.cwd) : null;
  for (const raw of rows) {
    const row = z.object({ data_json: z.string() }).safeParse(raw);
    if (!row.success) continue;
    let parsed;
    try { parsed = CheckEvent.safeParse(JSON.parse(row.data.data_json)); } catch { continue; }
    if (!parsed.success) continue;
    const record = parsed.data;
    let eligible = !record.source || record.source === source;
    if (record.sessionId && env.ctx.session?.id !== record.sessionId) {
      const session = z.object({ task_id: z.string().nullable() }).safeParse(env.ctx.tasks.db.prepare("SELECT task_id FROM sessions WHERE id=?").get(record.sessionId));
      if (!session.success || session.data.task_id !== env.ctx.taskId) eligible = false;
    }
    try {
      const artifact = scopedArtifact(env, record.logRef);
      if (artifact.row.task_id !== env.ctx.taskId || artifact.row.kind !== "check_log") eligible = false;
      if (eligible) env.universe.refs.set(record.logRef, artifact.content.toString("utf8").split(/\r?\n/).length);
    } catch { eligible = false; }
    env.checkResults?.push({ command: record.command, exitCode: eligible ? record.exitCode : null, logRef: record.logRef });
  }
}
