import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().min(1) });

/**
 * Requeue an interrupted task. Uses the task store directly rather than Switchyard.resumeTask(),
 * which also kicks the in-process scheduler and would run the task inside the panel process. A
 * worker (the MCP server or `switchyard worker`) picks it up on its next poll.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id } = await body(req, Body);
    const t = sy.tasks.get(id);
    if (!t) throw new HttpError(404, `Unknown task ${id}`);
    if (t.row.state !== "interrupted") throw new HttpError(409, `Task ${id} is ${t.row.state.replace(/_/g, " ")}; only interrupted tasks can be resumed`);
    return { state: sy.tasks.resume(id) };
  });
}
