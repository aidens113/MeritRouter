import "server-only";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { insights, PROJECT_SLUG_RE, QUALIFICATION_PROJECT, type Switchyard } from "switchyard-router";
import type { SwitcherProject } from "@/components/client/project-switcher";
import { LAST_PROJECT_COOKIE, QUALIFICATION_SLUG, SLUG_RE } from "./links";

// Project scope for server components and route handlers. A project route reads exactly one
// project: an unknown or archived slug is a 404, never a silent fall back to every project.

export type ProjectSummary = insights.ProjectSummary;

if (QUALIFICATION_SLUG !== QUALIFICATION_PROJECT) console.warn(`[panel] lib/links.ts QUALIFICATION_SLUG differs from the router's QUALIFICATION_PROJECT (${QUALIFICATION_PROJECT})`);
if (SLUG_RE.source !== PROJECT_SLUG_RE.source) console.warn(`[panel] lib/links.ts SLUG_RE (${SLUG_RE.source}) differs from the router's PROJECT_SLUG_RE (${PROJECT_SLUG_RE.source})`);

/**
 * The live (not archived) project `slug`, or null when it is unknown, archived, or malformed.
 * `archived: true` also finds an archived project (its settings page, where it can be unarchived).
 */
export function findProject(sy: Switchyard, slug: string, opts: { archived?: boolean } = {}): ProjectSummary | null {
  if (!PROJECT_SLUG_RE.test(slug)) return null;
  try {
    const p = insights.projectInfo(sy, slug);
    return p.archived && !opts.archived ? null : p;
  } catch (err) {
    if ((err as { code?: unknown }).code === "not_found") return null;
    throw err;
  }
}

/** The live project `slug` (or an archived one with `archived: true`), or a 404 page. */
export function project(sy: Switchyard, slug: string, opts: { archived?: boolean } = {}): ProjectSummary {
  return findProject(sy, slug, opts) ?? notFound();
}

/**
 * The project a task belongs to (its own, the primary project for an unassigned row, or
 * `_qualification` for qualification and comparison work); null for an unknown task.
 */
export function taskProject(sy: Switchyard, taskId: string): string | null {
  if (!sy.tasks.get(taskId)) return null;
  return insights.contextOfTask(sy, taskId).project.slug;
}

/** The project a session belongs to (through its task; the primary project for a task-less session); null for an unknown session. */
export function sessionProject(sy: Switchyard, sessionId: string): string | null {
  const s = sy.sessions.get(sessionId);
  if (!s) return null;
  return s.taskId ? taskProject(sy, s.taskId) : sy.projects.primary.project.slug;
}

/** 404 unless task `taskId` belongs to project `slug`. */
export function requireTaskIn(sy: Switchyard, slug: string, taskId: string): void {
  if (taskProject(sy, taskId) !== slug) notFound();
}

/** 404 unless session `sessionId` belongs to project `slug`. */
export function requireSessionIn(sy: Switchyard, slug: string, sessionId: string): void {
  if (sessionProject(sy, sessionId) !== slug) notFound();
}

/** The last project opened (cookie), when it is still a live project. */
export async function lastProject(sy: Switchyard): Promise<string | null> {
  const slug = (await cookies()).get(LAST_PROJECT_COOKIE)?.value ?? "";
  return slug && findProject(sy, slug) ? slug : null;
}

/** Project metadata identifies archived settings too; the picker filters archived entries. */
export function switcherProjects(sy: Switchyard): SwitcherProject[] {
  return insights.projectsGrid(sy, { includeArchived: true }).map((p) => ({ slug: p.slug, name: p.name, archived: p.archived, live: p.runningTasks > 0, queued: p.runningTasks === 0 && p.queuedTasks > 0, attention: p.attention }));
}
