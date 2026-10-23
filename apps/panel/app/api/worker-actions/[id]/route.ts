import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const Body = z.object({ project: z.string().max(100), decision: z.enum(["approve", "deny"]), reason: z.string().trim().min(1).max(4000), response: z.string().max(20000).optional() }).strict();
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async sy => {
    const id = Id.safeParse((await ctx.params).id);
    if (!id.success) throw new HttpError(400, "Invalid worker action id");
    const input = await body(req, Body);
    const request = insights.getWorkerAction(sy.db, { project: input.project, id: id.data });
    if (!request) throw new HttpError(404, "Unknown worker action in project");
    if (request.status !== "pending") throw new HttpError(409, "This request has already been decided; refresh to see its result");
    if (input.decision === "approve" && request.action.operation && !input.response?.trim()) throw new HttpError(400, "Perform the operation and supply its result before responding");
    try { return { request: await insights.decideWorkerAction(sy.db, sy.cfg, { ...input, id: id.data }, req.signal) }; }
    catch (error) { throw new HttpError(409, (error as Error).message); }
  });
}
