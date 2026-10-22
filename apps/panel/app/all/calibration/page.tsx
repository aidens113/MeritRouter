import Link from "next/link";
import { Scale } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Card, CardHeader, cx, EmptyState, Stat, type Tone } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { UrlFilters } from "@/components/client/url-filters";
import { ago, dateTime, humanize, modelHref, num, pct, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calibration" };

type Overview = ReturnType<typeof insights.calibrationOverview>;
type VerdictView = Overview["recent"][number];

const WINDOWS: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  correct: { label: "Confirmed correct", tone: "good" },
  false_approval: { label: "False approval", tone: "bad" },
  false_rejection: { label: "False rejection", tone: "serious" },
  pending: { label: "Awaiting confirmation", tone: "neutral" },
  led_to_repair: { label: "Led to a repair", tone: "accent" },
  superseded: { label: "Superseded", tone: "neutral" },
  no_verdict: { label: "Not judged", tone: "neutral" },
};

const VERDICT_TONE: Record<string, Tone> = { pass: "good", fail: "bad", inconclusive: "warn" };

function VerdictBadge({ v }: { v: VerdictView["verdict"] }) {
  return <Badge tone={v ? VERDICT_TONE[v] : "neutral"}>{v ?? "no verdict"}</Badge>;
}

/** Share of passed results per confirmation status, as one stacked bar. */
function ConfirmationBar({ row }: { row: Overview["verified"][number] }) {
  if (!row.passed) return <span className="text-xs text-ink-3">–</span>;
  const parts: Array<[number, string, string]> = [
    [row.confirmed, "bg-good", "confirmed"],
    [row.escaped, "bg-bad", "escaped defects"],
    [row.rejected, "bg-serious", "rejected"],
    [row.unconfirmed, "bg-surface-3", "awaiting confirmation"],
  ];
  return (
    <div className="flex h-2 w-40 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={parts.map(([n, , l]) => `${n} ${l}`).join(", ")}>
      {parts.map(([n, cls, l]) => (n ? <div key={l} className={cls} style={{ width: `${(n / row.passed) * 100}%` }} title={`${n} ${l}`} /> : null))}
    </div>
  );
}

const Num = ({ n, tone }: { n: number; tone?: "bad" | "good" | "serious" }) => (
  <span className={cx(n && tone === "bad" ? "font-semibold text-bad-ink" : n && tone === "serious" ? "font-semibold text-serious-ink" : n && tone === "good" ? "text-good-ink" : n ? "text-ink" : "text-ink-3")}>{num(n)}</span>
);

export default async function CalibrationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const daysParam = typeof sp.days === "string" && WINDOWS[sp.days] && sp.days !== "30" ? sp.days : "";
  const days = WINDOWS[daysParam] ?? 30;
  const now = Date.now();
  const o = insights.calibrationOverview(sy, { sinceMs: now - days * 86_400_000 });
  const all = o.verified[0]!;
  const levels = o.verified.slice(1);
  const t = o.totals;
  const usageTotal = o.usage.reduce((s, u) => s + u.requests, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calibration"
        // No HelpTip at the end of this text: wrapped near the right edge, its (invisible) popover
        // widens the page. The "Verified vs confirmed" card carries it (short enough not to wrap at phone width).
        description="How far verification can be trusted: each reviewer's verdicts, and every result that passed verification, set against what happened to it afterwards (accepted or rejected, integrated, job checks on the branch, undone through attribution)."
        live={["tasks", "jobs"]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <UrlFilters values={{ days: daysParam }} fields={[{ name: "days", label: "Window", kind: "select", options: [["7", "Last 7 days"], ["90", "Last 90 days"]], anyLabel: "Last 30 days" }]} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Passed verification" value={num(all.passed)} sub={all.passed ? `${pct(all.confirmed, all.passed)} subsequently confirmed` : "no results in this window"} help="verification" />
        <Stat label="Escaped defects" value={num(all.escaped)} tone={all.escaped ? "bad" : undefined} sub="passed, then undone or failing job checks" />
        <Stat label="False approvals" value={num(t.falseApprovals)} tone={t.falseApprovals ? "bad" : undefined} sub={`false rejections: ${num(t.falseRejections)}`} help="falseApproval" />
        <Stat label="Inconclusive rate" value={t.inconclusiveRate === null ? "–" : pct(t.inconclusive, t.decisive + t.inconclusive)} sub={`${num(t.verdicts)} verdict${t.verdicts === 1 ? "" : "s"} recorded`} />
        <Stat label="Reused · audited" value={`${num(t.cached)} · ${num(t.audits)}`} sub={`cached verdicts · audits (sample rate ${Math.round(o.audits.sampleRate * 100)}%)`} />
      </div>

      <Card>
        <CardHeader
          title="Verified vs confirmed"
          help="calibration"
          description="Results that passed verification, by level. Confirmed: accepted by the supervisor or a person, or integrated onto a job branch, and not contradicted since. Escaped: integrated or accepted, then undone or failing later job checks."
        />
        {all.passed ? (
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Passed</th>
                  <th>Confirmed</th>
                  <th>Escaped defects</th>
                  <th>Rejected</th>
                  <th>Awaiting confirmation</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {[all, ...levels].map((row) => (
                  <tr key={row.level} className={row.level === "all" ? "font-medium" : undefined}>
                    <td>{row.level === "all" ? "All levels" : humanize(row.level)}</td>
                    <td>{num(row.passed)}</td>
                    <td>
                      <Num n={row.confirmed} tone="good" />
                    </td>
                    <td>
                      <Num n={row.escaped} tone="bad" />
                    </td>
                    <td>
                      <Num n={row.rejected} tone="serious" />
                    </td>
                    <td>
                      <Num n={row.unconfirmed} />
                    </td>
                    <td>
                      <ConfirmationBar row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Scale size={22} />} title="No result passed verification in this window" />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Reviewers"
          help="review"
          description="Per reviewer model: its verdicts (verification reviews, reused verdicts, and audits), and how the decisive ones on the finally accepted revision held up. Cost is review requests per accepted task it reviewed."
        />
        {o.reviewers.length ? (
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Reviews</th>
                  <th>Pass · fail · inconclusive</th>
                  <th>Qualified</th>
                  <th>Confirmed correct</th>
                  <th>False approvals</th>
                  <th>False rejections</th>
                  <th>Awaiting</th>
                  <th>Requests per accepted task</th>
                </tr>
              </thead>
              <tbody>
                {o.reviewers.map((x) => (
                  <tr key={x.reviewer ?? "none"}>
                    <td>
                      {x.reviewer ? (
                        <Link href={modelHref(x.reviewer)} className="font-medium text-ink hover:underline">
                          {x.name}
                        </Link>
                      ) : (
                        <span className="text-ink-3">{x.name}</span>
                      )}
                      <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-ink-3">
                        {x.family ? <span>{x.family}</span> : null}
                        {x.levels.map((l) => (
                          <span key={l.level} title={`${l.reviews} at ${l.level}: ${l.correct} correct, ${l.falseApprovals} false approvals, ${l.falseRejections} false rejections`}>
                            · {l.level} {l.reviews}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {num(x.reviews)}
                      <div className="text-[11px] text-ink-3">
                        {x.audits ? `${num(x.audits)} audit${x.audits === 1 ? "" : "s"}` : ""}
                        {x.audits && x.cached ? " · " : ""}
                        {x.cached ? `${num(x.cached)} reused` : ""}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="text-good-ink">{num(x.pass)}</span> · <span className="text-bad-ink">{num(x.fail)}</span> · <span className="text-warn-ink">{num(x.inconclusive)}</span>
                      {x.noVerdict ? <div className="text-[11px] text-ink-3">{num(x.noVerdict)} without a verdict</div> : null}
                    </td>
                    <td>
                      {x.unqualified && !x.qualified ? (
                        <Badge tone="warn">unqualified</Badge>
                      ) : x.unqualified ? (
                        <span className="text-xs">
                          {num(x.qualified)} of {num(x.reviews)}
                        </span>
                      ) : (
                        <Badge tone="good">qualified</Badge>
                      )}
                    </td>
                    <td>
                      <Num n={x.confirmedCorrect} tone="good" />
                    </td>
                    <td>
                      <Num n={x.falseApprovals} tone="bad" />
                    </td>
                    <td>
                      <Num n={x.falseRejections} tone="serious" />
                    </td>
                    <td>
                      <Num n={x.pending} />
                      {x.ledToRepair ? <div className="text-[11px] text-ink-3">{num(x.ledToRepair)} led to a repair</div> : null}
                    </td>
                    <td>
                      {x.requestsPerAcceptedTask === null ? <span className="text-ink-3">–</span> : x.requestsPerAcceptedTask.toFixed(1)}
                      <div className="text-[11px] text-ink-3">
                        {num(x.requests)} review request{x.requests === 1 ? "" : "s"} · {num(x.acceptedTasks)} accepted
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Scale size={22} />} title="No reviewer verdicts yet">
            Verdicts are recorded when a deep or strict result is reviewed, when a verdict is reused, and when an audit finishes.
          </EmptyState>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Contradicted verdicts" help="falseApproval" description="Verdicts that what happened afterwards contradicted. A contradicted verdict is never reused from the cache." />
          <VerdictList rows={o.contradicted} now={now} empty="Nothing has contradicted a verdict in this window." />
        </Card>
        <Card>
          <CardHeader title="Recent verdicts" description="The newest recorded verdicts and how they stand." />
          <VerdictList rows={o.recent.slice(0, 12)} now={now} empty="No verdicts recorded in this window." />
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Audits"
          help="audit"
          description={`A share of passed results (verification.audit_sample_rate, now ${Math.round(o.audits.sampleRate * 100)}%) gets a background review by another independent reviewer. Audits never block or change acceptance, use free models only, and are skipped while the package allocation is tight.`}
        />
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
          {Object.keys(o.audits.decisions).length ? (
            Object.entries(o.audits.decisions).map(([k, n]) => (
              <Badge key={k} tone={k === "sampled" ? "accent" : k.startsWith("skipped") ? "warn" : "neutral"}>
                {humanize(k)}: {num(n)}
              </Badge>
            ))
          ) : (
            <span className="text-sm text-ink-3">{o.audits.sampleRate > 0 ? "No result has been considered for an audit in this window." : "Audit sampling is off (verification.audit_sample_rate: 0)."}</span>
          )}
        </div>
        {o.audits.recent.length ? (
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Audited task</th>
                  <th>Decision</th>
                  <th>Auditor</th>
                  <th>Verdict</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {o.audits.recent.map((a) => (
                  <tr key={a.taskId}>
                    <td className="max-w-md">
                      <Link href={`/tasks/${a.taskId}`} className="font-mono text-xs text-accent-ink hover:underline">
                        {shortId(a.taskId)}
                      </Link>
                      <div className="truncate text-xs text-ink-3">{a.goal}</div>
                    </td>
                    <td>
                      {humanize(a.decision)}
                      {a.reason ? <div className="max-w-xs text-[11px] text-ink-3">{a.reason}</div> : null}
                      {a.auditTaskId ? (
                        <div className="text-[11px]">
                          <Link href={`/tasks/${a.auditTaskId}`} className="text-accent-ink hover:underline">
                            audit task {shortId(a.auditTaskId)}
                          </Link>{" "}
                          <span className="text-ink-3">({a.status})</span>
                        </div>
                      ) : null}
                    </td>
                    <td>{a.reviewer ? <Link href={modelHref(a.reviewer)} className="hover:underline">{a.reviewerName}</Link> : <span className="text-ink-3">–</span>}</td>
                    <td>{a.decision === "sampled" ? <VerdictBadge v={a.verdict} /> : <span className="text-ink-3">–</span>}</td>
                    <td className="whitespace-nowrap" title={dateTime(a.at)}>
                      {ago(a.at, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Model requests by purpose" description={`Every request in the window, by what it was for. Audits and qualification runs are their own tasks; the rest by the request's purpose. ${num(usageTotal)} in all.`} />
        {o.usage.length ? (
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>Requests</th>
                  <th>Share</th>
                  <th>Input tokens</th>
                  <th>Output tokens</th>
                  <th>Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {o.usage.map((u) => (
                  <tr key={u.purpose}>
                    <td>{humanize(u.purpose)}</td>
                    <td>{num(u.requests)}</td>
                    <td>{usageTotal ? pct(u.requests, usageTotal) : "–"}</td>
                    <td>{num(u.inputTokens)}</td>
                    <td>{num(u.outputTokens)}</td>
                    <td>{u.costUsd ? `$${u.costUsd.toFixed(4)}` : <span className="text-ink-3">free</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No model requests in this window" />
        )}
      </Card>
    </div>
  );
}

function VerdictList({ rows, now, empty }: { rows: VerdictView[]; now: number; empty: string }) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-line">
      {rows.map((v) => (
        <li key={v.id} className="px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge v={v.verdict} />
            <Badge tone={OUTCOME[v.outcome]?.tone ?? "neutral"}>{OUTCOME[v.outcome]?.label ?? humanize(v.outcome)}</Badge>
            {v.purpose === "audit" ? <Badge tone="accent">audit</Badge> : null}
            {v.cached ? <Badge>reused</Badge> : null}
            <span className="text-xs text-ink-3">
              {v.level} · {v.qualified ? "qualified" : "unqualified"} · {v.reviewer ? <Link href={modelHref(v.reviewer)} className="hover:underline">{v.reviewerName}</Link> : v.reviewerName}
            </span>
            <span className="ml-auto text-xs text-ink-3" title={dateTime(v.at)}>
              {ago(v.at, now)}
            </span>
          </div>
          <div className="mt-1 truncate">
            <Link href={`/tasks/${v.taskId}`} className="font-mono text-xs text-accent-ink hover:underline">
              {shortId(v.taskId)}
            </Link>{" "}
            <span className="text-ink-2">{v.goal}</span>
          </div>
          {v.reasons.length ? <div className="mt-0.5 text-xs text-ink-3">{v.reasons.join("; ")}</div> : null}
        </li>
      ))}
    </ul>
  );
}
