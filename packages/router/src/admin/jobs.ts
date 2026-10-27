import type { MeritRouter } from "../core/service.js";
import type { TaskState, WorkerResult } from "../core/task.js";
import { fanOutProjects, locateProjectTask, newestFirst, projectIdFilter, projectQuestions, projectScope, taskIn, taskRequestsUsed, withAvailability, type ProjectTask, type RowsWithAvailability } from "./project-reads.js";

// Standalone jobs (supervise tasks): state, delegated tasks, branches, questions, and transcript.

export interface JobView {
  taskId: string;
  /** The job's project. */
  project: string;
  label: string | null;
  /** The job this one is a sub-job of (a sub-supervisor's parent job); null for a top-level job. */
  parentJobId: string | null;
  goal: string;
  state: TaskState;
  createdAt: number;
  finishedAt: number | null;
  modelRequestsUsed: number;
  branches: Array<{ alias: string; branch: string; baseSha: string; worktree: string }>;
  children: Array<{ taskId: string; label: string | null; profile: string; state: string; acceptance: string | null }>;
  pendingQuestions: number;
  workingDoc: string;
  result: WorkerResult | null;
  /** The supervisor session the transcript and branches come from (its latest); null for jobs that predate sessions or have not started. */
  sessionId: string | null;
}

export interface JobTurn {
  role: string;
  content: string;
  tools?: string[];
}

type TranscriptMessage = { role: string; content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> };

function jobTurns(messages: TranscriptMessage[]): JobTurn[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 4000) : m.content === null || m.content === undefined ? "" : JSON.stringify(m.content).slice(0, 4000),
      ...(m.tool_calls?.length ? { tools: m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 8000)})`) } : {}),
    }));
}

/**
 * A job's supervisor transcript and integration branches. They come from the job's latest
 * supervisor session (its transcript, and the last workspace any of its supervisor sessions
 * recorded). `job_state`, which supervisors no longer write, is read only as a fallback for jobs
 * that predate sessions. Everything is read from the job's own project store.
 */
function jobRecord(sy: MeritRouter, located: ProjectTask, withTranscript: boolean): { sessionId: string | null; branches: JobView["branches"]; transcript: JobTurn[] } {
  const { stores, project, task } = located;
  const taskId = task.row.id;
  const sessions = (stores.sessions?.forTask(taskId) ?? []).filter((s) => s.role === "supervisor");
  const latest = sessions.at(-1) ?? null;
  const prefix = sy.projectContext(project).supervisor.branch_prefix;
  const workspace = [...sessions].reverse().find((s) => s.workspace?.repos.length)?.workspace ?? null;
  let branches: JobView["branches"] = (workspace?.repos ?? []).flatMap((r) => (r.baseCommit ? [{ alias: r.alias, branch: r.branch ?? `${prefix}${taskId}`, baseSha: r.baseCommit, worktree: r.worktree }] : []));
  // The transcript reads the whole session log, so list views skip it.
  let transcript = latest && withTranscript && stores.sessions ? jobTurns(stores.sessions.transcript(latest.id) ?? []) : [];
  if (!branches.length || (withTranscript && !transcript.length)) {
    const st = stores.db.prepare("SELECT s.messages_json, s.detail_json FROM job_state s JOIN tasks t ON t.id = s.task_id WHERE s.task_id = ? AND t.project_id = ?").get(taskId, task.row.project_id) as { messages_json: string; detail_json: string | null } | undefined;
    if (st) {
      if (!branches.length) branches = st.detail_json ? ((JSON.parse(st.detail_json) as { repos?: JobView["branches"] }).repos ?? []) : [];
      if (withTranscript && !transcript.length) transcript = jobTurns(JSON.parse(st.messages_json) as TranscriptMessage[]);
    }
  }
  return { sessionId: latest?.id ?? null, branches, transcript };
}

/**
 * Jobs, newest first; `project` limits them to one project's (all projects when omitted, merged
 * from each project's store). `unavailable` names projects whose store could not be read.
 */
export function jobsView(sy: MeritRouter, limit = 50, project?: string): RowsWithAvailability<JobView> {
  const { rows, unavailable } = fanOutProjects(sy, projectScope(sy, project, { qualification: true }), (stores, slug) => {
    // A task stored with project_id='' belongs to the primary project by convention (ownedBy);
    // scanning the primary project's slug must also pick up those rows, or they are never listed.
    const f = projectIdFilter(sy, slug);
    return (stores.db.prepare(`SELECT id, created_at FROM tasks WHERE profile = 'supervise' AND ${f.sql} ORDER BY created_at DESC LIMIT ?`).all(...f.args, limit) as Array<{ id: string; created_at: number }>).map((r) => ({ ...r, stores, slug }));
  });
  const views = newestFirst(rows, (r) => r.created_at, limit).flatMap((r) => {
    const task = taskIn(sy, r.stores, r.id);
    if (!task || task.spec.profile !== "supervise") return [];
    const { transcript: _t, questions: _q, ...view } = jobDetailOf(sy, { project: r.slug, stores: r.stores, task }, { transcript: false });
    return [view];
  });
  return withAvailability(views, unavailable);
}

export type JobDetailView = JobView & { transcript: JobTurn[]; questions: ReturnType<MeritRouter["questions"]> };

/**
 * One job with its supervisor transcript (empty when `opts.transcript` is false) and every question
 * it asked; `opts.project` reads only that project's store (every project's otherwise).
 */
export function jobDetail(sy: MeritRouter, id: string, opts: { transcript?: boolean; project?: string } = {}): JobDetailView | null {
  const located = locateProjectTask(sy, id, opts.project);
  if (!located || located.task.spec.profile !== "supervise") return null;
  return jobDetailOf(sy, located, opts);
}

/** A located job's detail (shared by the list, the detail, and plan recovery). */
export function jobDetailOf(sy: MeritRouter, located: ProjectTask, opts: { transcript?: boolean } = {}): JobDetailView {
  const { stores, project, task: t } = located;
  const id = t.row.id;
  const rec = jobRecord(sy, located, opts.transcript !== false);
  const children = (stores.db.prepare("SELECT id FROM tasks WHERE json_extract(spec_json, '$.parentTaskId') = ? AND project_id = ? ORDER BY created_at").all(id, t.row.project_id) as { id: string }[]).flatMap((c) => {
    const ct = stores.tasks.get(c.id);
    return ct ? [{ taskId: c.id, label: ct.spec.label ?? null, profile: ct.spec.profile, state: ct.row.state, acceptance: ct.result?.acceptanceStatus ?? null }] : [];
  });
  const parent = t.spec.parentTaskId ? taskIn(sy, stores, t.spec.parentTaskId) : undefined;
  return {
    taskId: id,
    project: t.row.project_id,
    label: t.spec.label ?? null,
    parentJobId: parent?.spec.profile === "supervise" ? parent.row.id : null,
    goal: t.spec.goal,
    state: t.row.state,
    createdAt: t.row.created_at,
    finishedAt: t.row.finished_at,
    modelRequestsUsed: taskRequestsUsed(stores, id),
    branches: rec.branches,
    children,
    pendingQuestions: projectQuestions(stores, { taskId: id }).length,
    // A sub-job reports into its parent's working document (its own section there).
    workingDoc: sy.brainFor(project).workingDocPath(t.spec.brain?.effort ?? `job-${id}`),
    result: t.result,
    sessionId: rec.sessionId,
    transcript: rec.transcript,
    questions: projectQuestions(stores, { taskId: id, pendingOnly: false }),
  };
}
