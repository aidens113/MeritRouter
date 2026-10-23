import { z } from "zod";
import { insights, PROFILE_NAMES, TIER_NAMES } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  profile: z.enum(PROFILE_NAMES).nullable(),
  tier: z.enum(TIER_NAMES).nullable(),
  kind: z.enum(["force", "prefer", "block"]),
  endpointId: z.string().min(1),
  allowBelowFloor: z.boolean().default(false),
  note: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
});

export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    if (b.allowBelowFloor && b.kind !== "force") throw new HttpError(400, "Only force rules can allow a model below the size floor");
    if (b.profile && !sy.cfg.profiles[b.profile]) throw new HttpError(400, `Task type ${b.profile} is not configured`);
    if (!sy.catalog.get(b.endpointId)) throw new HttpError(404, `Unknown model ${b.endpointId}`);
    const id = insights.addRoutingOverride(sy, { ...b, ...(b.note ? { note: b.note } : {}) });
    return { id };
  });
}
