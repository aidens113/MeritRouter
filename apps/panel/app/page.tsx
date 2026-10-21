import Link from "next/link";
import { Archive, CircleAlert, Clock, FolderGit2, FolderPlus, Network, Plus } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Badge, buttonClass, Card, EmptyState, PageHeader } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { ago, dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

type ProjectCard = insights.ProjectCard;

function Count({ n, label, tone }: { n: number; label: string; tone?: "live" | "queued" }) {
  return (
    <div className="min-w-0">
      <div className={tone === "live" && n ? "text-lg font-semibold text-good-ink" : tone === "queued" && n ? "text-lg font-semibold text-warn-ink" : "text-lg font-semibold text-ink"}>{n}</div>
      <div className="truncate text-[11px] text-ink-3">{label}</div>
    </div>
  );
}

function ProjectTile({ p, now }: { p: ProjectCard; now: number }) {
  const live = p.runningTasks > 0;
  return (
    <li className="min-w-0">
      <Link
        href={projectBase(p.slug)}
        className="group flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-accent/50 hover:bg-surface-2/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
            <FolderGit2 size={16} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-ink group-hover:text-accent-ink">{p.name}</h2>
            <div className="truncate font-mono text-[11px] text-ink-3">
              {p.slug}
              {p.primary ? " · primary" : ""}
            </div>
          </div>
          {p.attention ? (
            <Badge tone="warn" icon={<CircleAlert size={11} />} title={p.attentionItems.join("\n")}>
              {p.attention} need{p.attention === 1 ? "s" : ""} you
            </Badge>
          ) : live ? (
            <Badge tone="good">running</Badge>
          ) : null}
        </div>

        <ul className="mt-3 space-y-1 text-xs">
          {p.repositories.length ? (
            p.repositories.slice(0, 4).map((r) => (
              <li key={r.alias} className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-mono text-ink">{r.alias}</span>
                <span className="truncate font-mono text-ink-3" title={r.path}>
                  {r.path}
                </span>
                {r.exists ? null : <Badge tone="bad" className="!py-0">missing</Badge>}
              </li>
            ))
          ) : (
            <li className="text-ink-3">No repositories</li>
          )}
          {p.repositories.length > 4 ? <li className="text-ink-3">and {p.repositories.length - 4} more</li> : null}
        </ul>

        <div className="mt-4 grid grid-cols-4 gap-2 border-t border-line pt-3">
          <Count n={p.runningJobs} label="jobs running" tone="live" />
          <Count n={p.queuedJobs} label="jobs queued" tone="queued" />
          <Count n={p.runningTasks} label="tasks running" tone="live" />
          <Count n={p.queuedTasks} label="tasks queued" tone="queued" />
        </div>

        {p.attentionItems.length ? <p className="mt-3 line-clamp-2 text-xs text-warn-ink">{p.attentionItems[0]}</p> : null}

        <div className="mt-auto flex items-center gap-1.5 pt-3 text-[11px] text-ink-3" title={p.lastActivityAt ? dateTime(p.lastActivityAt) : undefined}>
          <Clock size={12} aria-hidden /> {p.lastActivityAt ? `active ${ago(p.lastActivityAt, now)}` : "no activity yet"}
        </div>
      </Link>
    </li>
  );
}

/** The starting screen: every project as a card, "New project", and the archived ones. */
export default async function ProjectsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const all = insights.projectsGrid(r.sy, { includeArchived: true });
  const live = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);
  const now = Date.now();
  const busy = live.some((p) => p.runningTasks + p.queuedTasks > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Each project has its own repositories, jobs, tasks, sessions, and knowledge. Providers, models, routing, and budgets are shared by all of them."
        actions={
          <>
            {busy ? <AutoRefresh seconds={8} /> : null}
            <Link href="/new" className={buttonClass("primary")}>
              <Plus size={15} aria-hidden /> New project
            </Link>
          </>
        }
      />

      {live.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects">
          {live.map((p) => (
            <ProjectTile key={p.slug} p={p} now={now} />
          ))}
          <li>
            <Link href="/new" className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong p-4 text-sm text-ink-2 hover:border-accent/60 hover:text-accent-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <FolderPlus size={22} aria-hidden />
              New project
            </Link>
          </li>
        </ul>
      ) : (
        <Card>
          <EmptyState
            icon={<Network size={22} />}
            title="No projects yet"
            action={
              <Link href="/new" className={buttonClass("primary")}>
                <Plus size={15} aria-hidden /> Create your first project
              </Link>
            }
          >
            A project groups the repositories SwitchYard works in with their jobs, tasks, and knowledge.
          </EmptyState>
        </Card>
      )}

      {archived.length ? (
        <details className="group rounded-xl border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-ink-2 hover:text-ink">
            <Archive size={15} aria-hidden /> Archived projects <Badge>{archived.length}</Badge>
            <span className="ml-auto text-xs font-normal text-ink-3">kept with their history; hidden from the switcher</span>
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {archived.map((p) => (
              <li key={p.slug} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink">{p.name}</div>
                  <div className="font-mono text-[11px] text-ink-3">
                    {p.slug}
                    {p.archivedAt ? ` · archived ${ago(p.archivedAt, now)}` : ""}
                  </div>
                </div>
                <ActionButton url={`/api/projects/${encodeURIComponent(p.slug)}`} method="PATCH" payload={{ archived: false }} small success="Unarchived">
                  Unarchive
                </ActionButton>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
