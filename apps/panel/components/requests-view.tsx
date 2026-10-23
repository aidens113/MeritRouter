import Link from "next/link";
import type { MeritRouter } from "meritrouter";
import { insights } from "meritrouter";
import { cacheSaving, purposeLabel, RequestsTable } from "@/components/requests-table";
import { Card, HelpTip, Stat } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { UrlFilters } from "@/components/client/url-filters";
import { compact, num, pct } from "@/lib/format";
import { jobHref, projectBase } from "@/lib/links";

const LIMITS = ["50", "100", "200", "500"];

/**
 * The request log with its filters: one project's requests (`project`), or every project's (the
 * install-wide page, `project` null, which also shows requests charged to no task).
 */
export function RequestsView({ sy, project, sp }: { sy: MeritRouter; project: { slug: string; name: string } | null; sp: Record<string, string | string[] | undefined> }) {
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const status = str("status");
  const endpoint = str("endpoint");
  const task = str("task").trim();
  const job = str("job").trim();
  const page = Math.max(1, Math.min(10000, Math.floor(Number(str("page"))) || 1));
  const purpose = str("purpose");
  const tier = str("tier");
  const problems = str("problems");
  const limit = LIMITS.includes(str("limit")) ? Number(str("limit")) : 200;
  const scope = project ? { project: project.slug } : {};

  const filters = { ...scope, ...(status ? { status } : {}), ...(endpoint ? { endpointId: endpoint } : {}), ...(task ? { taskId: task } : {}), ...(job ? { jobId: job } : {}), ...(purpose ? { purpose } : {}), ...(tier ? { tier } : {}), ...(problems === "yes" ? { problems: true } : {}) };
  const total = insights.requestLogCount(sy, filters);
  const rows = insights.requestLog(sy, { ...filters, limit, offset: (page - 1) * limit });
  const scopedJob = job ? insights.jobDetail(sy, job, { transcript: false }) : null;
  const visibleJob = scopedJob && (!project || scopedJob.project === project.slug) ? scopedJob : null;
  const pageHref = (next: number) => {
    const query = new URLSearchParams(Object.entries(sp).flatMap(([key, value]) => typeof value === "string" && key !== "page" ? [[key, value]] : []));
    query.set("page", String(next));
    return `?${query}`;
  };
  const eps = sy.catalog.endpoints();
  const names = new Map(eps.map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const purposes = [...new Set(insights.requestLog(sy, { limit: 1000, ...scope }).map((x) => x.purpose))].sort();
  const ok = rows.filter((x) => x.status === "succeeded").length;
  const tokIn = rows.reduce((s, x) => s + (x.inputTokens ?? 0), 0);
  // Cached input was read again from the provider's prompt cache: it is not new work.
  const tokCached = rows.reduce((s, x) => s + (x.cachedInputTokens ?? 0), 0);
  const unknownCache = rows.filter(x => x.cachedInputTokens === null).length;
  const cacheKnown = unknownCache === 0;
  const tokOut = rows.reduce((s, x) => s + (x.outputTokens ?? 0), 0);
  const saving = cacheSaving(rows, new Map(eps.map((e) => [e.id, e.pricing])));
  const violations = rows.filter((x) => x.policyViolation).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Requests"
        description={
          <>
            {project ? `Every physical model request this project's tasks made at MeritRouter's gate, newest first.` : "Every physical model request admitted at MeritRouter's gate, from every project (and requests charged to no task, such as scans and probes), newest first."} A batched request answers several tasks at once and is counted once. <HelpTip term="requests" />
          </>
        }
        live={["requests"]}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Requests shown" value={num(rows.length)} sub={`${num(total)} matching | page ${page}`} />
        <Stat label="Succeeded" value={rows.length ? pct(ok, rows.length) : "–"} sub={`${num(rows.length - ok)} failed or uncertain`} />
        <Stat label="New tokens" value={cacheKnown ? compact(tokIn - tokCached + tokOut) : "Unknown"} sub={cacheKnown ? `${compact(tokIn - tokCached)} in | ${compact(tokOut)} out | ${compact(tokCached)} cached` : `${unknownCache} requests have unknown cache usage | ${compact(tokIn + tokOut)} total reported tokens`} />
        <Stat label="Prompt cache" value={cacheKnown && tokIn ? pct(tokCached, tokIn) : cacheKnown ? "0" : "Unknown"} sub={`${compact(tokCached)} known cached tokens${unknownCache ? ` | ${unknownCache} unknown requests` : ""} | ${saving.known ? `known savings $${saving.usd.toFixed(4)}` : "saving unknown (no cached price)"}`} />
        <Stat label="Policy violations" value={num(violations)} tone={violations ? "bad" : undefined} sub="served by a different model than routed" />
      </div>
      {visibleJob ? <p className="text-sm text-ink-2">Requests for <Link href={jobHref(projectBase(visibleJob.project), visibleJob.taskId)} className="text-accent-ink hover:underline">{visibleJob.label ?? visibleJob.taskId}</Link> and all its descendant tasks and sub-jobs.</p> : null}
      <Card>
        <div className="border-b border-line px-4 py-3">
          <UrlFilters
            values={{ status, endpoint, purpose, tier, problems, task, job, limit: str("limit") }}
            fields={[
              { name: "status", label: "Status", kind: "select", options: [["succeeded", "Succeeded"], ["failed", "Failed"], ["uncertain", "Uncertain"], ["reserved", "In flight"]] },
              { name: "endpoint", label: "Model", kind: "select", options: eps.map((e) => [e.id, e.displayName ?? e.gatewayModelId] as [string, string]) },
              { name: "purpose", label: "Purpose", kind: "select", options: purposes.map((p) => [p, purposeLabel(p)] as [string, string]) },
              { name: "tier", label: "Tier", kind: "select", options: ["T1", "T2", "T3"].map((t) => [t, t] as [string, string]) },
              { name: "problems", label: "Problems", kind: "select", options: [["yes", "Errors or violations only"]], anyLabel: "All requests" },
              { name: "limit", label: "Show", kind: "select", options: LIMITS.filter((l) => l !== "200").map((l) => [l, `${l} rows`] as [string, string]), anyLabel: "200 rows" },
              { name: "job", label: "Job id (including descendants)", kind: "text", placeholder: "job_..." },
              { name: "task", label: "Task id", kind: "text", placeholder: "t_…" },
            ]}
          />
        </div>
        <RequestsTable rows={rows} names={names} {...(project ? { base: projectBase(project.slug) } : {})} empty="No requests match these filters" />
      </Card>
      <nav aria-label="Request pages" className="flex items-center justify-between text-sm">
        {page > 1 ? <Link href={pageHref(page - 1)} className="text-accent-ink hover:underline">Previous page</Link> : <span />}
        <span className="text-ink-3">{total ? `${Math.min((page - 1) * limit + 1, total)}-${Math.min(page * limit, total)} of ${total}` : "No matching requests"}</span>
        {page * limit < total ? <Link href={pageHref(page + 1)} className="text-accent-ink hover:underline">Next page</Link> : <span />}
      </nav>
    </div>
  );
}
