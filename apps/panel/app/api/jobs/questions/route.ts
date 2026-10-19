import { z } from "zod";
import { body, handle } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ id: z.number().int().positive(), answer: z.string().trim().min(1, "write an answer").max(10_000) });

/** Answer a question a job's supervisor is waiting on. A running supervisor sees it within a second. */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const { id, answer } = await body(req, Body);
    sy.answerQuestion(id, answer, "user");
    return { answered: id };
  });
}
