import { notFound, redirect } from "next/navigation";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { itemBase, requestHref } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { RequestDetailView } from "@/components/request-detail";

export const dynamic = "force-dynamic";
export default async function RequestPermalink({ params }: { params: Promise<{ id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const q = insights.requestDetail(r.sy, (await params).id);
  if (!q) notFound();
  if (!q.project) return <RequestDetailView sy={r.sy} slug="" id={q.id} name="All projects" />;
  redirect(requestHref(itemBase(q.project), q.id));
}
