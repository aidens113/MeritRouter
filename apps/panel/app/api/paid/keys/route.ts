import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";
import { BILLING_CLASSES, safePaidKey } from "@/lib/paid";

export const dynamic = "force-dynamic";

const Body = z.object({
  provider: z.string().regex(/^[a-z0-9-]+$/, "pick a provider"),
  label: z.string().trim().max(80).default(""),
  secret: z.string().min(8, "the key looks too short").max(4000),
  billingClass: z.enum(BILLING_CLASSES).default("paid_postpaid"),
  monthlyCapUsd: z.number().positive("a monthly cap must be more than $0 (leave it empty for none)").nullable().default(null),
  prepaidBalanceUsd: z.number().min(0).nullable().default(null),
  expiresAt: z.number().int().positive().nullable().default(null),
});

/** Add a direct paid-provider key to the encrypted vault. The secret is never echoed back. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    if (!sy.cfg.paid.providers[b.provider]) throw new HttpError(400, `Unknown paid provider ${b.provider}: add it under Settings → Paid providers first.`, [`provider: unknown paid provider ${b.provider}`]);
    const k = insights.addPaidKey(sy, b);
    return { key: safePaidKey(k as unknown as Record<string, unknown>, false) };
  });
}
