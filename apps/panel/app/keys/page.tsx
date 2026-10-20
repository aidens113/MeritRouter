import Link from "next/link";
import { CreditCard, KeyRound, Power, Radar } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, Mono, PageHeader, type Tone } from "@/components/ui";
import { ActionButton } from "@/components/client/actions";
import { AddKeyForm, KeyRow, ProviderActions, type ProviderOption } from "@/components/client/provider-keys";
import { usd } from "@/lib/billing";
import { ago, modelHref } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Provider keys" };

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "good" },
  rate_limited: { label: "Cooling down", tone: "warn" },
  invalid: { label: "Needs attention", tone: "bad" },
  unknown: { label: "No usable key", tone: "neutral" },
};

const KIND: Record<insights.ProviderKind, string> = { builtin: "built-in", custom: "custom", paid: "paid provider", missing: "not configured" };

const POLICY_LABEL: Record<string, string> = { never: "never", on_free_exhaustion: "on free exhaustion", preferred: "preferred", premium: "premium" };

/**
 * Provider keys: every key SwitchYard uses to call providers directly (vault keys added here,
 * config keys read-only), their health, the models each provider offers, and paid spend.
 * Secrets never reach the browser: the server sends only last four characters.
 */
export default async function KeysPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const view = insights.providerKeysView(sy);
  const paid = insights.paidSummary(sy);
  const now = Date.now();
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const shown = view.providers.filter((p) => p.keys.length || p.inConfig || p.inPaid);
  const options: ProviderOption[] = view.providers
    .filter((p) => p.kind !== "missing")
    .map((p) => ({ id: p.id, displayName: p.displayName, kind: p.kind, needsAccountId: p.needsAccountId, noKey: p.noKey, accountId: p.accountId }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const windows: Array<{ label: string; spent: number; budget: number | null }> = [
    { label: "24 hours", spent: paid.day, budget: paid.budgets.perDayUsd },
    { label: "7 days", spent: paid.week, budget: paid.budgets.perWeekUsd },
    { label: "30 days", spent: paid.month, budget: paid.budgets.perMonthUsd },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Provider keys"
        description="Keys SwitchYard uses to call each provider directly. Several keys per provider are rotated; a key that is rate limited cools down while the next one serves. Secrets are never shown again after you add them."
        actions={
          <ActionButton url="/api/scan" success="Scan finished">
            <Radar size={14} aria-hidden /> Scan all providers
          </ActionButton>
        }
      />

      {view.usableKeys === 0 ? (
        <Callout tone="accent" icon={<KeyRound size={16} />} title="Add your first provider key">
          Pick a provider below, paste a key from its console, and press Test key to see the models it can use. Then Add key and Find models. Keys can also be declared under <Mono>providers</Mono> in the config file (prefer <Mono>api_key_env</Mono>); those appear here read-only.
        </Callout>
      ) : null}

      <Card id="add">
        <CardHeader title="Add a key" help="billingClass" description="Any built-in provider, a custom OpenAI-compatible server, or a provider configured for paid models." />
        <div className="p-4">
          <AddKeyForm providers={options} billingClasses={view.billingClasses} />
        </div>
      </Card>

      {shown.map((p) => {
        const h = p.health ? HEALTH[p.health.status] : null;
        const removable = p.kind === "custom" && p.inConfig && p.keys.every((k) => k.source === "vault" && k.status === "removed");
        return (
          <Card key={p.id} id={`provider-${p.id}`}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {p.displayName}
                  {p.displayName !== p.id ? <Mono>{p.id}</Mono> : null}
                  <Badge>{KIND[p.kind]}</Badge>
                  {!p.enabled && p.kind !== "missing" ? <Badge tone="warn">disabled in config</Badge> : null}
                  {h ? (
                    <Badge tone={h.tone}>
                      {h.label}
                      {p.health!.status === "rate_limited" && p.health!.resumeAt ? ` · back ${ago(p.health!.resumeAt, now)}` : ""}
                    </Badge>
                  ) : null}
                </span>
              }
              description={
                <span className="block space-y-0.5">
                  {p.health ? (
                    <span className="block">
                      {p.health.summary}
                      {p.health.requestsRemainingPct !== null ? ` · ${p.health.requestsRemainingPct}% of requests left` : ""}
                    </span>
                  ) : null}
                  {p.kind === "missing" ? <span className="block text-bad-ink">These keys belong to a provider that is no longer configured: add it back, or remove the keys.</span> : null}
                  {p.baseUrl ? <span className="block break-all font-mono text-[11px]">{p.baseUrl}</span> : null}
                  <span className="block">
                    {p.models.total ? (
                      <Link href={`/models?platform=${encodeURIComponent(p.models.platform)}`} className="text-accent-ink hover:underline">
                        {p.models.total} model{p.models.total === 1 ? "" : "s"} found · {p.models.routable} routable{p.models.free ? ` · ${p.models.free} free` : ""}
                        {p.models.unavailable ? ` · ${p.models.unavailable} unavailable` : ""}
                      </Link>
                    ) : p.kind === "paid" ? (
                      "Routes the models listed under paid.models (Settings)."
                    ) : (
                      "No models found yet."
                    )}
                  </span>
                </span>
              }
              actions={<ProviderActions id={p.id} discoverable={p.discoverable} removable={removable} />}
            />
            {p.keys.length ? (
              <ul className="divide-y divide-line">
                {p.keys.map((k) => (
                  <KeyRow key={k.ref} k={k} now={now} />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-3">No key yet.{p.noKey ? "" : " Add one above."}</p>
            )}
          </Card>
        );
      })}

      <Card id="paid">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <CreditCard size={15} aria-hidden /> Paid spend
            </span>
          }
          help="paidPolicy"
          description={
            <>
              Keys that are not free tier, and models with a price, follow the paid policy and budgets in{" "}
              <Link href="/settings#paid" className="text-accent-ink hover:underline">
                Settings → Paid routing
              </Link>
              .
            </>
          }
        />
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={paid.enabled ? "good" : "neutral"} icon={<Power size={11} aria-hidden />}>
              {paid.enabled ? "Paid routing on" : "Paid routing off"}
            </Badge>
            {(["T1", "T2", "T3", "T4"] as const).map((t) => (
              <Badge key={t}>
                {t}: {POLICY_LABEL[paid.tiers[t]] ?? paid.tiers[t]}
              </Badge>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {windows.map((w) => {
              const ratio = w.budget ? Math.min(1, w.spent / w.budget) : 0;
              return (
                <div key={w.label} className="rounded-lg border border-line px-3 py-2">
                  <div className="text-xs text-ink-3">Last {w.label}</div>
                  <div className="tabular text-sm font-medium text-ink">
                    {usd(w.spent)} <span className="font-normal text-ink-3">{w.budget !== null ? `of ${usd(w.budget, 2)}` : "· no budget"}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-valuemin={0} aria-valuemax={w.budget ?? undefined} aria-valuenow={w.spent} aria-label={`Spend in the last ${w.label}`}>
                    {w.budget ? <div className={cx("h-full rounded-full", ratio >= 1 ? "bg-bad" : ratio >= 0.8 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(ratio * 100, w.spent > 0 ? 1 : 0)}%` }} /> : null}
                  </div>
                </div>
              );
            })}
          </div>
          {paid.byEndpoint.length ? (
            <div className="overflow-x-auto">
              <table className="data-table tabular">
                <thead>
                  <tr>
                    <th>Model (30 days)</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {paid.byEndpoint.map((e) => (
                    <tr key={e.endpointId}>
                      <td>
                        <Link href={modelHref(e.endpointId)} className="text-accent-ink hover:underline">
                          {names.get(e.endpointId) ?? e.endpointId}
                        </Link>
                        <div className="font-mono text-[11px] text-ink-3">{e.endpointId}</div>
                      </td>
                      <td className="text-right">{e.requests}</td>
                      <td className="text-right">{usd(e.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-ink-3">No paid requests in the last 30 days.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
