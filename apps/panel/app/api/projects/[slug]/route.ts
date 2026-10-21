import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const Body = z.object({ archived: z.boolean() });

/**
 * Archive or unarchive a project. Archiving keeps its settings, tasks, sessions, and brain, and
 * is refused (409) while it has running or queued tasks.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    const { archived } = await body(req, Body);
    const project = archived ? insights.archiveProject(sy, slug) : insights.unarchiveProject(sy, slug);
    return { project };
  });
}
