import { z } from "zod";
import { insights, SEARCH_SERVICE_IDS } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Web search for agents: the serving backend, search-service keys (last four characters only), recent web requests. */
export async function GET() {
  return handle((sy) => ({ view: insights.webSearchView(sy) }));
}

const AddSearchKeyBody = z
  .object({
    service: z.enum(SEARCH_SERVICE_IDS, { error: "pick a search service" }),
    secret: z.string().trim().min(8, "the key looks too short").max(500),
    label: z.string().trim().max(80).default(""),
  })
  .strict();

/** Store a Tavily, Brave, or Exa key in the encrypted vault. The secret is never echoed back. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, AddSearchKeyBody);
    return { key: insights.addSearchKey(sy, b), status: sy.web.status() };
  });
}
