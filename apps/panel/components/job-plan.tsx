import Link from "next/link";
import type { ReactNode } from "react";
import { Copy, Hourglass, Lock, ShieldCheck, Users } from "lucide-react";
import { insights, type JobPlanView, type PlanNodeView, type PlanWait } from "switchyard-router";
import { Badge, Card, CardHeader, HelpTip, Mono } from "./ui";
import { AcceptanceBadge, ImportanceBadge, TASK_STATE_LABEL, TaskStateBadge, TierBadge } from "./task-badges";
import { dateTime, humanize, shortId } from "@/lib/format";
import { AgentLink, CommitLink, ModelLink, TaskLink } from "./entity-links";
import { sessionHref, taskHref } from "@/lib/links";

// The job page's plan view: the task graph (critical path highlighted), one row per node with its
// waiting reason, and the job's file leases. Server-rendered from insights.jobPlan.

const W = 200;
const H = 66;
const COL_GAP = 64;
const ROW_GAP = 16;
const PAD = 10;

function stateColor(n: PlanNodeView): string {
  if (n.waiting?.kind === "file_lease" || n.waiting?.kind === "acceptance" || n.state === "waiting_for_capacity" || n.state === "cancel_requested") return "var(--warn)";
  switch (n.state) {
    case "completed":
      return "var(--good)";
    case "running":
      return "var(--accent)";
    case "failed":
    case "budget_exhausted":
      return "var(--bad)";
    case "interrupted":
      return "var(--serious)";
    default:
      return "var(--ink-3)";
  }
}

/** A few words for the graph: what the node waits for. */
function shortWait(w: PlanWait | null): string | null {
  if (!w) return null;
  switch (w.kind) {
    case "file_lease":
      return `lease held by ${w.holderLabel ?? shortId(w.holderTaskId, 12)}`;
    case "acceptance":
      return `awaits acceptance of ${w.on.join(", ")}`;
    case "dependencies":
      return `after ${w.on.join(", ")}`;
    case "agent_cap":
      return `agent cap ${w.running}/${w.cap}`;
    case "capacity":
      return "waits for capacity";
    case "worker":
      return "ready";
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function layout(nodes: PlanNodeView[]) {
  const cols = new Map<number, PlanNodeView[]>();
  for (const n of nodes) cols.set(n.depth, [...(cols.get(n.depth) ?? []), n]);
  const depth = Math.max(0, ...nodes.map((n) => n.depth));
  const maxRows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, col] of cols) {
    const offset = ((maxRows - col.length) * (H + ROW_GAP)) / 2;
    col.forEach((n, i) => pos.set(n.label, { x: PAD + d * (W + COL_GAP), y: PAD + offset + i * (H + ROW_GAP) }));
  }
  return { pos, width: PAD * 2 + (depth + 1) * W + depth * COL_GAP, height: PAD * 2 + maxRows * H + (maxRows - 1) * ROW_GAP };
}

export function PlanGraph({ plan, base }: { plan: JobPlanView; base: string }) {
  const { pos, width, height } = layout(plan.nodes);
  return (
    <svg role="img" aria-label={`Task graph with ${plan.nodes.length} nodes; critical path ${plan.criticalPath.labels.join(" to ")}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      <defs>
        <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--axis)" />
        </marker>
        <marker id="plan-arrow-cp" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--accent)" />
        </marker>
      </defs>
      {plan.edges
        .filter((e) => !e.external && pos.has(e.from) && pos.has(e.to))
        .sort((a, b) => Number(a.onCriticalPath) - Number(b.onCriticalPath))
        .map((e) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const x1 = a.x + W;
          const y1 = a.y + H / 2;
          const x2 = b.x - 2;
          const y2 = b.y + H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${e.from}>${e.to}`}
              d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
              fill="none"
              stroke={e.onCriticalPath ? "var(--accent)" : "var(--axis)"}
              strokeWidth={e.onCriticalPath ? 2 : 1.25}
              markerEnd={e.onCriticalPath ? "url(#plan-arrow-cp)" : "url(#plan-arrow)"}
            />
          );
        })}
      {plan.nodes.map((n) => {
        const p = pos.get(n.label)!;
        const tier = n.tier && n.tier !== n.difficulty ? `${n.difficulty ?? "–"}→${n.tier}` : (n.difficulty ?? n.tier ?? "–");
        const meta = [n.profile, tier, n.redundancy > 1 ? `×${n.redundancy}` : null, n.importance && n.importance !== "normal" ? n.importance : null, n.requiresAcceptedInputs ? "accepted inputs" : null].filter(Boolean).join(" · ");
        const status = `${TASK_STATE_LABEL[n.state] ?? humanize(n.state)}${shortWait(n.waiting) && n.state !== "running" ? ` · ${shortWait(n.waiting)}` : ""}`;
        const box = (
          <g>
            <title>{`${n.label}: ${n.goal}${n.waiting ? `\n${n.waiting.text}` : ""}`}</title>
            <rect x={p.x} y={p.y} width={W} height={H} rx={8} fill="var(--surface)" stroke={n.onCriticalPath ? "var(--accent)" : "var(--line-strong)"} strokeWidth={n.onCriticalPath ? 2 : 1} />
            <rect x={p.x + 1} y={p.y + 8} width={3.5} height={H - 16} rx={1.75} fill={stateColor(n)} />
            <text x={p.x + 14} y={p.y + 20} fontSize={13} fontWeight={600} fill="var(--ink)">
              {clip(n.label, 24)}
            </text>
            <text x={p.x + 14} y={p.y + 37} fontSize={11} fill="var(--ink-3)">
              {clip(meta, 32)}
            </text>
            <text x={p.x + 14} y={p.y + 54} fontSize={11} fill="var(--ink-2)">
              {clip(status, 32)}
            </text>
          </g>
        );
        return n.taskId ? (
          <a key={n.label} href={taskHref(base, n.taskId)}>
            {box}
          </a>
        ) : (
          <g key={n.label}>{box}</g>
        );
      })}
    </svg>
  );
}

function WaitCell({ n, base, plan }: { n: PlanNodeView; base: string; plan: JobPlanView }): ReactNode {
  const w = n.waiting;
  const icon = w?.kind === "file_lease" ? <Lock size={12} aria-hidden /> : w?.kind === "acceptance" ? <ShieldCheck size={12} aria-hidden /> : w?.kind === "agent_cap" ? <Users size={12} aria-hidden /> : <Hourglass size={12} aria-hidden />;
  return (
    <div className="space-y-0.5 text-xs">
      {w ? (
        <span className={w.kind === "file_lease" || w.kind === "acceptance" ? "inline-flex items-start gap-1 text-warn-ink" : "inline-flex items-start gap-1 text-ink-2"}>
          <span className="mt-0.5 shrink-0">{icon}</span>
          {w.kind === "file_lease" ? <span>Waits for the file lease <TaskLink base={base} id={w.holderTaskId} label={w.holderLabel} /> holds{w.repository ? ` in ${w.repository} on ${w.globs.join(", ")}` : ""}</span> : w.kind === "acceptance" ? <span>Waits for acceptance of {w.taskIds.map((id, i) => <span key={id}>{i ? ", " : ""}<TaskLink base={base} id={id} label={w.on[i]} /></span>)}</span> : w.kind === "dependencies" ? <span>Waits for {w.on.map((label, i) => { const id = plan.nodes.find((x) => x.label === label)?.taskId ?? plan.otherTasks.find((x) => x.label === label)?.taskId; return <span key={label}>{i ? ", " : ""}{id ? <TaskLink base={base} id={id} label={label} /> : label}</span>; })} to finish</span> : w.text}
        </span>
      ) : n.state === "not_dispatched" ? (
        <span className="text-ink-3">not dispatched</span>
      ) : (
        n.leaseWaits > 0 ? null : <span className="text-ink-3">–</span>
      )}
      {n.leaseWaits > 0 && w?.kind !== "file_lease" ? <div className="text-ink-3">waited for a file lease {n.leaseWaits === 1 ? "once" : `${n.leaseWaits} times`}</div> : null}
    </div>
  );
}

/** `base` is the project path (`/p/<slug>`) links start from. */
export function PlanCard({ plan, base, recovery }: { plan: JobPlanView; base: string; recovery?: insights.PlanRecoveryView }) {
  if (!plan.plan) return null;
  const live = plan.leases.filter((l) => l.live);
  const released = plan.leases.filter((l) => !l.live).reverse();
  const v = plan.plan;
  return (
    <Card id="plan">
      <CardHeader
        title="Plan"
        help="plan"
        description={
          <>
            Version {v.version} of {plan.versions.length}, recorded {dateTime(v.createdAt)}
            {v.createdBy ? <> by {insights.parseAgentId(v.createdBy) ? <AgentLink base={base} agent={v.createdBy} /> : v.createdBy}</> : ""}
            {v.note ? `: ${v.note}` : "."}
          </>
        }
        actions={
          <a href={`/api/jobs/${encodeURIComponent(plan.jobId)}/plan`} className="text-xs text-accent-ink hover:underline">
            JSON
          </a>
        }
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-2.5 text-sm">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-ink-3">Critical path</span> <HelpTip term="criticalPath" />
          <span className="font-medium text-accent-ink">{plan.criticalPath.labels.length ? plan.criticalPath.labels.map((label, i) => { const id = plan.nodes.find((n) => n.label === label)?.taskId; return <span key={label}>{i ? " / " : ""}{id ? <TaskLink base={base} id={id} label={label} /> : label}</span>; }) : "–"}</span>
          <span className="text-xs text-ink-3">(estimated cost {plan.criticalPath.cost})</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-3">Agents running</span>
          <span className="tabular font-medium text-ink">
            {plan.running} of {plan.maxAgents}
          </span>
          <span className="text-xs text-ink-3">(team.max_agents)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-3">File leases held</span> <HelpTip term="fileLease" />
          <span className="tabular font-medium text-ink">{live.length}</span>
        </span>
      </div>
      <div className="overflow-x-auto border-b border-line p-4">
        <PlanGraph plan={plan} base={base} />
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 rounded bg-accent" aria-hidden /> critical path
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-1 rounded bg-good" aria-hidden /> completed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-1 rounded bg-accent" aria-hidden /> running
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-1 rounded bg-warn" aria-hidden /> held back (file lease, acceptance, capacity)
          </span>
          <span>Click a node to open its task.</span>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Node</th>
              <th>Type</th>
              <th>Depends on</th>
              <th title="Planned difficulty, then the tier the task was classified at">Tier</th>
              <th title="Importance, and whether the node starts only on accepted upstream results">Importance / inputs</th>
              <th>State</th>
              <th>Waiting</th>
              <th>Task</th>
            </tr>
          </thead>
          <tbody>
            {[...plan.nodes]
              .sort((a, b) => a.depth - b.depth)
              .map((n) => (
                <tr key={n.label}>
                  <td>
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                      {n.onCriticalPath ? <span className="inline-block h-2 w-2 rounded-full bg-accent" title="On the critical path" aria-label="On the critical path" /> : null}
                      {n.taskId ? <TaskLink base={base} id={n.taskId} label={n.label} /> : n.label}
                      {n.redundancy > 1 ? (
                        <Badge tone="accent" icon={<Copy size={10} aria-hidden />} title="Redundant node: its first attempt runs twice on different models; the first verified result wins">
                          ×{n.redundancy}
                        </Badge>
                      ) : null}
                    </span>
                    <div className="max-w-[16rem] truncate text-xs text-ink-3" title={n.goal}>
                      {n.goal}
                    </div>
                  </td>
                  <td>
                    {n.profile}
                    {n.allowedPaths?.length ? <div className="font-mono text-[11px] text-ink-3">{n.allowedPaths.join(", ")}</div> : null}
                  </td>
                  <td className="text-xs">{n.dependsOn.length ? n.dependsOn.map((label, i) => { const dep = plan.nodes.find((x) => x.label === label); const other = plan.otherTasks.find((x) => x.label === label); const id = dep?.taskId ?? other?.taskId; return <span key={label}>{i ? ", " : ""}{id ? <TaskLink base={base} id={id} label={label} /> : label}</span>; }) : <span className="text-ink-3">–</span>}</td>
                  <td>
                    <span className="inline-flex items-center gap-1">
                      <TierBadge tier={n.difficulty} />
                      {n.tier && n.tier !== n.difficulty ? (
                        <>
                          <span className="text-xs text-ink-3">→</span>
                          <TierBadge tier={n.tier} />
                        </>
                      ) : null}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      {n.importance && n.importance !== "normal" ? <ImportanceBadge level={n.importance} /> : <span className="text-xs text-ink-3">normal</span>}
                      {n.requiresAcceptedInputs ? (
                        <Badge tone="accent" title="Starts only on accepted upstream results">
                          accepted inputs
                        </Badge>
                      ) : (
                        <span className="text-xs text-ink-3">any inputs</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      {n.state === "not_dispatched" ? <Badge>not dispatched</Badge> : <TaskStateBadge state={n.state} />}
                      {n.acceptanceStatus ? <AcceptanceBadge status={n.acceptanceStatus} /> : null}
                      {recovery?.evidence.filter((e) => e.taskId === n.taskId).map((e) => <div key={e.commit} className="max-w-56 space-y-1 text-xs" title="The recorded supervisor changed this segment's scoped paths on the job branch after the failure. This does not independently verify completion; the original task failure and acceptance remain unchanged."><span className="text-warn-ink">failed; finished by the supervisor</span><div><CommitLink base={base} repository={e.repository} sha={e.commit} /> <AgentLink base={base} agent={e.agent} /></div><div className="text-ink-3">Later changes: {e.paths.join(", ")}</div></div>)}
                    </div>
                  </td>
                  <td className="min-w-[11rem]">
                    <WaitCell n={n} base={base} plan={plan} />
                  </td>
                  <td>
                    {n.taskId ? (
                      <Link href={taskHref(base, n.taskId)} className="font-mono text-xs text-accent-ink hover:underline">
                        {shortId(n.taskId, 14)}
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-3">–</span>
                    )}
                    {n.agents.map((agent) => <div key={agent}><AgentLink base={base} agent={agent} /></div>)}
                    {n.upstream ? (
                      <div className="text-[11px] text-ink-3" title={`Upstream results given to this node: ${n.upstream.artifactRef}`}>
                        given upstream results
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {recovery && plan.nodes.some((n) => n.state === "failed" || n.state === "budget_exhausted") ? <div className="space-y-1 border-t border-line px-4 py-2 text-xs text-ink-3"><p>Supervisor recovery annotations show later scoped changes, not independent verification. The latest {recovery.commitLimit} non-merge commits per recorded job branch are inspected; absent annotations do not establish that no recovery happened.</p>{recovery.errors.length ? <details><summary className="cursor-pointer text-warn-ink">Recovery history incomplete ({recovery.errors.length})</summary><ul>{recovery.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></details> : null}</div> : null}
      <Twins nodes={plan.nodes} base={base} />
      <div className="space-y-2 border-t border-line p-4">
        <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
          File leases <HelpTip term="fileLease" />
        </h3>
        {plan.leases.length ? (
          <ul className="space-y-1.5 text-sm">
            {[...live, ...released].slice(0, 30).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                {l.live ? (
                  <Badge tone="warn" icon={<Lock size={11} aria-hidden />}>
                    held
                  </Badge>
                ) : (
                  <Badge>released{l.releaseReason ? `: ${humanize(l.releaseReason).toLowerCase()}` : ""}</Badge>
                )}
                <TaskLink base={base} id={l.taskId} label={l.taskLabel} />
                <Mono>{l.globs.join(", ")}</Mono>
                <span className="text-xs text-ink-3">
                  in {l.repository} · from {dateTime(l.acquiredAt)}
                  {l.releasedAt ? ` to ${dateTime(l.releasedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">No coding task of this job has held a file lease yet.</p>
        )}
      </div>
      {plan.versions.length > 1 ? (
        <details className="border-t border-line px-4 py-3 text-sm">
          <summary className="cursor-pointer text-ink-2">Earlier versions ({plan.versions.length - 1})</summary>
          <ul className="mt-2 space-y-1 text-xs text-ink-2">
            {[...plan.versions].reverse().map((pv) => (
              <li key={pv.version}>
                v{pv.version} · {pv.nodes} node{pv.nodes === 1 ? "" : "s"} · {dateTime(pv.createdAt)}
                {pv.createdBy ? <>; {insights.parseAgentId(pv.createdBy) ? <AgentLink base={base} agent={pv.createdBy} /> : pv.createdBy}</> : ""}
                {pv.note ? ` · ${pv.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {plan.otherTasks.length ? (
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
          {plan.otherTasks.length} task{plan.otherTasks.length === 1 ? " was" : "s were"} delegated outside this plan version; see Worker tasks below.
        </p>
      ) : null}
    </Card>
  );
}

const TWIN_STATUS: Record<insights.TwinRunsView["status"], { label: string; tone: "accent" | "good" | "warn" | "bad" | "neutral" }> = {
  racing: { label: "both running", tone: "accent" },
  verified: { label: "first verified result used", tone: "good" },
  none_passed: { label: "neither passed verification", tone: "warn" },
  both_failed: { label: "both runs failed", tone: "bad" },
  skipped: { label: "ran once", tone: "neutral" },
  refused: { label: "refused: budget", tone: "bad" },
};

/** Redundant nodes: each twin run with its endpoints, session, and whether it won or was superseded. */
function Twins({ nodes, base }: { nodes: PlanNodeView[]; base: string }) {
  const twins = nodes.filter((n) => n.redundancy > 1);
  if (!twins.length) return null;
  return (
    <div className="space-y-3 border-t border-line p-4">
      <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
        Redundant nodes <HelpTip term="redundancy" />
      </h3>
      {twins.map((n) => {
        const st = n.twins ? TWIN_STATUS[n.twins.status] : null;
        return (
          <div key={n.label} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {n.taskId ? <TaskLink base={base} id={n.taskId} label={n.label} /> : <span className="font-medium text-ink">{n.label}</span>}
              {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>not started</Badge>}
              {n.twins?.cap ? <span className="text-xs text-ink-3">shared cap {n.twins.cap} requests</span> : null}
              {n.twins?.reason ? <span className="text-xs text-ink-3">{n.twins.reason}</span> : null}
            </div>
            {n.twins?.runs.length ? (
              <ul className="grid gap-2 md:grid-cols-2">
                {n.twins.runs.map((r, i) => (
                  <li key={r.sessionId ?? i} className="min-w-0 rounded-lg border border-line px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">Run {i + 1}</span>
                      {r.winner ? <Badge tone="good">verified first: used</Badge> : r.used ? <Badge tone="accent">used</Badge> : null}
                      {r.stopReason === "superseded" ? <Badge>superseded</Badge> : null}
                      {r.sessionStatus ? <span className="text-ink-3">session {r.sessionStatus}</span> : null}
                      {r.verification ? <span className="text-ink-3">verification {r.verification}</span> : null}
                    </div>
                    <div className="mt-1 break-all text-ink-3">
                      endpoints: <span className="font-mono text-ink-2">{r.endpoints.length ? r.endpoints.map((id, i) => <span key={id}>{i ? ", " : ""}<ModelLink id={id} /></span>) : "–"}</span>
                      {r.servedEndpoints.length ? (
                        <>
                          {" "}
                          · served by <span className="font-mono text-ink-2">{r.servedEndpoints.map((id, i) => <span key={id}>{i ? ", " : ""}<ModelLink id={id} /></span>)}</span>
                        </>
                      ) : null}
                    </div>
                    {r.sessionId ? (
                      <Link href={sessionHref(base, r.sessionId)} className="mt-1 inline-block font-mono text-accent-ink hover:underline">
                        {shortId(r.sessionId, 18)}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
