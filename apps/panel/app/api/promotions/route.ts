import { z } from "zod";
import { insights, PROJECT_SLUG_RE } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Project = z.string().trim().min(1).max(64).regex(PROJECT_SLUG_RE, "not a project slug");
const PromotionId = z.string().trim().regex(/^[a-z0-9_-]{1,120}$/, "not a promotion id");
const Status = z.enum(["pending_review", "pending_approval", "approved", "rejected", "awaiting_person"]);

/** Promotions to global knowledge, newest first: `?project=` limits them to one project, `?status=` filters (awaiting_person: what a person may decide now). */
export async function GET(req: Request) {
  return handle((sy) => {
    const q = new URL(req.url).searchParams;
    const project = q.get("project") ? Project.safeParse(q.get("project")) : null;
    if (project && !project.success) throw new HttpError(400, "project: not a project slug");
    const status = q.get("status") ? Status.safeParse(q.get("status")) : null;
    if (status && !status.success) throw new HttpError(400, `status: one of ${Status.options.join(", ")}`);
    return { promotions: insights.promotionsView(sy, { ...(project?.data ? { project: project.data } : {}), ...(status?.data ? { status: status.data } : {}) }) };
  });
}

const Decide = z
  .object({
    project: Project,
    id: PromotionId,
    approve: z.boolean(),
    reason: z.string().trim().max(1000, "at most 1000 characters").optional(),
  })
  .refine((b) => b.approve || !!b.reason, { path: ["reason"], message: "give a reason to reject: it is kept with the lesson in its project" });

/** A person approves or rejects a promotion waiting for them (recorded as decided by `panel`). */
export async function POST(req: Request) {
  return handle(async (sy) => {
    const b = await body(req, Decide);
    return { promotion: await insights.decideGlobalPromotion(sy, b.project, b.id, b.approve, "panel", b.reason ?? "") };
  });
}
