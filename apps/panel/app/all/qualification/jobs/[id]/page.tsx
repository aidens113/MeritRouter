import { redirect } from "next/navigation";
import { getSy } from "@/lib/sy";
import { QUALIFICATION_BASE, taskHref } from "@/lib/links";
import { requireQualificationTask } from "@/lib/qualification";

export const dynamic = "force-dynamic";

/** A comparison's team run is a job; the Qualification page shows it as its task view. */
export default async function QualificationJobPage({ params }: { params: Promise<{ id: string }> }) {
  const r = getSy();
  if (!r.sy) redirect(QUALIFICATION_BASE);
  const id = decodeURIComponent((await params).id);
  requireQualificationTask(r.sy, id);
  redirect(taskHref(QUALIFICATION_BASE, id));
}
