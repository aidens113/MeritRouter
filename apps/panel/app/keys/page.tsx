import { KeyRound, Lock, Users } from "lucide-react";
import { getSy } from "@/lib/sy";
import { normalizeProviders, safeKey, type SafeKey } from "@/lib/keys";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, EmptyState, Mono, PageHeader } from "@/components/ui";
import { AddKeyForm, KeyRow } from "@/components/client/keys";

export const dynamic = "force-dynamic";
export const metadata = { title: "Provider keys" };

export default async function KeysPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const eps = sy.catalog.endpoints();
  const modelsPer = new Map<string, number>();
  for (const e of eps) if (e.status !== "removed") modelsPer.set(e.providerId, (modelsPer.get(e.providerId) ?? 0) + 1);
  const free = new Set(sy.cfg.discovery.free_platforms);
  const billing = new Map(sy.spend.freeLlmApiKeyBilling().map((b) => [b.flKeyId, b.billingClass]));
  const paidPlatforms = new Set([...sy.spend.freeLlmApiKeyBilling()].filter((b) => b.billingClass !== "free_tier").map((b) => b.platform));

  const header = (
    <PageHeader
      title="Provider keys"
      description="API keys FreeLLMAPI uses to reach each service (Google, Groq, OpenRouter, …). You can add several keys per service; FreeLLMAPI rotates between them."
    />
  );
  const quotaNote = (
    <Callout tone="accent" icon={<Users size={16} />} title="Two keys on the same account do not double your quota">
      Free tiers are usually limited per account, not per key. Give keys from the same account the same <strong>quota group</strong> so they are understood as sharing one allowance. Keys from different accounts get different groups.
    </Callout>
  );

  if (!sy.admin) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="p-6">
          <EmptyState icon={<Lock size={24} />} title="Key management needs a FreeLLMAPI dashboard token">
            <p>
              Keys live in FreeLLMAPI, so the panel manages them through FreeLLMAPI&apos;s admin API. Log in to the FreeLLMAPI dashboard, copy its session token, and start the panel with <Mono>{sy.cfg.gateway.admin_token_env}=&lt;token&gt;</Mono> in its environment.
            </p>
            <p className="mt-2">
              The same token lets SwitchYard scan models and keep each model&apos;s chain verified. The variable name is set by <Mono>gateway.admin_token_env</Mono> in Settings.
            </p>
          </EmptyState>
        </Card>
        {quotaNote}
      </div>
    );
  }

  let keys: SafeKey[] = [];
  let providers: Array<{ id: string; name: string }> = [];
  let error: string | null = null;
  try {
    const [k, p] = await Promise.all([sy.admin.listKeys(), sy.admin.listProviders().catch(() => [])]);
    keys = k.map(safeKey);
    providers = normalizeProviders(p);
  } catch (err) {
    error = (err as Error).message;
  }
  const platforms = [...new Set([...keys.map((k) => k.platform), ...providers.map((p) => p.id)])].sort();
  const groups = [...new Set(keys.map((k) => k.groupLabel).filter((g): g is string => Boolean(g)))];

  return (
    <div className="space-y-6">
      {header}
      {error ? (
        <Callout tone="bad" title="Could not load keys from FreeLLMAPI">
          {error}. Check that FreeLLMAPI is running at <Mono>{sy.cfg.gateway.base_url}</Mono> and that the token in <Mono>{sy.cfg.gateway.admin_token_env}</Mono> is current (dashboard tokens expire).
        </Callout>
      ) : null}
      {quotaNote}
      <Callout tone="warn" title="Mark keys that cost money">
        Each key has a billing class. SwitchYard treats FreeLLMAPI keys as free tier unless you say otherwise; a key marked paid credits, billed to card, or trial blocks its whole platform from free routing, so free work never lands on a billed account. Direct paid routes are managed on the <a href="/paid" className="font-medium text-accent-ink hover:underline">Paid routes</a> page.
      </Callout>

      <Card>
        <CardHeader title="Add a key" description="Pick the service, paste the key, and optionally say which account it belongs to." />
        <div className="p-4">
          <AddKeyForm providers={providers} groups={groups} />
        </div>
      </Card>

      {!error && keys.length === 0 ? (
        <Card>
          <EmptyState icon={<KeyRound size={22} />} title="No keys yet">
            Add a key above. Most services offer a free tier; FreeLLMAPI&apos;s README lists where to get each key.
          </EmptyState>
        </Card>
      ) : null}

      {platforms
        .filter((p) => keys.some((k) => k.platform === p))
        .map((p) => {
          const list = keys.filter((k) => k.platform === p);
          const enabled = list.filter((k) => k.enabled).length;
          const groupsHere = new Set(list.filter((k) => k.enabled).map((k) => k.groupLabel ?? `__key${k.id}`));
          return (
            <Card key={p}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {providers.find((x) => x.id === p)?.name ?? p}
                    <Badge>{list.length} key{list.length === 1 ? "" : "s"}</Badge>
                    {free.has(p) ? <Badge tone="good">listed as free platform</Badge> : null}
                    {paidPlatforms.has(p) ? <Badge tone="warn">blocked from free routing: a key is marked paid</Badge> : null}
                  </span>
                }
                description={`${enabled} enabled · ${groupsHere.size} separate quota${groupsHere.size === 1 ? "" : "s"} · ${modelsPer.get(p) ?? 0} model${(modelsPer.get(p) ?? 0) === 1 ? "" : "s"} in the catalog`}
              />
              <ul className="divide-y divide-line">
                {list.map((k) => (
                  <KeyRow key={k.id} k={k} billing={billing.get(k.id) ?? "free_tier"} />
                ))}
              </ul>
            </Card>
          );
        })}
    </div>
  );
}
