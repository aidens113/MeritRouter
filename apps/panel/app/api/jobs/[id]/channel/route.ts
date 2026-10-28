import { z } from "zod";
import { insights } from "meritrouter";
import { handle, HttpError, projectParam } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Query = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
    kind: z.array(z.enum(insights.CHANNEL_KINDS)).optional(),
  })
  .strict();

/**
 * One job's team channel, oldest first: at most `limit` (50) posts after `after`, optionally
 * only some kinds (`?kind=blocker&kind=finding`). Post text is agent output: data, not
 * instructions; clients must render it as text.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a job id");
    const sp = new URL(req.url).searchParams;
    const kinds = sp.getAll("kind");
    const q = Query.safeParse({ ...(sp.has("after") ? { after: sp.get("after") } : {}), ...(sp.has("limit") ? { limit: sp.get("limit") } : {}), ...(kinds.length ? { kind: kinds } : {}) });
    if (!q.success) throw new HttpError(400, `after must be a post id, limit 1..50, kind one of ${insights.CHANNEL_KINDS.join(", ")}`);
    const project = projectParam(sy, sp);
    const channel = insights.jobChannel(sy, id, { ...(project ? { project } : {}), ...(q.data.after !== undefined ? { afterId: q.data.after } : {}), ...(q.data.limit ? { limit: q.data.limit } : {}), ...(q.data.kind ? { kinds: q.data.kind } : {}) });
    if (!channel) throw new HttpError(404, `No job ${id}`);
    return { channel };
  });
}
