import Link from "next/link";
import { Clock, Pin, Star, TriangleAlert } from "lucide-react";
import { insights, MODALITIES, TIER_NAMES, type Modality, type ProfileName, type TierName } from "meritrouter";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Card, CardHeader, cx, EmptyState, HelpTip, Mono } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { AddOverrideForm, OverridesList, type OverrideRow } from "@/components/client/routing-overrides";
import { ago, modelHref, params } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Routing" };

const PROFILE_HINT: Record<string, string> = {
  summarize: "Answer from text the supervisor supplies",
  inspect: "Simple read-only repository lookups",
  analyze: "Cross-file reasoning and repair proposals",
  implement: "Bounded code edits in an isolated worktree",
  review: "Review a patch or evidence",
};

export default async function RoutingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const profiles = Object.keys(sy.cfg.profiles) as ProfileName[];
  const profile = (typeof sp.profile === "string" && profiles.includes(sp.profile as ProfileName) ? sp.profile : profiles[0]) as ProfileName | undefined;
  const mods = (typeof sp.mods === "string" ? sp.mods.split(",") : ["text"]).filter((m): m is Modality => (MODALITIES as readonly string[]).includes(m));
  const modalities: Modality[] = mods.length ? mods : ["text"];
  const eps = sy.catalog.endpoints();
  const names = new Map(eps.map((e) => [e.id, e.displayName ?? e.gatewayModelId]));
  await sy.health.refresh().catch(() => undefined);

  const overrides: OverrideRow[] = sy.catalog.routingOverrides().map((o) => ({
    id: o.id!,
    profile: o.profile,
    tier: o.tier,
    kind: o.kind,
    endpointId: o.endpointId,
    modelName: names.get(o.endpointId) ?? o.endpointId,
    allowBelowFloor: o.allowBelowFloor,
    note: o.note ?? null,
    enabled: o.enabled,
    modelMissing: !names.has(o.endpointId),
  }));
  const tiers = sy.cfg.tiers;
  const href = (p: string, m: string[]) => `/all/routing?profile=${p}${m.join(",") !== "text" ? `&mods=${m.join(",")}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Routing" description="Which model each kind of task goes to, in what order, and why the others are skipped. Add rules to force, prefer, or block a model." />

      <Card>
        <CardHeader title="How MeritRouter picks a model" help="tier" />
        <div className="grid gap-4 p-4 lg:grid-cols-[3fr_2fr]">
          <div className="overflow-x-auto">
            <table className="data-table tabular">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Difficulty score</th>
                  <th>
                    <span className="inline-flex items-center gap-1">
                      Size floor <HelpTip term="sizeFloor" />
                    </span>
                  </th>
                  <th>Request budget</th>
                  <th>
                    <span className="inline-flex items-center gap-1">
                      Order <HelpTip term="prefer" />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {TIER_NAMES.map((t, i) => (
                  <tr key={t}>
                    <td>
                      <Badge tone="accent">{t}</Badge> <span className="text-xs text-ink-3">{["easy", "moderate", "hard"][i]}</span>
                    </td>
                    <td>
                      {i === 0 ? 0 : tiers[TIER_NAMES[i - 1]!].max_score + 1}–{tiers[t].max_score} points
                    </td>
                    <td>≥ {tiers[t].min_total_parameters_b}B</td>
                    <td>{tiers[t].max_model_requests} requests</td>
                    <td>{tiers[t].prefer === "smallest_sufficient" ? "Smallest sufficient first" : "Most capable first"}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <Badge tone="serious">T4</Badge>
                  </td>
                  <td>above {tiers.T3.max_score} points</td>
                  <td colSpan={3} className="text-ink-2">
                    Not sent to any model: returned to the Claude Code supervisor. <HelpTip term="t4" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 text-sm text-ink-2">
            <li>
              The rulebook scores each task (see a task&apos;s detail page for its score lines) and the score picks the tier. A task type can also start at a higher tier (<Mono>min_tier</Mono>).
            </li>
            <li>The size floor for a task is the larger of the task type&apos;s floor and the tier&apos;s floor. Smaller models are never used unless a force rule allows it.</li>
            <li>
              If a model is rate limited, the next one is tried (up to {sy.cfg.routing.max_endpoint_fallbacks} per request). {sy.cfg.routing.escalate_on_failure ? "A failed task is retried once at the next tier." : "Failed tasks are not retried at a higher tier."} <HelpTip term="fallback" />
            </li>
          </ul>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <nav aria-label="Task type" className="flex flex-wrap gap-1">
            {profiles.map((p) => (
              <Link key={p} href={href(p, modalities)} aria-current={p === profile ? "page" : undefined} className={cx("rounded-lg px-3 py-1.5 text-sm", p === profile ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-2")}>
                {p}
              </Link>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            Input includes:
            {MODALITIES.map((m) => {
              const on = modalities.includes(m);
              const next = on ? modalities.filter((x) => x !== m) : [...modalities, m];
              return (
                <Link key={m} href={href(profile ?? "", next.length ? next : ["text"])} aria-pressed={on} className={cx("rounded-full border px-2 py-0.5", on ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2")}>
                  {m}
                </Link>
              );
            })}
          </div>
        </div>
        {profile ? (
          <div className="p-4">
            <p className="mb-4 text-sm text-ink-2">
              <span className="font-medium text-ink">{profile}</span>: {PROFILE_HINT[profile] ?? sy.cfg.profiles[profile]!.mode} · task-type floor {sy.cfg.profiles[profile]!.min_total_parameters_b}B · starts at {sy.cfg.profiles[profile]!.min_tier} · up to {sy.cfg.profiles[profile]!.max_model_requests} requests
              {sy.cfg.profiles[profile]!.mode !== "completion" ? " · needs tool calling" : ""}
            </p>
            <div className="grid gap-4 lg:grid-cols-3">
              {TIER_NAMES.map((t) => (
                <TierColumn key={t} sy={sy} profile={profile} tier={t} modalities={modalities} />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState title="No task types configured">Add profiles to the config (Settings → Task types).</EmptyState>
        )}
      </Card>

      <Card>
        <CardHeader title="Manual routing rules" help="forceOverride" description="Rules apply immediately to new requests. A disabled rule is kept but ignored." />
        <OverridesList rows={overrides} />
        <div className="border-t border-line p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Add a rule</h3>
          <AddOverrideForm
            profiles={profiles}
            tiers={[...TIER_NAMES]}
            models={eps.filter((e) => e.status !== "removed").map((e) => ({ id: e.id, name: e.displayName ?? e.gatewayModelId, sizeB: e.totalParametersB, status: e.status }))}
            {...(profile ? { defaults: { profile } } : {})}
          />
        </div>
      </Card>
    </div>
  );
}

function TierColumn({ sy, profile, tier, modalities }: { sy: import("meritrouter").MeritRouter; profile: ProfileName; tier: TierName; modalities: Modality[] }) {
  const plan = insights.routingPreview(sy, profile, tier, modalities);
  const minTier = sy.cfg.profiles[profile]!.min_tier;
  const unused = TIER_NAMES.indexOf(tier) < TIER_NAMES.indexOf(minTier);
  const eligible = plan.explanations.filter((e) => e.eligible);
  const excluded = plan.explanations.filter((e) => !e.eligible);
  const now = Date.now();
  const quarantined = new Map(sy.catalog.endpoints().map((e) => [e.id, sy.gate.quarantined(e)]));
  return (
    <div className={cx("flex flex-col rounded-xl border border-line", unused && "opacity-60")}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <Badge tone="accent">{tier}</Badge>
          <span className="text-xs text-ink-3">floor {plan.floorB}B · {sy.cfg.tiers[tier].prefer === "smallest_sufficient" ? "smallest first" : "most capable first"}</span>
        </div>
        {plan.forced ? (
          <Badge tone="serious" icon={<Pin size={11} aria-hidden />}>
            forced
          </Badge>
        ) : null}
      </div>
      {unused ? <p className="px-3 pt-2 text-xs text-warn-ink">Not used: {profile} tasks start at {minTier}.</p> : null}
      <ol className="space-y-1 p-2">
        {eligible.length === 0 ? (
          <li className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad-ink">
            No model qualifies. Tasks at this tier fail with &quot;no eligible endpoint&quot; until a model is enabled or a rule changes.
          </li>
        ) : (
          eligible.map((e) => (
            <li key={e.endpointId} className="flex items-start gap-2 rounded-lg bg-surface-2 px-2.5 py-2">
              <span className="tabular mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-good-soft text-[11px] font-semibold text-good-ink">{e.rank}</span>
              <div className="min-w-0 flex-1">
                <Link href={modelHref(e.endpointId)} className="block truncate text-sm font-medium text-ink hover:text-accent-ink hover:underline" title={e.endpointId}>
                  {e.displayName}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
                  <span>{params(e.totalParametersB)}</span>
                  {e.via === "preferred" ? (
                    <Badge tone="accent" icon={<Star size={10} aria-hidden />}>
                      preferred
                    </Badge>
                  ) : e.via === "forced" ? (
                    <Badge tone="serious" icon={<Pin size={10} aria-hidden />}>
                      forced
                    </Badge>
                  ) : null}
                  {e.belowFloorAllowed ? (
                    <Badge tone="warn" icon={<TriangleAlert size={10} aria-hidden />}>
                      below floor allowed
                    </Badge>
                  ) : null}
                  {e.coolingDownUntil ? (
                    <Badge tone="warn" icon={<Clock size={10} aria-hidden />}>
                      rate limited, resumes {ago(e.coolingDownUntil, now)}
                    </Badge>
                  ) : null}
                  {e.qualification ? <span>{Math.round(e.qualification.passRate * 100)}% pass ({e.qualification.trials})</span> : null}
                  {quarantined.get(e.endpointId) ? (
                    <Badge tone="bad" title={quarantined.get(e.endpointId) ?? undefined}>
                      quarantined: skipped at dispatch
                    </Badge>
                  ) : null}
                </div>
              </div>
            </li>
          ))
        )}
      </ol>
      {excluded.length ? (
        <details className="mt-auto border-t border-line px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-2">Not used here ({excluded.length})</summary>
          <ul className="mt-2 space-y-2">
            {excluded.map((e) => (
              <li key={e.endpointId} className="text-xs">
                <Link href={modelHref(e.endpointId)} className="font-medium text-ink hover:underline">
                  {e.displayName}
                </Link>{" "}
                <span className="text-ink-3">{params(e.totalParametersB)}</span>
                <ul className="ml-3 list-disc text-ink-2">
                  {e.reasons.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
