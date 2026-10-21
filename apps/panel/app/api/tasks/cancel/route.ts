import { z } from "zod";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ project: z.string().trim().min(1).max(100).optional(), ids: z.array(z.string().min(1)).min(1).max(200) });

/** Cancel tasks. Unstarted tasks cancel at once; running ones stop at their next check. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { ids, project } = await body(req, Body);
    // With a project, a task of another project is refused.
    return { results: sy.cancelTasks(ids, project) };
  });
}
