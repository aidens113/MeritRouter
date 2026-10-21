import { getSy } from "@/lib/sy";
import { QUALIFICATION_SCOPE, requireQualificationSession } from "@/lib/qualification";
import { SetupScreen } from "@/components/setup";
import { SessionDetailView } from "@/components/session-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Qualification session" };

/** A session of a qualification or comparison task; any other session is a 404 here. */
export default async function QualificationSessionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const id = decodeURIComponent((await params).id);
  requireQualificationSession(r.sy, id);
  return <SessionDetailView sy={r.sy} id={id} sp={await searchParams} scope={QUALIFICATION_SCOPE} />;
}
