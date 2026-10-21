import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { PATH_HEADER, projectBase } from "@/lib/links";

export const dynamic = "force-dynamic";

/**
 * Every page under /p/<slug> is that project's: an unknown slug is a 404, and so is an archived
 * project's, except its settings page, which shows the settings read-only with Unarchive. (Each
 * page checks its project too, so a client-side move to another page of an archived project is
 * also a 404.)
 */
export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = getSy();
  // Without a loadable config each page shows the setup screen itself.
  if (r.sy) {
    const path = ((await headers()).get(PATH_HEADER) ?? "").replace(/\/+$/, "");
    project(r.sy, slug, { archived: path === `${projectBase(slug)}/settings` });
  }
  return children;
}
