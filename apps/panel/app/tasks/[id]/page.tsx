import { toItemProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** A permalink that spans projects: redirects to /p/<its project>/tasks/<id>. */
export default async function LegacyTasksDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  return toItemProject("tasks", decodeURIComponent((await params).id), searchParams);
}
