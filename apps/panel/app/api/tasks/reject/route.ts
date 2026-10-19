import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().min(1), reason: z.string().trim().min(1, "a reason is required").max(4000) });

/** Reject a finished task's result as the person using the panel; it becomes unmet. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id, reason } = await body(req, Body);
    return insights.decideTaskAcceptance(sy, id, "reject", { kind: "human", id: "panel" }, reason);
  });
}
