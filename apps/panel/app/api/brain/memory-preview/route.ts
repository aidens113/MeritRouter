import { insights } from "meritrouter";
import { z } from "zod";
import { handle, HttpError } from "@/lib/api";
import { findProject } from "@/lib/project";

export const dynamic = "force-dynamic";
const Query = z.object({ project: z.string().min(1).max(120), taskId: z.string().min(1).max(200).optional() }).strict();
export async function GET(req: Request) {
  return handle(sy => {
    const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new HttpError(400, "Invalid manifest query");
    if (!findProject(sy, query.data.project)) throw new HttpError(404, "Unknown project");
    // The task is looked up in the project's own store only.
    if (query.data.taskId && insights.taskOwner(sy, query.data.taskId, query.data.project) !== query.data.project) throw new HttpError(404, "Task is unavailable in this project");
    return { receipts: insights.brainMemoryManifestPreview(sy, query.data) };
  });
}
