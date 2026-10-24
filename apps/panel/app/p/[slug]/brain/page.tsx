import Link from "next/link";
import { BookOpenText, FileText, Inbox, Search, ShieldQuestion, Sparkles } from "lucide-react";
import { insights, type PromotionRecord, type MeritRouter } from "meritrouter";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { brainHref, jobHref, projectBase, taskHref } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, Mono, type Tone } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { RelatedPanel } from "@/components/related";
import { AgentLink, ModelLink, TaskLink } from "@/components/entity-links";
import { Markdown } from "@/components/markdown";
import { AccessDecision, BrainCreate, BrainEditor } from "@/components/client/brain";
import { BrainMemory } from "@/components/client/brain-memory";
import { Legend } from "@/components/client/charts";
import { ago, dateTime, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brain" };

type Entry = Awaited<ReturnType<typeof insights.brainTree>>[number];
type BlameLine = Awaited<ReturnType<typeof insights.brainDocumentBlame>>[number];

const KIND_LABEL: Record<string, string> = {
  working_doc: "working doc",
  report: "report",
  archive: "archive",
  lesson: "lesson",
  glossary: "glossary",
  decision: "decision",
  fact: "fact",
  repo_notes: "repo notes",
  index: "index",
  note: "note",
};

const STATUS_TONE: Record<string, Tone> = { Active: "accent", Paused: "warn", Blocked: "bad", Complete: "good", Superseded: "neutral", Archived: "neutral", Unclassified: "neutral" };

const TABS = [
  { id: "view", label: "View" },
  { id: "history", label: "History" },
  { id: "blame", label: "Blame" },
  { id: "related", label: "Related" },
  { id: "edit", label: "Edit" },
] as const;

/** The project the page shows: its slug, its base path, and its own index when the brain has one. */
type Sc = { slug: string; base: string; index: string | null };

/**
 * The documents a project's brain page lists: the project's own (`projects/<slug>/`), the
 * install-wide `global/` documents its agents read too (decision D4), and the root index.
 */
function inScope(sc: Sc, path: string): boolean {
  return insights.brainDocumentVisible(sc.slug, path);
}

function BrainAgent({ base, agent, knownAgents }: { base: string; agent: string; knownAgents: Set<string> }) {
  return knownAgents.has(agent) ? <AgentLink base={base} agent={agent} /> : <span>{agent}</span>;
}

const brainCommitHref = (slug: string, path: string, hash: string) => `${projectBase(slug)}/brain/commits/${encodeURIComponent(hash)}?path=${encodeURIComponent(path)}`;

/** The project's own index (`projects/<slug>/README.md`), regenerated like the root one. */
const projectIndexPath = (slug: string) => `projects/${slug}/README.md`;

const PROMOTION_LABEL: Record<string, string> = { pending_review: "pending review", pending_approval: "pending approval", approved: "approved", rejected: "rejected", reverted: "reverted" };
const PROMOTION_TONE: Record<string, Tone> = { pending_review: "warn", pending_approval: "warn", approved: "good", rejected: "bad", reverted: "serious" };

/** The project another project's document belongs to, for a link to it. */
function ownerOf(path: string): string | null {
  return /^projects\/([^/]+)\//.exec(path)?.[1] ?? null;
}

const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

export default async function BrainPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const p = project(sy, (await params).slug);
  const sc: Sc = { slug: p.slug, base: projectBase(p.slug), index: null };
  const brain = sy.brainFor(p.slug);
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const view = str("view") === "requests" ? "requests" : str("view") === "promotions" ? "promotions" : str("view") === "memory" ? "memory" : "docs";
  const provenanceTab = ["history", "blame", "related"].includes(str("tab"));
  const knownAgents = new Set(view === "promotions" || provenanceTab ? insights.agentsView(sy, { project: p.slug, limit: 2000 }).map(agent => agent.id) : []);
  const q = str("q").trim();

  let entries: Entry[] = [];
  let nextPage: string | null = null;
  let indexCheckedAt = 0;
  let brainError: string | null = null;
  try {
    if (view === "docs") {
      if (str("refresh") === "1") await brain.refreshIndex();
      const page = await insights.brainCatalogPage(sy, { project: p.slug, after: str("after") || undefined, limit: 50 });
      entries = page.entries;
      nextPage = page.next;
      indexCheckedAt = page.refreshedAt;
    }
  } catch (err) {
    brainError = (err as Error).message;
  }
  // With a per-project index the tree lists it instead of the root index (which only names projects).
  if (view === "docs" && brain.exists(projectIndexPath(p.slug))) {
    sc.index = projectIndexPath(p.slug);
    entries = entries.filter((e) => e.path.includes("/"));
  }
  const requests = insights.brainAccessRequests(sy, undefined, p.slug);
  const pending = requests.filter((x) => x.status === "pending");
  let promotions: PromotionRecord[] = [];
  let promotionsError: string | null = null;
  try {
    if (view === "promotions") promotions = sy.promotions({ project: p.slug });
  } catch (err) {
    promotionsError = (err as Error).message;
  }
  const waiting = promotions.filter((x) => x.status === "pending_review" || x.status === "pending_approval");
  const home = sc.index ?? (entries.some((e) => e.path === "README.md") ? "README.md" : (entries[0]?.path ?? ""));
  const path = str("path") || home;
  const tab = TABS.some((t) => t.id === str("tab")) ? (str("tab") as (typeof TABS)[number]["id"]) : "view";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Brain"
        live={["brain"]}
        description={
          <>
            This project's knowledge, plus the global documents every project's agents read: markdown documents in a git repository, each edit committed with the agent and model that made it. <HelpTip term="brain" />
          </>
        }
        actions={
          <form action={`${sc.base}/brain`} className="flex items-center gap-1.5" role="search">
            <label className="relative">
              <span className="sr-only">Search the brain</span>
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
              <input name="q" defaultValue={q} className="field w-64 pl-8" placeholder="Search documents" />
            </label>
          </form>
        }
      />

      <nav aria-label="Brain sections" className="flex flex-wrap gap-1 border-b border-line">
        <Link href={`${sc.base}/brain?view=memory`} aria-current={view === "memory" ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-2 text-sm", view === "memory" ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>Memory & preferences</Link>
        <Link href={`${sc.base}/brain`} aria-current={view === "docs" ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-2 text-sm", view === "docs" ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>
          Documents
        </Link>
        <Link href={`${sc.base}/brain?view=requests`} aria-current={view === "requests" ? "page" : undefined} className={cx("-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", view === "requests" ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>
          Access requests {pending.length ? <Badge tone="warn">{pending.length} pending</Badge> : null}
        </Link>
        <Link href={`${sc.base}/brain?view=promotions`} aria-current={view === "promotions" ? "page" : undefined} className={cx("-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", view === "promotions" ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>
          Promotions {waiting.length ? <Badge tone="warn">{waiting.length} waiting</Badge> : promotions.length ? <Badge>{promotions.length}</Badge> : null}
        </Link>
      </nav>

      {brainError ? (
        <Callout tone="bad" title="The brain repository could not be opened">
          {brainError}. Check <Mono>brain.path</Mono> in Settings ({brain.root}).
        </Callout>
      ) : null}

      {view === "memory" ? <BrainMemory project={p.slug} base={sc.base} /> : view === "requests" ? (
        <AccessRequests sc={sc} requests={requests} approver={sy.projects.get(p.slug)?.brain.access_approver ?? sy.cfg.brain.access_approver} />
      ) : view === "promotions" ? (
        <Promotions sc={sc} promotions={promotions} error={promotionsError} knownAgents={knownAgents} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[19rem_1fr]">
          <Card className="self-start lg:sticky lg:top-6">
            <CardHeader title="Documents" description={<span className="break-all">{brain.root}<br />{entries.length} documents on this page{indexCheckedAt ? ` · index checked ${ago(indexCheckedAt)}` : ""}</span>} />
            <Link prefetch={false} href={`${sc.base}/brain?refresh=1&path=${encodeURIComponent(path)}`} className="block px-3 py-2 text-xs text-accent-ink">Refresh document index</Link>
            <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-2">{entries.length ? <Tree sc={sc} entries={entries} current={q ? "" : path} project={p.slug} /> : <p className="p-2 text-sm text-ink-3">No documents yet.</p>}</div>
            {nextPage ? <Link prefetch={false} href={`${sc.base}/brain?after=${encodeURIComponent(nextPage)}`} className="block p-3 text-sm text-accent-ink">Next documents →</Link> : null}
            {str("after") ? <Link href={`${sc.base}/brain`} className="block p-3 text-sm text-accent-ink">First documents</Link> : null}
          </Card>
          <div className="min-w-0 space-y-6">
            <BrainCreate project={p.slug} base={sc.base} />
            {pending.length ? (
              <Callout tone="warn" icon={<ShieldQuestion size={16} />} title={`${pending.length} access request${pending.length === 1 ? "" : "s"} waiting`}>
                Workers asked for more brain access. <Link href={`${sc.base}/brain?view=requests`} className="font-medium text-accent-ink hover:underline">Review them →</Link>
              </Callout>
            ) : null}
            {q ? <SearchResults sc={sc} sy={sy} q={q} offset={str("searchafter")} generation={str("searchgeneration")} /> : path ? <DocPanel sc={sc} sy={sy} path={path} tab={tab} entries={entries} knownAgents={knownAgents} historyOffset={str("historyafter")} blameOffset={str("blameafter")} docOffset={str("docafter")} /> : (
              <Card>
                <EmptyState icon={<BookOpenText size={22} />} title="The brain is empty">
                  Working documents appear when a supervisor starts a job; workers add reports, and supervisors record decisions and lessons. You can also edit any document here.
                </EmptyState>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function group(e: Entry, project: string): string {
  if (e.kind === "index" || e.path === projectIndexPath(project)) return "Index";
  if (e.path.startsWith("global/lessons/")) return "Global · lessons";
  if (e.path.startsWith("global/")) return "Global";
  const m = /^projects\/([^/]+)\//.exec(e.path);
  const p = m ? (m[1] === project ? m[1] : `${m[1]}`) : null;
  const label: Record<string, string> = { working_doc: "working documents", report: "reports", archive: "archive", decision: "decisions", fact: "facts", repo_notes: "repository notes" };
  if (p) return `projects/${p} · ${label[e.kind] ?? "other notes"}`;
  return "Other";
}

const GROUP_ORDER = (g: string) => (g === "Index" ? 0 : g.startsWith("Global") ? 1 : g.includes("working documents") ? 2 : g.includes("reports") ? 3 : g.includes("decisions") ? 4 : g.includes("facts") ? 5 : g.includes("repository") ? 6 : g.includes("archive") ? 8 : 7);

function Tree({ sc, entries, current, project }: { sc: Sc; entries: Entry[]; current: string; project: string }) {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const g = group(e, project);
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const names = [...groups.keys()].sort((a, b) => GROUP_ORDER(a) - GROUP_ORDER(b) || a.localeCompare(b));
  return (
    <div className="space-y-3">
      {names.map((g) => {
        const list = groups.get(g)!;
        // Long groups (worker reports pile up) start folded unless the open document is inside.
        const folded = list.length > 6 && !list.some((e) => e.path === current);
        return (
        <details key={g} open={!folded} className="group/tree">
          <summary className="flex cursor-pointer list-none items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink">
            <span>{g}</span>
            <span className="font-normal normal-case">{list.length}</span>
          </summary>
          <ul className="space-y-0.5">
            {list.map((e) => {
              const short = e.path.replace(/^projects\/[^/]+\/(working\/)?/, "").replace(/^global\/(lessons\/)?/, "");
              return (
                <li key={e.path}>
                  <Link
                    prefetch={false} href={brainHref(sc.base, e.path)}
                    aria-current={e.path === current ? "page" : undefined}
                    className={cx("block rounded-md px-2 py-1 text-sm", e.path === current ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink")}
                    title={e.path}
                  >
                    <span className="block truncate">{e.title ?? short}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1">
                      <span className="truncate font-mono text-[10px] text-ink-3">{short}</span>
                      {e.status ? <Badge tone={STATUS_TONE[e.status] ?? "neutral"} className="!px-1.5 !py-0 !text-[10px]">{e.status}</Badge> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </details>
        );
      })}
    </div>
  );
}

async function SearchResults({ sc, sy, q, offset, generation }: { sc: Sc; sy: MeritRouter; q: string; offset: string; generation: string }) {
  let hits: Awaited<ReturnType<typeof insights.brainSearch>> = [];
  let error: string | null = null;
  let next: number | null = null;
  let indexGeneration = "";
  try {
    const page = await insights.brainSearchPage(sy, { project: sc.slug, query: q, limit: 30, offset: Number(offset) || 0, generation: generation || undefined });
    hits = page.entries;
    next = page.next;
    indexGeneration = page.generation;
  } catch (err) {
    error = (err as Error).message;
  }
  return (
    <Card>
      <CardHeader title={`Search: ${q}`} description={error ? undefined : `${hits.length} match${hits.length === 1 ? "" : "es"}, best first.`} actions={<Link href={`${sc.base}/brain`} className="text-xs text-accent-ink hover:underline">Clear search</Link>} />
      {error ? (
        <div className="p-4 text-sm text-bad-ink">{error}</div>
      ) : hits.length ? (
        <ul className="divide-y divide-line">
          {hits.map((h) => (
            <li key={h.path} className="px-4 py-3">
              <Link href={brainHref(sc.base, h.path)} className="font-medium text-accent-ink hover:underline">
                {h.title ?? h.path}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="font-mono">{h.path}</span>
                <Badge>{KIND_LABEL[h.kind] ?? h.kind}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-2">{snippet(h.snippet)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Search size={20} />} title="Nothing matched">
          Search matches whole words in titles and text. Try fewer or different words.
        </EmptyState>
      )}
      {next !== null ? <Link prefetch={false} href={`${sc.base}/brain?q=${encodeURIComponent(q)}&searchafter=${next}&searchgeneration=${indexGeneration}`} className="block p-3 text-sm text-accent-ink">More search results →</Link> : null}
    </Card>
  );
}

/** Snippets mark matches with [brackets]; show them highlighted, everything else as text. */
function snippet(s: string) {
  return s.split(/(\[[^\]]*\])/g).map((p, i) =>
    /^\[[^\]]*\]$/.test(p) ? (
      <mark key={i} className="rounded bg-warn-soft px-0.5 text-ink">
        {p.slice(1, -1)}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

async function DocPanel({ sc, sy, path, tab, entries, knownAgents, historyOffset, blameOffset, docOffset }: { sc: Sc; sy: MeritRouter; path: string; tab: string; entries: Entry[]; knownAgents: Set<string>; historyOffset: string; blameOffset: string; docOffset: string }) {
  if (!inScope(sc, path)) {
    const owner = ownerOf(path);
    return (
      <Callout tone="warn" title="Not in this project's brain">
        <Mono>{path}</Mono> belongs to {owner ? <>project <Mono>{owner}</Mono></> : "no project"}; this page shows project <Mono>{sc.slug}</Mono> and the global documents.{" "}
        {owner ? (
          <Link href={brainHref(projectBase(owner), path)} className="font-medium text-accent-ink hover:underline">
            Open it in {owner} →
          </Link>
        ) : null}
      </Callout>
    );
  }
  let doc: ReturnType<typeof insights.brainRead> | null = null;
  let error: string | null = null;
  try {
    doc = insights.brainRead(sy, path, sc.slug);
  } catch (err) {
    error = (err as Error).message;
  }
  const entry = entries.find((e) => e.path === path);
  const textOffset = Math.max(0, Math.min(doc?.content.length ?? 0, Number(docOffset) || 0));
  let history: Awaited<ReturnType<typeof insights.brainDocumentHistory>> = [];
  let historyNext: string | null = null;
  let historyError: string | null = null;
  if (doc && tab === "history") {
    try {
      const page = await insights.brainDocumentHistoryPage(sy, sc.slug, path, { cursor: historyOffset || undefined });
      history = page.entries; historyNext = page.next;
    } catch (err) { historyError = (err as Error).message; }
  }
  const related = doc && tab === "related" ? await insights.brainDocumentRelated(sy, sc.slug, path) : { tasks: [] as string[], jobs: [] as string[] };
  const agents = [...new Set(history.map(h => h.agent).filter((id): id is string => !!id))];
  const models = [...new Set(history.map(h => h.model).filter((id): id is string => !!id))];
  const href = (t: string) => `${brainHref(sc.base, path)}${t === "view" ? "" : `&tab=${t}`}`;
  return (
    <div className="space-y-6"><Card>
      <div className="border-b border-line px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <FileText size={15} className="text-ink-3" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">{entry?.title ?? path}</h2>
          {doc ? <Badge>{KIND_LABEL[doc.kind] ?? doc.kind}</Badge> : null}
          {entry?.status ? <Badge tone={STATUS_TONE[entry.status] ?? "neutral"}>{entry.status}</Badge> : null}
          {doc?.kind === "working_doc" ? <HelpTip term="workingDoc" /> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-3">
          <span className="font-mono">{path}</span>
          {doc ? <span>{doc.lines} lines</span> : null}
          {entry ? <span>changed {ago(entry.mtime)}</span> : null}
        </div>
        <nav aria-label="Document views" className="mt-2 flex gap-1">
          {TABS.map((t) => (
            <Link key={t.id} prefetch={false} href={href(t.id)} aria-current={tab === t.id ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === t.id ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:text-ink")}>
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="p-4">
        {error || !doc ? (
          <p className="text-sm text-bad-ink">{error ?? "Not found"}</p>
        ) : tab === "history" ? (
          historyError ? <p role="alert" className="text-sm text-bad-ink">History unavailable: {historyError} <Link href={href("history")} className="underline">Restart history</Link></p> : <><History rows={history} slug={sc.slug} path={path} knownAgents={knownAgents} />{historyNext !== null ? <Link prefetch={false} href={`${href("history")}&historyafter=${encodeURIComponent(historyNext)}`} className="block pt-3 text-sm text-accent-ink">Older changes →</Link> : null}</>
        ) : tab === "blame" ? (
          <Blame sy={sy} slug={sc.slug} path={path} knownAgents={knownAgents} offset={Math.max(0, Number(blameOffset) || 0)} />
        ) : tab === "related" ? (
          <p className="text-sm text-ink-3">Related task and job attribution appears below.</p>
        ) : tab === "edit" ? (
          /^(?:global\/preferences\/|projects\/[^/]+\/memory\/)/i.test(path) ? <Link href={`${sc.base}/brain?view=memory`} className="text-sm text-accent-ink">Edit typed memory in Memory & preferences →</Link> : <BrainEditor key={path} project={sc.slug} path={path} initial={doc.content} digest={doc.digest} kind={doc.kind} maxCurrentState={sy.cfg.brain.current_state_max_lines} />
        ) : (
          <>
            {doc.kind === "working_doc" ? (
              <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                <span className="inline-flex items-center gap-1">
                  Current State <HelpTip term="currentState" />
                </span>
                <span className="inline-flex items-center gap-1">
                  Work Ledger <HelpTip term="ledger" />
                </span>
              </p>
            ) : null}
            <Markdown text={doc.content.slice(textOffset, textOffset + 64_000)} basePath={path} linkBase={sc.base} />
            {textOffset + 64_000 < doc.content.length ? <Link prefetch={false} href={`${href("view")}&docafter=${textOffset + 64_000}`} className="block pt-3 text-sm text-accent-ink">Continue document →</Link> : null}
            {textOffset > 0 ? <Link prefetch={false} href={href("view")} className="block pt-3 text-sm text-accent-ink">Start of document</Link> : null}
          </>
        )}
      </div>
    </Card>
    {doc && (tab === "history" || tab === "related") ? <RelatedPanel groups={[
      { label: "Project", items: [{ key: sc.slug, node: <Link href={sc.base} className="text-accent-ink hover:underline">{sc.slug}</Link> }] },
      { label: "Commits", items: history.map(h => ({ key: h.commit, node: <Link href={brainCommitHref(sc.slug, path, h.commit)} className="font-mono text-accent-ink hover:underline">{h.commit.slice(0, 10)}</Link> })), more: { href: href("history"), label: "Document history" }, empty: "No recorded commits" },
      { label: "Agents", items: agents.map(agent => ({ key: agent, node: <BrainAgent base={sc.base} agent={agent} knownAgents={knownAgents} /> })) },
      { label: "Models", items: models.map(id => ({ key: id, node: <ModelLink id={id} /> })) },
      { label: "Tasks", items: related.tasks.map(id => ({ key: id, node: <TaskLink base={sc.base} id={id} /> })) },
      { label: "Jobs", items: related.jobs.map(id => ({ key: id, node: <Link href={jobHref(sc.base, id)} className="text-accent-ink hover:underline">{shortId(id)}</Link> })) },
    ]} /> : null}</div>
  );
}

function History({ rows, slug, path, knownAgents }: { rows: Awaited<ReturnType<typeof insights.brainDocumentHistory>>; slug: string; path: string; knownAgents: Set<string> }) {
  if (!rows.length) return <p className="text-sm text-ink-3">No commits recorded for this file. Files in mounted folders without <Mono>commit: true</Mono> are committed by you, not MeritRouter.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Commit</th>
            <th>Date</th>
            <th>Agent</th>
            <th>Model</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.commit}>
              <td className="font-mono text-xs text-ink-2"><Link href={brainCommitHref(slug, path, h.commit)} className="text-accent-ink hover:underline">{h.commit.slice(0, 10)}</Link></td>
              <td className="whitespace-nowrap text-xs">{dateTime(h.date)}</td>
              <td className="text-xs">{h.agent ? <BrainAgent base={projectBase(slug)} agent={h.agent} knownAgents={knownAgents} /> : <span className="text-ink-3">unknown</span>}</td>
              <td className="font-mono text-[11px] text-ink-2">{h.model ? <ModelLink id={h.model} /> : <span className="font-sans text-ink-3">–</span>}</td>
              <td className="text-ink">{h.subject}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Blame({ sy, slug, path, knownAgents, offset }: { sy: MeritRouter; slug: string; path: string; knownAgents: Set<string>; offset: number }) {
  let lines: BlameLine[] = [];
  try {
    lines = await insights.brainDocumentBlame(sy, slug, path, { strict: true });
  } catch (err) {
    return <p className="text-sm text-ink-3">{(err as Error).message}</p>;
  }
  if (!lines.length) return <p className="text-sm text-ink-3">This file is empty.</p>;
  const total = lines.length;
  lines = lines.slice(offset, offset + 200);
  // One colour per author (agent + model), in order of first appearance; beyond six, "Other".
  const keyOf = (l: BlameLine) => (l.uncommitted ? "uncommitted" : `${l.agent ?? l.authorName}${l.model ? ` · ${l.model}` : ""}`);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(keyOf(l), (counts.get(keyOf(l)) ?? 0) + 1);
  const authors = [...counts.keys()];
  const color = new Map(authors.map((a, i) => [a, a === "uncommitted" ? "var(--series-other)" : (SLOTS[i] ?? "var(--series-other)")]));
  const legend = authors.slice(0, 6).map((a) => ({ key: a, label: `${a} (${counts.get(a)} line${counts.get(a) === 1 ? "" : "s"})`, color: color.get(a)! }));
  if (authors.length > 6) legend.push({ key: "__other", label: `Other (${authors.length - 6} authors)`, color: "var(--series-other)" });
  return (
    <div className="space-y-3">
      <Legend series={legend} />
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[40rem] border-collapse font-mono text-xs">
          <tbody>
            {lines.map((l, i) => {
              const k = keyOf(l);
              const prev = i > 0 ? keyOf(lines[i - 1]!) + lines[i - 1]!.commit : null;
              const first = prev !== k + l.commit;
              const tip = l.uncommitted ? "Not committed yet" : !l.commit ? "Earlier attribution is outside this project's visible history" : `${l.agent ?? l.authorName} · role ${l.role ?? "?"} · model ${l.model ?? "?"} · commit ${l.commit.slice(0, 10)} · ${dateTime(l.date)}${l.task ? ` · task ${l.task}` : ""}`;
              return (
                <tr key={i} title={tip} className="group hover:bg-surface-2">
                  <td className="w-44 max-w-44 truncate border-r border-line px-2 py-0.5 font-sans text-[11px] text-ink-3" style={{ borderLeft: `4px solid ${color.get(k)}` }}>{first ? <>{l.agent ? <BrainAgent base={projectBase(slug)} agent={l.agent} knownAgents={knownAgents} /> : l.authorName} · {l.uncommitted ? "uncommitted" : !l.commit ? "earlier history" : <Link href={brainCommitHref(slug, path, l.commit)} className="text-accent-ink hover:underline">{l.commit.slice(0, 7)}</Link>}{l.task ? <> · <TaskLink base={projectBase(slug)} id={l.task} /></> : null}</> : ""}</td>
                  <td className="w-10 select-none px-2 py-0.5 text-right text-ink-3">{l.line}</td>
                  <td className="whitespace-pre-wrap px-2 py-0.5 text-ink [overflow-wrap:anywhere]">{l.text || " "}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-3">Hover a line for its commit, agent, role, and model. Colours follow the author, not the order of edits.</p>
      <p className="text-xs text-ink-3">Lines {Math.min(offset + 1, total)}–{Math.min(offset + 200, total)} of {total}. {offset + 200 < total ? <Link prefetch={false} href={`${brainHref(projectBase(slug), path)}&tab=blame&blameafter=${offset + 200}`} className="text-accent-ink">Next lines →</Link> : null}</p>
    </div>
  );
}

function AccessRequests({ sc, requests, approver }: { sc: Sc; requests: ReturnType<typeof insights.brainAccessRequests>; approver: string }) {
  const sorted = [...requests].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.createdAt - a.createdAt);
  return (
    <Card>
      <CardHeader
        title="Access requests"
        help="accessRequest"
        description={`Pending first. The configured approver is ${approver === "human" ? "you" : approver === "auto" ? "automatic (every request is approved)" : "the job's supervisor"}; you can decide any pending request here.`}
      />
      {sorted.length === 0 ? (
        <EmptyState icon={<Inbox size={22} />} title="No access requests">
          Workers ask here when their role&apos;s default brain access is not enough (for example, to write a decision).
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((x) => (
            <li key={x.id} className={cx("space-y-2 px-4 py-3", x.status !== "pending" && "opacity-80")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={x.status === "pending" ? "warn" : x.status === "approved" ? "good" : "bad"}>{x.status}</Badge>
                <span className="font-medium text-ink">{x.role}</span>
                <span className="text-ink-2">wants</span>
                <Badge tone="accent">{x.mode}</Badge>
                <span className="text-ink-2">on</span>
                <Mono>{x.pattern}</Mono>
              </div>
              <p className="text-sm text-ink-2">&ldquo;{x.reason}&rdquo;</p>
              <div className="flex flex-wrap gap-x-3 text-xs text-ink-3">
                <span>asked {dateTime(x.createdAt)}</span>
                {x.taskId ? (
                  <Link href={taskHref(sc.base, x.taskId)} className="text-accent-ink hover:underline">
                    task {shortId(x.taskId, 16)}
                  </Link>
                ) : null}
                {x.jobId ? (
                  <Link href={jobHref(sc.base, x.jobId)} className="text-accent-ink hover:underline">
                    job {shortId(x.jobId, 16)}
                  </Link>
                ) : null}
              </div>
              {x.status === "pending" ? (
                <AccessDecision id={x.id} project={sc.slug} />
              ) : (
                <p className="text-xs text-ink-3">
                  {x.status === "approved" ? "Approved" : "Denied"} by {x.decidedBy ?? "?"} {x.decidedAt ? dateTime(x.decidedAt) : ""}
                  {x.decisionReason ? `: ${x.decisionReason}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * This project's promotions to `global/` (decision D9): a supervisor's lesson checked for
 * project-specific detail, judged by an independent reviewer, and (when the install asks for it)
 * approved by a person. Approved lessons link to their global entry; rejected ones to the project
 * lesson they were saved as; reverted ones say who removed them from global/ and why.
 */
function Promotions({ sc, promotions, error, knownAgents }: { sc: Sc; promotions: PromotionRecord[]; error: string | null; knownAgents: Set<string> }) {
  const order: Record<string, number> = { pending_approval: 0, pending_review: 1, rejected: 2, approved: 3, reverted: 4 };
  const sorted = [...promotions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.created_at.localeCompare(a.created_at));
  const counts = Object.fromEntries(Object.keys(PROMOTION_LABEL).map((s) => [s, promotions.filter((x) => x.status === s).length]));
  return (
    <Card>
      <CardHeader
        title="Promotions to global knowledge"
        description={
          <>
            Lessons this project&apos;s supervisors proposed for <Mono>global/</Mono>, which every project&apos;s agents read. Each is checked for project-specific detail, then judged by an independent reviewer; a rejected lesson is kept as a project lesson with the reason.{" "}
            {Object.entries(counts)
              .filter(([, n]) => n)
              .map(([s, n]) => `${n} ${PROMOTION_LABEL[s]}`)
              .join(", ")}
          </>
        }
        actions={
          <Link href="/all/knowledge" className="text-xs text-accent-ink hover:underline">
            Global knowledge →
          </Link>
        }
      />
      {error ? (
        <div className="p-4 text-sm text-bad-ink">{error}</div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={<Sparkles size={22} />} title="No promotions yet">
          A supervisor proposes a lesson for every project when it learns something that applies beyond this one. It appears here with its review.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {sorted.map((x) => (
            <li key={x.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={PROMOTION_TONE[x.status] ?? "neutral"}>{PROMOTION_LABEL[x.status] ?? x.status}</Badge>
                <span className="font-medium text-ink">{x.title}</span>
              </div>
              <PromotionOutcome sc={sc} x={x} />
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3">
                <span>proposed {dateTime(Date.parse(x.created_at))}</span>
                <span>
                  by <BrainAgent base={sc.base} agent={x.supervisor.agent} knownAgents={knownAgents} />
                  {x.supervisor.model ? <> · <span className="font-mono">{x.supervisor.model}</span></> : null}
                </span>
                {x.supervisor.job ? (
                  <Link href={jobHref(sc.base, x.supervisor.job)} className="text-accent-ink hover:underline">
                    job {shortId(x.supervisor.job, 16)}
                  </Link>
                ) : null}
                {x.review.reviewer ? (
                  <span>
                    reviewed by {x.review.reviewer}
                    {x.review.reviewer_model ? <> · <span className="font-mono">{x.review.reviewer_model}</span></> : null}
                    {x.review.verdict ? ` (${x.review.verdict})` : ""}
                  </span>
                ) : x.review.attempts ? (
                  <span>
                    {x.review.attempts} review attempt{x.review.attempts === 1 ? "" : "s"}
                  </span>
                ) : null}
                {x.decided_by ? <span>decided by {x.decided_by}{x.decided_at ? ` ${dateTime(Date.parse(x.decided_at))}` : ""}</span> : null}
                <Link href={brainHref(sc.base, x.path)} className="text-accent-ink hover:underline">
                  record
                </Link>
              </div>
              {x.sources.length ? (
                <details className="text-xs text-ink-3">
                  <summary className="cursor-pointer hover:text-ink">
                    {x.sources.length} source{x.sources.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {x.sources.map((s) => (
                      <li key={s}>
                        {inScope(sc, s) ? (
                          <Link href={brainHref(sc.base, s)} className="font-mono text-accent-ink hover:underline">
                            {s}
                          </Link>
                        ) : (
                          <span className="font-mono">{s}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PromotionOutcome({ sc, x }: { sc: Sc; x: PromotionRecord }) {
  if (x.status === "approved")
    return (
      <p className="text-sm text-ink-2">
        In global knowledge
        {x.global_path ? (
          <>
            {" "}
            as{" "}
            <Link href={brainHref(sc.base, x.global_path)} className="font-mono text-[13px] text-accent-ink hover:underline">
              {x.global_path}
            </Link>
          </>
        ) : null}
        .{x.reason ? <span className="text-ink-3"> Note: {x.reason}</span> : null}
      </p>
    );
  if (x.status === "rejected")
    return (
      <div className="space-y-1 text-sm">
        <p className="text-ink-2">
          <span className="font-medium text-bad-ink">Not global:</span> {(x.reason ?? (x.review.reasons.join("; ") || "no reason recorded")).replace(/^not global knowledge: /i, "")}
        </p>
        {x.review.reasons.length && x.reason && !x.review.reasons.every((r) => x.reason!.includes(r)) ? (
          <ul className="list-disc pl-5 text-xs text-ink-3">
            {x.review.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {x.lesson_path ? (
          <p className="text-xs text-ink-3">
            Kept as a project lesson:{" "}
            <Link href={brainHref(sc.base, x.lesson_path)} className="font-mono text-accent-ink hover:underline">
              {x.lesson_path}
            </Link>
          </p>
        ) : null}
      </div>
    );
  if (x.status === "reverted")
    return (
      <div className="space-y-1 text-sm">
        <p className="text-ink-2">
          <span className="font-medium text-serious-ink">Reverted:</span> removed from global knowledge{x.reverted_by ? ` by ${x.reverted_by}` : ""}
          {x.reverted_at ? ` ${dateTime(Date.parse(x.reverted_at))}` : ""}
          {x.revert_reason ? <>. Why: {x.revert_reason}</> : "."}
        </p>
        {x.global_path ? (
          <p className="text-xs text-ink-3">
            It was <Mono>{x.global_path}</Mono>; its text stays in the brain&apos;s history (
            <Link href={`/all/knowledge#reverted`} className="text-accent-ink hover:underline">
              removed entries
            </Link>
            ), and it is never written again.
          </p>
        ) : null}
      </div>
    );
  if (x.status === "pending_approval")
    return (
      <p className="text-sm text-ink-2">
        The reviewer passed it; it waits for a person to approve it on{" "}
        <Link href="/all/knowledge" className="text-accent-ink hover:underline">
          Global knowledge
        </Link>
        .
      </p>
    );
  return <p className="text-sm text-ink-2">{x.reason ? `Waiting: ${x.reason}` : "An independent reviewer is judging whether it applies beyond this project."}</p>;
}
