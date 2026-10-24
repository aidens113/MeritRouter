import { insights } from "meritrouter";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Query = z.object({ project: z.string().min(1), query: z.string().min(1).max(2000), prefix: z.string().optional(), generation: z.string().optional(), offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) });
export async function GET(req: Request) {
  return handle(async sy => {
    const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new HttpError(400, "Invalid search query");
    if (!sy.projects.get(query.data.project)) throw new HttpError(404, "Unknown project");
    try { return await insights.brainSearchPage(sy, query.data); }
    catch (err) { if ((err as { code?: string }).code === "brain_cursor_stale") throw new HttpError(409, (err as Error).message); throw err; }
  });
}
