import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ endpointId: z.string().min(1), trials: z.number().int().min(1).max(10).optional(), evalIds: z.array(z.string().min(1)).optional() });

/** Queue a qualification run. A running worker executes and grades it. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    if (!sy.catalog.get(b.endpointId)) throw new HttpError(404, `Unknown model ${b.endpointId}`);
    try {
      const run = await insights.startQualification(sy, b.endpointId, { ...(b.trials ? { trials: b.trials } : {}), ...(b.evalIds ? { evalIds: b.evalIds } : {}) });
      return { run };
    } catch (err) {
      // Budget, status, and suite problems are explained in the message.
      throw new HttpError(409, (err as Error).message);
    }
  });
}
