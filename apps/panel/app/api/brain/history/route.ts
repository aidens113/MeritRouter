import { insights } from "meritrouter";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Query = z.object({ project: z.string().min(1), path: z.string().min(1).max(2000), offset: z.coerce.number().int().min(0).max(1000).default(0), limit: z.coerce.number().int().min(1).max(50).default(50) });
export async function GET(req: Request) {
  return handle(sy => {
    const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new HttpError(400, "Invalid history query");
    const { project, path, ...paging } = query.data;
    if (!sy.projects.get(project)) throw new HttpError(404, "Unknown project");
    if (!insights.brainDocumentVisible(project, path)) throw new HttpError(403, "Document is outside this project's Brain scope");
    return insights.brainDocumentHistoryPage(sy, project, path, paging);
  });
}
