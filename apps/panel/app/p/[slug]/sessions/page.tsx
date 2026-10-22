import Link from "next/link";
import { ScrollText } from "lucide-react";
import { insights, SESSION_STATUSES, type SessionStatus } from "switchyard-router";
import { getSy } from "@/lib/sy";
import { project } from "@/lib/project";
import { jobHref, projectBase, sessionHref, taskHref } from "@/lib/links";
import { SetupScreen } from "@/components/setup";
import { Callout, Card, EmptyState, HelpTip, Mono, Stat } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { UrlFilters } from "@/components/client/url-filters";
import { ROLE_LABEL, SESSION_STATUS_LABEL, SessionsTable } from "@/components/sessions-table";
import { shortId } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sessions" };

const LIMIT = 300;

export default async function SessionsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const r = getSy();
  if (!r.sy) return <SetupScreen error={r.error} configPath={r.configPath} />;
  const sy = r.sy;
  const p = project(sy, (await params).slug);
  const base = projectBase(p.slug);
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const status = str("status");
  const role = str("role");
  const task = str("task");
  const job = str("job");
  const parent = str("parent");
  const statusFilter = (SESSION_STATUSES as readonly string[]).includes(status) ? (status as SessionStatus) : undefined;

  let sessions = insights.sessionsView(sy, {
    project: p.slug,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(task ? { taskId: task } : {}),
    ...(job ? { jobId: job } : {}),
    ...(parent ? { parentSessionId: parent } : {}),
    limit: LIMIT,
  });
  if (role) sessions = sessions.filter((s) => s.role === role);
  const running = insights.sessionsView(sy, { project: p.slug, status: "running", limit: 1000 }).length;
  const interrupted = insights.sessionsView(sy, { project: p.slug, status: "interrupted", limit: 1000 }).length;
  const failed = insights.sessionsView(sy, { project: p.slug, status: "failed", limit: 1000 }).length;
  const now = Date.now();
  const filtered = Boolean(status || role || task || job || parent);
  const scope = job ? (
    <>
      job{" "}
      <Link href={jobHref(base, job)} className="font-medium text-accent-ink hover:underline">
        {shortId(job, 22)}
      </Link>
    </>
  ) : task ? (
    <>
      task{" "}
      <Link href={taskHref(base, task)} className="font-medium text-accent-ink hover:underline">
        {shortId(task, 22)}
      </Link>
    </>
  ) : parent ? (
    <>
      sessions spawned by{" "}
      <Link href={sessionHref(base, parent)} className="font-medium text-accent-ink hover:underline">
        {shortId(parent, 22)}
      </Link>
    </>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sessions"
        description={
          <>
            Every agent run, whatever its role: classifier calls, worker attempts at a task, and supervisors. Each session keeps a durable event log of its messages, model requests, and tool calls, so you can see exactly what it did. <HelpTip term="session" />
          </>
        }
        live={["sessions"]}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Running" value={running} sub="sessions with an open log" />
        <Stat label="Interrupted" value={interrupted} tone={interrupted ? "warn" : undefined} sub="stopped before they finished" />
        <Stat label="Failed" value={failed} tone={failed ? "bad" : undefined} sub="ended with an error" />
      </div>

      {scope ? (
        <Callout tone="accent" title={<>Showing only {scope}</>}>
          Clear the filters to see every session.
        </Callout>
      ) : null}

      <Card>
        <div className="border-b border-line px-4 py-3">
          <UrlFilters
            values={{ status, role, task, job, parent }}
            fields={[
              { name: "status", label: "Status", kind: "select", options: SESSION_STATUSES.map((s) => [s, SESSION_STATUS_LABEL[s] ?? s] as [string, string]) },
              { name: "role", label: "Role", kind: "select", options: Object.entries(ROLE_LABEL) },
            ]}
          />
        </div>
        {sessions.length === 0 ? (
          <EmptyState icon={<ScrollText size={22} />} title={filtered ? "No sessions match these filters" : "No sessions yet"}>
            {filtered ? (
              "Clear a filter to see more."
            ) : (
              <>
                Sessions are recorded as workers run tasks: start one through the MCP tools, <Mono>switchyard submit</Mono>, or a job.
              </>
            )}
          </EmptyState>
        ) : (
          <SessionsTable rows={sessions} base={base} now={now} />
        )}
      </Card>
      <p className="text-xs text-ink-3">Newest first. Showing {sessions.length} matching sessions (up to {LIMIT}).</p>
    </div>
  );
}
