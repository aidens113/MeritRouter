import { scopedSessionTimeline } from "./session-project-scope.js";
import { z } from "zod";
import { requestEvidence, type RequestEvidence } from "./request-evidence.js";
import type { WebCitation } from "../gateway/types.js";
import { parseCitations } from "./request-citations.js";
import { existsSync } from "node:fs";
import { ROLE_NAMES } from "../config/schema.js";
import type { Switchyard } from "../core/service.js";
import type { TaskState } from "../core/task.js";
import type { SessionRecord } from "../sessions/store.js";
import type { SessionEvent } from "../sessions/events.js";
import { parseTrailers } from "../attribution/index.js";
import { git } from "../workspaces/git.js";

/**
 * Entities and how they connect, for the panel's entity pages (panel-v2 D6): agents (the
 * attribution identity `<role>:<label>`, e.g. `implementer:posts`, `supervisor:<job>`), model
 * requests, commits and repositories, and what is related to a task, a session, or a model.
 * Everything is read-only. Request ids come from the sessions' own logs (a `model_response`
 * names its request), so an agent's requests are exactly the ones its sessions made.
 */

/** Session logs read for one view at most (each is a file read). */
const MAX_LOGS = 60;
/** Commits listed per query at most. */
const MAX_COMMITS = 200;
/** Diff text returned for one commit at most. */
const MAX_DIFF_BYTES = 200_000;

export interface AgentId {
  /** `<role>:<label>`. */
  id: string;
  role: string;
  label: string;
}

/** An agent id from untrusted input (a URL): `<role>:<label>` with a known role; null otherwise. */
export function parseAgentId(raw: string): AgentId | null {
  if (!z.string().min(3).max(240).safeParse(raw).success) return null;
  const i = raw.indexOf(":");
  if (i <= 0 || raw.length > 240) return null;
  const role = raw.slice(0, i);
  const label = raw.slice(i + 1);
  if (!(ROLE_NAMES as readonly string[]).includes(role) || !label || /[\s\u0000-\u001f]/.test(label)) return null;
  return { id: raw, role, label };
}

// ---------- agents ----------

export interface AgentRow extends AgentId {
  project: string;
  sessions: number;
  running: number;
  tasks: number;
  firstAt: number;
  lastAt: number;
  /** The newest session's status. */
  lastStatus: string;
}

/** Agents (grouped sessions), most recently active first; `project` limits them to one project's. */
export function agentsView(sy: Switchyard, opts: { project?: string; role?: string; limit?: number } = {}): AgentRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.project) {
    where.push("project_id = ?");
    args.push(opts.project);
  }
  if (opts.role) {
    where.push("role = ?");
    args.push(opts.role);
  }
  const rows = sy.db
    .prepare(
      `SELECT agent_label AS id, role, project_id AS project, COUNT(*) AS sessions, SUM(status = 'running') AS running, COUNT(DISTINCT task_id) AS tasks,
              MIN(created_at) AS firstAt, MAX(updated_at) AS lastAt,
              (SELECT s2.status FROM sessions s2 WHERE s2.agent_label = s.agent_label AND s2.project_id = s.project_id ORDER BY s2.created_at DESC LIMIT 1) AS lastStatus
         FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY agent_label, project_id ORDER BY MAX(updated_at) DESC LIMIT ?`,
    )
    .all(...args, Math.min(opts.limit ?? 200, 2000)) as Array<Omit<AgentRow, "label">>;
  return rows.map((r) => ({ ...r, label: r.id.slice(r.id.indexOf(":") + 1), running: Number(r.running ?? 0) }));
}

export interface EntityTask {
  taskId: string;
  label: string | null;
  profile: string;
  state: TaskState;
  acceptance: string | null;
  tier: string | null;
  project: string;
  /** The supervising job (spec.parentTaskId), when the task was delegated. */
  parentTaskId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface EntityRequest {
  id: string;
  reservedAt: number;
  finishedAt: number | null;
  status: string;
  purpose: string;
  tier: string | null;
  endpointId: string | null;
  servedModel: string | null;
  servedProvider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  paidUsd: number | null;
  errorKind: string | null;
  project: string;
  taskIds: string[];
  /** The session whose log names this request, when known. */
  sessionId: string | null;
}

export interface ModelUse {
  endpointId: string;
  servedModel: string | null;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface EntityCommit {
  repository: string;
  commit: string;
  subject: string;
  date: string;
  authorName: string;
  agent: string | null;
  role: string | null;
  model: string | null;
  task: string | null;
  job: string | null;
  request: string | null;
  added: number;
  removed: number;
  files: number;
}

export interface AgentDetail {
  agent: AgentId;
  project: string;
  sessions: SessionRecord[];
  tasks: EntityTask[];
  models: ModelUse[];
  requests: EntityRequest[];
  commits: EntityCommit[];
  /** Why commits could not be read (a repository missing or not a git repository). */
  commitsErrors: string[];
  jobs: Array<{ jobId: string; label: string | null; supervisor: string }>;
  totals: { sessions: number; running: number; tasks: number; requests: number; failedRequests: number; inputTokens: number; outputTokens: number; costUsd: number; paidUsd: number; commits: number; linesAdded: number; linesRemoved: number };
}

function taskRows(sy: Switchyard, ids: string[]): EntityTask[] {
  const out: EntityTask[] = [];
  const q = sy.db.prepare(
    `SELECT id, profile, state, tier, project_id, created_at, finished_at, json_extract(spec_json, '$.label') AS label,
            json_extract(spec_json, '$.parentTaskId') AS parent, json_extract(result_json, '$.acceptanceStatus') AS acceptance
       FROM tasks WHERE id = ?`,
  );
  for (const id of ids) {
    const r = q.get(id) as Record<string, unknown> | undefined;
    if (!r) continue;
    out.push({
      taskId: String(r.id),
      label: (r.label as string | null) ?? null,
      profile: String(r.profile),
      state: r.state as TaskState,
      acceptance: (r.acceptance as string | null) ?? null,
      tier: (r.tier as string | null) ?? null,
      project: String(r.project_id ?? ""),
      parentTaskId: (r.parent as string | null) ?? null,
      createdAt: Number(r.created_at),
      finishedAt: (r.finished_at as number | null) ?? null,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** The requests a session made: ids named by its log's model responses, plus failed ones of its executions while it ran. */
function sessionRequestIds(sy: Switchyard, session: SessionRecord): string[] {
  const page = sy.sessions.events(session.id, { limit: 100_000 });
  if (!page) return [];
  const ids = new Set<string>();
  const executions = new Set<string>();
  for (const e of page.events as SessionEvent[]) {
    if (e.type === "model_response") ids.add(e.data.requestId);
    else if (e.type === "model_request") executions.add(e.data.executionId);
  }
  if (executions.size && session.taskId) {
    const failed = sy.db
      .prepare(
        `SELECT r.id FROM model_requests r JOIN request_charges c ON c.request_id = r.id
          WHERE c.task_id = ? AND r.status != 'succeeded' AND r.reserved_at >= ? AND r.reserved_at <= ? AND r.execution_id IN (${[...executions].map(() => "?").join(",")})`,
      )
      .all(session.taskId, session.createdAt, session.endedAt ?? Date.now(), ...executions) as Array<{ id: string }>;
    for (const r of failed) ids.add(r.id);
  }
  return [...ids];
}

function requestRows(sy: Switchyard, ids: string[], sessionOf: Map<string, string> = new Map()): EntityRequest[] {
  if (!ids.length) return [];
  const out: EntityRequest[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = sy.db
      .prepare(
        `SELECT r.*, (SELECT group_concat(task_id) FROM request_charges c WHERE c.request_id = r.id) AS task_ids,
                (SELECT COALESCE(s.actual_usd, s.reserved_usd) FROM paid_spend s WHERE s.request_id = r.id) AS paid_usd
           FROM model_requests r WHERE r.id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.id);
      out.push({
        id,
        reservedAt: Number(r.reserved_at),
        finishedAt: (r.finished_at as number | null) ?? null,
        status: String(r.status),
        purpose: String(r.purpose),
        tier: (r.tier as string | null) ?? null,
        endpointId: (r.endpoint_id as string | null) ?? (r.served_endpoint_id as string | null) ?? null,
        servedModel: (r.served_model as string | null) ?? null,
        servedProvider: (r.served_provider as string | null) ?? null,
        inputTokens: (r.input_tokens as number | null) ?? null,
        outputTokens: (r.output_tokens as number | null) ?? null,
        costUsd: (r.reported_cost_usd as number | null) ?? (r.estimated_cost_usd as number | null) ?? null,
        paidUsd: (r.paid_usd as number | null) ?? null,
        errorKind: (r.error_kind as string | null) ?? null,
        project: String(r.project_id ?? ""),
        taskIds: r.task_ids ? String(r.task_ids).split(",") : [],
        sessionId: sessionOf.get(id) ?? null,
      });
    }
  }
  return out.sort((a, b) => b.reservedAt - a.reservedAt);
}

function modelUse(requests: EntityRequest[]): ModelUse[] {
  const by = new Map<string, ModelUse>();
  for (const r of requests) {
    const key = r.endpointId ?? r.servedModel ?? "unknown";
    const m = by.get(key) ?? { endpointId: key, servedModel: r.servedModel, requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    m.requests++;
    if (r.status === "failed") m.failed++;
    m.inputTokens += r.inputTokens ?? 0;
    m.outputTokens += r.outputTokens ?? 0;
    m.costUsd += r.paidUsd ?? r.costUsd ?? 0;
    m.servedModel ??= r.servedModel;
    by.set(key, m);
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests);
}

/** An agent's page: its tasks, sessions, models, requests, commits (with lines), and jobs. Null when it never ran in `project`. */
export async function agentDetail(sy: Switchyard, project: string, rawId: string): Promise<AgentDetail | null> {
  const agent = parseAgentId(rawId);
  if (!agent) return null;
  const ids = sy.db.prepare("SELECT id FROM sessions WHERE agent_label = ? AND project_id = ? ORDER BY created_at DESC").all(agent.id, project) as Array<{ id: string }>;
  const sessions = ids.map((r) => sy.sessions.get(r.id)).filter((s): s is SessionRecord => !!s);
  if (!sessions.length) return null;
  const sessionOf = new Map<string, string>();
  for (const s of sessions.slice(0, MAX_LOGS)) for (const id of sessionRequestIds(sy, s)) if (!sessionOf.has(id)) sessionOf.set(id, s.id);
  const requests = requestRows(sy, [...sessionOf.keys()], sessionOf);
  const tasks = taskRows(sy, [...new Set(sessions.map((s) => s.taskId).filter((t): t is string => !!t))]);
  const jobIds = [...new Set([...sessions.map((s) => s.jobId), ...tasks.map((t) => (t.profile === "supervise" ? t.taskId : t.parentTaskId))].filter((j): j is string => !!j))];
  const jobs = jobIds.map((jobId) => {
    const label = (sy.db.prepare("SELECT json_extract(spec_json, '$.label') AS l FROM tasks WHERE id = ?").get(jobId) as { l: string | null } | undefined)?.l ?? null;
    return { jobId, label, supervisor: `supervisor:${label ?? jobId}` };
  });
  const { commits, errors } = await projectCommits(sy, project, { agent: agent.id });
  const sum = (f: (r: EntityRequest) => number) => requests.reduce((n, r) => n + f(r), 0);
  return {
    agent,
    project,
    sessions,
    tasks,
    models: modelUse(requests),
    requests,
    commits,
    commitsErrors: errors,
    jobs,
    totals: {
      sessions: sessions.length,
      running: sessions.filter((s) => s.status === "running").length,
      tasks: tasks.length,
      requests: requests.length,
      failedRequests: requests.filter((r) => r.status === "failed").length,
      inputTokens: sum((r) => r.inputTokens ?? 0),
      outputTokens: sum((r) => r.outputTokens ?? 0),
      costUsd: sum((r) => r.paidUsd ?? r.costUsd ?? 0),
      paidUsd: sum((r) => r.paidUsd ?? 0),
      commits: commits.length,
      linesAdded: commits.reduce((n, c) => n + c.added, 0),
      linesRemoved: commits.reduce((n, c) => n + c.removed, 0),
    },
  };
}

// ---------- requests ----------

export interface RequestDetail extends EntityRequest {
  evidence: RequestEvidence | null;
  webCitations: WebCitation[];
  attempts: number | null;
  attemptsExact: boolean | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  usageBasis: string | null;
  estInputTokens: number;
  reservedOutputTokens: number;
  httpStatus: number | null;
  errorMessage: string | null;
  policyViolation: string | null;
  routeNote: string | null;
  cacheHit: boolean | null;
  executionId: string;
  nativeWebSearch: string | null;
  webSearchRequests: number | null;
  /** Each task charged for the request (a batch charges several). */
  charges: Array<{ taskId: string; inputTokens: number; outputTokens: number; exact: boolean }>;
  tasks: EntityTask[];
  /** Sessions whose logs name the request, with their agent. */
  sessions: Array<{ sessionId: string; agent: string; role: string }>;
}

/** One model request with everything it connects to; null for an unknown id. */
export function requestDetail(sy: Switchyard, id: string, project?: string): RequestDetail | null {
  const r = sy.db.prepare(`SELECT * FROM model_requests WHERE id = ?${project === undefined ? "" : " AND project_id = ?"}`).get(...(project === undefined ? [id] : [id, project])) as Record<string, unknown> | undefined;
  if (!r) return null;
  const charges = (sy.db.prepare("SELECT c.task_id,c.input_tokens,c.output_tokens,c.tokens_exact FROM request_charges c JOIN tasks t ON t.id=c.task_id WHERE c.request_id=? AND t.project_id=? LIMIT 50").all(id, String(r.project_id)) as Array<Record<string, number | string>>).map((c) => ({
    taskId: String(c.task_id), inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens), exact: Number(c.tokens_exact) === 1,
  }));
  const evidence = requestEvidence(sy, String(r.project_id), id);
  const sessions = evidence?.exchanges.flatMap(exchange => exchange.sessions) ?? [];
  const base = requestRows(sy, [id], new Map(sessions.length ? [[id, sessions[0]!.sessionId]] : []))[0]!;
  let tasks: EntityTask[] = [];
  try { tasks = taskRows(sy, charges.map(c => c.taskId)); }
  catch { if (evidence) { evidence.warnings.push("Related task metadata is malformed; task summaries omitted."); if (evidence.state === "available") evidence.state = "partial"; } }
  return {
    ...base,
    taskIds: charges.map(c => c.taskId),
    evidence,
    webCitations: evidence?.payloadScopeExclusive ? parseCitations(r.web_citations_json) : [],
    attempts: (r.provider_attempts as number | null) ?? null,
    attemptsExact: r.attempts_exact === null || r.attempts_exact === undefined ? null : Number(r.attempts_exact) === 1,
    cachedInputTokens: (r.cached_input_tokens as number | null) ?? null,
    reasoningTokens: (r.reasoning_tokens as number | null) ?? null,
    usageBasis: (r.usage_basis as string | null) ?? null,
    estInputTokens: Number(r.est_input_tokens),
    reservedOutputTokens: Number(r.reserved_output_tokens),
    httpStatus: (r.http_status as number | null) ?? null,
    errorMessage: evidence?.payloadScopeExclusive ? (r.error_message as string | null) ?? null : null,
    policyViolation: (r.policy_violation as string | null) ?? null,
    routeNote: evidence?.payloadScopeExclusive ? (r.route_note as string | null) ?? null : null,
    cacheHit: r.cache_hit === null || r.cache_hit === undefined ? null : Number(r.cache_hit) === 1,
    executionId: String(r.execution_id),
    nativeWebSearch: (r.native_web_search as string | null) ?? null,
    webSearchRequests: (r.web_search_requests as number | null) ?? null,
    charges,
    tasks,
    sessions,
  };
}

/** The requests one session made (newest first). */
export function sessionRequests(sy: Switchyard, sessionId: string): EntityRequest[] {
  const s = sy.sessions.get(sessionId);
  if (!s) return [];
  const owner = sy.db.prepare("SELECT project_id FROM sessions WHERE id=?").get(sessionId) as {project_id:string}|undefined;
  const timeline = owner ? scopedSessionTimeline(sy,sessionId,owner.project_id) : null;
  if (!timeline) return [];
  const ids = new Set(timeline.flatMap(e=>e.type === "model_response" ? [e.data.requestId] : []));
  const executions = [...new Set(timeline.flatMap(e=>e.type === "model_request" || e.type === "model_error" ? [e.data.executionId] : []))];
  if (executions.length && s.taskId) {
    const failed = sy.db.prepare(`SELECT DISTINCT r.id FROM model_requests r JOIN request_charges c ON c.request_id=r.id
      WHERE c.task_id=? AND r.project_id=? AND r.status!='succeeded' AND r.reserved_at>=? AND r.reserved_at<=?
      AND r.execution_id IN (${executions.map(()=>"?").join(",")}) LIMIT 1000`).all(s.taskId,owner!.project_id,s.createdAt,s.endedAt ?? Date.now(),...executions) as Array<{id:string}>;
    for (const row of failed) ids.add(row.id);
  }
  const list = [...ids];
  return requestRows(sy, list, new Map(list.map((i) => [i, sessionId])));
}

// ---------- commits and repositories ----------

const SHA_RE = /^[0-9a-f]{7,40}$/;
const SEP = "\x1f";
const REC = "\x1e";
const LOG_FORMAT = `${REC}%H${SEP}%s${SEP}%aI${SEP}%an${SEP}%(trailers:unfold,only)${SEP}`;

function parseLog(repository: string, raw: string): EntityCommit[] {
  const out: EntityCommit[] = [];
  for (const rec of raw.split(REC)) {
    if (!rec.trim()) continue;
    const parts = rec.split(SEP);
    const [commit, subject, date, authorName, trailers] = parts;
    if (!commit || !SHA_RE.test(commit)) continue;
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of (parts[5] ?? "").split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files++;
      added += m[1] === "-" ? 0 : Number(m[1]);
      removed += m[2] === "-" ? 0 : Number(m[2]);
    }
    const t = parseTrailers(trailers ?? "");
    out.push({
      repository,
      commit,
      subject: subject ?? "",
      date: date ?? "",
      authorName: authorName ?? "",
      agent: t.Agent ?? null,
      role: t.Role ?? null,
      model: t.Model ?? null,
      task: t.Task ?? null,
      job: t.Job ?? null,
      request: t.Request ?? null,
      added,
      removed,
      files,
    });
  }
  return out;
}

function projectRepos(sy: Switchyard, project: string): Record<string, { path: string; writable: boolean }> {
  return sy.projects.get(project)?.repositoryPaths ?? {};
}

/**
 * Commits in a project's repositories (every branch, newest first) whose attribution trailers
 * match every given value: an agent, a task, or a job.
 */
export async function projectCommits(sy: Switchyard, project: string, filter: { agent?: string; task?: string; job?: string; repository?: string }, limit = MAX_COMMITS): Promise<{ commits: EntityCommit[]; errors: string[] }> {
  const greps = [filter.agent ? `Agent: ${filter.agent}` : null, filter.task ? `Task: ${filter.task}` : null, filter.job ? `Job: ${filter.job}` : null].filter((g): g is string => !!g);
  const commits: EntityCommit[] = [];
  const errors: string[] = [];
  for (const [alias, repo] of Object.entries(projectRepos(sy, project))) {
    if (filter.repository && filter.repository !== alias) continue;
    if (!existsSync(repo.path)) continue;
    try {
      const raw = await git(repo.path, ["log", "--all", "--no-merges", `--max-count=${Math.min(limit, MAX_COMMITS)}`, `--format=${LOG_FORMAT}`, "--numstat", ...(greps.length ? ["-F", "--all-match", ...greps.map((g) => `--grep=${g}`)] : [])]);
      commits.push(
        ...parseLog(alias, raw).filter((c) => (!filter.agent || c.agent === filter.agent) && (!filter.task || c.task === filter.task) && (!filter.job || c.job === filter.job)),
      );
    } catch (err) {
      errors.push(`${alias}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return { commits: commits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit), errors };
}

export interface CommitDetail extends EntityCommit {
  body: string;
  parents: string[];
  /** Per file: lines added and removed (null for binary files). */
  fileStats: Array<{ path: string; added: number | null; removed: number | null }>;
  /** Branches that contain the commit. */
  branches: string[];
  diff: string;
  diffTruncated: boolean;
}

/** One commit of a project's repository, with its attribution, files, branches, and diff; null when unknown. */
export async function commitDetail(sy: Switchyard, project: string, alias: string, sha: string): Promise<CommitDetail | null> {
  const repositories = projectRepos(sy, project);
  const repo = Object.hasOwn(repositories, alias) ? repositories[alias] : undefined;
  if (!repo || !SHA_RE.test(sha) || !existsSync(repo.path)) return null;
  let raw: string;
  try {
    raw = await git(repo.path, ["show", "--no-color", "-M", `--format=${LOG_FORMAT}%P${SEP}%b${SEP}`, "--numstat", sha, "--"]);
  } catch {
    return null;
  }
  const parts = raw.split(REC)[1]?.split(SEP) ?? [];
  const [commit, subject, date, authorName, trailers, parents, body, stats] = parts;
  if (!commit) return null;
  const fileStats = (stats ?? "")
    .split(/\r?\n/)
    .map((l) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[3]!, added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) }));
  const t = parseTrailers(trailers ?? "");
  let diff = "";
  try {
    diff = await git(repo.path, ["show", "--no-color", "-M", "--format=", "--patch", sha, "--"], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    diff = "";
  }
  let branches: string[] = [];
  try {
    branches = (await git(repo.path, ["branch", "--format=%(refname:short)", "--contains", commit])).split(/\r?\n/).filter(Boolean);
  } catch {
    branches = [];
  }
  const bodyText = (body ?? "").replace(trailers ?? "", "").trim();
  return {
    repository: alias,
    commit,
    subject: subject ?? "",
    date: date ?? "",
    authorName: authorName ?? "",
    agent: t.Agent ?? null,
    role: t.Role ?? null,
    model: t.Model ?? null,
    task: t.Task ?? null,
    job: t.Job ?? null,
    request: t.Request ?? null,
    added: fileStats.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: fileStats.reduce((n, f) => n + (f.removed ?? 0), 0),
    files: fileStats.length,
    body: bodyText,
    parents: (parents ?? "").split(" ").filter(Boolean),
    fileStats,
    branches,
    diff: diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) : diff,
    diffTruncated: diff.length > MAX_DIFF_BYTES,
  };
}

export interface RepositoryView {
  alias: string;
  path: string;
  writable: boolean;
  exists: boolean;
  head: string | null;
  branch: string | null;
  branches: Array<{ name: string; commit: string; date: string; subject: string }>;
  commits: EntityCommit[];
  error: string | null;
}

/** A project's repository: where it is, its branches, and its newest commits with attribution. Null for an unknown alias. */
export async function repositoryView(sy: Switchyard, project: string, alias: string, limit = 50): Promise<RepositoryView | null> {
  const repositories = projectRepos(sy, project);
  const repo = Object.hasOwn(repositories, alias) ? repositories[alias] : undefined;
  if (!repo) return null;
  const view: RepositoryView = { alias, path: repo.path, writable: repo.writable, exists: existsSync(repo.path), head: null, branch: null, branches: [], commits: [], error: null };
  if (!view.exists) return view;
  try {
    view.head = (await git(repo.path, ["rev-parse", "HEAD"])).trim() || null;
    view.branch = (await git(repo.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
    view.branches = (await git(repo.path, ["for-each-ref", "refs/heads", `--format=%(refname:short)${SEP}%(objectname)${SEP}%(committerdate:iso-strict)${SEP}%(subject)`]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [name, commit, date, subject] = l.split(SEP);
        return { name: name ?? "", commit: commit ?? "", date: date ?? "", subject: subject ?? "" };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    view.commits = (await projectCommits(sy, project, { repository: alias }, limit)).commits;
  } catch (err) {
    view.error = (err as Error).message.split("\n")[0] ?? "git failed";
  }
  return view;
}

// ---------- related ----------

export interface TaskRelated {
  job: { jobId: string; label: string | null } | null;
  /** Enclosing jobs, nearest first (a sub-job's parent job, and so on). */
  ancestors: Array<{ jobId: string; label: string | null }>;
  agents: Array<{ id: string; role: string; sessions: number }>;
  sessions: number;
  models: ModelUse[];
  requests: number;
  commits: EntityCommit[];
  commitsErrors: string[];
  /** Worker reports in the brain for this task's label (paths), from the brain's index. */
  reports: string[];
  dependsOn: string[];
  children: EntityTask[];
}

/** Everything a task connects to, for its page's Related panel. Null for an unknown task. */
export async function taskRelated(sy: Switchyard, taskId: string): Promise<TaskRelated | null> {
  const t = sy.tasks.get(taskId);
  if (!t) return null;
  const project = t.row.project_id;
  const parentOf = (id: string) => sy.tasks.get(id)?.spec.parentTaskId ?? null;
  const labelOf = (id: string) => sy.tasks.get(id)?.spec.label ?? null;
  const ancestors: TaskRelated["ancestors"] = [];
  let cur = t.spec.parentTaskId ?? null;
  for (let depth = 0; cur && depth < 8; depth++) {
    ancestors.push({ jobId: cur, label: labelOf(cur) });
    cur = parentOf(cur);
  }
  const sessions = sy.sessions.forTask(taskId);
  const agents = new Map<string, { id: string; role: string; sessions: number }>();
  for (const s of sessions) {
    const a = agents.get(s.agentLabel) ?? { id: s.agentLabel, role: s.role, sessions: 0 };
    a.sessions++;
    agents.set(s.agentLabel, a);
  }
  const reqIds = (sy.db.prepare("SELECT request_id AS id FROM request_charges WHERE task_id = ?").all(taskId) as Array<{ id: string }>).map((r) => r.id);
  const requests = requestRows(sy, reqIds);
  const { commits, errors } = project ? await projectCommits(sy, project, { task: taskId }) : { commits: [], errors: [] };
  const label = t.spec.label ?? taskId;
  const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const reports = (
    sy.db.prepare("SELECT path FROM brain_files WHERE path LIKE ? ESCAPE '\\' ORDER BY path").all(`projects/${likeEscape(project)}/working/%/reports/${likeEscape(label)}.md`) as Array<{ path: string }>
  ).map((r) => r.path);
  const children = (sy.db.prepare("SELECT id FROM tasks WHERE json_extract(spec_json, '$.parentTaskId') = ? ORDER BY created_at").all(taskId) as Array<{ id: string }>).map((r) => r.id);
  return {
    job: ancestors[0] ?? null,
    ancestors,
    agents: [...agents.values()],
    sessions: sessions.length,
    models: modelUse(requests),
    requests: requests.length,
    commits,
    commitsErrors: errors,
    reports,
    dependsOn: (sy.db.prepare("SELECT depends_on FROM task_deps WHERE task_id = ?").all(taskId) as Array<{ depends_on: string }>).map((r) => r.depends_on),
    children: taskRows(sy, children),
  };
}

export interface ModelUsage {
  tasks: Array<EntityTask & { requests: number; lastAt: number }>;
  agents: Array<{ id: string; role: string; project: string; requests: number }>;
  projects: Array<{ project: string; requests: number }>;
}

/** Who used a model recently: the tasks charged for its newest requests, their agents, and projects. */
export function modelUsage(sy: Switchyard, endpointId: string, limit = 200): ModelUsage {
  const rows = sy.db
    .prepare(
      `SELECT r.id, r.reserved_at, r.project_id, c.task_id FROM model_requests r JOIN request_charges c ON c.request_id = r.id
        WHERE r.endpoint_id = ? ORDER BY r.reserved_at DESC LIMIT ?`,
    )
    .all(endpointId, limit) as Array<{ id: string; reserved_at: number; project_id: string; task_id: string }>;
  const perTask = new Map<string, { requests: number; lastAt: number; ids: Set<string> }>();
  const perProject = new Map<string, number>();
  for (const r of rows) {
    const t = perTask.get(r.task_id) ?? { requests: 0, lastAt: 0, ids: new Set<string>() };
    t.requests++;
    t.lastAt = Math.max(t.lastAt, r.reserved_at);
    t.ids.add(r.id);
    perTask.set(r.task_id, t);
    perProject.set(r.project_id, (perProject.get(r.project_id) ?? 0) + 1);
  }
  const tasks = taskRows(sy, [...perTask.keys()]).map((t) => ({ ...t, requests: perTask.get(t.taskId)!.requests, lastAt: perTask.get(t.taskId)!.lastAt }));
  const agents = new Map<string, { id: string; role: string; project: string; requests: number }>();
  let read = 0;
  for (const t of tasks) {
    const ids = perTask.get(t.taskId)!.ids;
    for (const s of sy.sessions.forTask(t.taskId)) {
      if (read++ >= MAX_LOGS) break;
      const n = sessionRequestIds(sy, s).filter((id) => ids.has(id)).length;
      if (!n) continue;
      const key = `${t.project}\n${s.agentLabel}`;
      const a = agents.get(key) ?? { id: s.agentLabel, role: s.role, project: t.project, requests: 0 };
      a.requests += n;
      agents.set(key, a);
    }
  }
  return {
    tasks: tasks.sort((a, b) => b.lastAt - a.lastAt),
    agents: [...agents.values()].sort((a, b) => b.requests - a.requests),
    projects: [...perProject.entries()].map(([project, requests]) => ({ project, requests })).sort((a, b) => b.requests - a.requests),
  };
}
