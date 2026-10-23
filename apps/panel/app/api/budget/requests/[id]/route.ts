import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";
const Id = z.string().regex(/^[1-9]\d*$/, "Request id must be a positive integer").transform(Number).pipe(z.number().int().positive().safe());
const Body = z.object({
  // An explicit empty scope is reserved for unassigned requests on the install dashboard.
  project: z.string().trim().max(100),
  approve: z.boolean(),
  grant: z.number().int().min(1).max(1000).optional(),
  reason: z.string().trim().min(1, "Give a reason the worker can act on").max(2000),
}).strict();

/** Human decisions are project-scoped; the library atomically enforces grants and stale state. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async (sy) => {
    const parsed = Id.safeParse((await ctx.params).id);
    if (!parsed.success) throw new HttpError(400, "Request id must be a positive safe integer");
    const input = await body(req, Body);
    try {
      return { request: insights.decideBudgetRequest(sy, parsed.data, { ...input, by: { kind: "human", id: "panel" } }, input.project) };
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === "already_decided" || code === "task_finished" || code === "budget_pool_exhausted") throw new HttpError(409, (err as Error).message);
      if (code === "invalid_request" || code === "reason_required") throw new HttpError(400, (err as Error).message);
      throw err;
    }
  });
}
