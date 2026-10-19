import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";
import { BILLING_CLASSES } from "@/lib/paid";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ platform: z.string().min(1).max(100), billingClass: z.enum(BILLING_CLASSES) });

/**
 * Record how a FreeLLMAPI key is billed. Stored by SwitchYard (not FreeLLMAPI); any key marked
 * other than free tier blocks its whole platform from free routing.
 */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = Number((await ctx.params).id);
    if (!Number.isInteger(id) || id < 0) throw new HttpError(400, "Key id must be a number");
    const b = await body(req, Body);
    insights.setFreeLlmApiKeyBilling(sy, id, b.platform, b.billingClass);
    return { id, billingClass: b.billingClass, blocksFreeRouting: b.billingClass !== "free_tier" };
  });
}
