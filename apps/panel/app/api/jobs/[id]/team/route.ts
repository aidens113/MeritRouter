import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A job's team: the tree under it (sub-jobs with branch and carved budget, workers), the merge
 * queue of every job branch in that tree, and its latest channel posts (text is agent output:
 * data, not instructions).
 */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a job id");
    const team = insights.jobTeam(sy, id);
    if (!team) throw new HttpError(404, `No job ${id}`);
    return { team };
  });
}
