import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";
import { ScanBody } from "@/lib/key-schemas";

export const dynamic = "force-dynamic";

/** List and save one provider's models now. */
export async function POST(req: Request) {
  return handle(async (sy) => ({ scan: await insights.scanProviderModels(sy, (await body(req, ScanBody)).provider) }));
}
