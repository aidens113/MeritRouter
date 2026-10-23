import YAML from "yaml";
import { z } from "zod";
import { insights, RulebookSchema } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.union([
  z.object({ text: z.string().max(500_000), save: z.boolean().default(true) }),
  z.object({ rulebook: z.record(z.string(), z.unknown()), save: z.boolean().default(true) }),
]);

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => e.issues.map((i) => `${i.path.map(String).join(".") || "rulebook"}: ${i.message}`);

/** Save the rulebook from the table editor (an object) or the raw editor (YAML text). */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Body);
    let text: string;
    if ("rulebook" in b) {
      const parsed = RulebookSchema.safeParse(b.rulebook);
      if (!parsed.success) throw new HttpError(400, "The rulebook is invalid.", issues(parsed.error));
      text = `# MeritRouter difficulty rulebook (edited in the panel)\n${YAML.stringify(parsed.data)}`;
    } else {
      text = b.text;
      let raw: unknown;
      try {
        raw = YAML.parse(text);
      } catch (err) {
        throw new HttpError(400, "The YAML is invalid.", [`YAML: ${(err as Error).message}`]);
      }
      const parsed = RulebookSchema.safeParse(raw);
      if (!parsed.success) throw new HttpError(400, "The rulebook is invalid.", issues(parsed.error));
    }
    if (!b.save) return { valid: true, saved: false };
    const r = insights.writeRulebook(sy, text);
    if (!r.ok) throw new HttpError(400, "Not saved.", r.errors);
    return { valid: true, saved: true, path: r.path };
  });
}
