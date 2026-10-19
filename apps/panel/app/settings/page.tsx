import Link from "next/link";
import YAML from "yaml";
import { Lock } from "lucide-react";
import { insights, RulebookSchema, type Rulebook } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { getIn, PROFILE_FIELDS, PROFILE_HELP, SECTIONS, type Section } from "@/lib/settings-schema";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, Mono, PageHeader } from "@/components/ui";
import { RepositoriesForm, SectionForm } from "@/components/client/settings-form";
import { YamlEditor } from "@/components/client/yaml-editor";
import { RulebookEditor } from "@/components/client/rulebook-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const TABS = [
  { id: "form", label: "Settings" },
  { id: "rulebook", label: "Rulebook" },
  { id: "yaml", label: "Advanced: raw YAML" },
] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const tab = TABS.some((t) => t.id === sp.tab) ? (sp.tab as (typeof TABS)[number]["id"]) : "form";
  const cfg = sy.cfg as unknown as Record<string, unknown>;
  const valuesFor = (s: Section) => Object.fromEntries(s.fields.map((f) => [f.path.join("."), getIn(cfg, f.path) as string | number | boolean | string[] | null | undefined]));
  const profileSections: Section[] = Object.keys(sy.cfg.profiles).map((name) => ({
    id: `profile-${name}`,
    title: `Task type: ${name}`,
    description: PROFILE_HELP[name] ?? "Task type settings.",
    fields: PROFILE_FIELDS(name),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          <>
            Everything in <Mono>{sy.cfg.configPath}</Mono>. Changes are validated before they are written, comments in the file are kept, and running workers reload the file automatically.
          </>
        }
      />
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.id} href={t.id === "form" ? "/settings" : `/settings?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-2 text-sm", tab === t.id ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "form" ? (
        <div className="grid gap-6 xl:grid-cols-[12rem_1fr]">
          <aside className="hidden xl:block">
            <ul className="sticky top-6 space-y-0.5 text-sm">
              {[...SECTIONS.map((s) => [s.id, s.title]), ["repositories", "Repositories"], ...profileSections.map((s) => [s.id, s.title.replace("Task type: ", "Type: ")]), ["paid", "Paid routing"]].map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`} className="block rounded-md px-2 py-1 text-ink-2 hover:bg-surface-2 hover:text-ink">
                    {title}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
          <div className="min-w-0 space-y-6">
            {SECTIONS.map((s) => (
              <SectionForm key={s.id} section={s} values={valuesFor(s)} />
            ))}
            <RepositoriesForm repos={Object.entries(sy.cfg.repositories).map(([alias, v]) => ({ alias, path: v.path, writable: v.writable, resolved: sy.cfg.repositoryPaths[alias]?.path ?? "" }))} />
            {profileSections.map((s) => (
              <SectionForm key={s.id} section={s} values={valuesFor(s)} badge={sy.cfg.profiles[s.id.slice("profile-".length) as keyof typeof sy.cfg.profiles]?.mode} />
            ))}
            <PaidCard cfg={cfg} />
          </div>
        </div>
      ) : tab === "yaml" ? (
        <Card>
          <CardHeader title="Raw YAML" description="Edit the whole file. Validate checks it against the same rules SwitchYard uses at startup; saving keeps the previous version as a .bak file." />
          <div className="p-4">
            <YamlEditor initial={insights.readConfigText(sy)} endpoint="/api/config/raw" saveLabel="Save config" rows={32} />
          </div>
        </Card>
      ) : (
        <RulebookTab sy={sy} />
      )}
    </div>
  );
}

function RulebookTab({ sy }: { sy: import("switchyard-router").Switchyard }) {
  const rb = insights.rulebookText(sy);
  let parsed: Rulebook | null = null;
  let parseError: string | null = null;
  try {
    const p = RulebookSchema.safeParse(YAML.parse(rb.text));
    if (p.success) parsed = p.data;
    else parseError = p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  } catch (err) {
    parseError = (err as Error).message;
  }
  return (
    <div className="space-y-6">
      <Callout tone="accent" title="How scoring works">
        Every task gets points from what can be measured (its kind of work, how much code and context, how many criteria) plus, when it could change the outcome, tags from a small classifier model. The total picks the tier: T1 up to {sy.cfg.tiers.T1.max_score}, T2 up to {sy.cfg.tiers.T2.max_score}, T3 up to {sy.cfg.tiers.T3.max_score}; anything higher goes back to the supervisor. Each task&apos;s page shows its score lines.
      </Callout>
      <Card>
        <CardHeader title="Rulebook" description={rb.isDefault ? "Built-in rules (no rulebook file yet)." : `From ${rb.path}`} />
        <div className="p-4">
          {parsed ? (
            <RulebookEditor initial={parsed} isDefault={rb.isDefault} path={rb.path} />
          ) : (
            <Callout tone="bad" title="The rulebook file could not be read as a table">
              {parseError}. Fix it in the raw editor below.
            </Callout>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Rulebook as YAML" description="Fallback editor for the same rules." />
        <div className="p-4">
          <YamlEditor initial={rb.text} endpoint="/api/rulebook" saveLabel="Save rulebook" rows={24} />
        </div>
      </Card>
    </div>
  );
}

function PaidCard({ cfg }: { cfg: Record<string, unknown> }) {
  const paid = (cfg.paid ?? cfg.spend ?? null) as Record<string, unknown> | null;
  const enabled = Boolean(paid?.enabled ?? paid?.paid_fallback_enabled);
  return (
    <Card id="paid" className="opacity-90">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Lock size={14} aria-hidden /> Paid routing
            <Badge>{enabled ? "on in config" : "off"}</Badge>
          </span>
        }
        description="Paid routing is not available yet. SwitchYard only routes to models verified free; these settings are locked in the panel."
      />
      <div className="p-4 text-sm text-ink-2">
        <p>
          Spending limits and paid models cannot be edited here. {paid ? "Current values (read only):" : "No paid settings are present in the config."}
        </p>
        {paid ? <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink-3">{YAML.stringify(paid)}</pre> : null}
      </div>
    </Card>
  );
}
