import Link from "next/link";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { SetupScreen } from "@/components/setup";
import { Mono, PageHeader } from "@/components/ui";
import { SectionNav } from "@/components/client/section-nav";
import { metaFor, VERIFICATION_META, type OverrideItem } from "./fields";
import { OverridesCard } from "./overrides";
import { BrainCard, GeneralCard, RepositoriesCard, SchedulingCard } from "./forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project settings" };

const NAV = [
  { id: "general", title: "General" },
  { id: "repositories", title: "Repositories" },
  { id: "brain", title: "Brain" },
  { id: "scheduling", title: "Scheduling and budgets" },
  { id: "verification", title: "Verification" },
  { id: "team", title: "Team policy" },
  { id: "commands", title: "Commands and paths" },
  { id: "roles", title: "Roles and charters" },
];

const VERIFICATION_ORDER = Object.keys(VERIFICATION_META);
const COMMAND_ORDER = ["coding.allowed_commands", "supervisor.allowed_commands", "coding.protected_paths", "supervisor.branch_prefix"];

/**
 * One project's settings (decision D2): what lives under `projects.<slug>` in the global config.
 * Every override shows the install-wide value it inherits; saving goes through
 * `insights.saveProjectSettings` (`patchProjectSettings`), so the file stays the source of truth.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  const v = insights.projectSettingsView(r.sy, p.slug);
  // Plain objects only: these cross into client components.
  const items: OverrideItem[] = v.overrides.map((o) => ({ ...metaFor(o.id), id: o.id, path: o.path, global: o.global ?? null, overridden: o.overridden, override: o.override ?? null }));
  const of = (section: string) => items.filter((i) => i.id.startsWith(`${section}.`));
  const rank = (order: string[], id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const verification = of("verification").sort((a, b) => rank(VERIFICATION_ORDER, a.id.slice("verification.".length)) - rank(VERIFICATION_ORDER, b.id.slice("verification.".length)));
  const commands = [...of("coding"), ...of("supervisor")].sort((a, b) => rank(COMMAND_ORDER, a.id) - rank(COMMAND_ORDER, b.id));
  const locked = v.legacy ? (
    <>
      This config holds a single project, so its sections are the install-wide ones: edit them in{" "}
      <Link href="/all/settings" className="text-accent-ink hover:underline">
        Settings
      </Link>
      . Adding a second project moves this one under <Mono>projects.{p.slug}</Mono>, after which it can override them.
    </>
  ) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project settings"
        description={
          <>
            {v.name}&apos;s repositories, brain, share of the worker and budgets, and the settings it overrides. Providers, models, routing, and the install-wide budgets are global: see{" "}
            <Link href="/all/settings" className="text-accent-ink hover:underline">
              Settings
            </Link>
            . Changes are validated before they are written, and running workers reload the file.
          </>
        }
      />
      <div className="space-y-4 xl:grid xl:grid-cols-[12rem_1fr] xl:gap-6 xl:space-y-0">
        <SectionNav label="Project settings sections" items={NAV} />
        {/* Scroll margin clears the sticky top bar and section strip on narrow screens. */}
        <div className="min-w-0 space-y-6 [&>section[id]]:scroll-mt-28 xl:[&>section[id]]:scroll-mt-6">
          <GeneralCard slug={p.slug} name={v.name} legacy={v.legacy} configPath={v.configPath} keyPath={v.configKeyPath.join(".")} activity={v.activity} />
          <RepositoriesCard slug={p.slug} rows={v.repositoryRows} />
          <BrainCard slug={p.slug} legacy={v.legacy} globalMounts={v.mounts.global} mounts={v.mounts.project} items={of("brain")} />
          <SchedulingCard slug={p.slug} legacy={v.legacy} limits={v.limits} />
          <OverridesCard
            id="verification"
            slug={p.slug}
            title="Verification"
            description="How this project's results are checked: importance, levels, review, and acceptance. A project value is merged onto the global policy (lists replace)."
            items={verification}
            locked={locked}
          />
          <OverridesCard id="team" slug={p.slug} title="Team policy" description="How this project's jobs grow: agents per job, sub-supervisors, and the team channel. Provider concurrency stays global." items={of("team")} locked={locked} />
          <OverridesCard
            id="commands"
            slug={p.slug}
            title="Commands and paths"
            description="What this project's coding workers and supervisors may run, which files they may not weaken, and the branch its jobs commit to."
            items={commands}
            locked={locked}
          />
          <OverridesCard id="roles" slug={p.slug} title="Roles and charters" description="Each role's charter, extra rules, and brain grants in this project. A role set here replaces the global entry for that role." items={of("roles")} locked={locked} />
        </div>
      </div>
    </div>
  );
}
