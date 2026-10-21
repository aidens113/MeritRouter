import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/tasks (the last project opened, else the projects grid). */
export default async function LegacyTasksPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/tasks", searchParams);
}
