import { WorkerActionRequestsCard } from "@/components/worker-action-requests";
import { BudgetRequestsCard, TaskBudgetCard } from "@/components/budget-requests";
import { RelatedPanel } from "@/components/related";
import { AgentLink, CommitLink, ModelLink, RequestLink, TaskLink } from "@/components/entity-links";
import { Tabs, pickTab } from "@/components/tabs";
import { Disclosure } from "@/components/disclosure";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, CheckCircle2, CircleDashed, CircleX, Globe, Terminal } from "lucide-react";
import { insights, isTerminal, type Classification, type Switchyard, type VerificationRecord } from "switchyard-router";
import { brainHref, sessionHref, jobHref, taskHref, repoHref } from "@/lib/links";
import type { DetailScope } from "@/components/detail-scope";
import { RequestsTable } from "@/components/requests-table";
import { SessionsTable } from "@/components/sessions-table";
import { AcceptanceBadge, ImportanceBadge, OutcomeBadge, TaskStateBadge, TierBadge, VerificationBadge } from "@/components/task-badges";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, KeyValue, Mono } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ActionButton } from "@/components/client/actions";
import { ArtifactViewer } from "@/components/client/artifact-viewer";
import { RequestsByPurpose, TrailHeading, VerificationTrail } from "@/components/verification-trail";
import { AcceptanceActions } from "@/components/client/acceptance";
import { dateTime, humanize, modelHref, num, pct } from "@/lib/format";

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

/**
 * One task's page: its goal and criteria, difficulty score, result, contract and verification,
 * artifacts, requests, sessions, and timeline. The caller has checked that the task belongs to
 * `scope.project`.
 */
export async function TaskDetailView({ sy, taskId, scope, sp = {} }: { sy: Switchyard; taskId: string; scope: DetailScope; sp?: Record<string, string | string[] | undefined> }) {
  const base = scope.base;
  const related = await insights.taskRelated(sy, taskId);
  const d = insights.taskDetail(sy, taskId);
  if (!d || d.status.state === "unknown") notFound();

  const st = d.status as Extract<typeof d.status, { profile: string }>;
  const res = d.result;
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const unresolved = new Set(res?.unresolvedCriteria ?? []);
  const unresolvedIds = res?.unresolvedCriterionIds ? new Set(res.unresolvedCriterionIds) : null;
  const verified = new Map((d.verification?.criteria ?? []).map((c) => [c.id, c]));
  const live = !isTerminal(st.state);
  const sessions = insights.sessionsView(sy, { taskId: st.taskId });
  const taskBudget = insights.taskBudget(sy, taskId);
  const budgetPending = insights.budgetRequestsView(sy, { taskId, project: scope.project, status: "pending", limit: 1000 });
  const budgetHistory = insights.budgetRequestsView(sy, { taskId, project: scope.project }).filter((r) => r.status !== "pending");
  const workerActions = insights.listWorkerActions(sy.db, { project: scope.project, taskId });
  const webRequests = insights.taskWebRequests(sy, st.taskId);

  const tab = pickTab(sp, ["result", "verification", "routing", "usage", "sessions"]);
  return (
    <div className="space-y-6">
      <Link href={scope.back.href} className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> {scope.back.label}
      </Link>
      <PageHeader
        title={`${st.profile} task`}
        live={[`tasks:${st.taskId}`, "budget", "requests"]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStateBadge state={st.state} />
            <TierBadge tier={st.tier} />
            {d.importance ? <ImportanceBadge level={d.importance.level} /> : null}
            {res ? <AcceptanceBadge status={res.acceptanceStatus} /> : null}
            {res?.verificationStatus ? <VerificationBadge status={res.verificationStatus} /> : null}
            {budgetPending.length ? <a href="#budget-requests" className="text-xs font-medium text-warn-ink hover:underline">{budgetPending.length} budget requests pending</a> : null}
            <Mono>{st.taskId}</Mono>
          </span>
        }
        actions={
          <>
            {scope.actions && st.state === "interrupted" ? (
              <ActionButton url="/api/tasks/resume" payload={{ project: scope.project, id: st.taskId }} variant="primary" success="Requeued: a running worker will pick it up">
                Resume
              </ActionButton>
            ) : null}
            {scope.actions && live && st.state !== "cancel_requested" ? (
              <ActionButton url="/api/tasks/cancel" payload={{ project: scope.project, ids: [st.taskId] }} variant="danger" confirm="Confirm cancel" success="Cancellation requested">
                Cancel task
              </ActionButton>
            ) : null}
          </>
        }
      />
      <WorkerActionRequestsCard policy={sy.cfg.security.outside_repository} requests={workerActions} decisions={scope.actions} />
      {scope.lists && (st.profile === "supervise" || d.spec.parentTaskId) ? (
        <Callout tone="accent" title={st.profile === "supervise" ? "This task is a job" : "Part of a job"}>
      {st.profile === "supervise" ? "Its questions, branches, worker tasks, and supervisor transcript are on the " : "It was delegated by a job's supervisor. See the "}
          <Link href={jobHref(base, st.profile === "supervise" ? st.taskId : (d.spec.parentTaskId ?? ""))} className="font-medium text-accent-ink hover:underline">
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
      {d.acceptance.awaitingDecision && res ? (
        <Callout tone="warn" title="This result needs a decision">
          <div className="space-y-3">
            <p>
              {d.acceptance.supervisorAcceptance
                ? `Strict verification: the result is accepted only by an explicit decision${d.acceptance.strictAcceptor === "human" ? ", and only a person can make it (verification.strict_acceptor is human)" : " from its supervisor or a person"}.`
                : "Verification could not establish the result on its own. Accept it if it meets the goal and criteria, or reject it with what is wrong."}{" "}
              <HelpTip term="acceptance" />
            </p>
            {d.verification?.reasons.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {d.verification.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            {scope.actions ? (
              <div className="max-w-xl">
                <AcceptanceActions taskId={st.taskId} project={scope.project} reasonRequired />
              </div>
            ) : null}
          </div>
        </Callout>
      ) : null}
      <Card>
        <CardHeader title="Goal and acceptance criteria" />
        <div className="space-y-4 p-4 text-sm">
          <p className="whitespace-pre-wrap text-ink">{d.spec.goal}</p>
          <ol className="space-y-1.5">
            {d.criteria.map((c, i) => {
              const v = verified.get(c.id);
              const open = v ? OPEN_OUTCOMES.includes(v.outcome) : unresolvedIds ? unresolvedIds.has(c.id) : [...unresolved].some((u) => u.includes(c.text) || u.startsWith(`[${i}]`));
              const good = v ? v.outcome === "passed" : res?.acceptanceStatus === "met";
              const label = v ? (CRITERION_OUTCOME[v.outcome] ?? v.outcome.replace(/_/g, " ")) : res?.acceptanceStatus === "met" ? "met, verified by checks" : "worker reports met (not verified)";
              return (
                <li key={c.id} className="flex items-start gap-2">
                  {!res || v?.outcome === "pending_review" ? (
                    <CircleDashed size={15} className="mt-0.5 shrink-0 text-ink-3" aria-label="pending" />
                  ) : open ? (
                    <CircleX size={15} className="mt-0.5 shrink-0 text-bad-ink" aria-label="unresolved" />
                  ) : (
                    <CheckCircle2 size={15} className={cx("mt-0.5 shrink-0", good ? "text-good-ink" : "text-accent-ink")} aria-label={label} />
                  )}
                  <span className="text-ink-2">
                    <span className="mr-1 font-mono text-[11px] text-ink-3">{c.id}</span>
                    {c.text}
                    <span className="ml-1 text-[11px] text-ink-3">· verified by {c.verify === "check" ? (c.checks.length ? c.checks.join(", ") : "checks") : c.verify}</span>
                    {res && !open ? <span className="ml-1 text-[11px] text-ink-3">· {label}</span> : null}
                    {res && open ? <span className="ml-1 text-[11px] text-bad-ink">· {v ? label : "unresolved"}</span> : null}
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
              ...(d.spec.repositoryAliases.length ? ([["Repositories", <span key="repos">{d.spec.repositoryAliases.map((alias, i) => <span key={alias}>{i ? ", " : ""}{repoHref(base, alias) ? <Link href={repoHref(base, alias)!} className="text-accent-ink hover:underline">{alias}</Link> : alias}</span>)}{d.spec.writableRepository ? <> (writes {repoHref(base, d.spec.writableRepository) ? <Link href={repoHref(base, d.spec.writableRepository)!} className="text-accent-ink hover:underline">{d.spec.writableRepository}</Link> : d.spec.writableRepository})</> : null}</span>]] as Array<[string, ReactNode]>) : []),
              ...(d.spec.context.fileRefs?.length ? ([["Files given", <span key="f" className="flex flex-wrap gap-1">{d.spec.context.fileRefs.map((f) => <Mono key={f}>{f}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
              ...(d.spec.constraints.allowedPaths?.length ? ([["May edit", d.spec.constraints.allowedPaths.join(", ")]] as Array<[string, ReactNode]>) : []),
              ...(st.dependsOn.length ? ([["Runs after", <span key="d" className="flex flex-wrap gap-1">{st.dependsOn.map((x) => <Link key={x} href={taskHref(base, x)} className="font-mono text-xs text-accent-ink hover:underline">{x}</Link>)}</span>]] as Array<[string, ReactNode]>) : []),
              ...(d.spec.hints?.difficulty ? ([["Supervisor hint", `difficulty ${d.spec.hints.difficulty}`]] as Array<[string, ReactNode]>) : []),
              ...(d.spec.routing?.endpointId ? ([["Pinned model", <Link key="p" href={modelHref(d.spec.routing.endpointId)} className="text-accent-ink hover:underline">{names.get(d.spec.routing.endpointId) ?? d.spec.routing.endpointId}</Link>]] as Array<[string, ReactNode]>) : []),
            ]}
          />
        </div>
      </Card>
      {budgetPending.length ? <BudgetRequestsCard requests={budgetPending} decisions={scope.actions} pendingOnly /> : null}
      <RelatedPanel groups={[
        { label: "Jobs", items: (related?.ancestors ?? []).map(j => ({ key: j.jobId, node: <TaskLink base={base} id={j.jobId} label={j.label} job /> })) },
        { label: "Agents", items: (related?.agents ?? []).map(a => ({ key: a.id, node: <AgentLink base={base} agent={a.id} /> })) },
        { label: "Sessions", items: sessions.map(s => ({ key: s.id, node: <Link href={sessionHref(base, s.id)} className="font-mono text-xs text-accent-ink hover:underline">{s.id}</Link> })) },
        { label: "Models", items: (related?.models ?? []).filter(m => m.endpointId).map(m => ({ key: m.endpointId, node: <ModelLink id={m.endpointId} /> })) },
        { label: "Requests", items: d.requests.map(r => ({ key: r.id, node: <RequestLink base={base} id={r.id} /> })) },
        { label: "Commits", items: (related?.commits ?? []).map(c => ({ key: c.repository + c.commit, node: <CommitLink base={base} repository={c.repository} sha={c.commit} />, meta: c.subject })) },
        { label: "Brain reports", items: (related?.reports ?? []).map(p => ({ key: p, node: <Link href={brainHref(base, p)} className="text-accent-ink hover:underline">{p}</Link> })) },
        { label: "Dependencies", items: (related?.dependsOn ?? []).map(id => ({ key: id, node: <TaskLink base={base} id={id} /> })) },
        { label: "Child tasks", items: (related?.children ?? []).map(t => ({ key: t.taskId, node: <TaskLink base={base} id={t.taskId} label={t.label} /> })) }
      ]} />
      <Tabs items={[{ "id": "result", "label": "Result" }, { "id": "verification", "label": "Verification" }, { "id": "routing", "label": "Routing" }, { "id": "usage", "label": "Usage" }, { "id": "sessions", "label": "Sessions" }]} active={tab} path={taskHref(base, st.taskId)} label="Page sections" anchors={{ "web-requests": "usage", "task-budget": "usage", "budget-history": "usage" }} />
      {tab === "result" ? <div className="space-y-6">{res ? (
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
                          {c.revision !== undefined ? <span className="text-[11px] text-ink-3" title="The staged tree the check ran on">{c.revision ? `on ${c.revision.slice(0, 12)}` : "no revision"}</span> : null}
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
                  ["Outcome", <span key="o" className="flex flex-wrap gap-1.5"><TaskStateBadge state={res.executionStatus} /><AcceptanceBadge status={res.acceptanceStatus} />{res.verificationStatus ? <VerificationBadge status={res.verificationStatus} /> : null}</span>],
                  ...(res.changedPaths?.length ? ([["Changed", <span key="c" className="flex flex-wrap gap-1">{res.changedPaths.map((p) => <Mono key={p}>{p}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                  ...(res.scopeViolation?.length ? ([["Out of scope", <span key="sv" className="flex flex-wrap gap-1 text-bad-ink">{res.scopeViolation.map((p) => <Mono key={p}>{p}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                  ...(res.protectedPathsChanged?.length ? ([["Protected paths", <span key="pp" className="flex flex-wrap gap-1">{res.protectedPathsChanged.map((p) => <Mono key={p}>{p}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                  ["Model requests", num(res.usage.modelRequests)],
                  ...(res.usage.webRequests ? ([["Web requests", `${num(res.usage.webRequests)} (searches and page fetches)`]] as Array<[string, ReactNode]>) : []),
                  ["Provider attempts", `${num(res.usage.providerAttempts)}${res.usage.providerAttemptsExact ? "" : " (reported, not exact)"}`],
                  ["Tokens", `${res.usage.uncachedInputTokens !== null && res.usage.uncachedInputTokens !== undefined ? `${num(res.usage.uncachedInputTokens)} new in · ` : ""}${num(res.usage.outputTokens)} out · ${num(res.usage.inputTokens)} in with ${(res.usage.cachedInputTokens == null ? "unknown" : num(res.usage.cachedInputTokens))} cached${res.usage.cachedInputTokens && res.usage.inputTokens ? ` (${pct(res.usage.cachedInputTokens, res.usage.inputTokens)})` : ""}`],
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
        </Card></div> : null}
      {tab === "verification" ? <div className="space-y-6"><ContractAndVerification d={d} names={names} base={base} /></div> : null}
      {tab === "routing" ? <div className="space-y-6">{res ? <Card><CardHeader title="Models tried" /><div className="p-4">{res.routing ? (
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
      ) : null}</div></Card> : null}<Card>
          <CardHeader title="Difficulty score" help="tier" description="How the rulebook scored this task. Points add up; the total picks the tier." />
          <div className="p-4">{d.classification ? <ClassificationView c={d.classification} sy={sy} profile={st.profile} /> : <p className="text-sm text-ink-3">Not scored yet. Scoring happens when a worker picks the task up.</p>}</div>
        </Card></div> : null}
      {tab === "usage" ? <div className="space-y-6">{taskBudget ? <TaskBudgetCard budget={taskBudget} used={st.modelRequestsUsed} base={base} /> : null}{budgetHistory.length ? <BudgetRequestsCard requests={budgetHistory} decisions={scope.actions} id="budget-history" /> : null}<Card>
        <CardHeader title="Model requests for this task" />
        <RequestsTable rows={d.requests} names={names} base={base} empty="No model requests were made for this task" />
      </Card>
        {webRequests.length ? (
          <Card id="web-requests">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Globe size={15} aria-hidden /> Web requests
                </span>
              }
              description={`Searches and page fetches this task made: ${new Set(webRequests.map((w) => w.callId)).size} of ${sy.cfg.web.max_requests_per_task} calls allowed per task. One row per attempt: a call whose backend failed moved on to the next backend, and the row marked "answered" is the backend that served it. What came back was given to the agent as untrusted data.`}
            />
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Kind</th>
                    <th>Backend (key)</th>
                    <th>Query or URL</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {webRequests.map((w) => (
                    <tr key={w.id}>
                      <td className="whitespace-nowrap tabular">{dateTime(w.startedAt)}</td>
                      <td>{w.kind === "search" ? "search" : "fetch"}</td>
                      <td>
                        <Mono>{w.backend}</Mono>
                        {w.keyRef && w.keyRef !== w.backend ? <div className="font-mono text-[11px] text-ink-3">{w.keyRef}</div> : null}
                      </td>
                      <td className="max-w-[28rem] break-all font-mono text-xs">{w.target}</td>
                      <td>
                        {w.status === "ok" ? (
                          <Badge tone="good">answered · {w.kind === "search" ? `${w.results ?? 0} result${w.results === 1 ? "" : "s"}` : w.bytes !== null ? `${num(w.bytes)} bytes` : "ok"}</Badge>
                        ) : w.status === "error" ? (
                          <span className="text-xs text-bad-ink">
                            {w.errorKind ? `${w.errorKind.replace("_", " ")}: ` : ""}
                            {w.error}
                          </span>
                        ) : (
                          <Badge tone="accent">running</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}</div> : null}
      {tab === "sessions" ? <div className="space-y-6"><Card>
        <CardHeader
          title="Agent sessions"
          help="session"
          description="Each run of this task (and each classifier call for it) as a session with its full event log: messages, model requests, and tool calls. Newest first."
          actions={
            sessions.length && scope.lists ? (
              <Link href={`${base}/sessions?task=${encodeURIComponent(st.taskId)}`} className="text-xs text-accent-ink hover:underline">
                Open in Sessions
              </Link>
            ) : null
          }
        />
        <SessionsTable rows={sessions} base={base} hideTask empty="No sessions recorded for this task" />
      </Card>
        <Disclosure summary="Task timeline"><Card>
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
        </Card></Disclosure></div> : null}
    </div>
  );
}

function stateTitle(s: string): string {
  return (
    { failed: "This task failed", budget_exhausted: "This task ran out of budget", interrupted: "This task was interrupted", waiting_for_capacity: "Waiting for model capacity", cancelled: "This task was cancelled", queued: "Waiting for a worker" } as Record<string, string>
  )[s] ?? "Status";
}

function eventTone(type: string): string {
  if (type === "completed" || type === "result_accepted") return "bg-good";
  if (["failed", "budget_exhausted", "finish_rejected", "result_rejected"].includes(type)) return "bg-bad";
  if (["interrupted", "waiting_for_capacity", "escalated", "cancel_requested", "cancelled", "verification_raised", "dependency_unverified"].includes(type)) return "bg-warn";
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

/** Criterion outcomes that leave the criterion open. */
const OPEN_OUTCOMES: string[] = ["failed", "unknown", "not_run", "stale", "environment_failure"];

const CRITERION_OUTCOME: Record<string, string> = {
  passed: "verified",
  failed: "failed",
  claimed: "worker claims met, with evidence (not verified)",
  unknown: "unknown: no evidence",
  not_run: "checks did not run",
  stale: "checks ran on another revision",
  environment_failure: "a check could not run",
  pending_review: "waiting for review",
};

/** "floor:risk-critical" -> "policy floor risk-critical"; "parent:t_x" -> "parent task t_x". */
function importanceSource(source: string): string {
  const [kind = "", ...rest] = source.split(":");
  const id = rest.join(":");
  const label: Record<string, string> = { task: "set on the task", default: "policy default", floor: "policy floor", rule: "policy rule", parent: "inherited from parent task" };
  return `${label[kind] ?? kind}${id ? ` ${id}` : ""}`;
}

function ContractAndVerification({ d, names, base }: { d: insights.TaskDetail; names: Map<string, string>; base: string }) {
  const c = d.contract?.contract;
  const v = d.verification;
  const t = d.trail;
  const followUps = t.reviews.length + t.retries.length + t.targetedChecks.length + t.raised.length;
  return (
    <Card>
      <CardHeader
        title="Contract and verification"
        help="verification"
        description="What evidence this result needs, fixed before the run, and what verification found. The level can only rise when the actual change is checked."
        actions={d.result?.verificationStatus ? <VerificationBadge status={d.result.verificationStatus} /> : null}
      />
      <div className="grid gap-6 p-4 lg:grid-cols-2">
        <div className="space-y-3 text-sm">
          <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
            Contract <HelpTip term="contract" />
          </h3>
          {d.contractError ? (
            <Callout tone="bad" title="The stored contract failed validation">
              {d.contractError}
            </Callout>
          ) : null}
          {d.importance ? (
            <KeyValue
              items={[
                [
                  <span key="i" className="inline-flex items-center gap-1">
                    Importance <HelpTip term="importance" />
                  </span>,
                  <span key="iv" className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ImportanceBadge level={d.importance.level} />
                      <span className="text-xs text-ink-3">{importanceSource(d.importance.source)}</span>
                    </span>
                    {d.importance.requested && d.importance.requested !== d.importance.level ? <span className="text-xs text-ink-3">requested {d.importance.requested}</span> : null}
                    {d.importance.reason ? <span className="text-xs text-ink-2">{d.importance.reason}</span> : null}
                    {!d.importance.compiled ? <span className="text-xs text-ink-3">As requested; the contract is compiled when a worker picks the task up.</span> : null}
                  </span>,
                ],
              ]}
            />
          ) : null}
          {c ? (
            <KeyValue
              items={[
                [
                  "Level",
                  <span key="l" className="flex flex-col gap-0.5">
                    <span>
                      <strong className="text-ink">{c.verification.level}</strong>
                      <span className="text-xs text-ink-3">{c.verification.matrixLevel !== c.verification.level ? ` (matrix ${c.verification.matrixLevel} at ${c.tier}, raised by rules)` : ` (matrix at ${c.tier})`}</span>
                    </span>
                    {v?.raisedFrom ? <span className="text-xs text-serious-ink">Raised on the result from {v.raisedFrom} to {v.level}</span> : null}
                  </span>,
                ],
                ...(c.verification.rulesMatched.length ? ([["Rules matched", <span key="r" className="flex flex-wrap gap-1">{c.verification.rulesMatched.map((r) => <Mono key={r}>{r}</Mono>)}</span>]] as Array<[string, ReactNode]>) : []),
                ["Required checks", <span key="rc" className="flex flex-wrap gap-1">{c.verification.requiredChecks.map((r) => <Mono key={r}>{r}</Mono>)}</span>],
                [
                  "Review",
                  c.verification.review.required
                    ? `required${c.verification.review.independent ? ", independent" : ""}${c.verification.review.qualification ? `, qualification ${c.verification.review.qualification}` : ""}${c.verification.review.minTotalParametersB ? `, at least ${c.verification.review.minTotalParametersB}B` : ""}`
                    : "not required",
                ],
                ["Acceptance", c.verification.acceptance === "supervisor" ? `explicit decision by ${c.verification.strictAcceptor === "human" ? "a person" : "the supervisor or a person"}` : "automatic when the policy is satisfied"],
                ...(c.declaredChecks.length ? ([["Declared checks", <span key="dc" className="flex flex-col gap-0.5">{c.declaredChecks.map((x) => <code key={x} className="break-all font-mono text-xs text-ink-2">{x}</code>)}</span>]] as Array<[string, ReactNode]>) : []),
                [
                  "Request budget",
                  <span key="b" className="tabular text-xs text-ink-2">
                    {c.budget.total} allocated: {c.budget.classification} classification · {c.budget.execution} execution · {c.budget.review} review · {c.budget.repair} repair
                    {c.budget.unallocated === null ? " · uncapped total" : c.budget.unallocated ? ` · ${c.budget.unallocated} unallocated` : ""}
                  </span>,
                ],
                ["Fingerprints", <span key="f" className="text-xs text-ink-2">rulebook {c.fingerprints.rulebook ?? "none"} · policy {c.fingerprints.policy}</span>],
                [
                  "Digest",
                  <span key="s" className="flex flex-col gap-0.5">
                    <Mono>{`sha256 ${d.contract!.sha256.slice(0, 16)}…`}</Mono>
                    <span className="text-xs text-ink-3">compiled {dateTime(d.contract!.createdAt)}, never edited</span>
                  </span>,
                ],
              ]}
            />
          ) : (
            <p className="text-ink-3">No contract yet. It is compiled after classification, before the first run{d.spec.profile === "supervise" ? "; jobs are verified by their job checks instead" : ""}.</p>
          )}
          <div>
            <h4 className="mb-1 text-xs font-semibold text-ink-3">Model requests by purpose</h4>
            <RequestsByPurpose used={t.requestsByPurpose} budget={c?.budget ?? null} />
          </div>
        </div>
        <div className="space-y-3 text-sm">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Verification record</h3>
          {v ? <VerificationRecordView v={v} /> : <p className="text-ink-3">{d.result ? "This result has no verification record." : "Verification runs when the worker returns a result."}</p>}
        </div>
      </div>
      {followUps ? (
        <div className="space-y-3 border-t border-line p-4">
          <TrailHeading />
          <VerificationTrail trail={t} criteria={new Map(d.criteria.map((x) => [x.id, x.text]))} names={names} base={base} />
        </div>
      ) : null}
    </Card>
  );
}

function VerificationRecordView({ v }: { v: VerificationRecord }) {
  return (
    <div className="space-y-4">
      <table className="data-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>Outcome</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {v.checks.map((c) => (
            <tr key={c.name}>
              <td className="whitespace-nowrap">
                <span className={cx("font-mono text-xs", c.required ? "text-ink" : "text-ink-3")}>{c.name}</span>
                {c.required ? null : <span className="ml-1 text-[10px] text-ink-3">(not required)</span>}
              </td>
              <td>
                <OutcomeBadge outcome={c.outcome} />
              </td>
              <td className="text-xs text-ink-2">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {v.criteria.length ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Outcome</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {v.criteria.map((c) => (
              <tr key={c.id}>
                <td className="text-xs text-ink-2">
                  <span className="mr-1 font-mono text-ink-3">{c.id}</span>
                  {c.text}
                  <span className="ml-1 text-ink-3">({c.verify})</span>
                  {c.note ? <div className="mt-0.5 text-ink-3">{c.note}</div> : null}
                </td>
                <td>
                  <OutcomeBadge outcome={c.outcome} />
                </td>
                <td>
                  <span className="flex flex-wrap gap-1">{c.evidenceRefs.length ? c.evidenceRefs.map((e) => <Mono key={e}>{e}</Mono>) : <span className="text-xs text-ink-3">–</span>}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {v.reasons.length ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-3">Why</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-2">
            {v.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h4 className="mb-1 text-xs font-semibold text-ink-3">Decisions</h4>
        {v.decisions.length ? (
          <ul className="space-y-1.5">
            {v.decisions.map((x, i) => (
              <li key={i} className="rounded-lg border border-line px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={x.decision === "accepted" ? "good" : "bad"}>{x.decision}</Badge>
                  <span className="text-ink">
                    by {x.by.id} <span className="text-ink-3">({x.by.kind})</span>
                  </span>
                  <span className="tabular text-ink-3">{dateTime(x.at)}</span>
                </div>
                {x.reason ? <p className="mt-1 text-ink-2">{x.reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-3">No supervisor or human decision recorded.</p>
        )}
      </div>
      <p className="text-[11px] text-ink-3">
        Policy {v.policyFingerprint}
        {v.contractSha256 ? ` · contract ${v.contractSha256.slice(0, 12)}` : ""}
        {v.rulesMatched.length ? ` · rules ${v.rulesMatched.join(", ")}` : ""}
      </p>
    </div>
  );
}
