import { RelatedPanel } from "@/components/related";
import { AgentLink, CommitLink, ModelLink, RequestLink, TaskLink } from "@/components/entity-links";
import { Tabs, pickTab } from "@/components/tabs";
import { Disclosure } from "@/components/disclosure";
import Link from "next/link";

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FileWarning } from "lucide-react";
import { insights, type SessionEvent, type MeritRouter } from "meritrouter";
import { jobHref, repoHref, sessionHref } from "@/lib/links";
import type { DetailScope } from "@/components/detail-scope";
import { buttonClass, Callout, Card, CardHeader, cx, KeyValue, Mono, Stat } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ActionButton } from "@/components/client/actions";
import { roleLabel, SessionStatusBadge, SessionsTable, sessionTaskHref } from "@/components/sessions-table";
import { SessionTimeline } from "@/components/session-timeline";
import { dateTime, duration, humanize, num } from "@/lib/format";

/** Events per page of the timeline (`?limit=` may ask for 20 to 1000). */
const PAGE = 200;

type Outcome = Extract<SessionEvent, { type: "tool_outcome" }>;

/**
 * One session's page: its event timeline (paged), the task's other sessions, and its children.
 * The caller has checked that the session belongs to `scope.project`.
 */
export function SessionDetailView({ sy, id, sp, scope }: { sy: MeritRouter; id: string; sp: Record<string, string | string[] | undefined>; scope: DetailScope }) {
  const base = scope.base;
  const rawAfter = typeof sp.after === "string" ? Number(sp.after) : 0;
  const after = Number.isInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const rawLimit = typeof sp.limit === "string" ? Number(sp.limit) : PAGE;
  const limit = Number.isInteger(rawLimit) ? Math.min(1000, Math.max(20, rawLimit)) : PAGE;

  const d = insights.sessionDetail(sy, id, { afterSeq: after, limit, project: scope.project });
  if (!d) notFound();
  const s = d.session;
  const running = s.status === "running";
  const now = Date.now();
  const requests = insights.sessionRequests(sy, s.id);

  // Outcomes for intents on this page that were written after it (only when the page is cut off).
  const laterOutcomes = new Map<number, Outcome>();
  const lastOnPage = d.events.at(-1)?.seq ?? after;
  if (d.hasMore) {
    const outcomesOnPage = new Set(d.events.flatMap((e) => (e.type === "tool_outcome" ? [e.data.intentSeq] : [])));
    const open = new Set(d.events.flatMap((e) => (e.type === "tool_intent" && !outcomesOnPage.has(e.seq) ? [e.seq] : [])));
    if (open.size) {
      const rest = insights.sessionDetail(sy, id, { afterSeq: lastOnPage, limit: 10_000, project: scope.project });
      for (const e of rest?.events ?? []) if (e.type === "tool_outcome" && open.has(e.data.intentSeq)) laterOutcomes.set(e.data.intentSeq, e);
    }
  }

  const self = sessionHref(base, s.id);
  const at = (afterSeq: number) => {
    const qs = new URLSearchParams();
    if (afterSeq > 0) qs.set("after", String(afterSeq));
    if (limit !== PAGE) qs.set("limit", String(limit));
    return qs.size ? `${self}?${qs}` : self;
  };
  const pageHref = (seq: number) => at(seq - 1);
  const firstOnPage = d.events[0]?.seq ?? after + 1;
  const prevAfter = Math.max(0, after - limit);
  const lastAfter = Math.max(0, s.lastSeq - limit);
  const paged = after > 0 || d.hasMore;
  const previous = s.previousSessionId ? d.taskSessions.find((t) => t.id === s.previousSessionId) : undefined;
  const next = d.taskSessions.find((t) => t.previousSessionId === s.id);
  const href = sessionTaskHref(s, base);
  // Intents without an outcome on this page, less those a resume settled.
  const settledByResume = d.events.reduce((n, e) => n + (e.type === "resumed" ? e.data.resolvedIntentSeqs.length : 0), 0);
  const unanswered = d.events.filter((e) => e.type === "tool_intent").length - d.events.filter((e) => e.type === "tool_outcome").length - settledByResume;
  const taskState = s.taskId ? (sy.tasks.get(s.taskId)?.row.state ?? null) : null;

  const pager = paged ? (
    <nav aria-label="Event pages" className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs text-ink-3">
        Events {d.events.length ? `${firstOnPage}–${lastOnPage}` : "none"} of {s.lastSeq}
      </span>
      <PageLink href={at(0)} disabled={after === 0} label="First page">
        <ChevronsLeft size={13} aria-hidden />
      </PageLink>
      <PageLink href={at(prevAfter)} disabled={after === 0} label="Earlier events">
        <ChevronLeft size={13} aria-hidden /> Earlier
      </PageLink>
      <PageLink href={at(lastOnPage)} disabled={!d.hasMore} label="Later events">
        Later <ChevronRight size={13} aria-hidden />
      </PageLink>
      <PageLink href={at(lastAfter)} disabled={!d.hasMore} label="Last page">
        <ChevronsRight size={13} aria-hidden />
      </PageLink>
    </nav>
  ) : null;

  const tab = pickTab(sp, ["timeline", "details", "requests"]);
  return (
    <div className="space-y-6">
      <Link href={scope.back.href} className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> {scope.back.label}
      </Link>
      <PageHeader
        title={`${roleLabel(s.role)} session`}
        live={[`sessions:${s.id}`]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SessionStatusBadge status={s.status} />
            {s.profile ? <span className="text-xs text-ink-2">{s.profile} task{s.tier ? ` · ${s.tier}` : ""}</span> : null}
            <Mono>{s.id}</Mono>
          </span>
        }
        actions={
          !running && scope.actions && s.resumable ? (
            <ActionButton url={`/api/sessions/${encodeURIComponent(s.id)}/resume`} payload={{ project: scope.project }} variant="primary" success="Requeued: a running worker continues this session where it stopped">
              Resume session
            </ActionButton>
          ) : null
        }
      />
      {s.status === "interrupted" || s.status === "failed" || s.status === "cancelled" ? (
        <Callout tone={s.status === "failed" ? "bad" : s.status === "interrupted" ? "serious" : "neutral"} title={s.status === "failed" ? "This session failed" : s.status === "interrupted" ? "This session stopped before it finished" : "This session was cancelled"}>
          {s.stopReason ? `${humanize(s.stopReason).replace(/\.?$/, ".")} ` : ""}
          {next ? (
            <>
              The task ran again in{" "}
              <Link href={sessionHref(base, next.id)} className="font-medium text-accent-ink hover:underline">
                a later session
              </Link>
              .
            </>
          ) : s.resumable ? (
            "Resume it to continue where it stopped: its transcript is restored, any tool call that was in flight is settled first (edits committed as recovered, delegations re-run, unknown outcomes reported to the agent), and a running worker picks it up."
          ) : s.status === "interrupted" ? (
            <>
              Its log ends at the last event written before it stopped.
              {taskState && taskState !== "interrupted" ? ` Its task is now ${humanize(taskState).toLowerCase()}, so this session cannot be resumed.` : taskState === "interrupted" ? " A later session of its task is the one to resume." : ""}
            </>
          ) : null}
        </Callout>
      ) : null}
      {d.corrupt.length ? (
        <Callout tone="warn" icon={<FileWarning size={16} />} title={`${d.corrupt.length} unreadable log line${d.corrupt.length === 1 ? "" : "s"} skipped`}>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
            {d.corrupt.slice(0, 10).map((c) => (
              <li key={c.line}>
                {c.line === 0 ? "log file" : `line ${c.line}`}: {c.error.slice(0, 160)}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={running ? "Active so far" : "Duration"} value={duration(s.durationMs)} sub={s.endedAt ? `ended ${dateTime(s.endedAt)}` : `last event ${dateTime(s.updatedAt)}`} />
        <Stat label="Model requests" value={num(s.modelRequests)} sub="requests sent through the gate" />
        <Stat label="Tool calls" value={num(s.toolCalls)} sub={unanswered > 0 && !d.hasMore && after === 0 ? `${unanswered} without an outcome` : "intents written before each call"} tone={unanswered > 0 && !running && !d.hasMore && after === 0 ? "warn" : undefined} />
        <Stat label="Events" value={num(s.lastSeq)} sub="lines in the session log" />
      </div>
      <RelatedPanel groups={[
        { label: "Task", items: s.taskId ? [{ key: s.taskId, node: <TaskLink base={base} id={s.taskId} label={s.taskLabel} job={s.profile === "supervise"} /> }] : [] },
        { label: "Job", items: s.jobId ? [{ key: s.jobId, node: <TaskLink base={base} id={s.jobId} job /> }] : [] },
        { label: "Agent", items: [{ key: s.agentLabel, node: <AgentLink base={base} agent={s.agentLabel} /> }] },
        { label: "Related runs", items: [s.parentSessionId, s.previousSessionId, next?.id].filter((id): id is string => !!id).map(id => ({ key: id, node: <Link href={sessionHref(base, id)} className="font-mono text-xs text-accent-ink hover:underline">{id}</Link> })) },
        { label: "Requests", items: requests.map(r => ({ key: r.id, node: <RequestLink base={base} id={r.id} /> })) },
        { label: "Models", items: [...new Set(requests.map(r => r.endpointId).filter((id): id is string => !!id))].map(id => ({ key: id, node: <ModelLink id={id} /> })) }
      ]} />
      {d.timelineUnavailable ? <Callout tone="warn" title="Historical timeline unavailable">{d.timelineUnavailable}</Callout> : null}
      <Tabs items={[{ "id": "timeline", "label": "Timeline" }, { "id": "details", "label": "Details" }, { "id": "requests", "label": "Requests" }]} active={tab} path={self} label="Page sections" keep={{ after: typeof sp.after === "string" ? sp.after : undefined, limit: typeof sp.limit === "string" ? sp.limit : undefined }} anchors={{}} />
      {tab === "timeline" ? <div className="space-y-6"><Card>
        <CardHeader
          title="Event log"
          help="toolJournal"
          description="Everything the session wrote, in order. Each tool call shows its intent (written before it ran) with its outcome (written after). Open an event to see the raw record."
          actions={pager}
        />
        <div className="p-4">
          {d.events.length ? (
            <SessionTimeline events={d.events} startedAt={s.createdAt} running={running} laterOutcomes={laterOutcomes} pageHref={pageHref} />
          ) : (
            <p className="text-sm text-ink-3">{after > 0 ? "No events after this point." : "The log has no readable events."}</p>
          )}
        </div>
        {pager ? <div className="flex justify-end border-t border-line px-4 py-3">{pager}</div> : null}
      </Card></div> : null}
      {tab === "details" ? <div className="space-y-6"><div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Details" help="session" />
          <div className="p-4">
            <KeyValue
              items={[
                ["Agent", <AgentLink key="a" base={base} agent={s.agentLabel} />],
                ["Role", roleLabel(s.role)],
                [
                  "Task",
                  href ? (
                    <Link key="t" href={href} className="text-accent-ink hover:underline">
                      {s.taskLabel ?? <span className="font-mono text-xs">{s.taskId}</span>}
                      {s.profile === "supervise" ? " (job)" : ""}
                    </Link>
                  ) : (
                    <span key="t" className="text-ink-3">none</span>
                  ),
                ],
                ...(s.jobId && s.jobId !== s.taskId
                  ? ([
                    [
                      "Job",
                      <Link key="j" href={jobHref(base, s.jobId)} className="font-mono text-xs text-accent-ink hover:underline">
                        {s.jobId}
                      </Link>,
                    ],
                  ] as Array<[string, ReactNode]>)
                  : []),
                [
                  "Spawned by",
                  s.parentSessionId ? (
                    <Link key="p" href={sessionHref(base, s.parentSessionId)} className="font-mono text-xs text-accent-ink hover:underline">
                      {s.parentSessionId}
                    </Link>
                  ) : (
                    <span key="p" className="text-ink-3">nothing (started directly)</span>
                  ),
                ],
                ...(s.previousSessionId
                  ? ([
                    [
                      "Previous run",
                      <span key="prev" className="inline-flex flex-wrap items-center gap-2">
                        <Link href={sessionHref(base, s.previousSessionId)} className="font-mono text-xs text-accent-ink hover:underline">
                          {s.previousSessionId}
                        </Link>
                        {previous ? <SessionStatusBadge status={previous.status} /> : null}
                      </span>,
                    ],
                  ] as Array<[string, ReactNode]>)
                  : []),
                ...(next
                  ? ([
                    [
                      "Next run",
                      <span key="next" className="inline-flex flex-wrap items-center gap-2">
                        <Link href={sessionHref(base, next.id)} className="font-mono text-xs text-accent-ink hover:underline">
                          {next.id}
                        </Link>
                        <SessionStatusBadge status={next.status} />
                      </span>,
                    ],
                  ] as Array<[string, ReactNode]>)
                  : []),
                ["Started", dateTime(s.createdAt)],
                ["Ended", s.endedAt ? dateTime(s.endedAt) : running ? "still running" : "–"],
                ...(s.stopReason ? ([["Stopped because", humanize(s.stopReason)]] as Array<[string, ReactNode]>) : []),
                ["Log file", <Mono key="l" className="break-all">{s.logPath}</Mono>],
              ]}
            />
          </div>
        </Card>
        <div className="space-y-6">
          {s.workspace?.repos.length ? (
            <Card>
              <CardHeader title="Workspace" description="Where this session works, and the last commit it made there." />
              <div className="space-y-3 p-4 text-sm">
                {s.workspace.repos.map((w) => (
                  <KeyValue
                    key={w.alias}
                    items={[
                      ["Repository", repoHref(base, w.alias) ? <Link key="r" href={repoHref(base, w.alias)!} className="text-accent-ink hover:underline">{w.alias}</Link> : w.alias],
                      ["Branch", w.branch ? <Mono key="b">{w.branch}</Mono> : "–"],
                      ["Base commit", w.baseCommit ? <CommitLink key="c" base={base} repository={w.alias} sha={w.baseCommit}>{w.baseCommit.slice(0, 12)}</CommitLink> : "–"],
                      ["Last commit", w.head ? <CommitLink key="h" base={base} repository={w.alias} sha={w.head}>{w.head.slice(0, 12)}</CommitLink> : "none yet"],
                      ["Worktree", <Mono key="w" className="break-all">{w.worktree}</Mono>],
                    ]}
                  />
                ))}
              </div>
            </Card>
          ) : null}
          {d.taskSessions.length > 1 ? (
            <Card>
              <CardHeader title="Runs of this task" description="Each attempt (a retry, an escalation, or a recovery) is its own session, oldest first." />
              <ol className="divide-y divide-line">
                {d.taskSessions.map((t, i) => (
                  <li key={t.id} className={cx("flex flex-wrap items-center gap-2 px-4 py-2 text-sm", t.id === s.id && "bg-accent-soft/50")}>
                    <span className="tabular w-5 text-xs text-ink-3">{i + 1}.</span>
                    {t.id === s.id ? (
                      <span className="font-medium text-ink">{roleLabel(t.role)} (this session)</span>
                    ) : (
                      <Link href={sessionHref(base, t.id)} className="font-medium text-accent-ink hover:underline">
                        {roleLabel(t.role)}
                      </Link>
                    )}
                    {t.tier ? <span className="text-xs text-ink-3">{t.tier}</span> : null}
                    <SessionStatusBadge status={t.status} />
                    <span className="ml-auto text-xs text-ink-3">{dateTime(t.createdAt)}</span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      </div>
        {d.children.length ? (
          <Card>
            <CardHeader title="Spawned sessions" description="Sessions this agent started by delegating work, oldest first." />
            <SessionsTable rows={d.children} base={base} now={now} />
          </Card>
        ) : null}</div> : null}
      {tab === "requests" ? <div className="space-y-6"><Card><CardHeader title="Model requests" /><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Request</th><th>Model</th><th>Status</th><th>Time</th></tr></thead><tbody>{requests.map(r => <tr key={r.id}><td><Link className="font-mono text-xs text-accent-ink hover:underline" href={"/requests/" + encodeURIComponent(r.id)}>{r.id}</Link></td><td>{r.endpointId ? <Link className="text-accent-ink hover:underline" href={"/all/models/detail?id=" + encodeURIComponent(r.endpointId)}>{r.servedModel ?? r.endpointId}</Link> : "-"}</td><td>{r.status}</td><td>{dateTime(r.reservedAt)}</td></tr>)}</tbody></table>{!requests.length ? <p className="p-4 text-sm text-ink-3">No requests recorded for this session.</p> : null}</div></Card></div> : null}
    </div>
  );
}

function PageLink({ href, disabled, label, children }: { href: string; disabled: boolean; label: string; children: ReactNode }) {
  if (disabled) {
    return (
      <span aria-disabled className={cx(buttonClass("secondary", true), "cursor-not-allowed opacity-40")} title={label}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={buttonClass("secondary", true)} title={label} aria-label={label}>
      {children}
    </Link>
  );
}
