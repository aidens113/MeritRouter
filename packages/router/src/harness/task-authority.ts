import { AdmissionDenied } from "../core/errors.js";
import type { RunContext } from "../runners/types.js";
import { LeaseRefSchema } from "../storage/task-leases.js";

/** Recheck before each tool/effect: an earlier model request cannot authorize later work. */
export function assertRunAuthority(ctx: RunContext): void {
  if (ctx.signal.aborted) throw new Error(`aborted: ${String(ctx.signal.reason ?? "aborted")}`);
  const parsed = LeaseRefSchema.safeParse(ctx.taskLease);
  if (!parsed.success || parsed.data.taskId !== ctx.taskId) throw new AdmissionDenied("lease_lost", "tool requires the original captured task lease", undefined, ctx.taskId);
  const lease = parsed.data;
  if (!ctx.tasks.dispatchable(lease.taskId, lease.owner, lease.runCount, lease.incarnation, lease.project)) {
    throw new AdmissionDenied("lease_lost", "captured task lease no longer authorizes this tool", undefined, ctx.taskId);
  }
}
