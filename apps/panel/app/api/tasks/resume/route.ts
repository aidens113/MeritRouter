import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ project: z.string().trim().min(1).max(100).optional(), id: z.string().min(1) });

/**
 * Requeue an interrupted task or an eligible completed FINAL-rejected delivery. The shared
 * service enforces repair eligibility, retained workspace and project scope. Agent-loop roles (read-only
 * workers, supervisors) continue their latest interrupted session, and a coding task starts over
 * in a fresh worktree. The scheduler kick inside resumeTask() is a no-op here: the panel's
 * instance has its scheduler stopped (lib/sy.ts), so a worker (the MCP server or
 * `meritrouter worker`) picks the task up on its next poll.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id, project } = await body(req, Body);
    const t = sy.tasks.get(id);
    if (!t) throw new HttpError(404, `Unknown task ${id}`);
    try {
      return { state: sy.resumeTask(id, project) };
    } catch (error) {
      if ((error as { code?: unknown }).code === "task_invalid") {
        throw new HttpError(409, (error as Error).message);
      }
      throw error;
    }
  });
}
