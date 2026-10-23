import { z } from "zod";
import { insights } from "meritrouter";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Agents = z.enum(["0", "1", "true", "false"]);

/**
 * A job's team metrics (or one agent's task): wall-clock, parallelism over time, critical paths,
 * requests and cost per completed task, verification share, and waiting time by reason.
 * `?agents=1` adds every agent's run and wait intervals.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = decodeURIComponent((await ctx.params).id);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new HttpError(400, "id must be a job or task id");
    const raw = new URL(req.url).searchParams.get("agents");
    const a = raw === null ? null : Agents.safeParse(raw);
    if (a && !a.success) throw new HttpError(400, "agents must be 1 or 0");
    const m = insights.jobMetrics(sy, id);
    if (!m) throw new HttpError(404, `No job or task ${id}`);
    if (a?.success && (a.data === "1" || a.data === "true")) return { metrics: m };
    const { agents: _agents, ...rest } = m;
    return { metrics: rest };
  });
}
