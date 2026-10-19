import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Requeue the task of an interrupted session so its next run continues that session (a coding
 * session in its own worktree; completion work re-runs fresh, linked to it). The panel's instance
 * never runs tasks (its scheduler is stopped): a worker, the MCP server or `switchyard worker`,
 * picks the task up on its next poll.
 */
export async function POST(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a session id");
    const s = sy.sessions.get(id);
    if (!s) throw new HttpError(404, `No session ${id}`);
    try {
      return sy.resumeSession(id);
    } catch (err) {
      // Refusals (not interrupted, task not interrupted, no task) are conflicts with the current state.
      const code = (err as { code?: unknown }).code;
      if (code === "task_invalid") throw new HttpError(409, (err as Error).message);
      throw err;
    }
  });
}
