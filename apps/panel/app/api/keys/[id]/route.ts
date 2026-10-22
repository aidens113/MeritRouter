import type { Switchyard } from "switchyard-router";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";
import { KeyPatchBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Vault key id from the path. Config keys are edited in the config file, never here. */
async function keyId(sy: Switchyard, ctx: Ctx): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Key id must be a number (config keys are edited in the config file)");
  if (!sy.vault.get(id)) throw new HttpError(404, `Unknown key ${id}`);
  return id;
}

export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const id = await keyId(sy, ctx);
    const p = await body(req, KeyPatchBody);
    const key = insights.updateProviderKey(sy, id, p);
    // A new secret or a re-enabled key may reach models the provider's listing does not have yet.
    const scan = key.enabled && (p.secret !== undefined || p.enabled === true) ? await insights.scanAfterKeyChange(sy, key.provider) : null;
    return { key, scan, scanText: scan ? insights.keyScanText(scan) : null };
  });
}

/** Keys with recorded paid spend stay listed (disabled, secret wiped) so spend history stays complete. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async (sy) => insights.removeProviderKey(sy, await keyId(sy, ctx)));
}
