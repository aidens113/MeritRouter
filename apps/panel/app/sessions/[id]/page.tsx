import { toItemProject, type SearchParams } from "@/lib/legacy";

export const dynamic = "force-dynamic";

/** A permalink that spans projects: redirects to /p/<its project>/sessions/<id>. */
export default async function LegacySessionsDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  return toItemProject("sessions", decodeURIComponent((await params).id), searchParams);
}
