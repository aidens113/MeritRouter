import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, BookOpenText, Bot, ChevronRight, GitBranch, MessageCircleQuestion, Terminal, User, Wrench } from "lucide-react";
import { insights, isTerminal } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { AcceptanceBadge, TaskStateBadge } from "@/components/task-badges";
import { SessionsTable } from "@/components/sessions-table";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, KeyValue, Mono, PageHeader } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { ArtifactViewer } from "@/components/client/artifact-viewer";
import { CopyCommand, QuestionAnswer } from "@/components/client/jobs";
import { dateTime, humanize, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Job" };

type Turn = { role: string; content: string; tools?: string[] };

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const id = decodeURIComponent((await params).id);
  const job = insights.jobDetail(sy, id);
  if (!job) notFound();
  const spec = sy.tasks.get(id)!.spec;
  const status = sy.getStatus([id])[0] as { stateReason?: string | null; maxModelRequests?: number; startedAt?: string | null };
  const live = !isTerminal(job.state);
  const pending = job.questions.filter((q) => q.answer === null);
  const answered = job.questions.filter((q) => q.answer !== null);
  const docExists = sy.brain.exists(job.workingDoc);
  const res = job.result;
  const sessions = insights.sessionsView(sy, { jobId: id, limit: 200 });

  return (
    <div className="space-y-6">
      <Link href="/jobs" className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> All jobs
      </Link>
      <PageHeader
        title={job.label ? `Job: ${job.label}` : "Job"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStateBadge state={job.state} />
            {res ? <AcceptanceBadge status={res.acceptanceStatus} /> : null}
            {pending.length ? <Badge tone="warn" icon={<MessageCircleQuestion size={11} />}>{pending.length} waiting for you</Badge> : null}
            <Mono>{job.taskId}</Mono>
          </span>
        }
        actions={
          <>
            {live && job.state !== "interrupted" ? <AutoRefresh seconds={4} /> : null}
            {job.state === "interrupted" ? (
              <ActionButton url="/api/tasks/resume" payload={{ id: job.taskId }} variant="primary" success="Requeued: a running worker resumes the supervisor where it stopped">
                Resume job
              </ActionButton>
            ) : null}
            {live && job.state !== "cancel_requested" ? (
              <ActionButton url="/api/tasks/cancel" payload={{ ids: [job.taskId] }} variant="danger" confirm="Confirm: cancel job" success="Cancellation requested">
                Cancel job
              </ActionButton>
            ) : null}
          </>
        }
      />

      {status.stateReason && job.state !== "completed" ? (
        <Callout tone={job.state === "failed" || job.state === "budget_exhausted" ? "bad" : job.state === "interrupted" ? "serious" : "warn"} title={job.state === "queued" ? "Waiting for a worker" : job.state === "interrupted" ? "This job is paused" : "Status"}>
          {humanize(status.stateReason).replace(/\.?$/, ".")}
          {job.state === "interrupted" ? " Resume it to continue from the saved transcript; a running worker picks it up." : ""}
        </Callout>
      ) : job.state === "queued" ? (
        <Callout tone="accent" title="Queued">
          The job starts when a worker is running: the MCP server inside Claude Code, or <Mono>switchyard worker</Mono>. <HelpTip term="worker" />
        </Callout>
      ) : null}

      {job.questions.length ? (
        <Card className={pending.length ? "border-warn/50" : undefined} id="questions">
          <CardHeader title="Questions from the supervisor" description={pending.length ? (job.state === "running" ? "The supervisor is waiting on these decisions. Pick an option or write an answer." : "Decisions the supervisor asked you for. Pick an option or write an answer.") : "All questions are answered."} />
          <div className="divide-y divide-line">
            {pending.map((q) => (
              <div key={q.id} className="px-4 py-3">
                <QuestionAnswer q={q} />
                <p className="mt-2 pl-6 text-[11px] text-ink-3">
                  Asked {dateTime(q.askedAt)}
                  {job.state === "running" ? " · the supervisor reads your answer within a second" : ""}
                </p>
                {job.state !== "running" ? (
                  <p className="mt-1 pl-6 text-xs text-warn-ink">
                    {isTerminal(job.state)
                      ? "This job has ended, so no supervisor is waiting for this answer. It is stored with the job for the record."
                      : "The job stopped while waiting for this answer. Answer here, then resume the job: the supervisor is given every answer you saved when it starts again."}
                  </p>
                ) : null}
              </div>
            ))}
            {answered.map((q) => (
              <div key={q.id} className="px-4 py-3 text-sm">
                <p className="text-ink-2">{q.question}</p>
                <p className="mt-1 text-ink">
                  <span className="text-ink-3">Answered:</span> {q.answer} <span className="text-[11px] text-ink-3">· {dateTime(q.answeredAt)}</span>
                </p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Goal" />
          <div className="space-y-4 p-4 text-sm">
            <p className="whitespace-pre-wrap text-ink">{spec.goal}</p>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Acceptance criteria</h3>
              <ol className="list-decimal space-y-1 pl-5 text-ink-2">
                {spec.constraints.acceptanceCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            </div>
            {spec.constraints.checks?.length ? (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Job checks</h3>
                <ul className="space-y-1">
                  {spec.constraints.checks.map((c) => (
                    <li key={c} className="flex items-start gap-2">
                      <Terminal size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
                      <code className="break-all font-mono text-xs text-ink-2">{c}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Details" />
          <div className="space-y-4 p-4">
            <KeyValue
              items={[
                ["Created", dateTime(job.createdAt)],
                ["Started", dateTime(status.startedAt ?? null)],
                ["Finished", dateTime(job.finishedAt)],
                ["Supervisor requests", `${job.modelRequestsUsed}${status.maxModelRequests && Number.isFinite(status.maxModelRequests) ? ` of ${status.maxModelRequests} allowed` : ""}`],
                ["Repositories", spec.repositoryAliases.join(", ")],
                ...(spec.budget?.maxPaidUsd !== undefined ? ([["Paid cap", `$${spec.budget.maxPaidUsd}`]] as Array<[string, ReactNode]>) : []),
                [
                  <span key="wd" className="inline-flex items-center gap-1">
                    Working document <HelpTip term="workingDoc" />
                  </span>,
                  docExists ? (
                    <Link key="l" href={`/brain?path=${encodeURIComponent(job.workingDoc)}`} className="inline-flex items-center gap-1 break-all text-accent-ink hover:underline">
                      <BookOpenText size={13} aria-hidden /> {job.workingDoc}
                    </Link>
                  ) : (
                    <span key="n" className="text-ink-3">{job.workingDoc} (created when the job starts)</span>
                  ),
                ],
                ["Task page", <Link key="t" href={`/tasks/${job.taskId}`} className="text-accent-ink hover:underline">requests, artifacts, timeline</Link>],
              ]}
            />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Branches" help="branch" description="Integrated work lives on these branches. Nothing is merged or pushed for you." />
        <div className="space-y-4 p-4">
          {job.branches.length ? (
            job.branches.map((b) => (
              <div key={b.alias} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <GitBranch size={14} className="text-ink-3" aria-hidden />
                  <span className="font-medium text-ink">{b.alias}</span>
                  <Mono>{b.branch}</Mono>
                  <span className="text-xs text-ink-3">based on {b.baseSha.slice(0, 12)}</span>
                </div>
                <CopyCommand command={`git merge --no-ff ${b.branch}`} />
                <p className="text-xs text-ink-3">
                  Run it in <Mono>{sy.cfg.repositoryPaths[b.alias]?.path ?? b.alias}</Mono> after reviewing <Mono>{`git log --stat ${b.baseSha.slice(0, 12)}..${b.branch}`}</Mono>. Integration worktree: <Mono>{b.worktree}</Mono>
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-ink-3">{job.state === "queued" ? "Branches are created when the job starts (one per writable repository)." : "This job has no writable repository, so it has no branch."}</p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Worker tasks" description="Tasks the supervisor delegated. Each has its own page with requests, artifacts, and checks." />
        {job.children.length ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Type</th>
                  <th>State</th>
                  <th>Acceptance</th>
                  <th>Task</th>
                </tr>
              </thead>
              <tbody>
                {job.children.map((c) => (
                  <tr key={c.taskId}>
                    <td className="font-medium text-ink">{c.label ?? "–"}</td>
                    <td>{c.profile}</td>
                    <td>
                      <TaskStateBadge state={c.state} />
                    </td>
                    <td>{c.acceptance ? <AcceptanceBadge status={c.acceptance} /> : <span className="text-xs text-ink-3">–</span>}</td>
                    <td>
                      <Link href={`/tasks/${c.taskId}`} className="font-mono text-xs text-accent-ink hover:underline">
                        {shortId(c.taskId, 22)}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No worker tasks yet">The supervisor delegates tasks after it has written its plan.</EmptyState>
        )}
      </Card>

      {res ? (
        <Card>
          <CardHeader title="Result" description={`Stopped because: ${humanize(res.stopReason)}`} />
          <div className="space-y-4 p-4 text-sm">
            <p className="whitespace-pre-wrap text-ink">{res.summary || "No summary."}</p>
            {res.findings.length ? (
              <ul className="space-y-1.5">
                {res.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border border-line px-3 py-2 text-ink-2">
                    {f.description}
                  </li>
                ))}
              </ul>
            ) : null}
            {res.unresolvedCriteria.length ? (
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Not verified</h3>
                <ul className="list-disc space-y-1 pl-5 text-bad-ink">
                  {res.unresolvedCriteria.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {res.checks.length ? (
              <div>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Checks run on the job branch</h3>
                <ul className="space-y-2">
                  {res.checks.map((c, i) => (
                    <li key={i} className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {c.exitCode === 0 ? <Badge tone="good">exit 0</Badge> : <Badge tone="bad">exit {c.exitCode ?? "killed"}</Badge>}
                        <code className="break-all font-mono text-xs text-ink-2">{c.command}</code>
                      </div>
                      <ArtifactViewer refId={c.logRef} kind="check_log" label="Check output" />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {res.patchRefs.length ? (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">Job branch diff</h3>
                {res.patchRefs.map((p) => (
                  <ArtifactViewer key={p} refId={p} kind="patch" label="Changes on the job branch" />
                ))}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Agent sessions"
          help="session"
          description="The supervisor and every agent working for this job, each with its full event log. Newest first."
          actions={
            sessions.length ? (
              <Link href={`/sessions?job=${encodeURIComponent(job.taskId)}`} className="text-xs text-accent-ink hover:underline">
                Open in Sessions
              </Link>
            ) : null
          }
        />
        <SessionsTable rows={sessions} empty="No sessions recorded for this job" />
      </Card>

      <Card>
        <CardHeader title="Supervisor transcript" help="supervisor" description="What the supervisor said and did, turn by turn. Tool calls are collapsed; open one to see its arguments and result." />
        <div className="p-4">{job.transcript.length ? <Transcript turns={job.transcript} /> : <p className="text-sm text-ink-3">Empty until the supervisor starts.</p>}</div>
      </Card>
    </div>
  );
}

function Transcript({ turns }: { turns: Turn[] }) {
  // Pair each assistant tool call with the tool result that follows it (results come in call order).
  const items: ReactNode[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role === "assistant") {
      const calls = t.tools ?? [];
      const results: string[] = [];
      let j = i + 1;
      while (j < turns.length && turns[j]!.role === "tool" && results.length < calls.length) results.push(turns[j++]!.content);
      items.push(
        <li key={i} className="relative">
          <Dot tone="bg-accent" />
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
            <Bot size={13} aria-hidden /> Supervisor
          </div>
          {t.content.trim() ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{t.content}</p> : null}
          {calls.length ? (
            <div className="mt-1.5 space-y-1">
              {calls.map((c, k) => (
                <ToolCall key={k} call={c} result={results[k]} />
              ))}
            </div>
          ) : null}
        </li>,
      );
      i = j - 1;
    } else if (t.role === "tool") {
      items.push(
        <li key={i} className="relative">
          <Dot tone="bg-ink-3" />
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink-2">Tool result</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-line p-3 font-mono text-[11px] text-ink-2">{t.content}</pre>
          </details>
        </li>,
      );
    } else {
      const first = i === 0;
      items.push(
        <li key={i} className="relative">
          <Dot tone="bg-good" />
          <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
            <User size={13} aria-hidden /> {first ? "Job brief" : "SwitchYard"}
          </div>
          {first ? (
            <details className="mt-1 rounded-lg border border-line">
              <summary className="cursor-pointer px-3 py-1.5 text-xs text-ink-2">{t.content.split("\n").find((l) => l.trim() && !/^Goal:?$/.test(l.trim()))?.slice(0, 140) ?? "Brief"}</summary>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-line p-3 font-mono text-[11px] text-ink-2">{t.content}</pre>
            </details>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{t.content}</p>
          )}
        </li>,
      );
    }
  }
  return (
    <ol className="relative space-y-4 pl-6">
      <span className="absolute bottom-2 left-[0.4rem] top-2 w-px bg-line" aria-hidden />
      {items}
    </ol>
  );
}

function Dot({ tone }: { tone: string }) {
  return <span className={cx("absolute -left-[1.3rem] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface", tone)} aria-hidden />;
}

function ToolCall({ call, result }: { call: string; result: string | undefined }) {
  const m = /^([\w.-]+)\(([\s\S]*)\)$/.exec(call);
  const name = m?.[1] ?? call;
  let args = m?.[2] ?? "";
  try {
    args = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // truncated arguments stay as they are
  }
  const failed = result?.startsWith("error:");
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs">
        <ChevronRight size={12} className="text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
        <Wrench size={12} className="text-ink-3" aria-hidden />
        <span className="font-mono font-medium text-ink">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{summarizeArgs(m?.[2] ?? "")}</span>
        {result === undefined ? <Badge>no result yet</Badge> : failed ? <Badge tone="bad">error</Badge> : <Badge tone="good">ok</Badge>}
      </summary>
      <div className="grid gap-2 border-t border-line p-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium text-ink-3">Arguments</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2">{args || "{}"}</pre>
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium text-ink-3">Result</div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2">{result ?? "(not returned yet)"}</pre>
        </div>
      </div>
    </details>
  );
}

function summarizeArgs(raw: string): string {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" · ")
      .slice(0, 160);
  } catch {
    return raw.slice(0, 160);
  }
}
