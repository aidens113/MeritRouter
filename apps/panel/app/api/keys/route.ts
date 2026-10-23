import { insights } from "meritrouter";
import { body, handle } from "@/lib/api";
import { AddKeyBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

/** Every provider and key (vault and config) with health and models found. Secrets never appear: only last four characters. */
export async function GET() {
  return handle((sy) => ({ view: insights.providerKeysView(sy) }));
}

/**
 * Store a key in the encrypted vault for any registry, custom, or paid provider, then list that
 * provider's models so routing can use them at once (`scan`). The secret is never echoed back.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, AddKeyBody);
    const key = insights.addProviderKey(sy, b);
    const scan = key.enabled ? await insights.scanAfterKeyChange(sy, key.provider) : null;
    return { key, scan, scanText: scan ? insights.keyScanText(scan) : null };
  });
}
