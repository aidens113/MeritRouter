import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSy } from "./sy";
import { findProject, lastProject, sessionProject, taskProject } from "./project";
import { projectBase } from "./links";

// Redirects for the URLs the panel had before projects. Global pages (/models, /routing, ...)
// redirect permanently in next.config.ts; these handle the per-project ones.

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function query(sp: Record<string, string | string[] | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, x);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** `/jobs` and the like: the same page in the last project opened, else the projects grid. */
export async function toLastProject(path: string, searchParams: SearchParams): Promise<never> {
  const r = getSy();
  const slug = r.sy ? await lastProject(r.sy) : null;
  redirect(slug ? `${projectBase(slug)}${path}${query(await searchParams)}` : "/");
}

/** `/tasks/<id>`, `/jobs/<id>`, `/sessions/<id>`: the page in the project the task or session belongs to. */
export async function toItemProject(kind: "tasks" | "jobs" | "sessions", id: string, searchParams: SearchParams): Promise<never> {
  const r = getSy();
  if (!r.sy) redirect("/");
  const slug = kind === "sessions" ? sessionProject(r.sy, id) : taskProject(r.sy, id);
  if (!slug || !findProject(r.sy, slug)) notFound();
  redirect(`${projectBase(slug)}/${kind}/${encodeURIComponent(id)}${query(await searchParams)}`);
}
