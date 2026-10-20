import { z } from "zod";
import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Version = z.coerce.number().int().positive();

/**
 * A job's task graph (the latest plan version, or `?version=n`): nodes with their task state,
 * tier, importance, and waiting reason; edges; the critical path; and the job's file leases.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a job id");
    const raw = new URL(req.url).searchParams.get("version");
    const v = raw === null ? null : Version.safeParse(raw);
    if (v && !v.success) throw new HttpError(400, "version must be a positive integer");
    const plan = insights.jobPlan(sy, id, v?.success ? { version: v.data } : {});
    if (!plan) throw new HttpError(404, v?.success ? `No job ${id} with plan version ${v.data}` : `No job ${id}`);
    return { plan };
  });
}
