import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { SetupScreen } from "@/components/setup";
import { Callout, Card, CardHeader, KeyValue, Mono, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project settings" };

/**
 * Placeholder (J2 step 1): this project's settings, read only. Editing them (repositories, brain
 * mounts, and per-project overrides through `insights.patchProjectSettings`) arrives with j2-project.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const p = project(r.sy, (await params).slug);
  const s = insights.projectSettings(r.sy, p.slug);
  const overrides = Object.entries(s.raw ?? {}).filter(([k]) => k !== "repositories" && k !== "name");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Project settings"
        description={
          <>
            Settings of <Mono>{p.slug}</Mono>, stored in <Mono>{s.configPath}</Mono>
            {s.configKeyPath.length ? <> under <Mono>{s.configKeyPath.join(".")}</Mono></> : " at the top level (a single-project config)"}. Providers, models, routing, and budgets are install-wide: see <Link href="/all/settings" className="text-accent-ink hover:underline">Settings</Link>.
          </>
        }
      />
      <Callout tone="accent" icon={<SlidersHorizontal size={16} />} title="Read only for now">
        Editing this project&apos;s repositories, brain mounts, and overrides from the panel comes next. Until then, edit the config file; running workers reload it.
      </Callout>
      <Card>
        <CardHeader title="Project" />
        <div className="p-4">
          <KeyValue
            items={[
              ["Name", s.name],
              ["Slug", <Mono key="s">{s.slug}</Mono>],
              ["Repositories", p.repositories.length ? p.repositories.map((x) => `${x.alias} (${x.writable ? "writable" : "read only"}): ${x.path}`).join("; ") : "none"],
              ["Overrides", overrides.length ? overrides.map(([k]) => k).join(", ") : "none: every section uses the install-wide value"],
            ]}
          />
        </div>
      </Card>
      {overrides.length ? (
        <Card>
          <CardHeader title="Overrides as written" description="This project's own values; every other setting is the install-wide one." />
          <pre className="overflow-x-auto p-4 font-mono text-xs text-ink-2">{JSON.stringify(Object.fromEntries(overrides), null, 2)}</pre>
        </Card>
      ) : null}
    </div>
  );
}
