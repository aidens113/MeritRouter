import { insights } from "switchyard-router";
import { handle } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * What deleting a project would remove and keep, with counts, and why it cannot be deleted now
 * (`blockers`). Read when the Danger zone's first dialog opens, so the counts are current.
 */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    const preview = await insights.previewProjectDeletion(sy, slug);
    return { preview };
  });
}
