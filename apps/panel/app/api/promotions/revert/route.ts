import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .regex(/^global\/[^\\]+\.md$/,"only a global entry (global/**/*.md) can be reverted"),
  reason: z.string().trim().min(1, "say why: the reason is recorded in the brain's history").max(1000, "at most 1000 characters"),
});

/** Revert a global entry: one brain commit removes it, recording who (`panel`) and why. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    return { revert: await insights.revertGlobalEntry(sy, b.path, "panel", b.reason) };
  });
}
