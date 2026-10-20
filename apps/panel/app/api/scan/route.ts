import { handle } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  return handle(async (sy) => {
    const summary = await sy.scan();
    return { summary };
  });
}
