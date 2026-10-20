import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Radar, ShieldAlert } from "lucide-react";
import { insights, MODALITIES, TIER_NAMES } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { isFree, keyedProviders, reachable, type ModelView } from "@/lib/models";
import { SetupScreen } from "@/components/setup";
import { Modalities, ProvenanceBadge, StatusBadge, statusKey } from "@/components/model-badges";
import { RequestsTable } from "@/components/requests-table";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, KeyValue, Mono, PageHeader, Stat } from "@/components/ui";
import { ActionButton } from "@/components/client/actions";
import { OverrideEditor } from "@/components/client/override-editor";
import { ago, compact, dateTime, duration, num, params, pct, tokens } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Model" };

export default async function ModelDetailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const id = typeof sp.id === "string" ? sp.id : "";
  const view = insights.modelsView(sy).find((v) => v.endpoint.id === id);
  if (!view) notFound();

  const ep = view.endpoint;
  const st = statusKey(ep, view.quarantined);
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const recent = insights.requestLog(sy, { endpointId: ep.id, limit: 15 });
  const s = view.stats7d;
  const profiles = Object.keys(sy.cfg.profiles);

  return (
    <div className="space-y-6">
      <Link href="/models" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> All models
      </Link>
      <PageHeader
        title={ep.displayName ?? ep.gatewayModelId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={st} />
            {view.override ? <Badge tone="accent">Overrides active</Badge> : null}
            <Badge>{ep.providerId}</Badge>
            <Mono>{ep.id}</Mono>
          </span>
        }
        actions={
          <ActionButton url="/api/scan" success="Scan finished">
            <Radar size={14} aria-hidden /> Scan now
          </ActionButton>
        }
      />

      <Callout tone={st === "active" && view.eligibility.some((c) => c.eligible) ? "good" : st === "quarantined" ? "bad" : "warn"} icon={st === "quarantined" ? <ShieldAlert size={16} /> : undefined} title={view.headline}>
        {ep.statusReason && st !== "active" && !view.headline.includes(ep.statusReason) ? <>Status: {ep.statusReason}. </> : null}
        {ep.notes ? <>Note: {ep.notes}</> : null}
      </Callout>

      <Card>
        <CardHeader title="Why is or isn't this model used?" help="eligibility" description="Each cell is one task type at one tier, with text-only input. A number is the model's position in the candidate list; red cells list what excludes it." />
        <div className="overflow-x-auto p-4">
          <EligibilityGrid view={view} profiles={profiles} />
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Requests (7 days)" value={num(s.requests)} sub={s.requests ? `${pct(s.succeeded, s.requests)} succeeded · ${s.failed} failed · ${s.uncertain} uncertain` : "Not used this week"} />
        <Stat label="Tokens (7 days)" value={compact(s.inputTokens + s.outputTokens)} sub={`${compact(s.inputTokens)} in · ${compact(s.outputTokens)} out`} />
        <Stat label="Average latency" value={s.avgLatencyMs === null ? "–" : duration(s.avgLatencyMs)} sub={s.lastUsedAt ? `last used ${ago(s.lastUsedAt)}` : "never used"} />
        <Stat label="Task outcomes (7 days)" value={`${s.tasksCompleted} completed`} sub={`${s.tasksFailed} failed${s.policyViolations ? ` · ${s.policyViolations} policy violation(s)` : ""}`} tone={s.policyViolations ? "bad" : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title="Facts" description={`Origin: ${ep.origin === "manual" ? "models file (manual entry)" : "discovered by scan"} · metadata checked ${ago(Date.parse(ep.checkedAt))}`} />
          <div className="p-4">
            <KeyValue
              items={[
                [
                  "Size",
                  <span key="s" className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{params(ep.totalParametersB)}</span>
                    {ep.activeParametersB ? <span className="text-ink-2">({params(ep.activeParametersB)} active, mixture of experts)</span> : null}
                    <ProvenanceBadge params={ep.params} />
                    <HelpTip term="provenance" />
                  </span>,
                ],
                ["Reads", <Modalities key="m" list={ep.inputModalities} showLabels />],
                ["Context limit", `${tokens(ep.contextLimitTokens)} tokens`],
                [
                  "Output limit",
                  <span key="o">
                    {tokens(ep.outputLimitTokens)} tokens{" "}
                    <Badge tone={ep.outputLimitSource === "default" ? "warn" : "neutral"} title={ep.outputLimitSource === "default" ? "No provider reported it: the value was assumed. Set the real limit in an override." : undefined}>
                      {ep.outputLimitSource}
                    </Badge>
                  </span>,
                ],
                ["Tool calling", ep.supportsTools === null ? "Unknown (cannot do repository work until set)" : ep.supportsTools ? "Yes" : "No (cannot do repository work)"],
                ["Structured output", ep.supportsStructuredOutput === null ? "Unknown" : ep.supportsStructuredOutput ? "Yes" : "No"],
                [
                  "Price",
                  <span key="p" className="flex flex-wrap items-center gap-2">
                    {isFree(ep) ? <Badge tone="good">Free (verified)</Badge> : <Badge tone="bad">Not verified free</Badge>}
                    <span className="text-xs text-ink-3">
                      source: {ep.pricing.source}
                      {ep.pricing.inputUsdPerMillion !== null ? ` · $${ep.pricing.inputUsdPerMillion}/M in, $${ep.pricing.outputUsdPerMillion ?? "?"}/M out` : ""}
                    </span>
                  </span>,
                ],
                [
                  "Rate limits",
                  ep.rateLimits && Object.values(ep.rateLimits).some((v) => v != null)
                    ? Object.entries(ep.rateLimits)
                        .filter(([, v]) => v != null)
                        .map(([k, v]) => `${num(v as number)} ${k}`)
                        .join(" · ")
                    : "not reported",
                ],
                ["Quota scope", ep.quotaScopeIds.length ? ep.quotaScopeIds.join(", ") : <span className="text-ink-3">none set <HelpTip term="quotaScope" /></span>],
                [
                  <span key="a" className="inline-flex items-center gap-1">
                    Reachable <HelpTip term="available" />
                  </span>,
                  reachable(ep, keyedProviders(sy)) ? (
                    "Yes"
                  ) : (
                    <span key="av">
                      No: no usable key for {ep.route.provider}, or the provider no longer lists it.{" "}
                      <Link href="/keys" className="text-accent-ink hover:underline">
                        Provider keys
                      </Link>
                    </span>
                  ),
                ],
                [
                  "Sent to",
                  <span key="r" className="space-y-1">
                    <Mono>{`${ep.route.provider}/${ep.route.model}`}</Mono>
                    <span className="block text-xs text-ink-3">Directly to the provider with one of its keys; the model it reports serving is checked against this one.</span>
                  </span>,
                ],
                ...(view.quarantined ? ([["Quarantine", <span key="q" className="text-bad-ink">{view.quarantined}</span>]] as Array<[string, ReactNode]>) : []),
                ["First seen", view.firstSeenAt ? dateTime(view.firstSeenAt) : "manual entry"],
              ]}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Parameter evidence" help="provenance" description="Every source SwitchYard found for this model's size." />
          <div className="p-4">
            {ep.params.evidence.length ? (
              <ul className="space-y-2">
                {ep.params.evidence.map((e, i) => (
                  <li key={i} className="rounded-lg border border-line px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={e.source === "huggingface" ? "good" : e.source === "name" ? "warn" : "neutral"}>{e.source === "huggingface" ? "Hugging Face" : e.source}</Badge>
                      <span className="font-medium text-ink">{params(e.totalB)}</span>
                      {e.activeB ? <span className="text-ink-2">{params(e.activeB)} active</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-ink-3">{e.detail}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No evidence recorded. {ep.totalParametersB === null ? "Enter the size below to enable this model." : "The size was entered manually."}</p>
            )}
            {ep.sourceUrls.length ? (
              <div className="mt-4">
                <div className="mb-1 text-xs font-medium text-ink-3">Sources</div>
                <ul className="space-y-1 text-sm">
                  {ep.sourceUrls.map((u) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-accent-ink hover:underline">
                        {u} <ExternalLink size={12} aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Card id="controls">
        <CardHeader title="Controls" help="override" description="Corrections you make here sit on top of discovered data and survive rescans." />
        <div className="p-4">
          <OverrideEditor
            id={ep.id}
            current={view.override}
            profiles={profiles}
            modalities={[...MODALITIES]}
            discovered={{
              totalB: ep.totalParametersB,
              activeB: ep.activeParametersB,
              contextTokens: ep.contextLimitTokens,
              outputTokens: ep.outputLimitTokens,
              modalities: ep.inputModalities,
              supportsTools: ep.supportsTools,
              supportsStructuredOutput: ep.supportsStructuredOutput,
              free: isFree(ep),
              needsConfirmation: ep.status === "pending_confirmation",
              heuristic: ep.params.confidence === "heuristic",
            }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Qualification" help="qualification" description="Pass rate per task family and tier, with a 95% confidence interval. Results at harder tiers count for easier ones." actions={<Link href="/qualification" className="text-xs text-accent-ink hover:underline">Leaderboard →</Link>} />
        <div className="p-4">
          <QualificationTable view={view} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Recent requests" actions={<Link href={`/requests?endpoint=${encodeURIComponent(ep.id)}`} className="text-xs text-accent-ink hover:underline">All requests for this model →</Link>} />
        <RequestsTable rows={recent} names={names} hideModel empty="This model has not served any requests yet" />
      </Card>
    </div>
  );
}

function EligibilityGrid({ view, profiles }: { view: ModelView; profiles: string[] }) {
  const cells = view.eligibility;
  const sameEverywhere = cells.length > 0 && cells.every((c) => !c.eligible && c.reasons.join("|") === cells[0]!.reasons.join("|"));
  if (sameEverywhere) {
    return (
      <div className="rounded-lg bg-bad-soft px-4 py-3 text-sm">
        <div className="font-semibold text-bad-ink">Not used for any task type at any tier</div>
        <ul className="mt-1 list-disc pl-5 text-ink-2">
          {cells[0]!.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-3">Fix this (see Controls below) and the model becomes a candidate wherever its size, limits, and capabilities fit.</p>
      </div>
    );
  }
  return (
    <table className="w-full min-w-[40rem] border-separate border-spacing-1 text-sm">
      <thead>
        <tr>
          <th className="w-32 text-left text-xs font-medium text-ink-3">Task type</th>
          {TIER_NAMES.map((t) => (
            <th key={t} className="text-left text-xs font-medium text-ink-3">
              {t}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {profiles.map((p) => (
          <tr key={p}>
            <th scope="row" className="text-left align-top font-medium text-ink">
              {p}
            </th>
            {TIER_NAMES.map((t) => {
              const c = view.eligibility.find((x) => x.profile === p && x.tier === t);
              if (!c) return <td key={t} className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-3">not evaluated</td>;
              return (
                <td key={t} className={cx("rounded-lg px-3 py-2 align-top", c.eligible ? "bg-good-soft" : "bg-bad-soft")}>
                  {c.eligible ? (
                    <div className="flex items-center gap-1.5 text-good-ink">
                      <span className="text-base font-semibold">#{c.rank}</span>
                      <span className="text-xs">{c.rank === 1 ? "tried first" : `tried ${ordinal(c.rank ?? 0)}`}</span>
                    </div>
                  ) : (
                    <div>
                      <div className="text-xs font-semibold text-bad-ink">Not used</div>
                      <ul className="mt-0.5 space-y-0.5 text-[11px] leading-snug text-ink-2">
                        {c.reasons.slice(0, 3).map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                        {c.reasons.length > 3 ? <li className="text-ink-3" title={c.reasons.slice(3).join("\n")}>+{c.reasons.length - 3} more</li> : null}
                      </ul>
                    </div>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function QualificationTable({ view }: { view: ModelView }) {
  const rows = view.qualification;
  if (!rows.some((q) => q.stat)) return <p className="text-sm text-ink-3">Not qualified yet. Run qualification from the Qualification page to measure this model.</p>;
  const families = [...new Set(rows.map((q) => q.family))];
  return (
    <div className="overflow-x-auto">
      <table className="data-table tabular">
        <thead>
          <tr>
            <th>Family</th>
            {TIER_NAMES.map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {families.map((f) => (
            <tr key={f}>
              <td className="font-medium">{f.replace("_", "-")}</td>
              {TIER_NAMES.map((t) => {
                const q = rows.find((x) => x.family === f && x.tier === t)?.stat;
                return (
                  <td key={t}>
                    {q ? (
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium">{Math.round(q.passRate * 100)}%</span>
                          {q.qualified ? <Badge tone="good">qualified</Badge> : null}
                        </span>
                        <span className="text-[11px] text-ink-3">
                          {Math.round(q.low * 100)}–{Math.round(q.high * 100)}% · {q.passes}/{q.trials} trials
                        </span>
                      </span>
                    ) : (
                      <span className="text-ink-3">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
