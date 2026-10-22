import { getSy } from "@/lib/sy";
import { QUALIFICATION_SCOPE, requireQualificationTask } from "@/lib/qualification";
import { SetupScreen } from "@/components/setup";
import { TaskDetailView } from "@/components/task-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Qualification task" };

/** A qualification or comparison task (the reserved `_qualification` project's); any other task is a 404 here. */
export default async function QualificationTaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const taskId = decodeURIComponent((await params).id);
  requireQualificationTask(r.sy, taskId);
  return <TaskDetailView sy={r.sy} taskId={taskId} sp={await searchParams} scope={QUALIFICATION_SCOPE} />;
}
