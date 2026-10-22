import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { RequestDetailView } from "@/components/request-detail";
import { QUALIFICATION_SLUG } from "@/lib/links";

export const dynamic = "force-dynamic";
export default async function QualificationRequest({ params }: { params: Promise<{ id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  return <RequestDetailView sy={r.sy} slug={QUALIFICATION_SLUG} id={(await params).id} name="Qualification" />;
}
