import Link from "next/link";
import { MessageCircleQuestion, Network, Settings2 } from "lucide-react";
import { insights, isTerminal } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Badge, Callout, Card, CardHeader, cx, EmptyState, HelpTip, Mono, PageHeader } from "@/components/ui";
import { AutoRefresh } from "@/components/client/actions";
import { NewJobForm } from "@/components/client/jobs";
import { ACCEPTANCE_LABEL, TaskStateBadge } from "@/components/task-badges";
import { ago, dateTime, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs" };

export default async function JobsPage() {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const enabled = Boolean(sy.cfg.profiles.supervise);
  const jobs = insights.jobsView(sy, 100);
  const now = Date.now();
  const live = jobs.some((j) => !isTerminal(j.state));
  const waiting = jobs.reduce((n, j) => n + j.pendingQuestions, 0);
  const repos = Object.entries(sy.cfg.repositories).map(([alias, v]) => ({ alias, writable: v.writable, path: sy.cfg.repositoryPaths[alias]?.path ?? v.path }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jobs"
        description={
          <>
            Standalone work run by a SwitchYard supervisor: it plans, delegates tasks to workers, verifies them, and commits the result to a job branch for you to review. <HelpTip term="job" />
          </>
        }
        actions={live ? <AutoRefresh seconds={5} /> : null}
      />

      {waiting ? (
        <Callout tone="warn" icon={<MessageCircleQuestion size={16} />} title={`${waiting} question${waiting === 1 ? "" : "s"} waiting for your answer`}>
          A supervisor paused to ask you something. Open the job marked below to answer.
        </Callout>
      ) : null}

      <Card id="new">
        <CardHeader title="New job" help="supervisor" description="Describe the goal; the supervisor writes a plan in the job's working document and delegates from there." />
        <div className="p-4">
          {!enabled ? (
            <div className="mb-4">
              <Callout tone="warn" icon={<Settings2 size={16} />} title="Jobs are not set up in this config">
                Starting a job needs the <Mono>supervise</Mono> task type (<Mono>profiles.supervise</Mono>), which says which models may supervise and how many requests they get.{" "}
                <Link href="/settings#supervisor" className="font-medium text-accent-ink hover:underline">
                  Enable it in Settings →
                </Link>
              </Callout>
            </div>
          ) : null}
          <NewJobForm repos={repos} enabled={enabled} />
        </div>
      </Card>

      <Card>
        <CardHeader title="All jobs" description="Newest first. A job's children are the worker tasks its supervisor delegated." />
        {jobs.length === 0 ? (
          <EmptyState icon={<Network size={22} />} title="No jobs yet">
            {enabled ? "Start one with the form above. It waits in the queue until a worker (the MCP server or switchyard worker) is running." : "Enable the supervise task type in Settings, then start a job here."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Job</th>
                  <th>State</th>
                  <th>Goal</th>
                  <th>
                    <span className="inline-flex items-center gap-1">
                      Branch <HelpTip term="branch" />
                    </span>
                  </th>
                  <th>Worker tasks</th>
                  <th>Requests</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const done = j.children.filter((c) => isTerminal(c.state as never)).length;
                  const ok = j.children.filter((c) => c.state === "completed").length;
                  return (
                    <tr key={j.taskId}>
                      <td className="whitespace-nowrap">
                        <div title={dateTime(j.createdAt)}>{ago(j.createdAt, now)}</div>
                        <div className="text-[11px] text-ink-3">{j.finishedAt ? `took ${Math.max(1, Math.round((j.finishedAt - j.createdAt) / 60_000))} min` : "not finished"}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        <Link href={`/jobs/${j.taskId}`} className="font-medium text-accent-ink hover:underline">
                          {j.label ?? shortId(j.taskId, 18)}
                        </Link>
                        {j.label ? <div className="font-mono text-[11px] text-ink-3">{shortId(j.taskId, 18)}</div> : null}
                        {j.parentJobId ? <div className="text-[11px] text-ink-3">sub-job of {jobs.find((x) => x.taskId === j.parentJobId)?.label ?? shortId(j.parentJobId, 14)}</div> : null}
                      </td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <TaskStateBadge state={j.state} />
                          {j.pendingQuestions ? (
                            <Badge tone="warn" icon={<MessageCircleQuestion size={11} />}>
                              {j.pendingQuestions} question{j.pendingQuestions === 1 ? "" : "s"}
                            </Badge>
                          ) : null}
                          {j.result ? <span className="text-[11px] text-ink-3">{(ACCEPTANCE_LABEL[j.result.acceptanceStatus] ?? j.result.acceptanceStatus).toLowerCase()}</span> : null}
                        </div>
                      </td>
                      <td className="max-w-[26rem]">
                        <Link href={`/jobs/${j.taskId}`} className="line-clamp-2 text-ink hover:text-accent-ink">
                          {j.goal}
                        </Link>
                      </td>
                      <td>
                        {j.branches.length ? (
                          <div className="space-y-0.5">
                            {j.branches.map((b) => (
                              <div key={b.alias} className="whitespace-nowrap font-mono text-[11px] text-ink-2" title={`${b.alias}: based on ${b.baseSha.slice(0, 12)}`}>
                                {b.alias}: {b.branch}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-ink-3">{j.state === "queued" ? "created when it starts" : "none"}</span>
                        )}
                      </td>
                      <td className="min-w-[8rem]">
                        {j.children.length ? (
                          <>
                            <div className="tabular text-xs text-ink">
                              {done} of {j.children.length} finished
                              {done !== ok ? <span className="text-ink-3"> · {ok} completed</span> : null}
                            </div>
                            <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-accent-soft" aria-hidden>
                              <div className={cx("h-full rounded-full", done === j.children.length ? "bg-good" : "bg-accent")} style={{ width: `${(done / j.children.length) * 100}%` }} />
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-ink-3">none yet</span>
                        )}
                      </td>
                      <td className="tabular text-xs text-ink">{j.modelRequestsUsed}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
