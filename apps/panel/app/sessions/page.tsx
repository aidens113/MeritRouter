import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/sessions (the last project opened, else the projects grid). */
export default async function LegacySessionsPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/sessions", searchParams);
}
