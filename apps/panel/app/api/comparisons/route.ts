import { z } from "zod";
import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Limit = z.coerce.number().int().positive().max(100);

/** Recorded team-vs-single comparisons, newest first (`?limit=n`, at most 100). Read-only: comparisons start from the CLI. */
export async function GET(req: Request) {
  return handle(async (sy) => {
    const raw = new URL(req.url).searchParams.get("limit");
    const limit = raw === null ? null : Limit.safeParse(raw);
    if (limit && !limit.success) throw new HttpError(400, "limit must be an integer from 1 to 100");
    return { comparisons: insights.comparisons(sy, { limit: limit?.success ? limit.data : 20 }) };
  });
}
