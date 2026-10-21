import { z } from "zod";
import { insights, SESSION_STATUSES } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Query = z.object({
  status: z.array(z.enum(SESSION_STATUSES)).max(SESSION_STATUSES.length).optional(),
  project: z.string().trim().min(1).max(100).optional(),
  task: z.string().trim().min(1).max(200).optional(),
  job: z.string().trim().min(1).max(200).optional(),
  parent: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/** Agent sessions, newest first. Filters: `project`, `status` (repeatable), `task`, `job`, `parent`, `limit`. */
export async function GET(req: Request) {
  return handle(async (sy) => {
    const sp = new URL(req.url).searchParams;
    const statuses = sp.getAll("status").filter(Boolean);
    const q = Query.safeParse({
      ...(statuses.length ? { status: statuses } : {}),
      ...Object.fromEntries(["project", "task", "job", "parent", "limit"].flatMap((k) => (sp.get(k) ? [[k, sp.get(k)]] : []))),
    });
    if (!q.success) {
      const errors = q.error.issues.map((i) => `${i.path.map(String).join(".") || "query"}: ${i.message}`);
      throw new HttpError(400, errors.join("; "), errors);
    }
    const f = q.data;
    const sessions = insights.sessionsView(sy, {
      ...(f.project ? { project: f.project } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.task ? { taskId: f.task } : {}),
      ...(f.job ? { jobId: f.job } : {}),
      ...(f.parent ? { parentSessionId: f.parent } : {}),
      limit: f.limit,
    });
    return { sessions };
  });
}
