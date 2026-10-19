import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, CheckCircle2, CircleDashed, CircleX, Terminal } from "lucide-react";
import { insights, isTerminal, type Classification, type Switchyard } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { RequestsTable } from "@/components/requests-table";
import { SessionsTable } from "@/components/sessions-table";
import { AcceptanceBadge, TaskStateBadge, TierBadge } from "@/components/task-badges";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, KeyValue, Mono, PageHeader } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { ArtifactViewer } from "@/components/client/artifact-viewer";
import { dateTime, humanize, modelHref, num } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task" };

const RULE_LABEL: Record<string, string> = {
  mode: "Kind of work",
  lines_in_scope: "Amount of code in scope",
  context_tokens: "Size of supplied context",
  extra_repository: "Extra repositories",
  acceptance_criteria: "Number of acceptance criteria",
  checks_required: "Checks must pass",
  output_schema: "Structured output required",
  retry_after_failure: "Retry after a failure",
  non_text_input: "Non-text input",
  "tag.kind": "Classifier: task kind",
  "tag.reasoning": "Classifier: reasoning needed",
  "tag.novelty": "Classifier: novelty",
  "tag.risk": "Classifier: risk",
  "tag.environment": "Classifier: environment",
  "tag.ambiguity": "Classifier: ambiguity",
  low_confidence: "Low classifier confidence",
};

const BASIS: Record<string, string> = {
  rules: "Rulebook only (the classifier could not have changed the tier, so it was skipped)",
  "rules+classifier": "Rulebook plus the difficulty classifier's tags",
  "rules+hint": "Rulebook plus the supervisor's difficulty hint",
  forced: "Tier set explicitly by the supervisor",
  "rules+classifier_failed": "Rulebook only (the classifier request failed)",
};

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const { id } = await params;
  const d = insights.taskDetail(sy, decodeURIComponent(id));
  if (!d || d.status.state === "unknown") notFound();

  const st = d.status as Extract<typeof d.status, { profile: string }>;
  const res = d.result;
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const unresolved = new Set(res?.unresolvedCriteria ?? []);
  const live = !isTerminal(st.state);
  const sessions = insights.sessionsView(sy, { taskId: st.taskId });

  return (
    <div className="space-y-6">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> All tasks
      </Link>
      <PageHeader
        title={`${st.profile} task`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStateBadge state={st.state} />
            <TierBadge tier={st.tier} />
            {res ? <AcceptanceBadge status={res.acceptanceStatus} /> : null}
            <Mono>{st.taskId}</Mono>
          </span>
        }
        actions={
          <>
            {live ? <AutoRefresh seconds={5} /> : null}
            {st.state === "interrupted" ? (
              <ActionButton url="/api/tasks/resume" payload={{ id: st.taskId }} variant="primary" success="Requeued: a running worker will pick it up">
                Resume
              </ActionButton>
            ) : null}
            {live && st.state !== "cancel_requested" ? (
              <ActionButton url="/api/tasks/cancel" payload={{ ids: [st.taskId] }} variant="danger" confirm="Confirm cancel" success="Cancellation requested">
                Cancel task
              </ActionButton>
            ) : null}
          </>
        }
      />

      {st.profile === "supervise" || d.spec.parentTaskId ? (
        <Callout tone="accent" title={st.profile === "supervise" ? "This task is a job" : "Part of a job"}>
          {st.profile === "supervise" ? "Its questions, branches, worker tasks, and supervisor transcript are on the " : "It was delegated by a job's supervisor. See the "}
          <Link href={`/jobs/${st.profile === "supervise" ? st.taskId : d.spec.parentTaskId}`} className="font-medium text-accent-ink hover:underline">
            job page
          </Link>
          .
        </Callout>
      ) : null}

      {st.stateReason && st.state !== "completed" ? (
        <Callout tone={st.state === "failed" || st.state === "budget_exhausted" ? "bad" : st.state === "interrupted" ? "serious" : "warn"} title={stateTitle(st.state)}>
          {humanize(st.stateReason)}
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Goal and acceptance criteria" />
          <div className="space-y-4 p-4 text-sm">
            <p className="whitespace-pre-wrap text-ink">{d.spec.goal}</p>
            <ol className="space-y-1.5">
              {d.spec.constraints.acceptanceCriteria.map((c, i) => {
                const open = [...unresolved].some((u) => u.includes(c) || u.startsWith(`[${i}]`));
                return (
                  <li key={i} className="flex items-start gap-2">
                    {!res ? (
                      <CircleDashed size={15} className="mt-0.5 shrink-0 text-ink-3" aria-label="pending" />
                    ) : open ? (
                      <CircleX size={15} className="mt-0.5 shrink-0 text-bad-ink" aria-label="unresolved" />
                    ) : (
                      <CheckCircle2 size={15} className={cx("mt-0.5 shrink-0", res.acceptanceStatus === "met" ? "text-good-ink" : "text-accent-ink")} aria-label={res.acceptanceStatus === "met" ? "met (verified by checks)" : "worker reports met"} />
                    )}
                    <span className="text-ink-2">
                      <span className="tabular mr-1 text-ink-3">[{i}]</span>
                      {c}
                      {res && !open ? <span className="ml-1 text-[11px] text-ink-3">{res.acceptanceStatus === "met" ? "met, verified by checks" : "worker reports met (not verified)"}</span> : null}
                      {res && open ? <span className="ml-1 text-[11px] text-bad-ink">unresolved</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
            <KeyValue
              items={[
                ["Created", dateTime(st.createdAt)],
                ["Started", dateTime(st.startedAt)],
                ["Finished", dateTime(st.finishedAt)],
                ["Model requests", `${st.modelRequestsUsed} of ${Number.isFinite(st.maxModelRequests) ? st.maxModelRequests : "unlimited"} allowed`],
                ...(d.spec.repositoryAliases.length ? ([["Repositories", d.spec.repositoryAliases.join(", ") + (d.spec.writableRepository ? ` (writes ${d.spec.writableRepository})` : "")]] as Array<[string, ReactNode]>) : []),
                ...(d.spec.context.fileRefs?.length ? ([["Files given", <span key="f" className="flex flex-wrap gap-1">{d.spec.context.fileRefs.map((f) => <Mono key={f}>{f}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                ...(d.spec.constraints.allowedPaths?.length ? ([["May edit", d.spec.constraints.allowedPaths.join(", ")]] as Array<[string, ReactNode]>) : []),
                ...(st.dependsOn.length ? ([["Runs after", <span key="d" className="flex flex-wrap gap-1">{st.dependsOn.map((x) => <Link key={x} href={`/tasks/${x}`} className="font-mono text-xs text-accent-ink hover:underline">{x}</Link>)}</span>]] as Array<[string, ReactNode]>) : []),
                ...(d.spec.hints?.difficulty ? ([["Supervisor hint", `difficulty ${d.spec.hints.difficulty}`]] as Array<[string, ReactNode]>) : []),
                ...(d.spec.routing?.endpointId ? ([["Pinned model", <Link key="p" href={modelHref(d.spec.routing.endpointId)} className="text-accent-ink hover:underline">{names.get(d.spec.routing.endpointId) ?? d.spec.routing.endpointId}</Link>]] as Array<[string, ReactNode]>) : []),
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Difficulty score" help="tier" description="How the rulebook scored this task. Points add up; the total picks the tier." />
          <div className="p-4">{d.classification ? <ClassificationView c={d.classification} sy={sy} profile={st.profile} /> : <p className="text-sm text-ink-3">Not scored yet. Scoring happens when a worker picks the task up.</p>}</div>
        </Card>
      </div>

      {res ? (
        <Card>
          <CardHeader title="Result" description={`Stopped because: ${humanize(res.stopReason)}`} />
          <div className="grid gap-6 p-4 lg:grid-cols-[3fr_2fr]">
            <div className="space-y-4 text-sm">
              {res.summary ? <p className="whitespace-pre-wrap text-ink">{res.summary}</p> : <p className="text-ink-3">No summary.</p>}
              {res.findings.length ? (
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Findings</h3>
                  <ul className="space-y-2">
                    {res.findings.map((f, i) => (
                      <li key={i} className="rounded-lg border border-line px-3 py-2">
                        <p className="text-ink">{f.description}</p>
                        {f.evidenceRefs.length ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {f.evidenceRefs.map((e) => (
                              <Mono key={e}>{e}</Mono>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {res.unresolvedCriteria.length ? (
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Unresolved criteria</h3>
                  <ul className="list-disc space-y-1 pl-5 text-bad-ink">
                    {res.unresolvedCriteria.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {res.checks.length ? (
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Checks</h3>
                  <ul className="space-y-2">
                    {res.checks.map((c, i) => (
                      <li key={i} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Terminal size={14} className="text-ink-3" aria-hidden />
                          {c.exitCode === 0 ? <Badge tone="good">exit 0</Badge> : <Badge tone="bad">exit {c.exitCode ?? "killed"}</Badge>}
                          <code className="break-all font-mono text-xs text-ink-2">{c.command}</code>
                        </div>
                        <ArtifactViewer refId={c.logRef} kind="check_log" label="Check output" />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="space-y-4">
              <KeyValue
                items={[
                  ["Outcome", <span key="o" className="flex flex-wrap gap-1.5"><TaskStateBadge state={res.executionStatus} /><AcceptanceBadge status={res.acceptanceStatus} /></span>],
                  ["Model requests", num(res.usage.modelRequests)],
                  ["Provider attempts", `${num(res.usage.providerAttempts)}${res.usage.providerAttemptsExact ? "" : " (reported, not exact)"}`],
                  ["Tokens", `${num(res.usage.inputTokens)} in · ${num(res.usage.outputTokens)} out${res.usage.cachedInputTokens ? ` · ${num(res.usage.cachedInputTokens)} cached` : ""}`],
                  ["Token basis", res.usage.batchId ? `${humanize(res.usage.tokenUsageBasis)} (share of batch ${res.usage.batchId})` : humanize(res.usage.tokenUsageBasis)],
                  ["Cost", res.usage.estimatedCostUsd === 0 ? "Free" : res.usage.estimatedCostUsd === null ? "unknown" : `$${res.usage.estimatedCostUsd}`],
                  [
                    "Served by",
                    res.servedEndpoints.length ? (
                      <span key="s" className="flex flex-col">
                        {res.servedEndpoints.map((e) => (
                          <Link key={e} href={modelHref(e)} className="text-accent-ink hover:underline">
                            {names.get(e) ?? e}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      "no model"
                    ),
                  ],
                  ...(Object.keys(res.baseCommits).length ? ([["Base commits", <span key="b" className="flex flex-col gap-0.5">{Object.entries(res.baseCommits).map(([a, c]) => <Mono key={a}>{`${a}@${c.slice(0, 12)}`}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                ]}
              />
              {res.routing ? (
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Models tried</h3>
                  <p className="mb-2 text-xs text-ink-2">
                    Ran at <strong>{res.routing.tier}</strong>
                    {res.routing.escalatedFrom ? ` after escalating from ${res.routing.escalatedFrom}` : ""}. <HelpTip term="fallback" />
                  </p>
                  <ol className="space-y-1">
                    {res.routing.attempts.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span className="tabular mt-0.5 w-4 shrink-0 text-ink-3">{i + 1}.</span>
                        <span className="min-w-0">
                          <Link href={modelHref(a.endpointId)} className="font-medium text-ink hover:underline">
                            {names.get(a.endpointId) ?? a.endpointId}
                          </Link>{" "}
                          <Badge tone={a.outcome === "succeeded" ? "good" : a.outcome.startsWith("skipped") ? "neutral" : "bad"}>{humanize(a.outcome).slice(0, 80)}</Badge>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Artifacts" description="Files the task produced: patches (with their base commit), model responses, check logs, and context manifests." />
        <div className="space-y-2 p-4">
          {d.artifacts.length ? (
            d.artifacts.map((a) => <ArtifactViewer key={a.id} refId={`artifact:${a.id}`} kind={a.kind} label={a.label} bytes={a.bytes} mediaType={a.media_type} defaultOpen={a.kind === "patch"} />)
          ) : (
            <p className="text-sm text-ink-3">No artifacts yet.</p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Model requests for this task" />
        <RequestsTable rows={d.requests} names={names} empty="No model requests were made for this task" />
      </Card>

      <Card>
        <CardHeader
          title="Agent sessions"
          help="session"
          description="Each run of this task (and each classifier call for it) as a session with its full event log: messages, model requests, and tool calls. Newest first."
          actions={
            sessions.length ? (
              <Link href={`/sessions?task=${encodeURIComponent(st.taskId)}`} className="text-xs text-accent-ink hover:underline">
                Open in Sessions
              </Link>
            ) : null
          }
        />
        <SessionsTable rows={sessions} hideTask empty="No sessions recorded for this task" />
      </Card>

      <Card>
        <CardHeader title="Timeline" />
        <ol className="relative space-y-3 p-4 pl-8">
          <span className="absolute bottom-4 left-[1.15rem] top-4 w-px bg-line" aria-hidden />
          {d.events.map((e, i) => (
            <li key={i} className="relative text-sm">
              <span className={cx("absolute -left-[1.1rem] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface", eventTone(e.type))} aria-hidden />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink">{humanize(e.type)}</span>
                <span className="tabular text-xs text-ink-3">{dateTime(e.ts)}</span>
              </div>
              {e.data ? <div className="mt-0.5 break-words font-mono text-[11px] text-ink-3">{describeEvent(e.data)}</div> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function stateTitle(s: string): string {
  return (
    { failed: "This task failed", budget_exhausted: "This task ran out of budget", interrupted: "This task was interrupted", waiting_for_capacity: "Waiting for model capacity", cancelled: "This task was cancelled", queued: "Waiting for a worker" } as Record<string, string>
  )[s] ?? "Status";
}

function eventTone(type: string): string {
  if (type === "completed") return "bg-good";
  if (["failed", "budget_exhausted", "finish_rejected"].includes(type)) return "bg-bad";
  if (["interrupted", "waiting_for_capacity", "escalated", "cancel_requested", "cancelled"].includes(type)) return "bg-warn";
  return "bg-accent";
}

function describeEvent(data: unknown): string {
  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ")
      .slice(0, 400);
  }
  return String(data);
}

function ClassificationView({ c, sy, profile }: { c: Classification; sy: Switchyard; profile: string }) {
  const t = sy.cfg.tiers;
  const max = Math.max(t.T3.max_score + 3, c.score + 1);
  const bands = [
    { tier: "T1", from: 0, to: t.T1.max_score, cls: "bg-accent-soft" },
    { tier: "T2", from: t.T1.max_score + 1, to: t.T2.max_score, cls: "bg-accent/25" },
    { tier: "T3", from: t.T2.max_score + 1, to: t.T3.max_score, cls: "bg-accent/40" },
    { tier: "T4", from: t.T3.max_score + 1, to: max, cls: "bg-serious-soft" },
  ];
  const pos = (v: number) => `${(Math.min(v + 0.5, max + 1) / (max + 1)) * 100}%`;
  const total = c.breakdown.reduce((s, l) => s + l.points, 0);
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-ink-2">
            Score <strong className="text-lg text-ink">{c.score}</strong> → <TierBadge tier={c.tier} />
          </span>
          <span className="text-xs text-ink-3">rulebook {c.rulebookVersion}</span>
        </div>
        <div className="relative mt-2 flex h-6 overflow-hidden rounded-md" aria-label={`Score ${c.score} on a scale where T1 is up to ${t.T1.max_score}, T2 up to ${t.T2.max_score}, T3 up to ${t.T3.max_score}`}>
          {bands.map((b) => (
            <div key={b.tier} className={cx("flex items-center justify-center border-r-2 border-surface text-[10px] font-medium text-ink-2 last:border-r-0", b.cls)} style={{ width: `${((b.to - b.from + 1) / (max + 1)) * 100}%` }}>
              {b.tier} {b.tier === "T4" ? `> ${t.T3.max_score}` : `≤ ${b.to}`}
            </div>
          ))}
          <div className="absolute top-0 h-full w-0.5 bg-ink" style={{ left: pos(c.score) }} aria-hidden />
        </div>
      </div>
      <table className="data-table tabular">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Measured</th>
            <th className="text-right">Points</th>
          </tr>
        </thead>
        <tbody>
          {c.breakdown.map((l, i) => (
            <tr key={i}>
              <td className="text-ink">{RULE_LABEL[l.rule] ?? humanize(l.rule)}</td>
              <td className="text-ink-2">{l.detail}</td>
              <td className={cx("text-right font-medium", l.points > 0 ? "text-ink" : "text-ink-3")}>{l.points > 0 ? `+${l.points}` : l.points}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={2} className="font-semibold text-ink">
              Total
            </td>
            <td className="text-right font-semibold text-ink">{total}</td>
          </tr>
        </tbody>
      </table>
      <KeyValue
        items={[
          ["Basis", BASIS[c.basis] ?? c.basis],
          ...(c.classifierConfidence !== null ? ([["Classifier", `${Math.round(c.classifierConfidence * 100)}% confident${c.classifierSuggestedTier ? `, suggested ${c.classifierSuggestedTier}` : ""}`]] as Array<[string, ReactNode]>) : []),
          ...(c.classifierRationale ? ([["Classifier said", c.classifierRationale]] as Array<[string, ReactNode]>) : []),
          ...(c.tags
            ? ([
                [
                  "Tags",
                  <span key="t" className="flex flex-wrap gap-1">
                    {Object.entries(c.tags).flatMap(([g, v]) => (Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => <Badge key={`${g}${x}`}>{`${g}: ${humanize(String(x))}`}</Badge>))}
                  </span>,
                ],
              ] as Array<[string, ReactNode]>)
            : []),
          ["Task type minimum", `${profile} tasks start at ${sy.cfg.profiles[profile as keyof typeof sy.cfg.profiles]?.min_tier ?? "T1"}`],
        ]}
      />
      {c.rejectReason ? (
        <Callout tone="serious" title="Returned to the supervisor (T4)">
          {c.rejectReason}
        </Callout>
      ) : null}
    </div>
  );
}
