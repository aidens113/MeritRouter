import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Optional: the project the session must belong to (panel pages send theirs). */
const Body = z.object({ project: z.string().trim().min(1).max(100).optional() });

/**
 * Requeue the task of an interrupted session so its next run continues that session (a coding
 * session in its own worktree; completion work re-runs fresh, linked to it). The panel's instance
 * never runs tasks (its scheduler is stopped): a worker, the MCP server or `meritrouter worker`,
 * picks the task up on its next poll.
 */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a session id");
    const { project } = req.headers.get("content-type")?.includes("json") ? await body(req, Body) : { project: undefined };
    // The session's own project's store (an id held by two projects is refused without a project).
    const owner = insights.sessionOwner(sy, id, project);
    if (!owner || (project && owner !== project)) throw new HttpError(404, `No session ${id}${project ? ` in project ${project}` : ""}`);
    try {
      return sy.resumeSession(id, project ?? owner);
    } catch (err) {
      // Refusals (not interrupted, task not interrupted, no task) are conflicts with the current state.
      const code = (err as { code?: unknown }).code;
      if (code === "task_invalid") throw new HttpError(409, (err as Error).message);
      throw err;
    }
  });
}
