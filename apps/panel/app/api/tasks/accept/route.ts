import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().min(1), reason: z.string().trim().max(4000).optional() });

/**
 * Accept a finished task's result as the person using the panel (recorded as `panel`, a human
 * acceptor). needs_supervisor and not_verified results need a reason; unmet results are refused.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id, reason } = await body(req, Body);
    return insights.decideTaskAcceptance(sy, id, "accept", { kind: "human", id: "panel" }, reason || null);
  });
}
