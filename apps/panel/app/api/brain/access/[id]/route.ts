import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ approve: z.boolean(), reason: z.string().trim().min(1, "give a reason: the worker and supervisor see it").max(1000) });

/** Approve or deny a worker's brain access request (recorded as decided by you). */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Request id must be a number");
    const b = await body(req, Body);
    const current = sy.brainAccess.get(id);
    if (!current) throw new HttpError(404, `Unknown access request ${id}`);
    if (current.status !== "pending") throw new HttpError(409, `Request ${id} was already ${current.status} by ${current.decidedBy ?? "someone"}`);
    return { request: insights.decideBrainAccess(sy, id, b.approve, b.reason) };
  });
}
