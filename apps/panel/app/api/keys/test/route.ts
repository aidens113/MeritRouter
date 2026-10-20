import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";
import { KeyTestBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

/**
 * List the models a key can use (a stored key by ref, or a pasted key before saving it). The
 * panel server calls the provider; the browser never does, and the secret is never returned.
 */
export async function POST(req: Request) {
  return handle(async (sy) => ({ result: await insights.testProviderKey(sy, await body(req, KeyTestBody)) }));
}
