import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/teams (the last project opened, else the projects grid). */
export default async function LegacyTeamsPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/teams", searchParams);
}
