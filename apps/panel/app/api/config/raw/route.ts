import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ text: z.string().max(1_000_000), save: z.boolean().default(false) });

/** Validate (and optionally save) the whole config as YAML. Saving keeps a .bak of the old file. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { text, save } = await body(req, Body);
    const v = save ? insights.writeConfigText(sy, text) : insights.validateConfigText(text, sy.cfg.configPath);
    if (!v.ok) throw new HttpError(400, save ? "Not saved: the YAML is invalid." : "The YAML is invalid.", v.errors);
    return { valid: true, saved: save };
  });
}
