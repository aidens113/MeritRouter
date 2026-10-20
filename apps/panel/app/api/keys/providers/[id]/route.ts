import { insights } from "switchyard-router";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Remove a custom provider from the config file (only once it has no keys). */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = (await ctx.params).id;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new HttpError(400, "Not a provider id");
    return insights.removeCustomProvider(sy, id);
  });
}
