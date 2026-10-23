import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

const Body = z.object({ id: z.string().min(1).max(1000), reason: z.string().trim().min(1).max(2000) }).strict();
export async function POST(req: Request) {
  return handle(async sy => {
    const input = await body(req, Body);
    try { return insights.acknowledgeModelQuarantine(sy, input.id, { actor: "human:panel", reason: input.reason }); }
    catch (error) {
      if ((error as { code?: string }).code === "not_quarantined") throw new HttpError(409, (error as Error).message);
      throw error;
    }
  });
}
