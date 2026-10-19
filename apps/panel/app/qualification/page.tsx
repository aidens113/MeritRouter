import Link from "next/link";
import { BadgeCheck, FlaskConical } from "lucide-react";
import { insights, TIER_NAMES, type Switchyard } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, Mono, PageHeader, Stat } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { ago, dateTime, humanize, modelHref, num } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Qualification" };

type Stat = { passRate: number; trials: number; passes: number; qualified: boolean; low: number; high: number };
interface BoardRow {
  endpointId: string;
  displayName: string;
  status: string;
  family: string;
  tier: string;
  stat: Stat | null;
}
interface Board {
  suiteVersion: string | null;
  evals: Array<{ id: string; family: string; tier: string; title: string; profile: string; maxModelRequests: number }>;
  rows: BoardRow[];
  runs: Array<{ id: string; endpointId: string; status: string; startedAt: number; finishedAt: number | null; graded: number; total: number }>;
  requestsUsedToday: number | null;
  dailyAllocation: number;
  fallbackReason: string | null;
}

/** Prefer the library's leaderboard; fall back to per-model stats when the suite is unavailable. */
function loadBoard(sy: Switchyard): Board {
  try {
    const b = insights.qualificationBoard(sy);
    return { ...b, fallbackReason: null };
  } catch (err) {
    const rows: BoardRow[] = insights.modelsView(sy).flatMap((v) =>
      v.qualification.map((q) => ({ endpointId: v.endpoint.id, displayName: v.endpoint.displayName ?? v.endpoint.gatewayModelId, status: v.endpoint.status, family: q.family, tier: q.tier, stat: q.stat })),
    );
    return { suiteVersion: null, evals: [], rows, runs: [], requestsUsedToday: null, dailyAllocation: sy.cfg.qualification.max_requests_per_day, fallbackReason: (err as Error).message };
  }
}

export default function QualificationPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const board = loadBoard(sy);
  const q = sy.cfg.qualification;
  const families = [...new Set(board.rows.map((x) => x.family))];
  const models = [...new Map(board.rows.map((x) => [x.endpointId, { id: x.endpointId, name: x.displayName, status: x.status }])).values()];
  const perRun = board.evals.reduce((s, e) => s + e.maxModelRequests, 0) * q.trials_per_task;
  const names = new Map(models.map((m) => [m.id, m.name]));
  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Qualification"
        description="Short evaluation tasks measure how often each model gets work right, per task family and tier. Routing can require a model to qualify before it serves real work."
        actions={<AutoRefresh seconds={10} />}
      />
      <Callout tone="warn" icon={<FlaskConical size={16} />} title="Qualification uses your free quota">
        Each run sends real requests through FreeLLMAPI ({perRun ? `up to ${perRun} per model with the current suite` : "a few dozen per model"}), capped at {q.max_requests_per_day} qualification requests per day. Runs execute only while a worker is active.
      </Callout>
      {board.fallbackReason ? (
        <Callout tone="neutral" title="Evaluation suite unavailable">
          Showing recorded results only. {board.fallbackReason}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Required for routing" value={q.required ? "Yes" : "No"} sub={q.required ? "Only qualified models serve" : "Results inform ordering only"} />
        <Stat label="Pass threshold" value={`${Math.round(q.pass_threshold * 100)}%`} sub={`after at least ${q.min_trials} trials`} />
        <Stat label="Used today" value={board.requestsUsedToday === null ? "–" : `${num(board.requestsUsedToday)} / ${num(board.dailyAllocation)}`} sub="qualification requests in the last 24h" />
        <Stat label="Suite" value={board.suiteVersion ?? "–"} sub={`${board.evals.length} evaluations · ${q.trials_per_task} trials each`} />
      </div>

      {families.length === 0 ? (
        <Card>
          <EmptyState icon={<BadgeCheck size={22} />} title="No qualification results yet">Run qualification for a model below to see its pass rates here.</EmptyState>
        </Card>
      ) : (
        families.map((f) => {
          const rows = board.rows.filter((x) => x.family === f);
          const ids = [...new Set(rows.map((x) => x.endpointId))];
          const score = (id: string) => rows.filter((x) => x.endpointId === id && x.stat).reduce((s, x) => s + (x.stat!.passRate ?? 0) * (x.stat!.trials > 0 ? 1 : 0), 0);
          const ranked = ids.filter((id) => rows.some((x) => x.endpointId === id && x.stat)).sort((a, b) => score(b) - score(a));
          const untested = ids.length - ranked.length;
          return (
            <Card key={f}>
              <CardHeader title={`${humanize(f).replace(/^./, (c) => c.toUpperCase())} tasks`} help="qualification" description={`${ranked.length} model${ranked.length === 1 ? "" : "s"} measured${untested ? ` · ${untested} not yet tested` : ""}. The dot is the pass rate, the band its 95% confidence interval, the tick the pass threshold.`} />
              {ranked.length ? (
                <div className="overflow-x-auto">
                  <table className="data-table tabular">
                    <thead>
                      <tr>
                        <th>Model</th>
                        {TIER_NAMES.map((t) => (
                          <th key={t} className="min-w-[11rem]">
                            {t}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.map((id) => (
                        <tr key={id}>
                          <td>
                            <Link href={modelHref(id)} className="font-medium text-ink hover:underline">
                              {names.get(id) ?? id}
                            </Link>
                          </td>
                          {TIER_NAMES.map((t) => {
                            const s = rows.find((x) => x.endpointId === id && x.tier === t)?.stat ?? null;
                            return (
                              <td key={t}>
                                <PassRate s={s} threshold={q.pass_threshold} minTrials={q.min_trials} />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="No results for this family yet" />
              )}
            </Card>
          );
        })
      )}

      <Card>
        <CardHeader title="Run qualification" description="Queues the evaluation suite against one model. Only active models can be qualified." />
        <ul className="divide-y divide-line">
          {models
            .filter((m) => m.status !== "removed")
            .map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <Link href={modelHref(m.id)} className="text-sm font-medium text-ink hover:underline">
                    {m.name}
                  </Link>
                  <div className="font-mono text-[11px] text-ink-3">{m.id}</div>
                </div>
                {m.status === "active" ? (
                  <ActionButton url="/api/qualification" payload={{ endpointId: m.id }} small confirm={perRun ? `Use up to ${perRun} requests?` : "Start run?"} success="Run queued: a worker will execute it">
                    <FlaskConical size={13} aria-hidden /> Run qualification
                  </ActionButton>
                ) : (
                  <Badge>{humanize(m.status)}: cannot run</Badge>
                )}
              </li>
            ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Recent runs" />
        {board.runs.length ? (
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Graded</th>
                  <th>Finished</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {board.runs.map((run) => (
                  <tr key={run.id}>
                    <td title={dateTime(run.startedAt)}>{ago(run.startedAt, now)}</td>
                    <td>
                      <Link href={modelHref(run.endpointId)} className="hover:underline">
                        {names.get(run.endpointId) ?? run.endpointId}
                      </Link>
                    </td>
                    <td>
                      <Badge tone={run.status === "completed" ? "good" : run.status === "failed" ? "bad" : "accent"}>{humanize(run.status)}</Badge>
                    </td>
                    <td>{run.total ? `${run.graded} / ${run.total}` : "–"}</td>
                    <td>{run.finishedAt ? dateTime(run.finishedAt) : "–"}</td>
                    <td>
                      <Mono>{run.id}</Mono>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No runs yet" />
        )}
      </Card>

      {board.evals.length ? (
        <Card>
          <CardHeader title="Evaluation suite" description={`Version ${board.suiteVersion}. Each evaluation is a small, graded task at a fixed tier.`} />
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Evaluation</th>
                  <th>Family</th>
                  <th>Tier</th>
                  <th>Task type</th>
                  <th className="text-right">Max requests</th>
                </tr>
              </thead>
              <tbody>
                {board.evals.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="font-medium text-ink">{e.title}</div>
                      <div className="font-mono text-[11px] text-ink-3">{e.id}</div>
                    </td>
                    <td>{humanize(e.family)}</td>
                    <td>
                      <Badge tone="accent">{e.tier}</Badge>
                    </td>
                    <td>{e.profile}</td>
                    <td className="tabular text-right">{e.maxModelRequests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function PassRate({ s, threshold, minTrials }: { s: Stat | null; threshold: number; minTrials: number }) {
  if (!s) return <span className="text-xs text-ink-3">not tested</span>;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold text-ink">{Math.round(s.passRate * 100)}%</span>
        <span className="text-[11px] text-ink-3">
          {s.passes}/{s.trials}
        </span>
        {s.qualified ? (
          <Badge tone="good">qualified</Badge>
        ) : s.trials < minTrials ? (
          <span className="text-[11px] text-ink-3" title={`Needs ${minTrials} trials`}>
            few trials
          </span>
        ) : null}
      </div>
      <div className="relative h-2 w-36 rounded-full bg-surface-2" aria-label={`95% interval ${Math.round(s.low * 100)} to ${Math.round(s.high * 100)} percent`}>
        <div className="absolute inset-y-0 rounded-full bg-accent/30" style={{ left: `${s.low * 100}%`, width: `${Math.max(1, (s.high - s.low) * 100)}%` }} />
        <div className="absolute -top-0.5 h-3 w-px bg-ink-3" style={{ left: `${threshold * 100}%` }} title={`Pass threshold ${Math.round(threshold * 100)}%`} />
        <div className={cx("absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface")} style={{ left: `${s.passRate * 100}%`, background: "var(--series-1)" }} />
      </div>
      <div className="text-[10px] text-ink-3">
        95% CI {Math.round(s.low * 100)}–{Math.round(s.high * 100)}% <HelpTip text="The true pass rate is likely inside this range. More trials narrow it. The tick marks the pass threshold." />
      </div>
    </div>
  );
}
