import Link from "next/link";

import { FlaskConical } from "lucide-react";

import { insights } from "meritrouter";

import { getSy } from "@/lib/sy";

import { project } from "@/lib/project";

import { projectBase } from "@/lib/links";

import { SetupScreen } from "@/components/setup";

import { Badge, Card, CardHeader, Callout, EmptyState } from "@/components/ui";

import { PageHeader } from "@/components/page-header";

import { CreateLabForm } from "@/components/client/labs";

import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Labs" };

export default async function LabsPage({ params }: { params: Promise<{ slug: string }> }) {

  const r = getSy(); if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;

  const p = project(r.sy, (await params).slug);

  const v = insights.labsListView(r.sy, p.slug);

  const base = `${projectBase(p.slug)}/labs`;

  return <div className="space-y-6">

    <PageHeader title="Labs" description="Run and check changes in isolated branches, data and ports before promoting them to your project." live={["labs"]} />

    {!v.configured ? <Callout tone="warn" title="Configure this project's lab recipe first">Declare services and checks in <Link className="text-accent-ink hover:underline" href={`${projectBase(p.slug)}/settings?tab=labs`}>Project settings / Labs</Link>. Commands run only after an explicit action.</Callout> : null}

    <Card><CardHeader title="Create a lab" description="A lab keeps its recipe snapshot, branches and data until you destroy it." /><div className="p-4"><CreateLabForm project={p.slug} configured={v.configured} /></div></Card>

    <div className="grid gap-4 lg:grid-cols-2">

      {v.labs.map(l => <Card key={l.name}><div className="space-y-3 p-4">

        <div className="flex items-center justify-between gap-2"><Link href={`${base}/${encodeURIComponent(l.name)}`} className="min-w-0 break-all text-base font-semibold text-accent-ink hover:underline">{l.name}</Link><Badge tone={l.status?.lab.state === "running" ? "good" : l.status?.lab.state === "failed" ? "bad" : !l.status || ["creating", "starting"].includes(l.status.lab.state) ? "warn" : "neutral"}>{l.status?.lab.state ?? "queued"}</Badge></div>

        <p className="break-words text-sm text-ink-2">{l.status?.lab.goal || "Creation is queued with the Labs supervisor."}</p>

        <p className="text-xs text-ink-3">{l.status ? `${l.status.services.filter(s => s.state === "running").length} services running · ${l.status.lab.checkNames.length} declared checks · updated ${ago(l.status.lab.updatedAt)}` : "No service has started."}</p>

        {l.operations.filter(o => o.state === "pending" || o.state === "running").map(o => <p key={o.id} className="text-xs text-ink-2">{o.kind}: {o.state === "pending" ? "queued; waiting for its supervisor" : "in progress"}</p>)}

        {l.operations[0]?.state === "failed" ? <p className="text-sm text-bad-ink">{l.operations[0].errorMessage}</p> : null}

      </div></Card>)}

    </div>

    {!v.labs.length ? <Card><EmptyState icon={<FlaskConical size={24} />} title="No labs yet">Create one to test a change with its own branches and runtime.</EmptyState></Card> : null}

  </div>;

}
