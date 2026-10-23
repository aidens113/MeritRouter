import type { Switchyard } from "../core/service.js";
import type { TaskState, WorkerResult } from "../core/task.js";
import { contextOfTask } from "./projects.js";

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
 * that predate sessions.
 */
function jobRecord(sy: Switchyard, taskId: string, withTranscript: boolean): { sessionId: string | null; branches: JobView["branches"]; transcript: JobTurn[] } {
  const sessions = sy.sessions.forTask(taskId).filter((s) => s.role === "supervisor");
  const latest = sessions.at(-1) ?? null;
  const prefix = contextOfTask(sy, taskId).supervisor.branch_prefix;
  const workspace = [...sessions].reverse().find((s) => s.workspace?.repos.length)?.workspace ?? null;
  let branches: JobView["branches"] = (workspace?.repos ?? []).flatMap((r) => (r.baseCommit ? [{ alias: r.alias, branch: r.branch ?? `${prefix}${taskId}`, baseSha: r.baseCommit, worktree: r.worktree }] : []));
  // The transcript reads the whole session log, so list views skip it.
  let transcript = latest && withTranscript ? jobTurns(sy.sessions.transcript(latest.id) ?? []) : [];
  if (!branches.length || (withTranscript && !transcript.length)) {
    const st = sy.db.prepare("SELECT messages_json, detail_json FROM job_state WHERE task_id = ?").get(taskId) as { messages_json: string; detail_json: string | null } | undefined;
    if (st) {
      if (!branches.length) branches = st.detail_json ? ((JSON.parse(st.detail_json) as { repos?: JobView["branches"] }).repos ?? []) : [];
      if (withTranscript && !transcript.length) transcript = jobTurns(JSON.parse(st.messages_json) as TranscriptMessage[]);
    }
  }
  return { sessionId: latest?.id ?? null, branches, transcript };
}

/** Jobs, newest first; `project` limits them to one project's (all projects when omitted). */
export function jobsView(sy: Switchyard, limit = 50, project?: string): JobView[] {
  const rows = sy.db.prepare(`SELECT id FROM tasks WHERE profile = 'supervise'${project ? " AND project_id = ?" : ""} ORDER BY created_at DESC LIMIT ?`).all(...(project ? [project] : []), limit) as { id: string }[];
  return rows.flatMap((r) => {
    const j = jobDetail(sy, r.id, { transcript: false });
    if (!j) return [];
    const { transcript: _t, questions: _q, ...view } = j;
    return [view];
  });
}

/** One job with its supervisor transcript (empty when `opts.transcript` is false) and every question it asked. */
export function jobDetail(sy: Switchyard, id: string, opts: { transcript?: boolean } = {}): (JobView & { transcript: JobTurn[]; questions: ReturnType<Switchyard["questions"]> }) | null {
  const t = sy.tasks.get(id);
  if (!t || t.spec.profile !== "supervise") return null;
  const rec = jobRecord(sy, id, opts.transcript !== false);
  const children = (sy.db.prepare("SELECT id FROM tasks WHERE json_extract(spec_json, '$.parentTaskId') = ? AND project_id = ? ORDER BY created_at").all(id, t.row.project_id) as { id: string }[]).map((c) => {
    const ct = sy.tasks.get(c.id)!;
    return { taskId: c.id, label: ct.spec.label ?? null, profile: ct.spec.profile, state: ct.row.state, acceptance: ct.result?.acceptanceStatus ?? null };
  });
  const parent = t.spec.parentTaskId ? sy.tasks.get(t.spec.parentTaskId) : null;
  return {
    taskId: id,
    project: t.row.project_id,
    label: t.spec.label ?? null,
    parentJobId: parent?.spec.profile === "supervise" ? parent.row.id : null,
    goal: t.spec.goal,
    state: t.row.state,
    createdAt: t.row.created_at,
    finishedAt: t.row.finished_at,
    modelRequestsUsed: sy.admission.taskTotals(id).requests,
    branches: rec.branches,
    children,
    pendingQuestions: sy.questions({ taskId: id }).length,
    // A sub-job reports into its parent's working document (its own section there).
    workingDoc: sy.brainFor(contextOfTask(sy, id).project.slug).workingDocPath(t.spec.brain?.effort ?? `job-${id}`),
    result: t.result,
    sessionId: rec.sessionId,
    transcript: rec.transcript,
    questions: sy.questions({ taskId: id, pendingOnly: false }),
  };
}
