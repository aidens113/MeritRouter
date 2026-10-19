import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";
import { BILLING_CLASSES, removedKeyIds, safePaidKey } from "@/lib/paid";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z
  .object({
    label: z.string().trim().max(80).optional(),
    enabled: z.boolean().optional(),
    billingClass: z.enum(BILLING_CLASSES).optional(),
    monthlyCapUsd: z.number().positive("a monthly cap must be more than $0 (leave it empty for none)").nullable().optional(),
    prepaidBalanceUsd: z.number().min(0).nullable().optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    /** Rotate the secret. Write-only, like adding. */
    secret: z.string().min(8, "the key looks too short").max(4000).optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "nothing to change");

async function keyId(sy: import("switchyard-router").Switchyard, ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Key id must be a number");
  if (!sy.vault.get(id)) throw new HttpError(404, `Unknown paid key ${id}`);
  return id;
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await keyId(sy, ctx);
    const p = await body(req, Patch);
    // A removed key has no secret left: enabling it would make requests fail at dispatch.
    if (removedKeyIds(sy).has(id)) throw new HttpError(409, "This key was removed (its secret is gone). Add a new key instead.");
    const k = insights.updatePaidKey(sy, id, p);
    return { key: safePaidKey(k as unknown as Record<string, unknown>, removedKeyIds(sy).has(id)) };
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await keyId(sy, ctx);
    insights.removePaidKey(sy, id);
    // Keys with recorded spend stay listed (disabled, secret wiped) so spend history stays complete.
    return { removed: id, keptForHistory: sy.vault.get(id) !== null };
  });
}
