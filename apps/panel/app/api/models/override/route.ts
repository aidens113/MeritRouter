import { z } from "zod";
import { EndpointOverrideSchema, insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.string().min(1), override: z.unknown() });

/** Replace (or clear, with override: null) the panel override for one model. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    if (!sy.catalog.get(b.id)) throw new HttpError(404, `Unknown model ${b.id}`);
    if (b.override === null) {
      insights.setModelOverride(sy, b.id, null);
      return { override: null };
    }
    const parsed = EndpointOverrideSchema.safeParse(b.override);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "override"}: ${i.message}`);
      throw new HttpError(400, errors.join("; "), errors);
    }
    insights.setModelOverride(sy, b.id, parsed.data);
    return { override: sy.catalog.override(b.id) };
  });
}
