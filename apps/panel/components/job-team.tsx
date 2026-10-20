import Link from "next/link";
import { GitBranch, GitMerge, MessagesSquare, Network, Quote, Wrench } from "lucide-react";
import type { insights } from "switchyard-router";
import { Badge, Card, CardHeader, Mono, type Tone } from "./ui";
import { AcceptanceBadge, TaskStateBadge } from "./task-badges";
import { dateTime, humanize, shortId } from "@/lib/format";

// The job page's team view (T2): the job tree (sub-jobs with branch and carved budget, and their
// workers), the merge queue of each job branch, and the team channel. Channel post text is model
// output: it is rendered as plain React text (escaped), quoted, and never as HTML or markdown.

type Team = insights.JobTeamView;
type TreeNode = insights.TeamTreeNode;
type Post = insights.ChannelPostView;

function Budget({ b }: { b: NonNullable<TreeNode["budget"]> }) {
  const usedPct = b.carved ? Math.min(100, (b.used / b.carved) * 100) : 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2" title={`Carved ${Math.round(b.share * 100)}% of the ${b.parentRemaining ?? "?"} requests the parent had left`}>
      <span>
        budget <span className="tabular font-medium text-ink">{b.carved}</span>
        {b.parentRemaining !== null ? <span className="text-ink-3"> of {b.parentRemaining} left</span> : null}
      </span>
      <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${usedPct}%` }} />
      </span>
      <span>
        used <span className="tabular">{b.used}</span>
      </span>
      {b.returned === null ? <span className="text-ink-3">held while open</span> : <Badge tone="good">{b.returned} returned</Badge>}
    </span>
  );
}

function TreeRow({ n, self }: { n: TreeNode; self: boolean }) {
  const href = n.kind === "job" ? `/jobs/${encodeURIComponent(n.taskId)}` : `/tasks/${encodeURIComponent(n.taskId)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {n.kind === "job" ? <Network size={14} className="shrink-0 text-accent-ink" aria-hidden /> : <Wrench size={13} className="shrink-0 text-ink-3" aria-hidden />}
        {self ? (
          <span className="font-medium text-ink">{n.label ?? shortId(n.taskId, 18)}</span>
        ) : (
          <Link href={href} className="font-medium text-accent-ink hover:underline">
            {n.label ?? shortId(n.taskId, 18)}
          </Link>
        )}
        <span className="text-xs text-ink-3">{n.kind === "job" ? (self ? "this job" : "sub-supervisor") : n.profile}</span>
      </span>
      <TaskStateBadge state={n.state} />
      {n.acceptance ? <AcceptanceBadge status={n.acceptance} /> : null}
      {n.kind === "job" ? <Badge tone="accent">level {n.depth}</Badge> : null}
      {n.branches.map((b) => (
        <span key={b.alias} className="inline-flex min-w-0 items-center gap-1 text-xs text-ink-3">
          <GitBranch size={12} aria-hidden /> <Mono className="break-all">{b.branch}</Mono>
        </span>
      ))}
      {n.budget ? <Budget b={n.budget} /> : n.kind === "job" ? <span className="text-xs text-ink-3">{n.requestsUsed} requests used</span> : null}
    </div>
  );
}

function Tree({ n, self }: { n: TreeNode; self: boolean }) {
  return (
    <li>
      <TreeRow n={n} self={self} />
      {n.children.length ? (
        <ul className="ml-2 border-l border-line pl-4">
          {n.children.map((c) => (
            <Tree key={c.taskId} n={c} self={false} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TeamCard({ team }: { team: Team }) {
  return (
    <Card id="team">
      <CardHeader
        title="Team"
        help="subJob"
        description={
          <>
            Supervisor level {team.depth} of at most {team.maxDepth} (team.max_depth). {team.subJobs ? `${team.subJobs} sub-job${team.subJobs === 1 ? "" : "s"} below this job, each on its own branch with a budget carved from this job's.` : "No sub-jobs below this job."}
            {team.parentJobId ? (
              <>
                {" "}
                A sub-job of{" "}
                <Link href={`/jobs/${encodeURIComponent(team.parentJobId)}`} className="text-accent-ink hover:underline">
                  {team.parentLabel ?? shortId(team.parentJobId, 18)}
                </Link>
                .
              </>
            ) : null}
          </>
        }
        actions={
          <a href={`/api/jobs/${encodeURIComponent(team.jobId)}/team`} className="text-xs text-accent-ink hover:underline">
            JSON
          </a>
        }
      />
      <ul className="px-4 py-2 text-sm">
        <Tree n={team.tree} self />
      </ul>
    </Card>
  );
}

const ITEM_TONE: Record<string, Tone> = { integrated: "good", queued: "accent", integrating: "accent", picked: "accent", conflict: "bad", failed: "bad", redelegated: "warn", refused: "warn" };

export function MergeQueueCard({ team }: { team: Team }) {
  if (!team.queues.length) return null;
  return (
    <Card id="merge-queue">
      <CardHeader title="Merge queue" help="mergeQueue" description="Integrations onto each job branch in this tree, in order: one at a time per branch, commits picked one by one, job checks after each." />
      <div className="divide-y divide-line">
        {team.queues.map((q) => (
          <div key={`${q.jobId}:${q.repo}:${q.branch}`} className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-sm">
              <GitMerge size={14} className="text-ink-3" aria-hidden />
              <span className="font-medium text-ink">{q.repo}</span>
              <Mono className="break-all">{q.branch}</Mono>
              {q.jobId !== team.jobId ? (
                <span className="text-xs text-ink-3">
                  branch of sub-job{" "}
                  <Link href={`/jobs/${encodeURIComponent(q.jobId)}`} className="text-accent-ink hover:underline">
                    {q.jobLabel ?? shortId(q.jobId, 16)}
                  </Link>
                </span>
              ) : null}
              {q.active ? <Badge tone="accent">{q.active} in progress</Badge> : null}
            </div>
            <div className="overflow-x-auto px-1 pb-2">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Work</th>
                    <th>State</th>
                    <th>Outcome</th>
                    <th>Job checks</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {q.items.map((i, k) => (
                    <tr key={i.id}>
                      <td className="tabular text-xs text-ink-3">{k + 1}</td>
                      <td>
                        <Link href={i.kind === "job" ? `/jobs/${encodeURIComponent(i.taskId)}` : `/tasks/${encodeURIComponent(i.taskId)}`} className="font-medium text-accent-ink hover:underline">
                          {i.taskLabel ?? shortId(i.taskId, 16)}
                        </Link>
                        <div className="text-[11px] text-ink-3">
                          {i.kind === "job" ? "sub-job branch" : "task commits"} · {i.commits} commit{i.commits === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={ITEM_TONE[i.state] ?? "neutral"}>{humanize(i.state).toLowerCase()}</Badge>
                          {i.rebased ? <Badge tone="warn" title="The pick conflicted; the work was rebased onto the branch head in its own worktree and picked again">rebased{i.dropped ? `, ${i.dropped} dropped` : ""}</Badge> : null}
                          {i.attempts > 1 ? <span className="text-[11px] text-ink-3">{i.attempts} attempts</span> : null}
                        </div>
                      </td>
                      <td className="min-w-[16rem] max-w-[30rem] text-xs text-ink-2">
                        {i.outcome}
                        {i.redelegatedTo ? (
                          <div>
                            re-delegated:{" "}
                            <Link href={`/tasks/${encodeURIComponent(i.redelegatedTo)}`} className="text-accent-ink hover:underline">
                              {i.redelegatedLabel ?? shortId(i.redelegatedTo, 16)}
                            </Link>
                          </div>
                        ) : null}
                        {i.conflict?.files.length ? <div className="font-mono text-[11px] text-ink-3">{i.conflict.files.join(", ")}</div> : null}
                      </td>
                      <td>
                        {i.checks.length ? (
                          <div className="flex flex-col items-start gap-1">
                            {i.checks.map((c, j) => (
                              <span key={j} className="inline-flex max-w-[18rem] items-center gap-1" title={c.command}>
                                {c.exitCode === 0 ? <Badge tone="good">exit 0</Badge> : <Badge tone="bad">exit {c.exitCode ?? "killed"}</Badge>}
                                <code className="truncate font-mono text-[11px] text-ink-3">{c.command}</code>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-ink-3">–</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs text-ink-3">{dateTime(i.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const KIND: Record<string, { label: string; tone: Tone }> = {
  finding: { label: "finding", tone: "accent" },
  blocker: { label: "blocker", tone: "warn" },
  interface_contract: { label: "interface contract", tone: "good" },
};

function PostItem({ p, showJob }: { p: Post; showJob: boolean }) {
  const k = KIND[p.kind] ?? { label: p.kind, tone: "neutral" as Tone };
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
        <Badge tone={k.tone}>{k.label}</Badge>
        <span className="font-medium text-ink">{p.author.label}</span>
        <span>({p.author.role})</span>
        {showJob ? (
          <span>
            in{" "}
            <Link href={`/jobs/${encodeURIComponent(p.jobId)}`} className="text-accent-ink hover:underline">
              {p.jobLabel ?? shortId(p.jobId, 14)}
            </Link>
          </span>
        ) : null}
        <span>
          {p.refs.length ? (
            <>
              about{" "}
              {p.refs.map((r, i) => (
                <span key={r.taskId}>
                  {i ? ", " : ""}
                  <Link href={`/tasks/${encodeURIComponent(r.taskId)}`} className="text-accent-ink hover:underline">
                    {r.label ?? shortId(r.taskId, 14)}
                  </Link>
                </span>
              ))}
            </>
          ) : (
            "job-wide"
          )}
        </span>
        <span>· #{p.id} · {dateTime(p.createdAt)}</span>
      </div>
      {/* Model output: plain text (React escapes it), quoted, never rendered as HTML or markdown. */}
      <blockquote className="flex gap-2 rounded-lg border-l-2 border-line-strong bg-surface-2 px-3 py-2">
        <Quote size={12} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-ink-2">{p.text}</span>
      </blockquote>
    </li>
  );
}

export function ChannelCard({ team }: { team: Team }) {
  const c = team.channel;
  if (!c.total) return null;
  const kinds = Object.entries(c.byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND[k]?.label ?? k}${n === 1 ? "" : "s"}`)
    .join(", ");
  return (
    <Card id="channel">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <MessagesSquare size={14} aria-hidden /> Team channel
          </span>
        }
        help="teamChannel"
        description={`${c.total} post${c.total === 1 ? "" : "s"} across this job${team.subJobs ? " and its sub-jobs" : ""} (${kinds}); the latest ${c.posts.length} shown, oldest first.`}
        actions={
          <a href={`/api/jobs/${encodeURIComponent(team.jobId)}/channel`} className="text-xs text-accent-ink hover:underline">
            JSON
          </a>
        }
      />
      <p className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-3">{c.notice}</p>
      <ul className="divide-y divide-line">
        {c.posts.map((p) => (
          <PostItem key={p.id} p={p} showJob={team.subJobs > 0} />
        ))}
      </ul>
    </Card>
  );
}
