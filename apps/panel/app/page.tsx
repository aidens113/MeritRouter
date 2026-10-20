import Link from "next/link";
import { CheckCircle2, CircleAlert, Cpu, Radar, Server, TriangleAlert } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, EmptyState, HelpTip, Mono, PageHeader, Stat } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { StackedBars, StackedColumns, type Series } from "@/components/client/charts";
import { ago, compact, dateTime, num, pct } from "@/lib/format";
import { TASK_STATE_LABEL, TaskStateBadge } from "@/components/task-badges";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

const HOUR = 3_600_000;
const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

export default async function OverviewPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const ov = await insights.overview(sy);
  const now = Date.now();
  // Re-bucket on our side: the library's SQL bucket expression can return raw timestamps when
  // the bucket size is bound as a float, so align every point to its hour here.
  const ts = insights.timeseries(sy, { hours: 24, bucketMinutes: 60 }).map((p) => ({ ...p, bucketStart: Math.floor(p.bucketStart / HOUR) * HOUR }));
  const tiers = insights.tierDistribution(sy, now - 7 * 24 * HOUR);
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));

  // Buckets: every hour in the last 24h, so quiet hours show as gaps rather than disappearing.
  const first = Math.floor((now - 24 * HOUR) / HOUR) * HOUR + HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => first + i * HOUR);
  const byEp = new Map<string, number>();
  for (const p of ts) byEp.set(p.endpointId, (byEp.get(p.endpointId) ?? 0) + p.requests);
  // Top five models by volume get the first five categorical slots (ordered by id so a model keeps
  // its colour while it stays in the top five); the rest fold into "Other".
  const top = [...byEp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id)
    .sort();
  const series: Series[] = top.map((id, i) => ({
    key: id,
    label: id === "(none)" ? "No model (refused before dispatch)" : (names.get(id) ?? id),
    color: SLOTS[i]!,
    values: buckets.map((b) => ts.filter((p) => p.endpointId === id && p.bucketStart === b).reduce((s, p) => s + p.requests, 0)),
  }));
  const otherIds = [...byEp.keys()].filter((id) => !top.includes(id));
  if (otherIds.length)
    series.push({
      key: "__other",
      label: `Other (${otherIds.length} model${otherIds.length > 1 ? "s" : ""})`,
      color: "var(--series-other)",
      values: buckets.map((b) => ts.filter((p) => otherIds.includes(p.endpointId) && p.bucketStart === b).reduce((s, p) => s + p.requests, 0)),
    });

  const u = ov.usage24h;
  const tierOrder = ["T1", "T2", "T3", "T4", "unclassified"];
  const tierRows = tierOrder
    .map((t) => tiers.find((x) => x.tier === t) ?? (t === "unclassified" ? null : { tier: t, tasks: 0, completed: 0 }))
    .filter((x): x is { tier: string; tasks: number; completed: number } => x !== null);
  const tierHint: Record<string, string> = { T1: "easy", T2: "moderate", T3: "hard", T4: "to supervisor", unclassified: "not scored yet" };
  const states = Object.entries(ov.tasksByState).sort((a, b) => b[1] - a[1]);
  // Items that need a decision from you, computed here so each can link to where you act.
  const questions = sy.questions({ pendingOnly: true });
  const jobsAsking = [...new Set(questions.map((q) => q.taskId))];
  const accessPending = insights.brainAccessRequests(sy, "pending");
  const actions: Array<{ key: string; text: string; href: string; cta: string }> = [];
  if (questions.length)
    actions.push({
      key: "questions",
      text: `${questions.length} question${questions.length === 1 ? "" : "s"} waiting for you from ${jobsAsking.length} job${jobsAsking.length === 1 ? "" : "s"}: "${questions[0]!.question.slice(0, 120)}"`,
      href: jobsAsking.length === 1 ? `/jobs/${jobsAsking[0]}#questions` : "/jobs",
      cta: "Answer",
    });
  if (accessPending.length)
    actions.push({
      key: "access",
      text: `${accessPending.length} brain access request${accessPending.length === 1 ? "" : "s"} pending (${accessPending[0]!.role} wants ${accessPending[0]!.mode} on ${accessPending[0]!.pattern})`,
      href: "/brain?view=requests",
      cta: "Review",
    });
  const attentionCount = ov.attention.length + actions.length;
  const totalModels = ov.models.active + ov.models.pending_confirmation + ov.models.disabled + ov.models.removed;

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="What SwitchYard is doing right now, what it used in the last 24 hours, and anything that needs your attention." actions={<AutoRefresh seconds={8} />} />

      {attentionCount ? (
        <Card className="border-warn/40">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-ink">
            <TriangleAlert size={16} className="text-warn-ink" aria-hidden /> Needs your attention
            <Badge tone="warn">{attentionCount}</Badge>
          </div>
          <ul className="divide-y divide-line">
            {actions.map((a) => (
              <li key={a.key} className="flex items-start gap-2 px-4 py-2.5 text-sm text-ink">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn-ink" aria-hidden />
                <span className="min-w-0 flex-1">{a.text}</span>
                <Link href={a.href} className="shrink-0 text-xs font-medium text-accent-ink hover:underline">
                  {a.cta} →
                </Link>
              </li>
            ))}
            {ov.attention.map((a) => (
              <li key={a} className="flex items-start gap-2 px-4 py-2.5 text-sm text-ink">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-warn-ink" aria-hidden />
                <AttentionText text={a} />
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Callout tone="good" icon={<CheckCircle2 size={16} />} title="Nothing needs your attention">
          The gateway is configured, models are confirmed, and no policy violations were recorded in the last 24 hours.
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Model requests (24h)" help="requests" value={compact(u.modelRequests)} sub={`${compact(ov.usage7d.modelRequests)} in the last 7 days`} />
        <Stat
          label="Success rate (24h)"
          value={u.modelRequests ? pct(u.succeededResponses, u.modelRequests) : "–"}
          tone={u.modelRequests && u.succeededResponses / u.modelRequests < 0.8 ? "warn" : undefined}
          sub={u.modelRequests ? `${num(u.failedRequests)} failed · ${num(u.uncertainRequests)} uncertain` : "No requests yet"}
        />
        <Stat label="Tasks (24h)" value={`${num(u.logicalTasks.completed)} done`} sub={`${num(u.logicalTasks.failed)} failed · ${num(u.logicalTasks.other)} other · ${num(u.logicalTasks.submitted)} submitted`} tone={u.logicalTasks.failed > u.logicalTasks.completed ? "bad" : undefined} />
        <Stat label="Tokens (24h)" value={compact(u.inputTokens + u.outputTokens)} sub={`${compact(u.inputTokens)} in · ${compact(u.outputTokens)} out · ${compact(u.cachedInputTokens)} cached`} />
        <Stat label="Routable models" value={`${ov.models.routable} of ${totalModels}`} sub={`${ov.models.active} active · ${ov.models.pending_confirmation} need confirmation · ${ov.models.disabled} disabled`} tone={ov.models.routable === 0 ? "bad" : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Requests over the last 24 hours" description="Physical model requests per hour, stacked by the model that was targeted." help="requests" actions={<Link className="text-xs text-accent-ink hover:underline" href="/requests">Request log →</Link>} />
          <div className="p-4">
            {ts.length ? (
              <StackedColumns buckets={buckets} series={series} bucketMinutes={60} />
            ) : (
              <EmptyState icon={<Cpu size={22} />} title="No model requests in the last 24 hours">
                Requests appear here once a worker runs delegated tasks. Start Claude Code with the SwitchYard MCP server, or run <Mono>switchyard worker</Mono>.
              </EmptyState>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Tasks by tier (7 days)" help="tier" description="How difficult delegated work was, and how much of it completed." />
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
              <EmptyState title="No tasks in the last 7 days">Tasks submitted by the supervisor are scored into tiers T1–T3 (or T4, returned to the supervisor).</EmptyState>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Worker" help="worker" />
          <div className="space-y-3 p-4 text-sm">
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
            <div className="border-t border-line pt-3">
              <div className="mb-1.5 text-xs font-medium text-ink-3">Tasks by state (all time)</div>
              {states.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {states.map(([s, n]) => (
                    <Link key={s} href={`/tasks?state=${s}`} className="inline-flex items-center gap-1 rounded-full hover:opacity-80" title={`Show ${TASK_STATE_LABEL[s] ?? s} tasks`}>
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

        <Card>
          <CardHeader title="Provider health" description="As reported by FreeLLMAPI (GET /v1/providers)." />
          <div className="p-4">
            {ov.providers.length ? (
              <ul className="space-y-2 text-sm">
                {ov.providers.map((p) => (
                  <li key={p.platform} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{p.platform}</span>
                    <span className="flex items-center gap-2 text-xs text-ink-3">
                      {p.keys} key{p.keys === 1 ? "" : "s"}
                      {p.requestsRemainingPct !== null ? <span>{Math.round(p.requestsRemainingPct)}% left</span> : null}
                      {p.status === "healthy" ? (
                        <Badge tone="good">Healthy</Badge>
                      ) : p.status === "rate_limited" ? (
                        <Badge tone="warn" title={p.lastError ?? undefined}>
                          Rate limited{p.resumeAt ? ` · resumes ${ago(p.resumeAt, now)}` : ""}
                        </Badge>
                      ) : p.status === "invalid" ? (
                        <Badge tone="bad" title={p.lastError ?? undefined}>Key invalid</Badge>
                      ) : (
                        <Badge>Unknown</Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Server size={20} />} title="No provider health reported">
                {ov.gatewayConfigured ? "No provider has reported health yet." : "Add a provider key (under providers in the config) so models can be reached."}
              </EmptyState>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Model catalog scan"
            description="Lists the models of every provider with a usable key and checks their sizes and prices."
            actions={<ActionButton url="/api/scan" small variant="secondary" success="Scan finished">
              <Radar size={13} aria-hidden /> Scan now
            </ActionButton>}
          />
          <div className="space-y-2 p-4 text-sm">
            {ov.lastScan ? (
              <>
                <div className="flex items-center gap-2">
                  {ov.lastScan.ok === null ? <Badge tone="accent">Running</Badge> : ov.lastScan.ok ? <Badge tone="good">Succeeded</Badge> : <Badge tone="bad">Failed</Badge>}
                  <span className="text-ink-2" title={dateTime(ov.lastScan.startedAt)}>
                    {ago(ov.lastScan.startedAt, now)}
                  </span>
                </div>
                {ov.lastScan.summary ? (
                  <ul className="grid grid-cols-2 gap-1 text-xs text-ink-2">
                    <li>{ov.lastScan.summary.scanned} models scanned</li>
                    <li>{ov.lastScan.summary.added.length} new</li>
                    <li>{ov.lastScan.summary.pendingConfirmation.length} need confirmation</li>
                    <li>{ov.lastScan.summary.unavailable.length} unavailable</li>
                    {ov.lastScan.summary.errors.length ? <li className="col-span-2 text-bad-ink">{ov.lastScan.summary.errors.length} error(s): {ov.lastScan.summary.errors[0]}</li> : null}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="text-ink-2">No scan has run yet.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Attention items mention env vars and config keys; render those as code. */
function AttentionText({ text }: { text: string }) {
  const parts = text.split(/(\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z_]+\.[a-z_]+\b)/g);
  return (
    <span>
      {parts.map((p, i) => (i % 2 === 1 ? <Mono key={i}>{p}</Mono> : <span key={i}>{p}</span>))}
    </span>
  );
}
