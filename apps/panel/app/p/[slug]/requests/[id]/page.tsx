import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { SetupScreen } from "@/components/setup";
import { RequestDetailView } from "@/components/request-detail";

export const dynamic = "force-dynamic";
export default async function RequestPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, id } = await params;
  const p = project(r.sy, slug);
  return <RequestDetailView sy={r.sy} slug={p.slug} id={id} name={p.name} />;
}
