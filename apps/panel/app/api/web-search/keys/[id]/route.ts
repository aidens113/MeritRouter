import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function keyId(ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Key id must be a number (config keys are edited in the config file)");
  return id;
}

const PatchBody = z.object({ enabled: z.boolean() }).strict();

/** Enable or disable a search-service key. */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await keyId(ctx);
    const p = await body(req, PatchBody);
    return { key: insights.setSearchKeyEnabled(sy, id, p.enabled) };
  });
}

/** Remove a search-service key (its secret is wiped). */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => insights.removeSearchKey(sy, await keyId(ctx)));
}
