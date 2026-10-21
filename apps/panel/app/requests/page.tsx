import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/requests (the last project opened, else the projects grid). */
export default async function LegacyRequestsPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/requests", searchParams);
}
