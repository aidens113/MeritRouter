import { z } from "zod";
import { insights } from "meritrouter";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Query = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10_000).default(500),
});

/**
 * One session with a page of its event log (events with seq > `after`, at most `limit`), the
 * sessions it spawned, and its task's other sessions. Continue with `after` = the last seq while
 * `hasMore` is true.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a session id");
    const sp = new URL(req.url).searchParams;
    const q = Query.safeParse(Object.fromEntries(["after", "limit"].flatMap((k) => (sp.get(k) ? [[k, sp.get(k)]] : []))));
    if (!q.success) {
      const errors = q.error.issues.map((i) => `${i.path.map(String).join(".") || "query"}: ${i.message}`);
      throw new HttpError(400, errors.join("; "), errors);
    }
    const d = insights.sessionDetail(sy, id, { afterSeq: q.data.after, limit: q.data.limit });
    if (!d) throw new HttpError(404, `No session ${id}`);
    return d;
  });
}
