import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { SetupScreen } from "@/components/setup";
import { RequestsView } from "@/components/requests-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Requests" };

/** This project's request log. */
export default async function ProjectRequestsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  return <RequestsView sy={r.sy} project={p} sp={await searchParams} />;
}
