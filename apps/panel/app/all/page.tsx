import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpenText, CheckCircle2, CircleAlert, Hourglass, MessageCircleQuestion, Network, Server, TriangleAlert } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { ALL, jobHref, projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, EmptyState, Mono, Stat } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { TaskStateBadge } from "@/components/task-badges";
import { ago, compact, dateTime, num, pct, shortId } from "@/lib/format";
import { usd } from "@/components/job-metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "All projects" };

type Usage = insights.ProjectUsage;

/** Where to act on an attention item: a project's page for its items, an install page for the rest. */
function attentionLink(project: string | null, text: string, onlyJob: string | null): { href: string; cta: string } | null {
  if (project === null) {
    if (/global knowledge/i.test(text)) return { href: `${ALL}/knowledge#pending`, cta: "Review" };
    if (/provider key/i.test(text)) return { href: `${ALL}/keys`, cta: "Fix" };
    if (/model|scan|policy violation/i.test(text)) return { href: `${ALL}/models`, cta: "Open" };
    return null;
  }
  const base = projectBase(project);
  if (/question/.test(text)) return { href: onlyJob ? `${jobHref(base, onlyJob)}#questions` : `${base}/jobs`, cta: "Answer" };
  if (/acceptance decision/.test(text)) return { href: `${base}/tasks?state=completed`, cta: "Decide" };
  if (/brain access/.test(text)) return { href: `${base}/brain?view=requests`, cta: "Review" };
  if (/interrupted/.test(text)) return { href: `${base}/tasks?state=interrupted`, cta: "Resume" };
  if (/^Repository /.test(text)) return { href: `${base}/settings`, cta: "Fix" };
  return { href: base, cta: "Open" };
}

/** A single-hue magnitude bar in a table cell; the number beside it carries the value. */
function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex min-w-[8rem] items-center gap-2" title={label}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: "var(--series-1)" }} />
      </div>
      <span className="tabular w-12 text-right text-xs text-ink">{compact(value)}</span>
    </div>
  );
}

const FOOT = { borderTop: "1px solid var(--line)", borderBottom: 0 } as const;

/** Hover text for a new-token count: the parts, and the total with cached input. */
function tokenTitle(u: insights.ProjectUsage): string {
  return `${num(u.uncachedInputTokens)} new input + ${num(u.outputTokens)} output; ${num(u.cachedInputTokens)} more input served from cache (${num(u.inputTokens + u.outputTokens)} with cached)`;
}

export default async function AllProjectsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const d = await insights.globalDashboard(sy);
  const health = await insights.providerHealth(sy);
  const awaiting = insights.promotionsView(sy, { status: "awaiting_person" });
  const now = Date.now();
  const names = new Map(d.projects.map((p) => [p.slug, p.name]));
  const ov = d.install;

  // Attention: install-wide items first, then each project's, grouped by project.
  const install = [...ov.attention];
  if (awaiting.length) install.push(`${awaiting.length} promotion(s) to global knowledge wait for a person's decision.`);
  const asking = new Map<string, string[]>();
  for (const q of sy.questions({ pendingOnly: true })) {
    const p = sy.tasks.projectOf(q.taskId) ?? "";
    const list = asking.get(p) ?? [];
    if (!list.includes(q.taskId)) list.push(q.taskId);
    asking.set(p, list);
  }
  const groups = [
    ...(install.length ? [{ project: null as string | null, items: install }] : []),
    ...d.projects.filter((p) => p.attentionItems.length).map((p) => ({ project: p.slug as string | null, items: p.attentionItems })),
  ];
  const attentionCount = groups.reduce((n, g) => n + g.items.length, 0);

  const totalModels = ov.models.active + ov.models.pending_confirmation + ov.models.disabled + ov.models.removed;
  const rows: Array<{ key: string; label: ReactNode; u24: Usage; u7: Usage }> = [
    ...d.projects.map((p) => ({
      key: p.slug,
      label: (
        <Link href={projectBase(p.slug)} className="font-medium text-accent-ink hover:underline">
          {p.name}
        </Link>
      ),
      u24: p.usage24h,
      u7: p.usage7d,
    })),
    // Qualification runs and eval comparisons work in a reserved project that is not one of the projects.
    ...(d.qualification.usage7d.requests || d.qualification.usage7d.tasksSubmitted || d.qualification.usage7d.paidSpendUsd
      ? [
          {
            key: "__qualification",
            label: (
              <Link href="/all/qualification#work" className="text-accent-ink hover:underline">
                Qualification and comparisons
              </Link>
            ),
            u24: d.qualification.usage24h,
            u7: d.qualification.usage7d,
          },
        ]
      : []),
    ...(d.unattributed.usage7d.requests || d.unattributed.usage7d.paidSpendUsd ? [{ key: "__none", label: <span className="text-ink-2">No project (probes, scans)</span>, u24: d.unattributed.usage24h, u7: d.unattributed.usage7d }] : []),
  ];
  const max24 = Math.max(0, ...rows.map((x) => x.u24.requests));
  const max7 = Math.max(0, ...rows.map((x) => x.u7.requests));
  const openBreakers = health.breakers.filter((b) => b.effective !== "closed");

  return (
    <div className="space-y-6">
      <PageHeader
        title="All projects"
        description="Every project's jobs, queues, and usage on this install, and what needs you. The pages in the sidebar (models, routing, provider keys, knowledge, settings) are shared by all projects."
        live={["tasks", "jobs", "requests", "workers", "keys", "brain", "projects"]}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Jobs" value={`${num(d.totals.runningJobs)} running`} sub={`${num(d.totals.queuedJobs)} queued across ${d.projects.length} project${d.projects.length === 1 ? "" : "s"}`} />
        <Stat label="Tasks" value={`${num(d.totals.runningTasks)} running`} sub={`${num(d.totals.queuedTasks)} queued`} />
        <Stat label="Model requests (24h)" help="requests" value={compact(d.totals.usage24h.requests)} sub={`${num(d.totals.usage24h.failedRequests)} failed · ${compact(d.totals.usage7d.requests)} in 7 days`} />
        <Stat label="Paid spend (24h)" value={usd(d.totals.usage24h.paidSpendUsd)} sub={`${usd(d.totals.usage7d.paidSpendUsd)} in 7 days`} />
        <Stat
          label="Workers"
          value={ov.workers.length ? `${ov.workers.length} active` : "None"}
          tone={ov.workers.length ? "good" : d.totals.queuedTasks ? "warn" : undefined}
          sub={ov.workers.length ? `${ov.models.routable} of ${totalModels} models routable` : d.totals.queuedTasks ? "Queued tasks wait for a worker" : "Nothing queued"}
        />
      </div>

      {attentionCount ? (
        <Card className="border-warn/40">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            <TriangleAlert size={16} className="text-warn-ink" aria-hidden /> Needs your attention
            <Badge tone="warn">{attentionCount}</Badge>
          </div>
          <div className="divide-y divide-line">
            {groups.map((g) => {
              const jobs = asking.get(g.project ?? "") ?? [];
              return (
                <div key={g.project ?? "__install"} className="px-4 py-2.5">
                  <div className="mb-1.5 text-xs font-semibold text-ink-2">
                    {g.project === null ? (
                      "This install"
                    ) : (
                      <Link href={projectBase(g.project)} className="text-accent-ink hover:underline">
                        {names.get(g.project) ?? g.project}
                      </Link>
                    )}
                  </div>
                  <ul className="space-y-1.5">
                    {g.items.map((a) => {
                      const act = attentionLink(g.project, a, jobs.length === 1 ? jobs[0]! : null);
                      return (
                        <li key={a} className="flex items-start gap-2 text-sm text-ink">
                          <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn-ink" aria-hidden />
                          <span className="min-w-0 flex-1 break-words">{a}</span>
                          {act ? (
                            <Link href={act.href} className="shrink-0 text-xs font-medium text-accent-ink hover:underline">
                              {act.cta} →
                            </Link>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Callout tone="good" icon={<CheckCircle2 size={16} />} title="Nothing needs your attention">
          No questions, decisions, access requests, interrupted tasks, or promotions are waiting in any project, and provider keys and models are in order.
        </Callout>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Running and queued jobs" description="Top-level jobs of every project that have not finished, newest first." />
          {d.jobs.length ? (
            <ul className="divide-y divide-line">
              {d.jobs.map((j) => (
                <li key={j.taskId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <Network size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Link href={jobHref(projectBase(j.project), j.taskId)} className="font-medium text-accent-ink hover:underline">
                        {j.label ?? shortId(j.taskId, 18)}
                      </Link>
                      <Link href={projectBase(j.project)} className="text-xs text-ink-3 hover:text-ink hover:underline">
                        {names.get(j.project) ?? j.project}
                      </Link>
                    </div>
                    <p className="line-clamp-2 text-xs text-ink-2">{j.goal}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TaskStateBadge state={j.state} />
                    {j.pendingQuestions ? (
                      <Badge tone="warn" icon={<MessageCircleQuestion size={11} />}>
                        {j.pendingQuestions} question{j.pendingQuestions === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                    <span className="text-[11px] text-ink-3" title={dateTime(j.createdAt)}>
                      {j.startedAt ? `started ${ago(j.startedAt, now)}` : `queued ${ago(j.createdAt, now)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Network size={22} />} title="No jobs running or queued">
              Start a job from a project&apos;s Jobs page. Each job runs a supervisor that plans, delegates, verifies, and commits to a job branch.
            </EmptyState>
          )}
        </Card>

        <Card>
          <CardHeader title="Queues by project" description="Every task (jobs, their workers, and standalone tasks) running or waiting to run." />
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="text-right">Running</th>
                  <th className="text-right">Waiting</th>
                  <th>Oldest waiting</th>
                </tr>
              </thead>
              <tbody>
                {d.projects.map((p) => {
                  const s = p.tasksByState;
                  const waitingFor = [
                    s.queued ? `${s.queued} queued` : null,
                    s.waiting_for_dependencies ? `${s.waiting_for_dependencies} on dependencies` : null,
                    s.waiting_for_capacity ? `${s.waiting_for_capacity} for capacity` : null,
                  ].filter((x): x is string => x !== null);
                  return (
                    <tr key={p.slug}>
                      <td className="whitespace-nowrap">
                        <Link href={`${projectBase(p.slug)}/tasks?state=active`} className="font-medium text-accent-ink hover:underline">
                          {p.name}
                        </Link>
                      </td>
                      <td className="tabular text-right text-xs">{num(p.runningTasks)}</td>
                      <td className="tabular text-right text-xs" title={waitingFor.join(", ") || "nothing waiting"}>
                        {num(p.queuedTasks)}
                        {waitingFor.length > 1 || s.waiting_for_capacity ? <div className="whitespace-nowrap text-[11px] text-ink-3">{waitingFor.join(" · ")}</div> : null}
                      </td>
                      <td className="whitespace-nowrap text-xs text-ink-2">
                        {p.oldestQueuedAt ? (
                          <span className="inline-flex items-center gap-1" title={dateTime(p.oldestQueuedAt)}>
                            <Hourglass size={12} className="text-ink-3" aria-hidden /> {ago(p.oldestQueuedAt, now)}
                          </span>
                        ) : (
                          <span className="text-ink-3">none</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Usage and paid spend by project"
          help="requests"
          description="Model requests charged to each project's tasks, tokens, failures, and paid spend (settled where known, else the reservation)."
          actions={
            <Link className="text-xs text-accent-ink hover:underline" href={`${ALL}/requests`}>
              Request log →
            </Link>
          }
        />
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Requests (24h)</th>
                <th>Requests (7 days)</th>
                <th className="text-right">Failed (24h)</th>
                <th className="text-right" title="New input plus output; cached input is in each cell's hover text">
                  New tokens (24h)
                </th>
                <th className="text-right">Paid (24h)</th>
                <th className="text-right">Paid (7 days)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.key}>
                  <td className="whitespace-nowrap">{x.label}</td>
                  <td>
                    <Bar value={x.u24.requests} max={max24} label={`${num(x.u24.requests)} requests in the last 24 hours`} />
                  </td>
                  <td>
                    <Bar value={x.u7.requests} max={max7} label={`${num(x.u7.requests)} requests in the last 7 days`} />
                  </td>
                  <td className="tabular whitespace-nowrap text-right text-xs">
                    {x.u24.requests ? (
                      <span className={x.u24.failedRequests / x.u24.requests > 0.2 ? "text-bad-ink" : undefined}>
                        {num(x.u24.failedRequests)} <span className="text-ink-3">({pct(x.u24.failedRequests, x.u24.requests)})</span>
                      </span>
                    ) : (
                      <span className="text-ink-3">–</span>
                    )}
                  </td>
                  <td className="tabular text-right text-xs" title={tokenTitle(x.u24)}>
                    {compact(x.u24.uncachedInputTokens + x.u24.outputTokens)}
                  </td>
                  <td className="tabular text-right text-xs">{usd(x.u24.paidSpendUsd)}</td>
                  <td className="tabular text-right text-xs">{usd(x.u7.paidSpendUsd)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium text-ink">
                <td style={FOOT}>All projects</td>
                <td style={FOOT} className="tabular text-xs">
                  <span className="block w-full pr-0 text-right">{compact(d.totals.usage24h.requests)}</span>
                </td>
                <td style={FOOT} className="tabular text-xs">
                  <span className="block w-full text-right">{compact(d.totals.usage7d.requests)}</span>
                </td>
                <td style={FOOT} className="tabular text-right text-xs">
                  {num(d.totals.usage24h.failedRequests)}
                </td>
                <td style={FOOT} className="tabular text-right text-xs" title={tokenTitle(d.totals.usage24h)}>
                  {compact(d.totals.usage24h.uncachedInputTokens + d.totals.usage24h.outputTokens)}
                </td>
                <td style={FOOT} className="tabular text-right text-xs">
                  {usd(d.totals.usage24h.paidSpendUsd)}
                </td>
                <td style={FOOT} className="tabular text-right text-xs">
                  {usd(d.totals.usage7d.paidSpendUsd)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Worker" help="worker" description="One worker serves every project, sharing capacity fairly." />
          <div className="space-y-2 p-4 text-sm">
            {ov.workers.length ? (
              <>
                <Badge tone="good" icon={<CheckCircle2 size={12} />}>
                  Running
                </Badge>
                <ul className="space-y-1 text-xs text-ink-3">
                  {ov.workers.map((w) => (
                    <li key={w.owner} className="flex justify-between gap-2">
                      <span className="truncate font-mono">{w.owner}</span>
                      <span>seen {ago(w.lastSeen, now)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <Badge tone={d.totals.queuedTasks ? "warn" : "neutral"}>No worker running</Badge>
                <p className="text-ink-2">
                  Tasks run while a worker is active: the MCP server inside Claude Code, or <Mono>switchyard worker</Mono>.
                  {d.totals.queuedTasks ? ` ${num(d.totals.queuedTasks)} queued task${d.totals.queuedTasks === 1 ? "" : "s"} wait until one starts.` : ""}
                </p>
              </>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Provider health"
            description="From SwitchYard's own key state (cooldowns, invalid keys, limits) and circuit breakers."
            actions={
              <Link className="text-xs text-accent-ink hover:underline" href={`${ALL}/keys`}>
                Provider keys →
              </Link>
            }
          />
          <div className="p-4">
            {health.providers.length ? (
              <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {health.providers.map((p) => {
                  const breaker = openBreakers.find((b) => b.platform === p.platform);
                  return (
                    <li key={p.platform} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-ink">{p.platform}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                        {p.keys} key{p.keys === 1 ? "" : "s"}
                        {p.requestsRemainingPct !== null ? <span>{Math.round(p.requestsRemainingPct)}% left</span> : null}
                        {breaker ? (
                          <Badge tone="bad" title={`Circuit breaker: ${breaker.effective}`}>
                            {breaker.effective === "open" ? `Breaker open${breaker.probeInMs ? ` · probe in ${Math.ceil(breaker.probeInMs / 1000)}s` : ""}` : "Breaker probing"}
                          </Badge>
                        ) : null}
                        {p.status === "healthy" ? (
                          <Badge tone="good">Healthy</Badge>
                        ) : p.status === "rate_limited" ? (
                          <Badge tone="warn" title={p.lastError ?? undefined}>
                            Rate limited{p.resumeAt ? ` · resumes ${ago(p.resumeAt, now)}` : ""}
                          </Badge>
                        ) : p.status === "invalid" ? (
                          <Badge tone="bad" title={p.lastError ?? undefined}>
                            Key invalid
                          </Badge>
                        ) : (
                          <Badge>Unknown</Badge>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={<Server size={20} />} title="No provider health reported">
                {ov.usableKeys ? (
                  "No provider has reported health yet."
                ) : (
                  <>
                    Add a provider key on the{" "}
                    <Link href={`${ALL}/keys`} className="text-accent-ink hover:underline">
                      Provider keys
                    </Link>{" "}
                    page so models can be reached.
                  </>
                )}
              </EmptyState>
            )}
          </div>
        </Card>
      </div>

      <p className="text-xs text-ink-3">
        <BookOpenText size={13} className="mr-1.5 inline align-[-2px]" aria-hidden />
        Lessons supervisors promoted for every project, with where they came from, are on the{" "}
        <Link href={`${ALL}/knowledge`} className="text-accent-ink hover:underline">
          Knowledge
        </Link>{" "}
        page.
      </p>
    </div>
  );
}
