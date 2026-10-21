/**
 * The panel's URL scheme, shared by server and client components.
 *
 * - `/` is the projects grid and `/new` creates a project.
 * - `/p/<slug>/...` holds one project's pages (overview, jobs, teams, tasks, sessions, requests,
 *   brain, settings). Every one of them reads that project only.
 * - `/all/...` holds the install-wide pages ("All projects"): the dashboard, every project's
 *   requests, models, routing, provider keys, qualification, calibration, and global settings.
 * - The pre-projects URLs (`/jobs`, `/tasks/<id>`, `/models`, ...) redirect: global pages to
 *   `/all/...`, list pages to the last project you opened, and detail pages (`/tasks/<id>`,
 *   `/jobs/<id>`, `/sessions/<id>`) to the project the task or session belongs to. A view that
 *   spans projects links a task through `/tasks/<id>` for that reason.
 */

/** The cookie that remembers the last project opened (set by proxy.ts on `/p/<slug>` requests). */
export const LAST_PROJECT_COOKIE = "sy_project";

/** The install-wide section. */
export const ALL = "/all";

/**
 * Where the reserved `_qualification` project's work is viewed (it is never a project page):
 * `/all/qualification/tasks/<id>`, `/sessions/<id>`, and `/jobs/<id>` (a job's task view).
 */
export const QUALIFICATION_BASE = "/all/qualification";

/** The reserved project qualification runs and eval comparisons work in (the router's QUALIFICATION_PROJECT). */
export const QUALIFICATION_SLUG = "_qualification";

/** Base path of an item's project pages: `/p/<slug>`, or the Qualification page for `_qualification`. */
export function itemBase(project: string): string {
  return project === QUALIFICATION_SLUG ? QUALIFICATION_BASE : projectBase(project);
}

/** Request header proxy.ts sets to the request's path (read by layouts). */
export const PATH_HEADER = "x-switchyard-path";

/** Base path of one project's pages, e.g. `/p/shop`. */
export function projectBase(slug: string): string {
  return `/p/${encodeURIComponent(slug)}`;
}

/**
 * Link builders for task, job, session, and brain pages under a base: a project's base
 * (`/p/<slug>`) inside a project, or `""` in views that span projects (those URLs redirect to the
 * item's own project).
 */
export const taskHref = (base: string, id: string) => `${base}/tasks/${encodeURIComponent(id)}`;
export const jobHref = (base: string, id: string) => `${base}/jobs/${encodeURIComponent(id)}`;
export const sessionHref = (base: string, id: string) => `${base}/sessions/${encodeURIComponent(id)}`;
export const brainHref = (base: string, path: string) => `${base}/brain?path=${encodeURIComponent(path)}`;

/** The slug in a `/p/<slug>/...` path, or null outside a project. */
export function slugOfPath(path: string): string | null {
  const m = /^\/p\/([^/]+)/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** The project slug rule (the router's PROJECT_SLUG_RE), for client-side checks before the server's. */
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A slug suggested from a project name: lower case, runs of other characters become one dash. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[-]+$/g, "")
    .slice(0, 48)
    .replace(/[._-]+$/g, "");
}
