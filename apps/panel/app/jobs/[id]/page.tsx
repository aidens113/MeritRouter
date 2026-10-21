import { toItemProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** A permalink that spans projects: redirects to /p/<its project>/jobs/<id>. */
export default async function LegacyJobsDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  return toItemProject("jobs", decodeURIComponent((await params).id), searchParams);
}
