import Link from "next/link";
import { ListChecks } from "lucide-react";
import { TASK_STATES, isTerminal, type TaskState } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { SetupScreen } from "@/components/setup";
import { Card, cx, EmptyState, HelpTip, Mono, PageHeader } from "@/components/ui";
import { ActionButton, AutoRefresh } from "@/components/client/actions";
import { UrlFilters } from "@/components/client/url-filters";
import { TASK_STATE_LABEL, TaskStateBadge, TierBadge } from "@/components/task-badges";
import { ago, dateTime, shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

const GROUPS: Record<string, TaskState[]> = {
  active: ["queued", "waiting_for_dependencies", "waiting_for_capacity", "running", "cancel_requested", "interrupted"],
  finished: ["completed", "failed", "cancelled", "budget_exhausted"],
};

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const state = str("state");
  const type = str("type");
  const tier = str("tier");
  const q = str("q").trim().toLowerCase();
  const states: TaskState[] | undefined = GROUPS[state] ?? ((TASK_STATES as readonly string[]).includes(state) ? [state as TaskState] : undefined);
  let tasks = sy.listTasks(states, 300);
  if (type) tasks = tasks.filter((t) => t.profile === type);
  if (tier) tasks = tasks.filter((t) => (t.tier ?? "") === tier);
  if (q) tasks = tasks.filter((t) => `${t.taskId} ${t.goal}`.toLowerCase().includes(q));
  const now = Date.now();
  const filtered = Boolean(state || type || tier || q);

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Work the supervisor delegated: its type, difficulty tier, how many model requests it used against its budget, and how it ended."
        actions={<AutoRefresh seconds={6} />}
      />
      <Card>
        <div className="border-b border-line px-4 py-3">
          <UrlFilters
            values={{ state, type, tier, q: str("q") }}
            fields={[
              { name: "state", label: "State", kind: "select", options: [["active", "Not finished"], ["finished", "Finished"], ...TASK_STATES.map((s) => [s, TASK_STATE_LABEL[s] ?? s] as [string, string])] },
              { name: "type", label: "Task type", kind: "select", options: Object.keys(sy.cfg.profiles).map((p) => [p, p] as [string, string]) },
              { name: "tier", label: "Tier", kind: "select", options: ["T1", "T2", "T3", "T4"].map((t) => [t, t] as [string, string]) },
              { name: "q", label: "Search goal or id", kind: "text", placeholder: "e.g. login bug" },
            ]}
          />
        </div>
        {tasks.length === 0 ? (
          <EmptyState icon={<ListChecks size={22} />} title={filtered ? "No tasks match these filters" : "No tasks yet"}>
            {filtered ? (
              "Clear a filter to see more."
            ) : (
              <>
                Tasks appear when Claude Code delegates work through the SwitchYard MCP tools, or with <Mono>switchyard submit</Mono>.
              </>
            )}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Task</th>
                  <th>State</th>
                  <th>
                    <span className="inline-flex items-center gap-1">
                      Tier <HelpTip term="tier" />
                    </span>
                  </th>
                  <th>Requests used</th>
                  <th>Goal</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const used = t.modelRequestsUsed;
                  const budget = Number.isFinite(t.maxModelRequests) ? t.maxModelRequests : null;
                  const ratio = budget ? Math.min(1, used / budget) : 0;
                  return (
                    <tr key={t.taskId}>
                      <td className="whitespace-nowrap">
                        <div title={dateTime(t.createdAt)}>{ago(Date.parse(t.createdAt), now)}</div>
                        <div className="text-[11px] text-ink-3">
                          {t.finishedAt ? `took ${Math.max(1, Math.round((Date.parse(t.finishedAt) - Date.parse(t.startedAt ?? t.createdAt)) / 1000))}s` : t.startedAt ? "started" : "not started"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <Link href={`/tasks/${t.taskId}`} className="font-mono text-xs font-medium text-accent-ink hover:underline">
                          {shortId(t.taskId, 18)}
                        </Link>
                        <div className="text-xs text-ink-2">
                          {t.profile}
                          {t.purpose !== "work" ? <span className="text-ink-3"> · {t.purpose}</span> : null}
                        </div>
                      </td>
                      <td>
                        <TaskStateBadge state={t.state} />
                        {t.stateReason && t.state !== "completed" ? (
                          <div className="mt-1 max-w-[16rem] truncate text-[11px] text-ink-3" title={t.stateReason}>
                            {t.stateReason}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <TierBadge tier={t.tier} />
                      </td>
                      <td className="min-w-[8rem]">
                        <div className="tabular text-xs text-ink">
                          {used}
                          {budget ? <span className="text-ink-3"> / {budget}</span> : null}
                        </div>
                        {budget ? (
                          <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-accent-soft" aria-hidden>
                            <div className={cx("h-full rounded-full", ratio >= 1 ? "bg-bad" : ratio > 0.75 ? "bg-warn" : "bg-accent")} style={{ width: `${ratio * 100}%` }} />
                          </div>
                        ) : null}
                      </td>
                      <td className="max-w-[28rem]">
                        <Link href={`/tasks/${t.taskId}`} className="line-clamp-2 text-ink hover:text-accent-ink">
                          {t.goal}
                        </Link>
                        {t.dependsOn.length ? <div className="mt-0.5 text-[11px] text-ink-3">after {t.dependsOn.map((d) => shortId(d, 12)).join(", ")}</div> : null}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <span className="inline-flex gap-1">
                          {t.state === "interrupted" ? (
                            <ActionButton url="/api/tasks/resume" payload={{ id: t.taskId }} small success="Requeued">
                              Resume
                            </ActionButton>
                          ) : null}
                          {!isTerminal(t.state) && t.state !== "cancel_requested" ? (
                            <ActionButton url="/api/tasks/cancel" payload={{ ids: [t.taskId] }} small variant="ghost" confirm="Confirm cancel">
                              Cancel
                            </ActionButton>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-2 text-xs text-ink-3">Showing the {tasks.length} most recent matching tasks (up to 300).</p>
    </div>
  );
}
