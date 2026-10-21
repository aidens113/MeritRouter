import path from "node:path";
import { z } from "zod";
import { insights, PROJECT_SLUG_RE, REPOSITORY_ALIAS_RE } from "switchyard-router";
import { handle, HttpError, json } from "@/lib/api";
import { switcherProjects } from "@/lib/project";

export const dynamic = "force-dynamic";

/**
 * The live projects with their activity, for the project switcher. `?path=<folder>`: what the
 * server finds at a new project's repository folder and what creating the project will do there.
 */
export async function GET(req: Request) {
  return handle((sy) => {
    const p = new URL(req.url).searchParams.get("path");
    if (p !== null) {
      if (p.length > 1000) throw new HttpError(400, "path: at most 1000 characters");
      return { check: insights.inspectRepositoryPath(sy, p) };
    }
    return { projects: switcherProjects(sy) };
  });
}

const Body = z.object({
  name: z.string().trim().min(1, "give the project a name").max(80, "at most 80 characters"),
  slug: z.string().trim().min(1, "enter a slug").max(64, "at most 64 characters").regex(PROJECT_SLUG_RE, "lower-case letters, digits, '.', '_', '-', starting with a letter or digit"),
  repositories: z
    .array(
      z.object({
        alias: z.string().trim().min(1, "enter an alias").max(64, "at most 64 characters").regex(REPOSITORY_ALIAS_RE, "letters, digits, '.', '_', '-' only"),
        path: z.string().trim().min(1, "enter the repository's folder").max(1000),
        writable: z.boolean().default(true),
      }),
    )
    .max(20, "at most 20 repositories")
    .default([]),
  mounts: z
    .array(
      z.object({
        prefix: z.string().trim().min(1, "enter a prefix").max(200),
        path: z.string().trim().min(1, "enter a folder").max(1000),
        commit: z.boolean().default(false),
      }),
    )
    .max(20, "at most 20 mounts")
    .default([]),
});

type FieldErrors = Record<string, string[]>;

function add(errors: FieldErrors, key: string, msg: string) {
  (errors[key] ??= []).push(msg);
}

/**
 * Create a project: its repository folders prepared (created and set up with git as needed),
 * `projects.<slug>` in the global config (validated, backed up, reloaded by running workers), and
 * its brain folders. Every problem comes back keyed by field
 * (`fieldErrors["repositories.0.path"]`), so the form shows it beside the input.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ ok: false, error: "request body must be JSON" }, 400);
    }
    const fieldErrors: FieldErrors = {};
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues) add(fieldErrors, i.path.map(String).join(".") || "form", i.message);
      return json({ ok: false, error: "Check the highlighted fields.", errors: Object.entries(fieldErrors).flatMap(([k, v]) => v.map((m) => `${k}: ${m}`)), fieldErrors }, 400);
    }
    const b = parsed.data;
    const aliases = b.repositories.map((r) => r.alias);
    aliases.forEach((a, i) => {
      if (aliases.indexOf(a) !== i) add(fieldErrors, `repositories.${i}.alias`, `alias ${a} is used twice`);
    });
    if (Object.keys(fieldErrors).length) return json({ ok: false, error: "Check the highlighted fields.", fieldErrors }, 400);

    const input: insights.CreateProjectInput = {
      slug: b.slug,
      name: b.name,
      repositories: Object.fromEntries(b.repositories.map((r) => [r.alias, { path: r.path, ...(r.writable ? {} : { writable: false }) }])),
      ...(b.mounts.length ? { mounts: b.mounts.map((m) => ({ prefix: m.prefix, path: m.path, ...(m.commit ? { commit: true } : {}) })) } : {}),
    };
    const out = await insights.createProject(sy, input);
    if (out.ok) return { project: out.project, convertedLegacy: out.convertedLegacy };

    // Map the library's messages onto the form's fields; anything else is shown above the form.
    const general: string[] = [];
    for (const e of out.errors) {
      const repo = /^repository(?: alias)? "?([^":\s]+)"?[:\s]/.exec(e);
      const mount = /^projects\.[^.]+\.brain\.mounts\.(\d+)(?:\.(\w+))?: (.*)$/.exec(e);
      if (/^slug |^project \S+ already exists/.test(e)) add(fieldErrors, "slug", e.replace(/^slug "[^"]*": /, ""));
      else if (/^name: /.test(e)) add(fieldErrors, "name", e.slice(6));
      else if (repo && aliases.includes(repo[1]!)) {
        const i = aliases.indexOf(repo[1]!);
        add(fieldErrors, /^repository alias/.test(e) ? `repositories.${i}.alias` : `repositories.${i}.path`, e.replace(/^repository (alias )?"?[^":\s]+"?:\s*/, ""));
      } else if (mount) add(fieldErrors, `mounts.${mount[1]}.${mount[2] ?? "path"}`, mount[3]!);
      else general.push(e);
    }
    return json({ ok: false, error: general.length ? general.join("; ") : "Check the highlighted fields.", errors: out.errors, fieldErrors, configDir: path.dirname(sy.cfg.configPath) }, 400);
  });
}
