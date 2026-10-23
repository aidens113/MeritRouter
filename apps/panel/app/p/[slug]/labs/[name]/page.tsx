import Link from "next/link";

import { notFound } from "next/navigation";

import { insights } from "meritrouter";

import { getSy } from "@/lib/sy";

import { project } from "@/lib/project";

import { projectBase } from "@/lib/links";

import { SetupScreen } from "@/components/setup";

import { Badge, Card, CardHeader, Callout, Mono } from "@/components/ui";

import { PageHeader } from "@/components/page-header";

import { LabControls, LabLogViewer, LabPromotionDetail } from "@/components/client/labs";

import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Lab" };

export default async function LabPage({ params }: { params: Promise<{ slug: string; name: string }> }) {

  const r = getSy(); if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;

  const { slug, name } = await params; const p = project(r.sy, slug);

  let v: ReturnType<typeof insights.labDetailView>;

  try { v = insights.labDetailView(r.sy, p.slug, name); } catch (e) { if ((e as { code?: string }).code === "not_found") notFound(); throw e; }

  const s = v.status;

  return <div className="space-y-6">

    <PageHeader title={name} description={<span className="break-words">{s?.lab.goal || "No active runtime. Inspect the persisted supervisor operation below."}</span>} live={["labs"]} />

    <Link className="text-sm text-accent-ink hover:underline" href={`${projectBase(slug)}/labs`}>All labs</Link>

    {s ? <><Card><CardHeader title="Runtime" description="Controls queue work with the Labs supervisor; submitting an operation does not mean it completed." /><div className="space-y-4 p-4">

      <div className="flex flex-wrap gap-2" data-lab-state={s.lab.state}><Badge tone={s.lab.state === "running" ? "good" : s.lab.state === "failed" ? "bad" : s.lab.state === "starting" ? "warn" : "neutral"}>{s.lab.state}</Badge><span className="text-sm text-ink-3">{s.ownership === "other" ? "Owned by another live supervisor" : s.ownership === "local" ? "Owned by this supervisor" : "No active service owner"}</span></div>

      <LabControls project={slug} name={name} services={s.lab.serviceNames} checks={s.lab.checkNames} disabled={v.archived} />

      <div className="grid gap-3 sm:grid-cols-2">{s.services.map(service => <div key={service.name} className="rounded-lg border border-line p-3"><div className="flex justify-between gap-2"><span className="text-sm font-medium">{service.name}</span><Badge tone={service.state === "running" ? "good" : service.state === "failed" ? "bad" : ["starting", "backoff"].includes(service.state) ? "warn" : "neutral"}>{service.state}</Badge></div><p className="mt-1 text-xs text-ink-3">{service.pid ? `PID ${service.pid} · ` : ""}{service.restart_count} restarts</p>{s.urls[service.name] ? <a href={s.urls[service.name]} className="mt-2 block break-all text-xs text-accent-ink hover:underline" target="_blank" rel="noreferrer">{s.urls[service.name]}</a> : null}</div>)}</div>

      {!s.services.length ? <p className="text-sm text-ink-3">Services have not started. Start uses this lab's recipe snapshot.</p> : null}

    </div></Card>

    <Card><CardHeader title="Repositories and revisions" /><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Repository</th><th>Lab branch</th><th>Target</th><th>Current revision</th></tr></thead><tbody>{s.lab.repositories.map(repo => <tr key={repo.alias}><td>{repo.alias}</td><td><Mono>{repo.branch}</Mono></td><td><Mono>{repo.target}</Mono></td><td><Mono>{s.heads[repo.alias]?.slice(0, 12) ?? "unavailable"}</Mono></td></tr>)}</tbody></table></div></Card>

    <Card><CardHeader title="Checks" description="Results are tied to a repository revision. Promotion still checks whether that evidence is current." /><div className="space-y-3 p-4">{s.checks.length ? s.checks.map(check => <details key={check.id} className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm"><span className={check.exitCode === 0 && !check.killed ? "text-good-ink" : "text-bad-ink"}>{check.name}: {check.exitCode === 0 && !check.killed ? "passed" : "failed"}</span> <span className="text-xs text-ink-3">{check.revision.slice(0, 12)} · {dateTime(check.createdAt)}</span></summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{check.stdout}{check.stderr}{check.killed ? `\nStopped: ${check.killed}` : ""}</pre></details>) : <p className="text-sm text-ink-3">No checks run yet. Use a declared check above.</p>}</div></Card>

    <Card><CardHeader title="Service logs" /><div className="p-4"><LabLogViewer project={slug} name={name} services={s.lab.serviceNames} /></div></Card></> : <Callout title="No active runtime">Creation may still be in progress, or this lab was destroyed. Inspect the persisted operation below for its outcome.</Callout>}

    <Card><CardHeader title="Operations" description="Pending requests wait for the active owner. Failures remain here with a stable error code." /><div className="space-y-3 p-4">{v.operations.length ? v.operations.map(op => <div key={op.id} className="rounded-lg border border-line p-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{op.kind}</span><span className="flex flex-wrap gap-2"><Badge tone={op.state === "completed" ? "good" : op.state === "failed" ? "bad" : "warn"}>{op.state}</Badge>{op.promotionState ? <Badge tone={op.promotionState === "promoted" ? "good" : op.promotionState === "prepared" ? "warn" : "bad"}>Promotion: {op.promotionState}</Badge> : null}</span></div><p className="mt-1 break-all text-xs text-ink-3">{op.requestedBy} · {dateTime(op.createdAt)} · {op.id}</p>{op.promotionReason ? <p className="mt-2 text-sm text-ink-2">Review: {op.promotionReason}</p> : null}{op.outcomeMessage ? <p className="mt-2 text-sm text-bad-ink">{op.outcomeMessage}</p> : null}{op.kind === "promote" && op.state === "completed" ? <LabPromotionDetail project={slug} name={name} operationId={op.id} /> : null}{op.errorCode ? <p className="mt-2 break-words text-sm text-bad-ink">{op.errorCode}: {op.errorMessage}</p> : null}</div>) : <p className="text-sm text-ink-3">No queued operations.</p>}</div></Card>

  </div>;

}

