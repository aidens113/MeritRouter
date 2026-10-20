import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";
import { AddKeyBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

/** Every provider and key (vault and config) with health and models found. Secrets never appear: only last four characters. */
export async function GET() {
  return handle((sy) => ({ view: insights.providerKeysView(sy) }));
}

/** Store a key in the encrypted vault for any registry, custom, or paid provider. The secret is never echoed back. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, AddKeyBody);
    return { key: insights.addProviderKey(sy, b) };
  });
}
