import { getSy } from "@/lib/sy";
import { project, requireTaskIn } from "@/lib/project";
import { projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { TaskDetailView } from "@/components/task-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task" };

export default async function TaskDetailPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const { slug, id } = await params;
  const p = project(r.sy, slug);
  const base = projectBase(p.slug);
  const taskId = decodeURIComponent(id);
  // Another project's task is not found here (its own project's URL is /tasks/<id>).
  requireTaskIn(r.sy, p.slug, taskId);
  return <TaskDetailView sy={r.sy} taskId={taskId} scope={{ project: p.slug, base, back: { href: `${base}/tasks`, label: "All tasks" }, actions: true, lists: true }} />;
}
