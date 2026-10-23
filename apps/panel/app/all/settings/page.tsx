import { Tabs, pickTab } from "@/components/tabs";
import Link from "next/link";
import YAML from "yaml";
import { Globe, Network, SlidersHorizontal } from "lucide-react";
import { insights, MODALITIES, ROLE_NAMES, RulebookSchema, WEB_SEARCH_BACKENDS, type Rulebook } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { projectBase } from "@/lib/links";
import { BRAIN_SECTION, type Field, getIn, PAID_SECTION, PROFILE_FIELDS, PROFILE_HELP, ROLE_HELP, SECTIONS, SUPERVISE_PROFILE_DEFAULT, SUPERVISOR_SECTION, type Section, WEB_SECTION } from "@/lib/settings-schema";
import { SetupScreen } from "@/components/setup";
import { Callout, Card, CardHeader, cx, Mono } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { RepositoriesForm, SectionForm } from "@/components/client/settings-form";
import { RolesForm, RowsForm, type Column, type RoleValue } from "@/components/client/settings-rows";
import { ActionButton } from "@/components/client/actions";
import { YamlEditor } from "@/components/client/yaml-editor";
import { RulebookEditor } from "@/components/client/rulebook-editor";
import { SectionNav } from "@/components/client/section-nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

/** Decision D9's human approval of global lessons (an install-wide brain setting). */
const GLOBAL_APPROVAL_FIELD: Field = {
  path: ["brain", "global_requires_approval"],
  label: "Approve global lessons yourself",
  kind: "bool",
  help: "Supervisors' lessons that pass the project check and the independent review wait on the Knowledge page until you approve or reject them. Off: they are added at once, and you can revert them there.",
};

const TABS = [{ id: "general", label: "General" }, { id: "security", label: "Security" }, { id: "routing", label: "Routing" }, { id: "types", label: "Task types" }, { id: "web", label: "Web and paid" }, { id: "brain", label: "Brain and roles" }, { id: "rulebook", label: "Rulebook" }, { id: "yaml", label: "Raw YAML" }];
function sectionTab(id: string): string {
  if (id === "security") return "security";
  if (["tiers", "routing", "scoring", "qualification", "allocation", "capacity"].includes(id)) return "routing";
  if (["execution", "coding", "supervisor"].includes(id) || id.startsWith("profile-")) return "types";
  if (id.startsWith("web") || id.startsWith("paid")) return "web";
  if (id.startsWith("brain") || id === "roles") return "brain";
  return "general";
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  // With several projects, repositories live under projects.<slug> (each project's settings page).
  const multiProject = insights.globalSettings(sy).multiProject;
  const tab = pickTab(sp, TABS.map(t => t.id));
  const cfg = sy.cfg as unknown as Record<string, unknown>;
  const valuesFor = (s: Section) => Object.fromEntries(s.fields.map((f) => [f.path.join("."), getIn(cfg, f.path) as string | number | boolean | string[] | null | undefined]));
  // With several projects, project-level settings (repositories, the brain project, brain mounts and
  // access, per-project overrides) live on each project's settings page; top-level brain mounts and
  // auto-approve rules already in the file still apply to every project, so they stay editable here.
  const projects = multiProject ? insights.projectList(sy) : [];
  const brainSection: Section = multiProject
    ? { ...BRAIN_SECTION, fields: [...BRAIN_SECTION.fields.filter((f) => !["brain.project", "brain.access_approver"].includes(f.path.join("."))), GLOBAL_APPROVAL_FIELD] }
    : { ...BRAIN_SECTION, fields: [...BRAIN_SECTION.fields, GLOBAL_APPROVAL_FIELD] };
  const showMounts = !multiProject || sy.cfg.brain.mounts.length > 0;
  const showAutoApprove = !multiProject || sy.cfg.brain.auto_approve.length > 0;
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
      <Tabs items={TABS} active={tab} path="/all/settings" label="Settings sections" anchors={Object.fromEntries([...SECTIONS.map(s => s.id), ...profileSections.map(s => s.id), "repositories", "supervisor", "web", "web-limits", "paid", "paid-providers", "paid-models", "brain", "brain-mounts", "brain-auto-approve", "roles"].map(id => [id, sectionTab(id)]))} />

      {!["yaml", "rulebook"].includes(tab) ? (
        <div className="space-y-4 xl:grid xl:grid-cols-[12rem_1fr] xl:gap-6 xl:space-y-0">
          <SectionNav
            label="Settings sections"
            items={[
              ...SECTIONS.map((s) => ({ id: s.id, title: s.title })),
              multiProject ? { id: "repositories", title: "Project settings" } : { id: "repositories", title: "Repositories" },
              ...profileSections.map((s) => ({ id: s.id, title: s.title.replace("Task type: ", "Type: ") })),
              { id: "supervisor", title: "Supervisor (jobs)" },
              { id: "web", title: "Web search" },
              { id: "web-limits", title: "Web search caps" },
              { id: "paid", title: "Paid routing" },
              { id: "paid-providers", title: "Paid providers" },
              { id: "paid-models", title: "Paid models" },
              { id: "brain", title: "Brain" },
              ...(showMounts ? [{ id: "brain-mounts", title: "Brain mounts" }] : []),
              ...(showAutoApprove ? [{ id: "brain-auto-approve", title: "Auto-approve rules" }] : []),
              { id: "roles", title: "Roles" },
            ].filter(s => sectionTab(s.id) === tab)}
          />
          {/* Scroll margin clears the sticky top bar and section strip on narrow screens. */}
          <div className="min-w-0 space-y-6 [&>section[id]]:scroll-mt-28 xl:[&>section[id]]:scroll-mt-6">
            {SECTIONS.filter(s => sectionTab(s.id) === tab).map((s) => (
              <SectionForm key={s.id} section={s} values={valuesFor(s)} />
            ))}
            {tab === "general" ? <>{multiProject ? (
              <Card id="repositories">
                <CardHeader
                  title="Project settings"
                  description="This page holds settings shared by every project. Each project's own settings page holds its repositories, brain mounts and access rules, and its overrides of verification, team limits, allowed commands, protected paths, branch prefix, and roles. The values below are the defaults a project uses when it does not override them."
                />
                <ul className="flex flex-wrap gap-2 p-4 text-sm">
                  {projects.map((p) => (
                    <li key={p.slug}>
                      <Link href={`${projectBase(p.slug)}/settings`} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-accent-ink hover:bg-surface-2">
                        <SlidersHorizontal size={13} aria-hidden /> {p.name}
                      </Link>
                    </li>
                  ))}
                  {projects.length ? null : <li className="text-ink-3">No live projects.</li>}
                </ul>
              </Card>
            ) : (
              <RepositoriesForm repos={Object.entries(sy.cfg.repositories).map(([alias, v]) => ({ alias, path: v.path, writable: v.writable, resolved: sy.cfg.repositoryPaths[alias]?.path ?? "" }))} />
            )}</> : null}
            {tab === "types" ? <>{profileSections.map((s) => (
              <SectionForm key={s.id} section={s} values={valuesFor(s)} badge={sy.cfg.profiles[s.id.slice("profile-".length) as keyof typeof sy.cfg.profiles]?.mode} />
            ))}</> : null}
            {tab === "types" ? <>{!sy.cfg.profiles.supervise ? (
              <Callout tone="accent" icon={<Network size={16} />} title="Standalone jobs are off">
                <p>
                  Jobs need the <Mono>supervise</Mono> task type. Adding it writes <Mono>profiles.supervise</Mono> with the standalone preset (supervisor mode, T3 and up, models of 100B+ parameters, 30 requests); you can tune it afterwards.
                </p>
                <div className="mt-2">
                  <ActionButton url="/api/config" payload={{ patch: [{ path: ["profiles", "supervise"], value: SUPERVISE_PROFILE_DEFAULT }] }} variant="primary" small success="Added. Jobs can be started from the Jobs page.">
                    Add the supervise task type
                  </ActionButton>
                </div>
              </Callout>
            ) : null}</> : null}
            {tab === "types" ? <><SectionForm section={SUPERVISOR_SECTION} values={valuesFor(SUPERVISOR_SECTION)} /></> : null}
            {tab === "web" ? <><WebStatus sy={sy} /></> : null}
            {tab === "web" ? <><SectionForm section={WEB_SECTION} values={valuesFor(WEB_SECTION)} badge={sy.web.status().on ? "on" : "off"} /></> : null}
            {tab === "web" ? <><RowsForm
              id="web-limits"
              title="Web search caps"
              description="Optional caps per search backend, counted from SwitchYard's own record of web requests (for ollama, page fetches count too). A backend at its cap is skipped until its UTC day or month resets. Set them to your plan's allowance: SwitchYard has no built-in numbers."
              path={["web", "search", "limits"]}
              keyField="backend"
              columns={WEB_LIMIT_COLUMNS}
              rows={Object.entries(sy.cfg.web.search.limits).map(([backend, l]) => ({ backend, ...l }))}
              newRow={{ backend: "tavily" }}
              addLabel="Add cap"
              empty="No caps: backends are used until they report a limit (then they cool down)."
            /></> : null}
            {tab === "web" ? <><SectionForm section={PAID_SECTION} values={valuesFor(PAID_SECTION)} badge={sy.cfg.paid.enabled ? "on" : "off"} /></> : null}
            {tab === "web" ? <><RowsForm
              id="paid-providers"
              title="Paid providers"
              description="Providers paid models are reached through directly. Keys for them are added on the Provider keys page, never here."
              path={["paid", "providers"]}
              keyField="name"
              columns={PROVIDER_COLUMNS}
              rows={Object.entries(sy.cfg.paid.providers).map(([name, p]) => ({ name, ...p }))}
              newRow={{ name: "", kind: "openai_compatible", base_url: "", balance_api: "none" }}
              addLabel="Add provider"
              empty="No paid providers. Add one to configure paid models."
            /></> : null}
            {tab === "web" ? <><RowsForm
              id="paid-models"
              title="Paid models"
              description="Models served by the providers above. A model needs a price (set here or fetched from the provider's pricing URL) and an enabled key before it can be used."
              path={["paid", "models"]}
              columns={modelColumns(Object.keys(sy.cfg.paid.providers))}
              rows={sy.cfg.paid.models as unknown as Array<Record<string, unknown>>}
              newRow={{ provider: Object.keys(sy.cfg.paid.providers)[0] ?? "", model: "", context_limit_tokens: 128000, output_limit_tokens: 8192, input_modalities: ["text"], supports_tools: true, supports_structured_output: false, ignore_size_floor: false }}
              addLabel="Add model"
              empty="No paid models."
            /></> : null}
            {tab === "brain" ? <><SectionForm section={brainSection} values={valuesFor(brainSection)} /></> : null}
            {tab === "brain" ? <>{showMounts ? (
              <RowsForm
                id="brain-mounts"
                title={multiProject ? "Brain mounts (every project)" : "Brain mounts"}
                description={multiProject ? "Mounts set at the top of the file apply to every project. Add a project's own mounts on its settings page." : "Map a brain path prefix to an existing folder, for example a repository's docs/working, so agents read and write it as part of the brain."}
                path={["brain", "mounts"]}
                columns={MOUNT_COLUMNS}
                rows={sy.cfg.brain.mounts as unknown as Array<Record<string, unknown>>}
                newRow={{ prefix: "", path: "", commit: false }}
                addLabel="Add mount"
                empty="No mounts: everything lives in the brain repository."
              />
            ) : null}</> : null}
            {tab === "brain" ? <>{showAutoApprove ? (
              <RowsForm
                id="brain-auto-approve"
                title={multiProject ? "Auto-approve rules (every project)" : "Auto-approve rules"}
                description={multiProject ? "Rules set at the top of the file apply to every project. Add a project's own rules on its settings page." : "Access requests matching a rule are approved without asking. The rule's access level must cover what is asked, and the worker's tier must be at least the minimum."}
                path={["brain", "auto_approve"]}
                columns={AUTO_APPROVE_COLUMNS}
                rows={sy.cfg.brain.auto_approve as unknown as Array<Record<string, unknown>>}
                newRow={{ pattern: "", mode: "read", min_tier: "T1" }}
                addLabel="Add rule"
                empty="No auto-approve rules."
              />
            ) : null}</> : null}
            {tab === "brain" ? <><RolesForm roles={[...ROLE_NAMES]} values={sy.cfg.roles as Record<string, RoleValue | undefined>} help={ROLE_HELP} /></> : null}
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

/** Agents' web search now: the backend pool and its state, or how to turn it on. */
function WebStatus({ sy }: { sy: import("switchyard-router").Switchyard }) {
  const s = insights.webSearchView(sy, { recent: 0 }).status;
  return (
    <Callout tone={s.on ? "good" : "accent"} icon={<Globe size={16} />} title={s.on ? `Web search is on (${s.strategy})` : "Web search is off"}>
      {s.on ? (
        <p>
          {insights.webStatusText(s)}. Backend states and keys are on the{" "}
          <Link href="/all/keys#web-search" className="text-accent-ink hover:underline">
            Provider keys page
          </Link>
          .
        </p>
      ) : (
        <p>
          {s.reason}. To turn it on, add an <Mono>ollama-cloud</Mono> key or a Tavily, Brave, or Exa key on the{" "}
          <Link href="/all/keys#web-search" className="text-accent-ink hover:underline">
            Provider keys page
          </Link>
          , or set a SearXNG instance below.
        </p>
      )}
      {s.warnings.length ? (
        <ul className="mt-1 list-disc pl-4">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </Callout>
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

const PROVIDER_COLUMNS: Column[] = [
  { key: "name", label: "Name", kind: "text", placeholder: "openrouter", help: "Lowercase letters, digits, dashes. Used in model entries." },
  { key: "kind", label: "API style", kind: "select", options: ["openai_compatible", "anthropic"] },
  { key: "base_url", label: "Base URL", kind: "text", wide: true, placeholder: "https://openrouter.ai/api/v1" },
  { key: "pricing_url", label: "Pricing URL (optional)", kind: "optText", wide: true, placeholder: "none (prices set per model)", help: "An OpenRouter-style /models list to fetch prices from." },
  { key: "balance_api", label: "Balance API", kind: "select", options: ["none", "openrouter", "deepseek"] },
];

function modelColumns(providers: string[]): Column[] {
  return [
    { key: "provider", label: "Provider", kind: "select", options: providers },
    { key: "model", label: "Model id", kind: "text", placeholder: "anthropic/claude-sonnet-4.5" },
    { key: "display_name", label: "Display name", kind: "optText" },
    { key: "input_usd_per_million", label: "Input $ / M tokens", kind: "optNumber", placeholder: "fetch or unknown" },
    { key: "output_usd_per_million", label: "Output $ / M tokens", kind: "optNumber", placeholder: "fetch or unknown" },
    { key: "context_limit_tokens", label: "Context limit", kind: "int" },
    { key: "output_limit_tokens", label: "Output limit", kind: "int" },
    { key: "declared_parameters_b", label: "Declared size (B)", kind: "optNumber", placeholder: "not published", help: "Closed models do not publish sizes; declare one to apply size floors." },
    { key: "input_modalities", label: "Input types", kind: "multi", options: [...MODALITIES], wide: true },
    { key: "supports_tools", label: "Supports tools", kind: "bool" },
    { key: "supports_structured_output", label: "Structured output", kind: "bool" },
    { key: "ignore_size_floor", label: "Exempt from size floors", kind: "bool", help: "Lets an unsized model serve where a floor applies." },
  ];
}

const WEB_LIMIT_COLUMNS: Column[] = [
  { key: "backend", label: "Backend", kind: "select", options: [...WEB_SEARCH_BACKENDS] },
  { key: "per_day", label: "Per UTC day", kind: "optNumber", placeholder: "no cap", help: "Whole number of requests." },
  { key: "per_month", label: "Per UTC month", kind: "optNumber", placeholder: "no cap", help: "Whole number of requests." },
];

const MOUNT_COLUMNS: Column[] = [
  { key: "prefix", label: "Brain prefix", kind: "text", placeholder: "projects/demo/working" },
  { key: "path", label: "Folder", kind: "text", wide: true, placeholder: "../my-repo/docs/working", help: "Relative to the config file." },
  { key: "commit", label: "SwitchYard commits there", kind: "bool", help: "Off: you commit changes in that repository yourself." },
];

const AUTO_APPROVE_COLUMNS: Column[] = [
  { key: "pattern", label: "Path pattern", kind: "text", wide: true, placeholder: "projects/demo/facts/**" },
  { key: "mode", label: "Up to access", kind: "select", options: ["read", "append", "write", "admin"] },
  { key: "min_tier", label: "Minimum tier", kind: "select", options: ["T1", "T2", "T3"] },
];
