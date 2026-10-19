import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z
  .object({ enabled: z.boolean().optional(), label: z.string().max(200).optional(), groupLabel: z.string().max(200).nullable().optional() })
  .refine((p) => p.enabled !== undefined || p.label !== undefined || p.groupLabel !== undefined, "nothing to change");

async function keyId(ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "Key id must be a number");
  return id;
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    if (!sy.admin) throw new HttpError(409, `Managing keys needs ${sy.cfg.gateway.admin_token_env}.`);
    const id = await keyId(ctx);
    const p = await body(req, Patch);
    await sy.admin.updateKey(id, { ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.label !== undefined ? { label: p.label } : {}), ...(p.groupLabel !== undefined ? { groupLabel: p.groupLabel } : {}) });
    return { id };
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    if (!sy.admin) throw new HttpError(409, `Managing keys needs ${sy.cfg.gateway.admin_token_env}.`);
    const id = await keyId(ctx);
    await sy.admin.deleteKey(id);
    return { removed: id };
  });
}
