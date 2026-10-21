import { toLastProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** Moved under a project: /p/<slug>/brain (the last project opened, else the projects grid). */
export default async function LegacyBrainPage({ searchParams }: { searchParams: SearchParams }) {
  return toLastProject("/brain", searchParams);
}
