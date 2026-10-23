import Link from "next/link";
import { insights, type MeritRouter } from "meritrouter";
import { Card, CardHeader, Stat } from "@/components/ui";
import { StackedBars, StackedColumns, type Series } from "@/components/client/charts";
import { compact, num, pct } from "@/lib/format";
import { USAGE_RANGES, usageBuckets, usageRange } from "@/lib/usage-range";

/** One rolling range drives every usage number and graph, globally or in a project. */
export function UsageOverview({ sy, path, project, searchParams }: {
  sy: MeritRouter; path: string; project?: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const range = usageRange(searchParams.range);
  const now = Date.now();
  const points = insights.timeseries(sy, { hours: range.hours, bucketMinutes: range.bucketMinutes, project });
  const tiers = insights.tierDistribution(sy, now - range.hours * 3_600_000, project);
  const buckets = usageBuckets(now, range.hours, range.bucketMinutes);
  const step = range.bucketMinutes * 60_000;
  const totals = points.reduce((sum, point) => ({ requests: sum.requests + point.requests, failed: sum.failed + point.failed, input: sum.input + point.inputTokens, output: sum.output + point.outputTokens }), { requests: 0, failed: 0, input: 0, output: 0 });
  const slots = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];
  const names = new Map(sy.catalog.endpoints().map(endpoint => [endpoint.id, endpoint.displayName ?? endpoint.gatewayModelId]));
  const counts = new Map<string, number>();
  const byBucket = new Map<number, typeof points>();
  for (const point of points) {
    counts.set(point.endpointId, (counts.get(point.endpointId) ?? 0) + point.requests);
    const bucket = Math.floor(point.bucketStart / step) * step;
    const group = byBucket.get(bucket) ?? [];
    group.push(point);
    byBucket.set(bucket, group);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
  const requestSeries: Series[] = top.map((id, index) => ({ key: id, label: id === "(none)" ? "No model (before dispatch)" : names.get(id) ?? id, color: slots[index]!, values: buckets.map(bucket => (byBucket.get(bucket) ?? []).filter(point => point.endpointId === id).reduce((sum, point) => sum + point.requests, 0)) }));
  if (counts.size > top.length) requestSeries.push({ key: "__other", label: "Other models", color: "var(--series-other)", values: buckets.map(bucket => (byBucket.get(bucket) ?? []).filter(point => !top.includes(point.endpointId)).reduce((sum, point) => sum + point.requests, 0)) });
  const tokenSeries: Series[] = [
    { key: "input", label: "Input (including cached)", color: slots[0]!, values: buckets.map(bucket => (byBucket.get(bucket) ?? []).reduce((sum, point) => sum + point.inputTokens, 0)) },
    { key: "output", label: "Output", color: slots[1]!, values: buckets.map(bucket => (byBucket.get(bucket) ?? []).reduce((sum, point) => sum + point.outputTokens, 0)) },
  ];
  const tierRows = ["T1", "T2", "T3", "T4", "unclassified"].map(tier => tiers.find(row => row.tier === tier) ?? { tier, tasks: 0, completed: 0 });
  const href = (id: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "range" || key === "tab") continue;
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
    }
    query.set("range", id);
    return `${path}?${query}`;
  };
  return <section aria-label="Usage overview" className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-ink">Usage - {range.label.toLowerCase()}</h2>
      <nav aria-label="Usage time range" className="flex flex-wrap gap-1 rounded-lg border border-line p-1">
        {USAGE_RANGES.map(option => <Link key={option.id} href={href(option.id)} scroll={false} aria-current={option.id === range.id ? "true" : undefined} className={`rounded-md px-3 py-1.5 text-xs font-medium ${option.id === range.id ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-2"}`}>{option.label}</Link>)}
      </nav>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Reported tokens" value={`~${compact(totals.input + totals.output)}`} sub={`${compact(totals.input)} input / ${compact(totals.output)} output; cached input included`} />
      <Stat label="Model requests" value={compact(totals.requests)} sub={range.label} />
      <Stat label="Successful requests" value={totals.requests ? pct(totals.requests - totals.failed, totals.requests) : "-"} sub={`${num(totals.failed)} not succeeded (failed, pending or uncertain)`} />
      <Stat label="Tasks submitted" value={compact(tiers.reduce((sum, tier) => sum + tier.tasks, 0))} sub={range.label} />
    </div>
    <p className="text-xs text-ink-3">Rolling window; first and current buckets can be partial. Times use your browser's local time. Reported tokens may be incomplete when a provider omits usage.</p>
    <Card><CardHeader title={`Tokens - ${range.label.toLowerCase()}`} description="Reported input and output, including cached input." actions={<Link href={`${path}/requests`} className="text-xs text-accent-ink hover:underline">Request log</Link>} /><div className="p-4"><StackedColumns buckets={buckets} series={tokenSeries} bucketMinutes={range.bucketMinutes} unit="tokens" />{!totals.requests ? <p className="mt-2 text-xs text-ink-3">No requests in this time range. Choose a longer range to see older usage.</p> : null}</div></Card>
    <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
      <Card><CardHeader title={`Requests - ${range.label.toLowerCase()}`} description="Physical model requests, stacked by targeted model." help="requests" /><div className="p-4"><StackedColumns buckets={buckets} series={requestSeries} bucketMinutes={range.bucketMinutes} /></div></Card>
      <Card><CardHeader title={`Tasks by tier - ${range.label.toLowerCase()}`} description="Tasks submitted during the selected range, grouped by current outcome." help="tier" /><div className="p-4"><StackedBars rows={tierRows.map(tier => ({ key: tier.tier, label: tier.tier === "unclassified" ? "Unscored" : tier.tier }))} series={[{ key: "completed", label: "Completed", color: slots[0]!, values: tierRows.map(tier => tier.completed) }, { key: "other", label: "Not completed", color: "var(--series-other)", values: tierRows.map(tier => tier.tasks - tier.completed) }]} /></div></Card>
    </div>
  </section>;
}
