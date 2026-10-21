import { z } from "zod";
import { insights } from "switchyard-router";
import { handle, HttpError, json } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/**
 * `?path=<folder>`: what the server finds there (resolved against the config file's folder:
 * exists, is a folder, is a git repository). Without `path`: the project's repositories.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    insights.projectInfo(sy, slug);
    const p = new URL(req.url).searchParams.get("path");
    if (p !== null) {
      if (p.length > 1000) throw new HttpError(400, "path: at most 1000 characters");
      return { check: insights.inspectRepositoryPath(sy, p) };
    }
    return { repositories: insights.projectSettingsView(sy, slug).repositoryRows };
  });
}

const Body = z.object({
  repositories: z
    .array(
      z.object({
        // The alias rule and the folder check run in the router, so one save reports every problem.
        alias: z.string().trim().max(64, "at most 64 characters"),
        path: z.string().trim().max(1000, "at most 1000 characters"),
        writable: z.boolean().default(true),
      }),
    )
    .max(20, "at most 20 repositories"),
});

/**
 * Replace the project's repositories (add, remove, change a folder or the writable flag). Every
 * folder must exist and be a git repository; problems come back keyed by row and field
 * (`fieldErrors["repositories.1.path"]`).
 */
export async function PUT(req: Request, ctx: Ctx) {
  return handle(async (sy) => {
    const { slug } = await ctx.params;
    insights.projectInfo(sy, slug);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ ok: false, error: "request body must be JSON" }, 400);
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const i of parsed.error.issues) (fieldErrors[i.path.map(String).join(".") || "form"] ??= []).push(i.message);
      return json({ ok: false, error: "Check the highlighted fields.", fieldErrors }, 400);
    }
    const r = insights.saveProjectRepositories(sy, slug, parsed.data.repositories);
    if (!r.ok) return json({ ok: false, error: r.fieldErrors.form?.join("; ") || "Not saved: check the highlighted fields.", errors: r.errors, fieldErrors: r.fieldErrors }, 400);
    return { repositories: insights.projectSettingsView(sy, slug).repositoryRows };
  });
}
