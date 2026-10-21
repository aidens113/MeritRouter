import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { RequestsView } from "@/components/requests-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "All requests" };

/** Every project's request log, plus requests charged to no task. */
export default async function AllRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  return <RequestsView sy={r.sy} project={null} sp={await searchParams} />;
}
