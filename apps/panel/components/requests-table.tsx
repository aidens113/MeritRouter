import Link from "next/link";
import { Globe, ShieldAlert } from "lucide-react";
import type { insights } from "switchyard-router";
import { RequestStatusBadge, TierBadge } from "./task-badges";
import { Badge, EmptyState } from "./ui";
import { dateTime, duration, humanize, modelHref, num, pct, shortDateTime, shortId } from "@/lib/format";
import { itemBase, projectBase, QUALIFICATION_BASE, QUALIFICATION_SLUG, requestHref, taskHref, jobHref } from "@/lib/links";

export type RequestRow = ReturnType<typeof insights.requestLog>[number];

const PURPOSE: Record<string, string> = {
  completion: "Answer",
  completion_repair: "Answer (repair)",
  batch: "Batched answers",
  tool_loop: "Repository investigation",
  classification: "Difficulty classifier",
  runner: "Coding agent",
};

export function purposeLabel(p: string): string {
  return PURPOSE[p] ?? humanize(p);
}

type Pricing = { inputUsdPerMillion: number | null; cachedInputUsdPerMillion?: number | null | undefined };

/**
 * What the provider's prompt cache saved on these requests: each request's cached input tokens
 * times the difference between its model's input and cached-input prices. `known` is false when
 * no request with cached tokens has a model with a cached price (nothing is guessed).
 */
export function cacheSaving(rows: Pick<RequestRow, "endpointId" | "cachedInputTokens">[], pricing: Map<string, Pricing>): { usd: number; known: boolean } {
  let usd = 0;
  let known = false;
  for (const r of rows) {
    const p = r.endpointId ? pricing.get(r.endpointId) : undefined;
    if (r.cachedInputTokens === null || !p || p.inputUsdPerMillion === null || p.cachedInputUsdPerMillion === null || p.cachedInputUsdPerMillion === undefined) continue;
    usd += (r.cachedInputTokens * Math.max(0, p.inputUsdPerMillion - p.cachedInputUsdPerMillion)) / 1_000_000;
    known = true;
  }
  return { usd, known };
}

/**
 * `base` is the project path (`/p/<slug>`) task links start from; without it (a view across
 * projects) each row links into its own project, and qualification work to /all/qualification.
 */
/** The provider's own web search in this request: searches run and the sources it cited (untrusted links). */
function WebSearchLine({ row }: { row: RequestRow }) {
  const cites = row.webCitations;
  return (
    <div className="mt-1 max-w-[16rem] text-[11px] text-ink-3" title={`Native web search: ${row.nativeWebSearch}. Cited sources are untrusted web content.`}>
      <span className="inline-flex items-center gap-1 text-ink-2">
        <Globe size={11} aria-hidden /> {num(row.webSearchRequests)} search{row.webSearchRequests === 1 ? "" : "es"}
        {cites.length ? ` · ${cites.length} source${cites.length === 1 ? "" : "s"}` : ""}
      </span>
      {cites.slice(0, 3).map((c, i) => (
        <a key={i} href={c.url} target="_blank" rel="noreferrer noopener nofollow" className="block truncate hover:underline">
          {c.title ?? c.url}
        </a>
      ))}
    </div>
  );
}

export function RequestsTable({ rows, names, base, hideModel = false, empty }: { rows: RequestRow[]; names: Map<string, string>; base?: string; hideModel?: boolean; empty?: string }) {
  if (!rows.length) return <EmptyState title={empty ?? "No requests recorded"}>Requests appear here as workers call models through the gate.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="data-table tabular">
        <thead>
          <tr>
            <th>Time</th>
            <th>Purpose</th>
            <th>Tier</th>
            {hideModel ? null : <th>Model</th>}
            <th>Status</th>
            <th className="text-right" title="Upstream provider attempts reported by the gateway (never exact)">
              Attempts
            </th>
            <th className="text-right" title="Every input token the provider read, cached ones included">
              Tokens in
            </th>
            <th className="text-right">Out</th>
            <th className="text-right" title="Of the input, how much the provider served from its prompt cache (and its share of the input)">
              Cached
            </th>
            <th>Error / policy</th>
            {base === undefined ? <th>Project</th> : null}
            <th>Tasks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">
                <Link href={requestHref(r.project && r.project !== QUALIFICATION_SLUG ? projectBase(r.project) : "", r.id)} className="text-accent-ink hover:underline" title={`${dateTime(r.reservedAt)}: open request ${r.id}`}>
                  {shortDateTime(r.reservedAt)}
                </Link>
                <div className="text-[11px] text-ink-3">{r.finishedAt ? duration(r.finishedAt - r.reservedAt) : "in flight"}</div>
              </td>
              <td className="whitespace-nowrap">{purposeLabel(r.purpose)}</td>
              <td>
                <TierBadge tier={r.tier} />
              </td>
              {hideModel ? null : (
                <td className="min-w-[9rem] max-w-[16rem]">
                  {r.endpointId ? (
                    <Link href={modelHref(r.endpointId)} className="text-ink hover:text-accent-ink hover:underline">
                      {names.get(r.endpointId) ?? r.endpointId}
                    </Link>
                  ) : (
                    <span className="text-ink-3">none</span>
                  )}
                  {r.servedModel && r.endpointId && !r.endpointId.endsWith(`/${r.servedModel}`) ? <div className="text-[11px] text-bad-ink">served by {r.servedModel}</div> : null}
                  {r.routeNote ? <div className="text-[11px] text-ink-3">{r.routeNote}</div> : null}
                </td>
              )}
              <td>
                <RequestStatusBadge status={r.status} />
                {r.nativeWebSearch ? <WebSearchLine row={r} /> : null}
              </td>
              <td className="text-right">{num(r.providerAttempts)}</td>
              <td className="text-right">{num(r.inputTokens)}</td>
              <td className="text-right">{num(r.outputTokens)}</td>
              <td className="text-right">
                {r.cachedInputTokens === null ? <span className="text-ink-3">Unknown</span> : num(r.cachedInputTokens)}
                {r.cachedInputTokens && r.inputTokens ? <div className="text-[11px] text-ink-3">{pct(r.cachedInputTokens, r.inputTokens)}</div> : null}
              </td>
              <td className="min-w-[8rem] max-w-[18rem]">
                {r.policyViolation ? (
                  <Badge tone="bad" icon={<ShieldAlert size={11} aria-hidden />} title={r.policyViolation}>
                    Policy violation
                  </Badge>
                ) : null}
                {r.errorKind ? (
                  <div className="text-xs">
                    <span className="font-medium text-bad-ink">{humanize(r.errorKind)}</span>
                    {r.errorMessage ? <span className="text-ink-3"> · {r.errorMessage.slice(0, 160)}</span> : null}
                  </div>
                ) : null}
                {r.policyViolation ? <div className="mt-0.5 text-[11px] text-ink-3">{r.policyViolation.slice(0, 200)}</div> : null}
                {!r.errorKind && !r.policyViolation ? <span className="text-ink-3">–</span> : null}
              </td>
              {base === undefined ? (
                <td className="whitespace-nowrap">
                  {r.project === QUALIFICATION_SLUG ? (
                    <Link href={QUALIFICATION_BASE} className="text-xs text-accent-ink hover:underline" title="Qualification runs and eval comparisons (not a project)">
                      qualification
                    </Link>
                  ) : r.project ? (
                    <Link href={itemBase(r.project)} className="font-mono text-xs text-accent-ink hover:underline">
                      {r.project}
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-3" title="Charged to no task: a scan, probe, or qualification request">
                      install
                    </span>
                  )}
                </td>
              ) : null}
              <td className="whitespace-nowrap">
                {r.taskIds.length > 2 ? (
                  <span title={r.taskIds.join(", ")}>
                    <Badge tone="accent">batch of {r.taskIds.length}</Badge>
                  </span>
                ) : null}
                <div className="flex flex-col">
                  {r.taskIds.slice(0, r.taskIds.length > 2 ? 0 : 2).map((t) => (
                    <Link key={t} href={(r.taskRefs?.find(ref => ref.id === t)?.job ? jobHref : taskHref)(base ?? (r.project ? itemBase(r.project) : ""), t)} className="font-mono text-xs text-accent-ink hover:underline">
                      {r.taskRefs?.find(ref => ref.id === t)?.job ? "Job: " : "Task: "}{r.taskRefs?.find(ref => ref.id === t)?.label ?? shortId(t, 14)}
                    </Link>
                  ))}
                  {r.taskIds.length > 2 ? (
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {r.taskIds.map((t) => (
                        <Link key={t} href={(r.taskRefs?.find(ref => ref.id === t)?.job ? jobHref : taskHref)(base ?? (r.project ? itemBase(r.project) : ""), t)} className="font-mono text-[11px] text-accent-ink hover:underline">
                          {r.taskRefs?.find(ref => ref.id === t)?.job ? "Job: " : "Task: "}{r.taskRefs?.find(ref => ref.id === t)?.label ?? shortId(t, 8)}
                        </Link>
                      ))}
                    </span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
