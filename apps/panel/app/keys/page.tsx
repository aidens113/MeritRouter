import { KeyRound } from "lucide-react";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, EmptyState, Mono, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Provider keys" };

/**
 * Read-only view of the provider keys SwitchYard uses (config and vault), until P3 rebuilds this
 * page with adding, testing, and editing keys. Secrets are never shown: only labels and last four.
 */
export default async function KeysPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const creds = sy.providers.credentials().list();
  const health = new Map(sy.providers.statuses().map((s) => [s.platform, s]));
  const providers = [...new Set(creds.map((c) => c.provider))].sort();

  return (
    <div className="space-y-6">
      <PageHeader title="Provider keys" description="Keys SwitchYard uses to call each provider directly. Several keys per provider are rotated." />
      <Callout tone="accent" title="Add keys in the config for now">
        Add keys under <Mono>providers.&lt;id&gt;.keys</Mono> in the config file (prefer <Mono>api_key_env</Mono>), each with a <Mono>billing_class</Mono>. Adding and testing keys here comes with the rebuilt page.
      </Callout>
      {providers.length === 0 ? (
        <Card>
          <EmptyState icon={<KeyRound size={22} />} title="No provider keys yet">
            Add a key under <Mono>providers</Mono> in the config, then run a scan.
          </EmptyState>
        </Card>
      ) : null}
      {providers.map((p) => {
        const list = creds.filter((c) => c.provider === p);
        const h = health.get(p);
        return (
          <Card key={p}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {p}
                  <Badge>{list.length} key{list.length === 1 ? "" : "s"}</Badge>
                  {h ? <Badge tone={h.status === "healthy" ? "good" : h.status === "invalid" ? "bad" : h.status === "rate_limited" ? "warn" : undefined}>{h.status}</Badge> : null}
                </span>
              }
              description={h?.lastError ?? undefined}
            />
            <ul className="divide-y divide-line">
              {list.map((c) => (
                <li key={c.ref} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="text-ink">{c.label || c.ref}</span>
                  {c.last4 ? <Mono>…{c.last4}</Mono> : null}
                  <Badge>{c.billingClass}</Badge>
                  <Badge>{c.source}</Badge>
                  {c.unusableReason ? <span className="text-xs text-bad-ink">{c.unusableReason}</span> : null}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
