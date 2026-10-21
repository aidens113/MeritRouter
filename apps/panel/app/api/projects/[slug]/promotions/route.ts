import { insights, PROMOTION_STATUSES, type PromotionStatus } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * This project's promotions to `global/` (decision D9), newest first, optionally one status:
 * pending review, pending approval, approved (with the global entry's path), or rejected (with
 * the reason and the project lesson it was saved as). Deciding them is on the global Knowledge page.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    insights.projectInfo(sy, slug);
    const status = new URL(req.url).searchParams.get("status");
    if (status !== null && !(PROMOTION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status: one of ${PROMOTION_STATUSES.join(", ")}`);
    const promotions = sy.promotions({ project: slug, ...(status ? { status: status as PromotionStatus } : {}) });
    return { promotions: promotions.map(({ body: _body, ...meta }) => meta) };
  });
}
