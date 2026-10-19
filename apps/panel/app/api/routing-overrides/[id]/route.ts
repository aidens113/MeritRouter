import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({ enabled: z.boolean().optional(), note: z.string().max(500).optional() }).refine((p) => p.enabled !== undefined || p.note !== undefined, "send enabled and/or note");

async function idOf(ctx: Ctx, sy: import("switchyard-router").Switchyard): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || !sy.catalog.routingOverrides().some((o) => o.id === id)) throw new HttpError(404, "No such routing rule");
  return id;
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await idOf(ctx, sy);
    const p = await body(req, Patch);
    sy.catalog.updateRoutingOverride(id, { ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.note !== undefined ? { note: p.note } : {}) });
    return { id };
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await idOf(ctx, sy);
    sy.catalog.removeRoutingOverride(id);
    return { removed: id };
  });
}
