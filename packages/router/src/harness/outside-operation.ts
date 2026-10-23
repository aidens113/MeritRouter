import { WorkerActionRequests, outsideRepositoryPolicy } from "./worker-actions.js";
import type { HarnessEnv } from "./tools.js";
import { LeaseRefSchema } from "../storage/task-leases.js";
import { assertRunAuthority } from "./task-authority.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";

/** Keep supervisor host/network authority live across provider retries and awaited I/O. */
export async function withOutsideAuthority<T>(env: HarnessEnv, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const current = () => {
    assertRunAuthority(env.ctx);
    if (!currentSupervisorAuthority(env.ctx.tasks.db, env.ctx.cfg, LeaseRefSchema.parse(env.ctx.taskLease), env.ctx.now()) || outsideRepositoryPolicy(env.ctx.cfg) !== "supervisor") throw new Error("Supervisor outside-repository authority was revoked");
  };
  current();
  const stopper = new AbortController();
  const signal = AbortSignal.any([env.ctx.signal, stopper.signal]);
  const timer = setInterval(() => { try { current(); } catch (error) { stopper.abort(error); } }, 50);
  try { const result = await run(signal); current(); return result; }
  finally { clearInterval(timer); }
}

/** Return a supervisor request/result instead of letting a worker perform a host/network action. */
export async function mediateOutsideOperation(env: HarnessEnv, operation: string, args: Record<string, unknown>): Promise<string | null> {
  const lease = LeaseRefSchema.parse(env.ctx.taskLease);
  if (env.ctx.signal.aborted || lease.taskId !== env.ctx.taskId || !env.ctx.tasks.dispatchable(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project)) {
    throw new Error("The original task lease no longer authorizes an outside action");
  }
  const policy = outsideRepositoryPolicy(env.ctx.cfg);
  if (policy === "disabled") throw new Error("Actions outside the repository are disabled by security.outside_repository");
  // Role text and tool arguments do not establish supervisor authority.
  if (currentSupervisorAuthority(env.ctx.tasks.db, env.ctx.cfg, lease, env.ctx.now()) && policy === "supervisor") return null;
  const row = await new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).fileOperation(env.ctx, {
    operation, args, reason: `${operation} requires an action outside this agent's repository sandbox`,
    ...(env.toolInvocationId ? { invocationId: env.toolInvocationId } : {}),
  });
  return JSON.stringify({
    id: row.id, status: row.status, operation,
    ...(row.status === "completed" ? { response: row.output, provenance: "supervisor_response" } : {
      message: row.status === "pending" || row.status === "running"
        ? "No action was performed by this agent. The exact request is awaiting supervisor/operator handling. Call await_supervisor_action with this id to wait without model requests."
        : "The supervisor action was refused or could not complete; no worker access was granted.",
    }),
  });
}
