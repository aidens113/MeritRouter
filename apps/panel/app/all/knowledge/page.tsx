import Link from "next/link";
import { BookOpenText, CheckCircle2, Clock, GitCommitHorizontal, History, ShieldCheck, Undo2, UserCheck } from "lucide-react";
import { insights } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { ALL, brainHref, projectBase } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Markdown } from "@/components/markdown";
import { Badge, Callout, Card, CardHeader, EmptyState, Mono, type Tone } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ago, dateTime, shortId } from "@/lib/format";
import { PromotionDecision, RevertEntry } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Knowledge" };

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_review: { label: "Waiting for review", tone: "neutral" },
  pending_approval: { label: "Waiting for you", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  reverted: { label: "Reverted", tone: "serious" },
};

const VERDICT_TONE: Record<string, Tone> = { pass: "good", fail: "bad", inconclusive: "warn" };

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

export default async function KnowledgePage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const k = await insights.globalKnowledge(sy);
  const promotions = insights.promotionsView(sy);
  const live = new Map(insights.projectList(sy).map((p) => [p.slug, p.name]));
  const now = Date.now();
  // Global files open on a live project's Brain page (every project's brain shows global/).
  const viewer = live.has(sy.projects.primary.project.slug) ? sy.projects.primary.project.slug : ([...live.keys()][0] ?? null);
  const viewBase = viewer ? projectBase(viewer) : null;

  const awaiting = promotions.filter((p) => p.awaitingPerson);
  const reviewing = promotions.filter((p) => p.status === "pending_review" && !p.awaitingPerson);
  const decided = promotions.filter((p) => p.status === "approved" || p.status === "rejected" || p.status === "reverted").slice(0, 12);
  // Promotion records by project and id, so a removed entry shows its record's status.
  const records = new Map(promotions.map((p) => [`${p.project}/${p.id}`, p]));

  /** A project name linking to its overview (plain text for an archived or unknown project). */
  const projectLink = (slug: string | null) =>
    !slug ? (
      <span className="text-ink-3">unknown project</span>
    ) : live.has(slug) ? (
      <Link href={projectBase(slug)} className="text-accent-ink hover:underline">
        {live.get(slug)}
      </Link>
    ) : (
      <span title="archived or no longer configured">{slug}</span>
    );

  /** A brain path linking to its document on the owning project's Brain page (global paths on the viewer project's). */
  const sourceLink = (p: string) => {
    const owner = /^projects\/([^/]+)\//.exec(p)?.[1] ?? null;
    const base = owner ? (live.has(owner) ? projectBase(owner) : null) : viewBase;
    return base ? (
      <Link key={p} href={brainHref(base, p)} className="break-all font-mono text-[11px] text-accent-ink hover:underline">
        {p}
      </Link>
    ) : (
      <span key={p} className="break-all font-mono text-[11px] text-ink-3">
        {p}
      </span>
    );
  };

  const reviewLine = (rv: { verdict: string | null; reviewer: string | null; reviewerModel: string | null; reasons: string[] } | null) =>
    rv && rv.verdict ? (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone={VERDICT_TONE[rv.verdict] ?? "neutral"} icon={<ShieldCheck size={11} />}>
          Review: {rv.verdict}
        </Badge>
        <span className="text-ink-2">
          by <Mono>{rv.reviewerModel ?? rv.reviewer ?? "unknown model"}</Mono>
          {rv.reviewer && rv.reviewerModel && rv.reviewer !== rv.reviewerModel ? <span className="text-ink-3"> ({rv.reviewer})</span> : null}
        </span>
      </span>
    ) : (
      <span className="text-ink-3">No independent review recorded</span>
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Global knowledge: lessons and terms the agents of every project read. Only supervisors add to it, and only after a check that the lesson names nothing of its project and an independent review on another model. You can approve, reject, and revert."
      />

      <Callout tone={k.requiresApproval ? "accent" : "neutral"} icon={<UserCheck size={16} />} title={k.requiresApproval ? "Promotions wait for your approval" : "Promotions that pass review land without you"}>
        {k.requiresApproval ? (
          <>A supervisor&apos;s lesson that passes the check and the review waits below until you approve or reject it (<Mono>brain.global_requires_approval</Mono> is on).</>
        ) : (
          <>
            A supervisor&apos;s lesson that passes the check and the review is added at once; you can revert it here. To decide each one yourself, turn on <Mono>brain.global_requires_approval</Mono> in{" "}
            <Link href={`${ALL}/settings#brain`} className="text-accent-ink hover:underline">
              Settings
            </Link>
            .
          </>
        )}
      </Callout>

      <Card id="pending" className={awaiting.length ? "border-warn/40" : undefined}>
        <CardHeader
          title={
            <>
              Waiting for you {awaiting.length ? <Badge tone="warn">{awaiting.length}</Badge> : null}
            </>
          }
          description="Promotions a person decides: passed review and waiting for approval, or with no review running (no eligible reviewer, or reviews that did not settle). Rejected lessons stay in their project with your reason."
        />
        {awaiting.length ? (
          <ul className="divide-y divide-line">
            {awaiting.map((p) => (
              <li key={`${p.project}/${p.id}`} className="space-y-2.5 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{p.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                      <span>From {projectLink(p.project)}</span>
                      <span>
                        by <Mono>{p.supervisor.agent}</Mono>
                        {p.supervisor.model ? (
                          <>
                            {" "}
                            on <Mono>{p.supervisor.model}</Mono>
                          </>
                        ) : null}
                      </span>
                      <span title={p.created_at}>{ago(ms(p.created_at), now)}</span>
                    </div>
                  </div>
                  <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {reviewLine(p.review.verdict ? { verdict: p.review.verdict, reviewer: p.review.reviewer, reviewerModel: p.review.reviewer_model, reasons: p.review.reasons } : null)}
                  {p.review.attempts ? <span className="text-ink-3">{p.review.attempts} review attempt{p.review.attempts === 1 ? "" : "s"}</span> : null}
                </div>
                {p.reason ? <p className="text-xs text-ink-2">{p.reason}</p> : null}
                {p.review.reasons.length ? (
                  <ul className="list-disc pl-5 text-xs text-ink-2">
                    {p.review.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
                  <Markdown text={p.body} basePath={p.path} linkBase={projectBase(p.project)} />
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-ink-3">
                  <span>Sources:</span>
                  {p.sources.map(sourceLink)}
                </div>
                <PromotionDecision project={p.project} id={p.id} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing waits for you">
            {reviewing.length ? `${reviewing.length} promotion${reviewing.length === 1 ? " is" : "s are"} under review now.` : "No promotion is waiting for a decision."}
          </EmptyState>
        )}
        {reviewing.length && awaiting.length ? (
          <p className="border-t border-line px-4 py-2 text-xs text-ink-3">
            {reviewing.length} more under review: {reviewing.map((p) => p.title).join("; ")}.
          </p>
        ) : null}
      </Card>

      <Card id="lessons">
        <CardHeader
          title={
            <>
              Global lessons <Badge>{k.lessons.length}</Badge>
            </>
          }
          description="What landed in global/lessons, newest first, with where each came from. Reverting removes it in one brain commit that records who and why; the text stays in the history."
        />
        {k.lessons.length ? (
          <ul className="divide-y divide-line">
            {k.lessons.map((e) => {
              const pv = e.provenance;
              return (
                <li key={e.path} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{e.title}</div>
                      <div className="break-all font-mono text-[11px] text-ink-3">{e.path}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {viewBase ? (
                        <Link href={`${brainHref(viewBase, e.path)}&tab=history`} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
                          <History size={13} aria-hidden /> History
                        </Link>
                      ) : null}
                      {e.revertable ? <RevertEntry path={e.path} title={e.title} /> : null}
                    </div>
                  </div>
                  {pv ? (
                    <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
                      <dt className="text-ink-3">From</dt>
                      <dd className="min-w-0">
                        {projectLink(pv.project)}
                        {pv.promotedAt ? (
                          <span className="text-ink-3" title={dateTime(ms(pv.promotedAt))}>
                            {" "}
                            · {ago(ms(pv.promotedAt), now)}
                          </span>
                        ) : null}
                      </dd>
                      <dt className="text-ink-3">Promoted by</dt>
                      <dd className="min-w-0 break-words">
                        <Mono>{pv.promotedBy ?? "unknown"}</Mono>
                        {pv.supervisorModel ? (
                          <>
                            {" "}
                            on <Mono>{pv.supervisorModel}</Mono>
                          </>
                        ) : null}
                      </dd>
                      <dt className="text-ink-3">Review</dt>
                      <dd className="min-w-0">{reviewLine(pv.review)}</dd>
                      <dt className="text-ink-3">Approved by</dt>
                      <dd className="min-w-0 break-words text-ink-2">{pv.approvedBy ?? "–"}</dd>
                      <dt className="text-ink-3">Sources</dt>
                      <dd className="flex min-w-0 flex-col">{pv.sources.length ? pv.sources.map(sourceLink) : <span className="text-ink-3">none recorded</span>}</dd>
                    </dl>
                  ) : (
                    <p className="text-xs text-ink-3">No provenance: written by hand or before gated promotion.</p>
                  )}
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-medium text-accent-ink">Show lesson</summary>
                    <div className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
                      <Markdown text={e.body} basePath={e.path} linkBase={viewBase ?? ALL} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<BookOpenText size={22} />} title="No global lessons yet">
            Supervisors promote a lesson with <Mono>brain_promote_lesson</Mono>; it lands here once it passes the check and the review{k.requiresApproval ? ", and you approve it" : ""}.
          </EmptyState>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card id="glossary">
          <CardHeader
            title="Glossary"
            description="Shared terms in global/glossary.md. Edit it on a project's Brain page."
            actions={
              viewBase && k.glossary ? (
                <>
                  <Link href={`${brainHref(viewBase, k.glossary.path)}&tab=history`} className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink hover:underline">
                    <History size={13} aria-hidden /> History
                  </Link>
                  <Link href={`${brainHref(viewBase, k.glossary.path)}&tab=edit`} className="text-xs text-accent-ink hover:underline">
                    Edit →
                  </Link>
                </>
              ) : null
            }
          />
          <div className="px-4 py-3 text-sm">{k.glossary && k.glossary.body.trim() ? <Markdown text={k.glossary.body} basePath={k.glossary.path} linkBase={viewBase ?? ALL} /> : <p className="text-ink-3">No glossary yet.</p>}</div>
        </Card>

        <Card id="decided">
          <CardHeader title="Recent decisions" description="The latest promotions that were approved, rejected (by a reviewer, the check, or a person), or approved and later reverted by a person." />
          {decided.length ? (
            <ul className="divide-y divide-line">
              {decided.map((p) => (
                <li key={`${p.project}/${p.id}`} className="space-y-1 px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 font-medium text-ink">{p.title}</span>
                    <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-xs text-ink-3">
                    <span>From {projectLink(p.project)}</span>
                    {p.decided_by ? <span>decided by {p.decided_by}</span> : null}
                    {p.decided_at ? <span title={p.decided_at}>{ago(ms(p.decided_at), now)}</span> : null}
                  </div>
                  {p.status === "rejected" && p.reason ? <p className="line-clamp-3 text-xs text-ink-2">{p.reason}</p> : null}
                  {p.status === "rejected" && p.lesson_path ? <div className="text-xs text-ink-3">Kept in the project as {sourceLink(p.lesson_path)}</div> : null}
                  {p.status === "reverted" ? (
                    <p className="text-xs text-ink-2">
                      Reverted{p.reverted_by ? ` by ${p.reverted_by}` : ""}
                      {p.reverted_at ? <span className="text-ink-3" title={p.reverted_at}> {ago(ms(p.reverted_at), now)}</span> : null}
                      {p.revert_reason ? <>: {p.revert_reason}</> : null}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No decisions yet">Approved, rejected, and reverted promotions appear here.</EmptyState>
          )}
        </Card>
      </div>

      {k.other.length ? (
        <Card id="other">
          <CardHeader title="Other global entries" description="Files under global/ outside lessons and the glossary, usually written by people." />
          <ul className="divide-y divide-line">
            {k.other.map((e) => (
              <li key={e.path} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  {viewBase ? (
                    <Link href={brainHref(viewBase, e.path)} className="font-medium text-accent-ink hover:underline">
                      {e.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{e.title}</span>
                  )}
                  <div className="break-all font-mono text-[11px] text-ink-3">{e.path}</div>
                </div>
                {e.revertable ? <RevertEntry path={e.path} title={e.title} /> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card id="reverted">
        <CardHeader title="Removed entries" description="Global entries removed from the brain, newest first, from its git history: who removed each and why. The text is kept in the commit before the removal. A reverted promotion's record says so, and its lesson is never written again." />
        {k.reverts.length ? (
          <ul className="divide-y divide-line">
            {k.reverts.map((x) => (
              <li key={x.commit} className="space-y-1 px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                      <Undo2 size={14} className="text-ink-3" aria-hidden /> {x.title ?? x.paths[0] ?? x.subject}
                    </span>
                    <div className="break-all font-mono text-[11px] text-ink-3">{x.paths.join(", ")}</div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-ink-3" title={x.date}>
                    <Clock size={12} aria-hidden /> {ago(ms(x.date), now)}
                  </span>
                </div>
                <div className="text-xs text-ink-2">
                  {x.revertedBy ? <>Removed by {x.revertedBy}</> : "Removed"}
                  {x.reason ? <>: {x.reason}</> : <span className="text-ink-3"> (no reason recorded)</span>}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                  <span className="inline-flex items-center gap-1">
                    <GitCommitHorizontal size={12} aria-hidden /> <span className="font-mono">{shortId(x.commit, 10)}</span>
                  </span>
                  {x.project ? <span>From {projectLink(x.project)}</span> : null}
                  {x.promotion ? <span className="break-all">promotion {x.promotion}</span> : null}
                  {x.promotion && x.project && records.get(`${x.project}/${x.promotion}`)?.status === "reverted" ? (
                    live.has(x.project) ? (
                      <Link href={`${projectBase(x.project)}/brain?view=promotions`} className="hover:underline">
                        <Badge tone="serious">promotion reverted</Badge>
                      </Link>
                    ) : (
                      <Badge tone="serious">promotion reverted</Badge>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing removed">Reverted global entries appear here with who reverted them and why.</EmptyState>
        )}
      </Card>
    </div>
  );
}
