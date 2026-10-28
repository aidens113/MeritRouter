import { z } from "zod";
import { insights } from "meritrouter";
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
    // The task's own project's store (an id held by two projects is refused without a project).
    const owner = insights.taskOwner(sy, id, project);
    if (!owner) throw new HttpError(404, `Unknown task ${id}${project ? ` in project ${project}` : ""}`);
    try {
      return { state: sy.resumeTask(id, project ?? owner) };
    } catch (error) {
      if ((error as { code?: unknown }).code === "task_invalid") {
        throw new HttpError(409, (error as Error).message);
      }
      throw error;
    }
  });
}
