import Link from "next/link";
import { CreditCard, KeyRound, Power, TriangleAlert } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { removedKeyIds, safePaidKey } from "@/lib/paid";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, Mono, PageHeader, type Tone } from "@/components/ui";
import { AddPaidKeyForm, PaidKeyRow } from "@/components/client/paid";
import { BILLING_LABEL, usd } from "@/lib/billing";
import { modelHref } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Paid routes" };

const POLICY: Record<string, { label: string; tone: Tone; text: string }> = {
  never: { label: "Never", tone: "neutral", text: "Free models only." },
  on_free_exhaustion: { label: "On free exhaustion", tone: "accent", text: "Paid models serve only after every free model failed or was busy." },
  preferred: { label: "Preferred", tone: "warn", text: "Paid models are tried before free ones." },
  premium: { label: "Premium", tone: "warn", text: "Work too hard for free workers goes to a paid model instead of back to the supervisor." },
};

export default async function PaidPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const s = insights.paidSummary(sy);
  const removed = removedKeyIds(sy);
  const keys = s.keys.map((k) => safePaidKey(k as unknown as Record<string, unknown>, removed.has(k.id)));
  const names = new Map(sy.catalog.endpoints().map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  const models = sy.cfg.paid.models;
  const flPaid = s.freeLlmApiKeyBilling.filter((b) => b.billingClass !== "free_tier");
  const windows: Array<{ label: string; spent: number; budget: number | null }> = [
    { label: "Last 24 hours", spent: s.day, budget: s.budgets.perDayUsd },
    { label: "Last 7 days", spent: s.week, budget: s.budgets.perWeekUsd },
    { label: "Last 30 days", spent: s.month, budget: s.budgets.perMonthUsd },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Paid routes"
        description="Direct paid-provider models (never through FreeLLMAPI): when they may serve, what they have cost, and the keys they use. Free routing is unaffected unless a policy below allows paid models."
      />

      <Callout
        tone={s.enabled ? "good" : "neutral"}
        icon={<Power size={16} />}
        title={s.enabled ? "Paid routing is on" : "Paid routing is off"}
      >
        {s.enabled ? "Paid models may serve where the tier policy allows, within the budgets below." : "No paid request will be made, whatever the tier policies say."}{" "}
        The master switch and budgets live in <Link href="/settings#paid" className="font-medium text-accent-ink hover:underline">Settings → Paid routing</Link>.
      </Callout>

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Spend against budgets" description="Reserved worst-case cost counts as spent until a request settles to its billed cost." />
          <div className="space-y-4 p-4">
            {windows.map((w) => {
              const ratio = w.budget ? Math.min(1, w.spent / w.budget) : 0;
              const tone = w.budget === null ? "bg-accent" : ratio >= 1 ? "bg-bad" : ratio >= 0.8 ? "bg-warn" : "bg-accent";
              return (
                <div key={w.label}>
                  <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium text-ink">{w.label}</span>
                    <span className="tabular text-ink-2">
                      {usd(w.spent)} {w.budget !== null ? <span className="text-ink-3">of {usd(w.budget, 2)} budget{ratio >= 1 ? " · limit reached" : ratio >= 0.8 ? " · nearly used" : ""}</span> : <span className="text-ink-3">· no budget for this window</span>}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-valuemin={0} aria-valuemax={w.budget ?? undefined} aria-valuenow={w.spent} aria-label={`${w.label} spend`}>
                    {w.budget ? <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.max(ratio * 100, w.spent > 0 ? 1 : 0)}%` }} /> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="When paid models may serve" help="paidPolicy" description="Per difficulty tier. Edit in Settings." />
          <ul className="divide-y divide-line">
            {(["T1", "T2", "T3", "T4"] as const).map((t) => {
              const p = POLICY[s.tiers[t]] ?? { label: s.tiers[t], tone: "neutral" as Tone, text: "" };
              return (
                <li key={t} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <Badge tone={t === "T4" ? "serious" : "accent"}>{t}</Badge>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={p.tone}>{p.label}</Badge>
                      {t === "T4" ? <HelpTip term="premium" /> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">{p.text}</p>
                  </div>
                </li>
              );
            })}
            <li className="px-4 py-2.5 text-xs text-ink-3">
              Up to <strong className="text-ink-2">{sy.cfg.paid.max_paid_attempts}</strong> paid model{sy.cfg.paid.max_paid_attempts === 1 ? "" : "s"} tried per request. Jobs&apos; own supervisors follow <Mono>supervisor.paid_policy</Mono> ({POLICY[sy.cfg.supervisor.paid_policy]?.label ?? sy.cfg.supervisor.paid_policy}).
            </li>
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title="Keys" help="billingClass" description="Direct provider keys in SwitchYard's encrypted vault. Several keys per provider are tried in order while they have room under their cap and balance." />
        {keys.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Label</th>
                  <th>Billing class</th>
                  <th>Key</th>
                  <th className="text-right">Spent (30 days)</th>
                  <th>Cap and balance left</th>
                  <th>Expires</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <PaidKeyRow key={k.id} k={k} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<KeyRound size={22} />} title="No paid keys yet">
            {s.providers.length ? "Add a key below. Paid models stay unavailable until their provider has an enabled key." : "Add a paid provider in Settings first, then add its key here."}
          </EmptyState>
        )}
        <div className="border-t border-line p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Add a key</h3>
          {s.providers.length ? (
            <AddPaidKeyForm providers={s.providers} />
          ) : (
            <p className="text-sm text-ink-3">
              No paid providers configured. Add one under <Link href="/settings#paid-providers" className="text-accent-ink hover:underline">Settings → Paid providers</Link>.
            </p>
          )}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Spend by model (30 days)" />
          {s.byEndpoint.length ? (
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Requests</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {s.byEndpoint.map((e) => (
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
          ) : (
            <EmptyState icon={<CreditCard size={20} />} title="No paid requests in the last 30 days" />
          )}
        </Card>

        <Card>
          <CardHeader title="Configured paid models" description={`${models.length} model${models.length === 1 ? "" : "s"} in paid.models. Prices are USD per million tokens.`} />
          {models.length ? (
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="text-right">Input</th>
                  <th className="text-right">Output</th>
                  <th>Size floor</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={`${m.provider}/${m.model}`}>
                    <td>
                      <div className="text-ink">{m.display_name ?? m.model}</div>
                      <div className="font-mono text-[11px] text-ink-3">
                        {m.provider}/{m.model}
                      </div>
                    </td>
                    <td className="text-right">{m.input_usd_per_million !== undefined ? `$${m.input_usd_per_million}` : <span className="text-ink-3">fetched or unknown</span>}</td>
                    <td className="text-right">{m.output_usd_per_million !== undefined ? `$${m.output_usd_per_million}` : <span className="text-ink-3">–</span>}</td>
                    <td className="text-xs">{m.ignore_size_floor ? <Badge tone="warn">exempt</Badge> : m.declared_parameters_b ? `declared ${m.declared_parameters_b}B` : <span className="text-ink-3">size unknown: excluded where a floor applies</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No paid models configured">
              Add models under <Link href="/settings#paid-models" className="text-accent-ink hover:underline">Settings → Paid models</Link>.
            </EmptyState>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="FreeLLMAPI keys marked as paid" help="billingClass" description="Set on the Provider keys page. A FreeLLMAPI key marked as anything but free tier blocks its whole platform from free routing." />
        <div className="p-4 text-sm">
          {flPaid.length ? (
            <ul className="space-y-1.5">
              {flPaid.map((b) => (
                <li key={b.flKeyId} className="flex flex-wrap items-center gap-2">
                  <TriangleAlert size={14} className="text-warn-ink" aria-hidden />
                  <span className="text-ink">
                    Key #{b.flKeyId} on <strong>{b.platform}</strong>
                  </span>
                  <Badge>{BILLING_LABEL[b.billingClass] ?? b.billingClass}</Badge>
                  <span className="text-xs text-ink-3">{b.platform} is not used for free routing</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">None. Every FreeLLMAPI key is treated as free tier unless you mark it on the <Link href="/keys" className="text-accent-ink hover:underline">Provider keys</Link> page.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
