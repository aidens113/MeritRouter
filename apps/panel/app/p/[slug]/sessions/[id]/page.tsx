import { getSy } from "@/lib/sy";
import { project, requireSessionIn } from "@/lib/project";
import { projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { SessionDetailView } from "@/components/session-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Session" };

export default async function SessionDetailPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, id: rawId } = await params;
  const p = project(r.sy, slug);
  const base = projectBase(p.slug);
  const id = decodeURIComponent(rawId);
  // Another project's session is not found here (its own project's URL is /sessions/<id>).
  requireSessionIn(r.sy, p.slug, id);
  return <SessionDetailView sy={r.sy} id={id} sp={await searchParams} scope={{ project: p.slug, base, back: { href: `${base}/sessions`, label: "All sessions" }, actions: true, lists: true }} />;
}
