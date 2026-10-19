import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().min(1) });

/**
 * Requeue an interrupted task, as `switchyard resume <task>` does: agent-loop roles (read-only
 * workers, supervisors) continue their latest interrupted session, and a coding task starts over
 * in a fresh worktree. The scheduler kick inside resumeTask() is a no-op here: the panel's
 * instance has its scheduler stopped (lib/sy.ts), so a worker (the MCP server or
 * `switchyard worker`) picks the task up on its next poll.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id } = await body(req, Body);
    const t = sy.tasks.get(id);
    if (!t) throw new HttpError(404, `Unknown task ${id}`);
    if (t.row.state !== "interrupted") throw new HttpError(409, `Task ${id} is ${t.row.state.replace(/_/g, " ")}; only interrupted tasks can be resumed`);
    return { state: sy.resumeTask(id) };
  });
}
