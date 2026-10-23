import type { JobPlanView } from "../admin/insights.js";
import { oneLine, stamp, table } from "./terminal.js";

/** A job's plan for the terminal (`meritrouter plan`): header, one row per node (critical path marked *), leases. */
export function planText(p: JobPlanView): string {
  const head = [`job ${p.jobId} ${p.jobState}: ${oneLine(p.goal)}`];
  if (!p.plan) {
    return [...head, "no plan recorded (the supervisor delegated without plan_work)", ...p.otherTasks.map((t) => `  ${t.label ?? t.taskId} [${t.profile}] ${t.state}`)].join("\n");
  }
  head.push(
    `plan v${p.plan.version} of ${p.versions.length}, recorded ${stamp(p.plan.createdAt)}${p.plan.createdBy ? ` by ${p.plan.createdBy}` : ""}${p.plan.note ? `: ${oneLine(p.plan.note, 80)}` : ""}`,
    `critical path (*): ${p.criticalPath.labels.join(" -> ") || "(none)"} (estimated cost ${p.criticalPath.cost})`,
    `agents running: ${p.running} of ${p.maxAgents} (team.max_agents)`,
  );
  const rows = [...p.nodes]
    .sort((a, b) => a.depth - b.depth)
    .map((n) => ({
      cp: n.onCriticalPath ? "*" : "",
      node: n.label,
      profile: n.profile,
      after: n.dependsOn.join(",") || "-",
      tier: `${n.difficulty ?? "-"}/${n.tier ?? "-"}`,
      importance: n.importance ?? "normal",
      inputs: n.requiresAcceptedInputs ? "accepted" : "any",
      state: n.state,
      acceptance: n.acceptanceStatus ?? "",
      task: n.taskId ?? "",
      runs: n.redundancy > 1 ? `${n.redundancy}${n.twins ? ` ${n.twins.status}` : ""}` : "",
      waiting: n.waiting?.text ?? (n.leaseWaits ? `waited for a file lease ${n.leaseWaits}x` : ""),
    }));
  const live = p.leases.filter((l) => l.live);
  return [
    ...head,
    "",
    table(rows),
    "(tier: planned/assigned; inputs: accepted = starts only on accepted upstream results)",
    "",
    live.length ? "live file leases:" : "live file leases: none",
    ...live.map((l) => `  ${l.taskLabel ?? l.taskId} holds ${l.globs.join(", ")} in ${l.repository} since ${stamp(l.acquiredAt)}`),
    ...(p.otherTasks.length ? ["", "tasks outside this plan version:", ...p.otherTasks.map((t) => `  ${t.label ?? t.taskId} [${t.profile}] ${t.state}`)] : []),
  ].join("\n");
}
