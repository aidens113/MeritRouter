import type { ReactNode } from "react";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";

export const dynamic = "force-dynamic";

/** Every page under /p/<slug> is that project's: an unknown or archived slug is a 404. */
export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = getSy();
  // Without a loadable config each page shows the setup screen itself.
  if (r.sy) project(r.sy, slug);
  return children;
}
