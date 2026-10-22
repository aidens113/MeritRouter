import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";
export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  return handle(async sy => {
    const q = new URL(req.url).searchParams;
    const project = q.get("project"), service = q.get("service");
    if (!project || !service) throw new HttpError(400, "Choose a project and service");
    return insights.labLogs(sy, project, (await ctx.params).name, service);
  });
}
