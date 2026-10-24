import { insights } from "meritrouter";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Query = z.object({ project: z.string().min(1), prefix: z.string().optional(), after: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export async function GET(req: Request) {
  return handle(async sy => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "Invalid catalog query");
    if (!sy.projects.get(parsed.data.project)) throw new HttpError(404, "Unknown project");
    try { return await insights.brainCatalogPage(sy, parsed.data); }
    catch (err) { if ((err as { code?: string }).code === "brain_cursor_stale") throw new HttpError(409, (err as Error).message); throw err; }
  });
}
