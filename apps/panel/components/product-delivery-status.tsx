import Link from "next/link";
import { insights } from "meritrouter";
import { taskHref } from "@/lib/links";
import { Badge, Card, CardHeader, Mono } from "@/components/ui";
import { ActionButton } from "@/components/client/actions";

type Delivery = NonNullable<ReturnType<typeof insights.deliveryView>>;
type Report = ReturnType<typeof insights.projectDeliveryReport>;

/** Stored read models only; FINAL controls refresh and compare the actual candidate through MCP. */
export function ProductDeliveryStatus({ delivery, taskId, taskState, project, base }: {
  delivery: Delivery; taskId: string; taskState: string; project: string; base: string;
}) {
  const accepted = delivery.accepted && taskState === "completed";
  const repair = taskState === "completed" && delivery.finalDecision?.decision === "reject";
  return <Card id="product-delivery">
    <CardHeader title="Product delivery" description="Stored candidate and evidence; this page does not freshly inspect Git or the running product." />
    <div className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap gap-2">
        <Badge tone={accepted ? "good" : "warn"}>{accepted ? "Recorded acceptance effective" : "Product review unresolved"}</Badge>
        <span>Stage: <strong>{delivery.stage}</strong> · Specification revision {delivery.spec.revision}</span>
      </div>
      <p>Recorded readiness: <strong>{delivery.readiness?.status === "ready_for_final_review" ? "Ready for FINAL review" : "Evidence incomplete"}</strong>. Recorded FINAL decision: <strong>{delivery.finalDecision?.decision ?? "Not decided"}</strong>.</p>
      {delivery.finalDecision ? <p className="whitespace-pre-wrap break-words">FINAL reason: {delivery.finalDecision.reason}</p> : null}
      {delivery.finalDecision?.decision === "accept" && !accepted ? <p className="text-warn-ink">Historical acceptance is no longer effective for the recorded delivery requirements or task state.</p> : null}
      {delivery.readiness?.blockers.length ? <ul className="list-disc space-y-1 pl-5">{delivery.readiness.blockers.slice(0, 20).map((blocker, index) => <li key={index} className="break-words">{blocker.criterionId ?? "Delivery"}: {blocker.detail}</li>)}</ul> : null}
      {(delivery.readiness?.blockers.length ?? 0) > 20 ? <p>Additional blockers are available through <Mono>delivery_status</Mono>.</p> : null}
      <p>Next: the initiating FINAL supervisor should inspect <Mono>delivery_status</Mono>, independently check the exact candidate, record observations with <Mono>record_delivery_observation</Mono>, then use <Mono>decide_delivery</Mono> with the inspected specification and candidate digests. Task result acceptance is a separate decision.</p>
      {delivery.finalDecision?.decision === "reject" ? <p>Repair is required. {repair ? "Request repair below to requeue this supervisor with its retained workspace and remaining budget. Eligibility is checked by the service; this does not accept the product." : taskState === "interrupted" ? "Resume the paused supervisor below to continue." : "Ask the initiating supervisor to review ongoing repair work."}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link href={taskHref(base, taskId)} className="font-medium text-accent-ink hover:underline">Review task and evidence</Link>
        {taskState === "interrupted" ? <ActionButton url="/api/tasks/resume" payload={{ project, id: taskId }} small success="Requeued: a running worker resumes the supervisor">Resume supervisor</ActionButton> : null}
        {repair ? <ActionButton url="/api/tasks/resume" payload={{ project, id: taskId }} small confirm="Confirm: request repair" success="Repair queued: a running worker picks up the supervisor">Request repair</ActionButton> : null}
      </div>
    </div>
  </Card>;
}

export function ProjectProductDeliveries({ report, base, nextHref }: { report: Report; base: string; nextHref: string | null }) {
  const issues = report.deliveries.filter(delivery => delivery.needsAttention);
  if (!report.deliveries.length) return null;
  return <Card id="product-deliveries">
    <CardHeader title="Product delivery reviews" description="Bounded stored delivery summaries. Sources and runtimes are rechecked by the FINAL supervisor before a decision." />
    <div className="space-y-3 p-4 text-sm">
      {issues.length ? <ul className="divide-y divide-line">{issues.map(delivery => <li key={delivery.taskId} className="space-y-1 py-2 first:pt-0">
        <Link href={taskHref(base, delivery.taskId)} className="break-all font-medium text-accent-ink hover:underline">{delivery.taskId}</Link>
        <p>Stage: {delivery.stage} · Recorded readiness: {delivery.readiness.replaceAll("_", " ")} · FINAL: {delivery.historicalFinalDecision ?? "Not decided"}</p>
        <p className="break-words text-ink-2">{delivery.reasons.map(reason => reason.replaceAll("_", " ")).join("; ")}</p>
      </li>)}</ul> : <p>No unresolved products in these {report.deliveries.length} recorded deliveries.</p>}
      <p>Open a task for evidence and ask the initiating FINAL supervisor to inspect <Mono>delivery_status</Mono> before accepting, rejecting or arranging repair.</p>
      {nextHref ? <Link href={nextHref} className="font-medium text-accent-ink hover:underline">Next delivery summaries →</Link> : null}
    </div>
  </Card>;
}
