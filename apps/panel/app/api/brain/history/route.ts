import { insights } from "meritrouter";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Query = z.object({ project: z.string().min(1), path: z.string().min(1).max(2000), cursor: z.string().max(5000).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();
export async function GET(req: Request) {
  return handle(async sy => {
    const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new HttpError(400, "Invalid history query");
    const { project, path, ...paging } = query.data;
    if (!sy.projects.get(project)) throw new HttpError(404, "Unknown project");
    if (!insights.brainDocumentVisible(project, path)) throw new HttpError(403, "Document is outside this project's Brain scope");
    try { return await insights.brainDocumentHistoryPage(sy, project, path, paging); }
    catch (err) { if ((err as { code?: string }).code === "brain_cursor_stale") throw new HttpError(409, (err as Error).message); throw err; }
  });
}
