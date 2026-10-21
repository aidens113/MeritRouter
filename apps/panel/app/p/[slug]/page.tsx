import Link from "next/link";
import { CheckCircle2, CircleAlert, Cpu, FolderGit2, Info, MessageCircleQuestion, Network, Play, TriangleAlert } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { jobHref, projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Badge, buttonClass, Callout, Card, CardHeader, EmptyState, Mono, PageHeader, Stat } from "@/components/ui";
import { AutoRefresh } from "@/components/client/actions";
import { StackedBars, StackedColumns, type Series } from "@/components/client/charts";
import { ago, compact, dateTime, num, pct, shortId } from "@/lib/format";
import { TASK_STATE_LABEL, TaskStateBadge } from "@/components/task-badges";
import { usd } from "@/components/job-metrics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project overview" };

const HOUR = 3_600_000;
const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

/** Where to act on one of the project's attention items. */
function attentionLink(base: string, text: string, onlyJob: string | null): { href: string; cta: string } | null {
  if (/question/.test(text)) return { href: onlyJob ? `${jobHref(base, onlyJob)}#questions` : `${base}/jobs`, cta: "Answer" };
  if (/acceptance decision/.test(text)) return { href: `${base}/tasks?state=completed`, cta: "Decide" };
  if (/brain access/.test(text)) return { href: `${base}/brain?view=requests`, cta: "Review" };
  if (/interrupted/.test(text)) return { href: `${base}/tasks?state=interrupted`, cta: "Resume" };
  if (/^Repository /.test(text)) return { href: `${base}/settings`, cta: "Fix" };
  return null;
}

export default async function ProjectOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const { slug } = await params;
  const p0 = project(sy, slug);
  // Set up this project's repositories first (create a missing folder, set up git, commit a first
  // snapshot); a repository that is already a git repository with history is not touched. Only what
  // SwitchYard cannot fix itself is left for the attention list.
  if (!p0.archived) await sy.prepareRepositories({ projects: [p0.slug] }).catch(() => undefined);
  const p = project(sy, slug);
  const base = projectBase(p.slug);
  const ov = insights.projectOverview(sy, p.slug);
  const now = Date.now();
  // Re-bucket on our side: the library's SQL bucket expression can return raw timestamps when
  // the bucket size is bound as a float, so align every point to its hour here.
  const ts = insights.timeseries(sy, { hours: 24, bucketMinutes: 60, project: p.slug }).map((x) => ({ ...x, bucketStart: Math.floor(x.bucketStart / HOUR) * HOUR }));
  const tiers = insights.tierDistribution(sy, now - 7 * 24 * HOUR, p.slug);
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));

  const first = Math.floor((now - 24 * HOUR) / HOUR) * HOUR + HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => first + i * HOUR);
  const byEp = new Map<string, number>();
  for (const x of ts) byEp.set(x.endpointId, (byEp.get(x.endpointId) ?? 0) + x.requests);
  const top = [...byEp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id)
    .sort();
  const series: Series[] = top.map((id, i) => ({
    key: id,
    label: id === "(none)" ? "No model (refused before dispatch)" : (names.get(id) ?? id),
    color: SLOTS[i]!,
    values: buckets.map((b) => ts.filter((x) => x.endpointId === id && x.bucketStart === b).reduce((s, x) => s + x.requests, 0)),
  }));
  const otherIds = [...byEp.keys()].filter((id) => !top.includes(id));
  if (otherIds.length)
    series.push({
      key: "__other",
      label: `Other (${otherIds.length} model${otherIds.length > 1 ? "s" : ""})`,
      color: "var(--series-other)",
      values: buckets.map((b) => ts.filter((x) => otherIds.includes(x.endpointId) && x.bucketStart === b).reduce((s, x) => s + x.requests, 0)),
    });

  const u = ov.usage24h;
  const tierOrder = ["T1", "T2", "T3", "T4", "unclassified"];
  const tierRows = tierOrder
    .map((t) => tiers.find((x) => x.tier === t) ?? (t === "unclassified" ? null : { tier: t, tasks: 0, completed: 0 }))
    .filter((x): x is { tier: string; tasks: number; completed: number } => x !== null);
  const tierHint: Record<string, string> = { T1: "easy", T2: "moderate", T3: "hard", T4: "to supervisor", unclassified: "not scored yet" };
  const states = Object.entries(ov.tasksByState).sort((a, b) => b[1] - a[1]);
  const asking = [...new Set(sy.questions({ pendingOnly: true, project: p.slug }).map((q) => q.taskId))];
  const onlyJob = asking.length === 1 ? asking[0]! : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={p.name}
        description={
          <>
            What this project is doing now, what it used in the last 24 hours, and what needs you. Project <Mono>{p.slug}</Mono>
            {p.primary ? " (primary: work submitted without a project lands here)" : ""}.
          </>
        }
        actions={
          <>
            <AutoRefresh seconds={8} />
            <Link href={`${base}/jobs#new`} className={buttonClass("primary", true)}>
              <Play size={13} aria-hidden /> New job
            </Link>
          </>
        }
      />

      {ov.notices.length ? (
        <Callout tone="accent" icon={<Info size={16} />} title="Repositories set up">
          <ul className="space-y-0.5">
            {ov.notices.map((n) => (
              <li key={n} className="break-words">
                {n}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {ov.attention.length ? (
        <Card className="border-warn/40">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            <TriangleAlert size={16} className="text-warn-ink" aria-hidden /> Needs your attention
            <Badge tone="warn">{ov.attention.length}</Badge>
          </div>
          <ul className="divide-y divide-line">
            {ov.attention.map((a) => {
              const act = attentionLink(base, a, onlyJob);
              return (
                <li key={a} className="flex items-start gap-2 px-4 py-2.5 text-sm text-ink">
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
        </Card>
      ) : (
        <Callout tone="good" icon={<CheckCircle2 size={16} />} title="Nothing needs your attention">
          No questions, decisions, access requests, or interrupted tasks in this project, and every repository is in place.
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Jobs" value={`${num(ov.activity.runningJobs)} running`} sub={`${num(ov.activity.queuedJobs)} queued · ${num(ov.activity.runningTasks)} tasks running, ${num(ov.activity.queuedTasks)} queued`} />
        <Stat label="Model requests (24h)" help="requests" value={compact(u.modelRequests)} sub={`${compact(ov.usage7d.modelRequests)} in the last 7 days`} />
        <Stat
          label="Success rate (24h)"
          value={u.modelRequests ? pct(u.succeededResponses, u.modelRequests) : "–"}
          tone={u.modelRequests && u.succeededResponses / u.modelRequests < 0.8 ? "warn" : undefined}
          sub={u.modelRequests ? `${num(u.failedRequests)} failed · ${num(u.uncertainRequests)} uncertain` : "No requests yet"}
        />
        <Stat label="Tasks (24h)" value={`${num(u.logicalTasks.completed)} done`} sub={`${num(u.logicalTasks.failed)} failed · ${num(u.logicalTasks.other)} other · ${num(u.logicalTasks.submitted)} submitted`} tone={u.logicalTasks.failed > u.logicalTasks.completed ? "bad" : undefined} />
        <Stat label="Paid spend (24h)" value={usd(ov.paidSpendUsd.last24h)} sub={`${usd(ov.paidSpendUsd.last7d)} in the last 7 days · ${compact(u.inputTokens + u.outputTokens)} tokens today`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Running and queued jobs" description="This project's top-level jobs that have not finished, newest first." actions={<Link className="text-xs text-accent-ink hover:underline" href={`${base}/jobs`}>All jobs →</Link>} />
          {ov.jobs.length ? (
            <ul className="divide-y divide-line">
              {ov.jobs.map((j) => (
                <li key={j.taskId} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <Network size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link href={jobHref(base, j.taskId)} className="font-medium text-accent-ink hover:underline">
                      {j.label ?? shortId(j.taskId, 18)}
                    </Link>
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
            <EmptyState icon={<Network size={22} />} title="No jobs running or queued" action={<Link href={`${base}/jobs#new`} className="text-sm text-accent-ink hover:underline">Start a job →</Link>}>
              A job runs a supervisor that plans, delegates to workers, verifies, and commits to a job branch.
            </EmptyState>
          )}
        </Card>

        <Card>
          <CardHeader title="Repositories" description="Where this project's tasks read and write." actions={<Link className="text-xs text-accent-ink hover:underline" href={`${base}/settings`}>Project settings →</Link>} />
          {p.repositories.length ? (
            <ul className="divide-y divide-line">
              {p.repositories.map((repo) => (
                <li key={repo.alias} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                  <FolderGit2 size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[13px] text-ink">{repo.alias}</span>
                      {repo.writable ? <Badge>writable</Badge> : <Badge>read only</Badge>}
                      {repo.exists ? null : <Badge tone="warn">not set up</Badge>}
                    </div>
                    <div className="break-all font-mono text-[11px] text-ink-3">{repo.path}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No repositories">Tasks in this project can only work on text you give them until you add one.</EmptyState>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Requests over the last 24 hours" description="This project's physical model requests per hour, stacked by the model that was targeted." help="requests" actions={<Link className="text-xs text-accent-ink hover:underline" href={`${base}/requests`}>Request log →</Link>} />
          <div className="p-4">
            {ts.length ? (
              <StackedColumns buckets={buckets} series={series} bucketMinutes={60} />
            ) : (
              <EmptyState icon={<Cpu size={22} />} title="No model requests in the last 24 hours">
                Requests appear here once a worker runs this project&apos;s tasks. Start Claude Code with the SwitchYard MCP server, or run <Mono>switchyard worker</Mono>.
              </EmptyState>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Tasks by tier (7 days)" help="tier" description="How difficult this project's delegated work was, and how much of it completed." />
          <div className="p-4">
            {tierRows.some((t) => t.tasks) ? (
              <StackedBars
                rows={tierRows.map((t) => ({ key: t.tier, label: t.tier === "unclassified" ? "Unscored" : t.tier, hint: tierHint[t.tier] ?? "" }))}
                series={[
                  { key: "completed", label: "Completed", color: "var(--series-1)", values: tierRows.map((t) => t.completed) },
                  { key: "other", label: "Not completed", color: "var(--series-other)", values: tierRows.map((t) => t.tasks - t.completed) },
                ]}
              />
            ) : (
              <EmptyState title="No tasks in the last 7 days">Tasks are scored into tiers T1–T3 (or T4, returned to the supervisor).</EmptyState>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Worker" help="worker" description="Workers serve every project at once, sharing capacity fairly." />
        <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
          <div className="space-y-2">
            {ov.workers.length ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone="good" icon={<CheckCircle2 size={12} />}>Running</Badge>
                  <span className="text-ink-2">{ov.workers.length} worker{ov.workers.length > 1 ? "s" : ""} active</span>
                </div>
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
                <Badge tone="neutral">No worker running</Badge>
                <p className="text-ink-2">
                  Tasks run while a worker is active: the MCP server inside Claude Code, or <Mono>switchyard worker</Mono>. Queued tasks wait until one starts.
                </p>
              </>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-ink-3">This project&apos;s tasks by state (all time)</div>
            {states.length ? (
              <div className="flex flex-wrap gap-1.5">
                {states.map(([s, n]) => (
                  <Link key={s} href={`${base}/tasks?state=${s}`} className="inline-flex items-center gap-1 rounded-full hover:opacity-80" title={`Show ${TASK_STATE_LABEL[s] ?? s} tasks`}>
                    <TaskStateBadge state={s} count={n} />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink-3">No tasks yet.</p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
