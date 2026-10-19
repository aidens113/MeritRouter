import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { purposeLabel, RequestsTable } from "@/components/requests-table";
import { Card, HelpTip, PageHeader, Stat } from "@/components/ui";
import { AutoRefresh } from "@/components/client/actions";
import { UrlFilters } from "@/components/client/url-filters";
import { compact, num, pct } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Requests" };

const LIMITS = ["50", "100", "200", "500"];

export default async function RequestsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const status = str("status");
  const endpoint = str("endpoint");
  const task = str("task").trim();
  const purpose = str("purpose");
  const tier = str("tier");
  const problems = str("problems");
  const limit = LIMITS.includes(str("limit")) ? Number(str("limit")) : 200;

  let rows = insights.requestLog(sy, { limit, ...(status ? { status } : {}), ...(endpoint ? { endpointId: endpoint } : {}), ...(task ? { taskId: task } : {}) });
  if (purpose) rows = rows.filter((x) => x.purpose === purpose);
  if (tier) rows = rows.filter((x) => x.tier === tier);
  if (problems === "yes") rows = rows.filter((x) => x.errorKind || x.policyViolation);
  const eps = sy.catalog.endpoints();
  const names = new Map(eps.map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const purposes = [...new Set(insights.requestLog(sy, { limit: 1000 }).map((x) => x.purpose))].sort();
  const ok = rows.filter((x) => x.status === "succeeded").length;
  const tokIn = rows.reduce((s, x) => s + (x.inputTokens ?? 0), 0);
  const tokOut = rows.reduce((s, x) => s + (x.outputTokens ?? 0), 0);
  const violations = rows.filter((x) => x.policyViolation).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Requests"
        description={
          <>
            Every physical model request admitted at SwitchYard&apos;s gate, newest first. A batched request answers several tasks at once and is counted once. <HelpTip term="requests" />
          </>
        }
        actions={<AutoRefresh seconds={8} />}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Requests shown" value={num(rows.length)} sub={`newest ${limit} matching the filters`} />
        <Stat label="Succeeded" value={rows.length ? pct(ok, rows.length) : "–"} sub={`${num(rows.length - ok)} failed or uncertain`} />
        <Stat label="Tokens" value={compact(tokIn + tokOut)} sub={`${compact(tokIn)} in · ${compact(tokOut)} out`} />
        <Stat label="Policy violations" value={num(violations)} tone={violations ? "bad" : undefined} sub="served by a different model than routed" />
      </div>
      <Card>
        <div className="border-b border-line px-4 py-3">
          <UrlFilters
            values={{ status, endpoint, purpose, tier, problems, task, limit: str("limit") }}
            fields={[
              { name: "status", label: "Status", kind: "select", options: [["succeeded", "Succeeded"], ["failed", "Failed"], ["uncertain", "Uncertain"], ["reserved", "In flight"]] },
              { name: "endpoint", label: "Model", kind: "select", options: eps.map((e) => [e.id, e.displayName ?? e.gatewayModelId] as [string, string]) },
              { name: "purpose", label: "Purpose", kind: "select", options: purposes.map((p) => [p, purposeLabel(p)] as [string, string]) },
              { name: "tier", label: "Tier", kind: "select", options: ["T1", "T2", "T3"].map((t) => [t, t] as [string, string]) },
              { name: "problems", label: "Problems", kind: "select", options: [["yes", "Errors or violations only"]], anyLabel: "All requests" },
              { name: "limit", label: "Show", kind: "select", options: LIMITS.filter((l) => l !== "200").map((l) => [l, `${l} rows`] as [string, string]), anyLabel: "200 rows" },
              { name: "task", label: "Task id", kind: "text", placeholder: "t_…" },
            ]}
          />
        </div>
        <RequestsTable rows={rows} names={names} empty="No requests match these filters" />
      </Card>
    </div>
  );
}
