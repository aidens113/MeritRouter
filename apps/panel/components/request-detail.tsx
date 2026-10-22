import Link from "next/link";
import { notFound } from "next/navigation";
import { insights, type Switchyard } from "switchyard-router";
import { itemBase, sessionHref, QUALIFICATION_SLUG } from "@/lib/links";
import { dateTime, duration } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { AgentLink, TaskLink, ModelLink } from "@/components/entity-links";
import { RelatedPanel } from "@/components/related";
import { Disclosure } from "@/components/disclosure";
import { Card, KeyValue, Badge, Callout } from "@/components/ui";

export function RequestDetailView({ sy, slug, id, name }: { sy: Switchyard; slug: string; id: string; name: string }) {
  const q = insights.requestDetail(sy, id);
  if (!q || q.project !== slug) notFound();
  const base = slug ? itemBase(slug) : "";
  return <div className="space-y-4">
    <PageHeader title="Model request" description={q.id} meta={<Badge>{q.status}</Badge>} live={["requests"]} back={{ href: !slug ? "/all/requests" : slug === QUALIFICATION_SLUG ? base : `${base}/requests`, label: slug === QUALIFICATION_SLUG ? "Qualification" : "Requests" }} />
    {q.errorMessage && <Callout tone="bad" title={q.errorKind ?? "Request failed"}>{q.errorMessage}</Callout>}
    <Card><div className="p-4"><KeyValue items={[
      ["Purpose", q.purpose], ["Model", q.endpointId ? <ModelLink id={q.endpointId} name={q.servedModel} /> : q.servedModel ?? "Unknown"],
      ["Provider", q.servedProvider ?? "Unknown"], ["Reserved", dateTime(q.reservedAt)], ["Finished", dateTime(q.finishedAt)], ["Latency", q.finishedAt === null ? "Pending" : duration(q.finishedAt - q.reservedAt)],
      ["Tokens in / out", `${q.inputTokens ?? "Unknown"} / ${q.outputTokens ?? "Unknown"}`], ["Cached / reasoning", `${q.cachedInputTokens ?? "Unknown"} / ${q.reasoningTokens ?? "Unknown"}`],
      ["Cost", q.costUsd === null ? "Unknown" : `$${q.costUsd.toFixed(6)}`], ["Paid", q.paidUsd === null ? "-" : `$${q.paidUsd.toFixed(6)}`], ["Attempts", `${q.attempts ?? "Unknown"}${q.attemptsExact === false ? " (estimated)" : ""}`],
      ["Tier", q.tier ?? "-"], ["HTTP status", q.httpStatus ?? "-"], ["Policy", q.policyViolation ?? "-"], ["Route", q.routeNote ?? "-"], ["Web search", `${q.nativeWebSearch ?? "-"} (${q.webSearchRequests ?? 0} requests)`],
    ]} /></div></Card>
    <RelatedPanel groups={[
      { label: "Project", items: [{ key: slug, node: <Link href={base || "/all"}>{name}</Link> }] },
      { label: "Tasks charged", items: q.tasks.map(t => ({ key: t.taskId, node: <TaskLink base={itemBase(t.project)} id={t.taskId} label={t.label} /> })) },
      { label: "Sessions", items: q.sessions.map(s => ({ key: s.sessionId, node: <Link href={sessionHref(base, s.sessionId)}>{s.sessionId}</Link> })) },
      { label: "Agents", items: [...new Set(q.sessions.map(s => s.agent))].map(a => ({ key: a, node: <AgentLink base={base} agent={a} /> })) },
    ]} />
    {q.webCitations.length > 0 && <Disclosure summary="Cited sources" meta={q.webCitations.length}><ul className="space-y-3 text-sm">{q.webCitations.map((c, i) => <li key={`${c.url}:${i}`}>{/^https?:\/\//i.test(c.url) ? <a className="break-all text-accent-ink hover:underline" href={c.url} target="_blank" rel="noopener noreferrer">{c.title ?? c.url}</a> : <span className="break-all">{c.title ?? c.url}</span>}{c.text && <p className="mt-1 whitespace-pre-wrap text-ink-3">{c.text}</p>}</li>)}</ul></Disclosure>}
    <Disclosure summary="Usage accounting"><KeyValue items={[["Basis", q.usageBasis ?? "Unknown"], ["Estimated input", q.estInputTokens], ["Reserved output", q.reservedOutputTokens], ["Cache hit", q.cacheHit === null ? "Unknown" : String(q.cacheHit)], ["Execution", q.executionId]]} /><ul className="mt-3 space-y-1 text-sm">{q.charges.map(c => <li key={c.taskId}><TaskLink base="" id={c.taskId} />: {c.inputTokens} input / {c.outputTokens} output ({c.exact ? "exact" : "estimated"})</li>)}</ul></Disclosure>
  </div>;
}
