import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/jobs (the last project opened, else the projects grid). */
export default async function LegacyJobsPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/jobs", searchParams);
}
