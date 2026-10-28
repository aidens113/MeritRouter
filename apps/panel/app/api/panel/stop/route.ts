import { turnPanelOffAfterDrain } from "meritrouter";
import { handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * The power button: record that the user turned the panel off (background checks then leave it
 * off), drain the Router, answer, and end this process. Agents keep running; a new agent session or
 * `meritrouter panel` starts the panel again. Same-origin only: a cross-site form cannot turn it off.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const origin = req.headers.get("origin");
    if (origin) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.headers.get("host")) throw new HttpError(403, "the panel can be turned off only from its own pages");
    }
    const { stoppedAt } = await turnPanelOffAfterDrain(sy);
    return { stopped: true, stoppedAt };
  });
}
