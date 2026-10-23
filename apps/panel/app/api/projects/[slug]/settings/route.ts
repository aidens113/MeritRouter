import { z } from "zod";
import { insights } from "meritrouter";
import { body, handle, HttpError, json } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** One project's settings as the settings page shows them: each override beside the global value. */
export async function GET(_req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    return { settings: insights.projectSettingsView(sy, slug) };
  });
}

const Segment = z.union([z.string().min(1).max(120), z.number().int().min(0).max(1000)]);

const Body = z.object({
  /** Paths relative to the project (`["team", "max_agents"]`); a null value resets the key to the global value. */
  patch: z
    .array(z.object({ path: z.array(Segment).min(1).max(8), value: z.unknown() }))
    .min(1, "nothing to save")
    .max(60, "at most 60 changes at once"),
});

/**
 * Edit one project's settings under `projects.<slug>` in the config (validated before writing,
 * previous file kept as .bak, running workers reload it). Errors come back keyed by
 * project-relative field (`fieldErrors["team.max_agents"]`).
 */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    // 404 for an unknown project; an archived project's settings are read-only.
    if (insights.projectInfo(sy, slug).archived) throw new HttpError(409, `project ${slug} is archived: unarchive it to change its settings`);
    const { patch } = await body(req, Body);
    const r = insights.saveProjectSettings(sy, slug, patch.map((p) => ({ path: p.path, value: p.value ?? null })));
    if (!r.ok) return json({ ok: false, error: r.fieldErrors.form?.join("; ") || "Not saved: check the highlighted fields.", errors: r.errors, fieldErrors: r.fieldErrors }, 400);
    return { saved: patch.length };
  });
}
