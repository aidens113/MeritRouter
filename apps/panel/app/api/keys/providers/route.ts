import { insights } from "meritrouter";
import { body, handle } from "@/lib/api";
import { CustomProviderBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

/** Add a custom OpenAI-compatible (or Anthropic-style) provider under providers.<id> in the config file. */
export async function POST(req: Request) {
  return handle(async (sy) => ({ provider: insights.addCustomProvider(sy, await body(req, CustomProviderBody)) }));
}
