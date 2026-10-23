import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";
export const dynamic = "force-dynamic";
const Project = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const Create = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), goal: z.string().max(16000).default("") }).strict();
export async function GET(req: Request) {
  return handle(sy => {
    const project = Project.safeParse(new URL(req.url).searchParams.get("project"));
    if (!project.success) throw new HttpError(400, "Choose a project");
    return insights.labsListView(sy, project.data);
  });
}
export async function POST(req: Request) {
  return handle(async sy => {
    const project = Project.safeParse(new URL(req.url).searchParams.get("project"));
    if (!project.success) throw new HttpError(400, "Choose a project");
    const b = await body(req, Create);
    return insights.requestLabControl(sy, project.data, b.name, { action: "create", goal: b.goal });
  });
}
