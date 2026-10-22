import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const Body = z.object({ archived: z.boolean() });
const DeleteBody = z.object({ confirm: z.string() });

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

/**
 * Delete a project permanently: its settings, tasks, sessions, artifacts, SwitchYard worktrees,
 * and brain folder (requests and paid spend are kept for accounting; repository folders and
 * branches are never touched). `confirm` must be the slug. Refused (409) while it has running or
 * queued tasks, and for the last live project. GET ./deletion previews it.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    const { confirm } = await body(req, DeleteBody);
    const deleted = await insights.deleteProject(sy, slug, { confirm });
    return { deleted };
  });
}
