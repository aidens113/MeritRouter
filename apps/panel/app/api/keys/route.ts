import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";
import { safeKey } from "@/lib/keys";

export const dynamic = "force-dynamic";

const Body = z.object({
  platform: z.string().min(1).max(100),
  label: z.string().max(200).default(""),
  key: z.string().min(1).max(4000),
  groupLabel: z.string().max(200).nullable().optional(),
});

/** Add a provider key to FreeLLMAPI. The secret is forwarded once and never echoed back. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    if (!sy.admin) throw new HttpError(409, `Managing keys needs a FreeLLMAPI dashboard token: set ${sy.cfg.gateway.admin_token_env} and restart the panel.`);
    const b = await body(req, Body);
    const created = (await sy.admin.addKey({ platform: b.platform, key: b.key, ...(b.label ? { label: b.label } : {}) })) as Record<string, unknown> | null;
    let id: number | null = typeof created?.id === "number" ? created.id : null;
    if (b.groupLabel) {
      // addKey takes no group: set it right after, finding the new key if the response has no id.
      if (id === null) {
        const keys = (await sy.admin.listKeys()).filter((k) => k.platform === b.platform && (!b.label || k.label === b.label));
        id = keys.length ? Math.max(...keys.map((k) => Number(k.id))) : null;
      }
      if (id !== null) await sy.admin.updateKey(id, { groupLabel: b.groupLabel });
    }
    const key = id !== null ? (await sy.admin.listKeys()).find((k) => Number(k.id) === id) : undefined;
    return { key: key ? safeKey(key) : null };
  });
}
