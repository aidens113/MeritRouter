import { z } from "zod";
import { maxAgentsPerJob, type Importance, type ProfileName } from "../config/schema.js";
import type { Switchyard } from "../core/service.js";
import { isTerminal, type TaskState } from "../core/task.js";
import { UPSTREAM_CONTEXT_EVENT, UpstreamContextEventSchema, type BaseChoice } from "../context/upstream.js";
import { FileLeaseStore, type FileLease } from "../storage/file-leases.js";
import { splitRepoKey } from "../projects/context.js";
import { PlanStore, criticalPath, type CriticalPath, type JobPlan, type PlanDifficulty } from "../storage/plans.js";
import { AWAITING_ACCEPTANCE, WAITING_FOR_FILE_LEASE, WAITING_FOR_PROJECT_CAP, type StoredTask, type TaskRow } from "../storage/tasks.js";
import { REDUNDANCY_SETTLED, REDUNDANCY_SKIPPED, REDUNDANCY_STARTED } from "../core/redundancy.js";
import { contextOfTask } from "./projects.js";

// A job's task graph for people and supervisors: the plan's nodes joined with the tasks they
// were dispatched as, the critical path, the job's file leases, and why waiting nodes wait.

/** Why a node has not started. `text` is a plain sentence for the CLI and panel. */
export type PlanWait =
  | { kind: "dependencies"; on: string[]; text: string }
  | { kind: "acceptance"; on: string[]; taskIds: string[]; text: string }
  | { kind: "file_lease"; holderTaskId: string; holderLabel: string | null; repository: string | null; globs: string[]; text: string }
  | { kind: "agent_cap"; running: number; cap: number; text: string }
  | { kind: "capacity"; reason: string | null; text: string }
  | { kind: "worker"; text: string };

export interface PlanNodeView {
  label: string;
  profile: ProfileName;
  goal: string;
  acceptanceCriteria: string[];
  /** Labels this node depends on (in the plan, or tasks the job dispatched earlier). */
  dependsOn: string[];
  writableRepository: string | null;
  allowedPaths: string[] | null;
  /** The planned difficulty (tier hint); null when the planner gave none. */
  difficulty: PlanDifficulty | null;
  importance: Importance | null;
  requiresAcceptedInputs: boolean;
  /** Estimated cost (tier weight) used for the critical path. */
  weight: number;
  /** Longest chain of plan dependencies before this node (roots are 0). */
  depth: number;
  onCriticalPath: boolean;
  /** The task the node was dispatched as; null when it has no task (yet). */
  taskId: string | null;
  state: TaskState | "not_dispatched";
  stateReason: string | null;
  /** The tier the task was classified at. */
  tier: string | null;
  acceptanceStatus: string | null;
  verificationStatus: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  waiting: PlanWait | null;
  /** Times the scheduler held this node back for another task's file lease. */
  leaseWaits: number;
  /** The upstream results artifact this node was given, and the base commits chosen for it. */
  upstream: { artifactRef: string; baseCommits: BaseChoice[] } | null;
  /** Runs the node's first attempt asked for (`redundancy`: 1, or 2 for twin runs). */
  redundancy: number;
  /** What happened to a redundant node's twin runs; null for a node that runs once or has not started. */
  twins: TwinRunsView | null;
}

/** One of a redundant node's two runs. */
export interface TwinRunView {
  sessionId: string | null;
  /** Endpoints this run was given (the plan's candidates, split so the twins never share one). */
  endpoints: string[];
  /** Endpoints that actually served it. */
  servedEndpoints: string[];
  /** The run's outcome state and verification, once it finished; null while it runs or when cancelled. */
  state: string | null;
  verification: string | null;
  sessionStatus: string | null;
  stopReason: string | null;
  /** Its result passed verification first. */
  winner: boolean;
  /** Its result became the task's result. */
  used: boolean;
}

export interface TwinRunsView {
  /** `racing` while both run; `verified`: one passed verification first; `none_passed` / `both_failed`; `skipped`: ran once (why in reason); `refused`: the contract could not pay for a second run. */
  status: "racing" | "verified" | "none_passed" | "both_failed" | "skipped" | "refused";
  reason: string | null;
  /** The shared request cap of both runs. */
  cap: number | null;
  runs: TwinRunView[];
}

export interface PlanEdge {
  from: string;
  to: string;
  /** The upstream is a task dispatched before this plan version, not a node of it. */
  external: boolean;
  onCriticalPath: boolean;
}

export interface PlanLeaseView extends FileLease {
  taskLabel: string | null;
}

export interface PlanVersionSummary {
  version: number;
  createdAt: number;
  createdBy: string | null;
  note: string | null;
  nodes: number;
}

export interface JobPlanView {
  jobId: string;
  jobState: TaskState;
  goal: string;
  /** The version shown (the latest unless one was asked for); null when the job recorded no plan. */
  plan: PlanVersionSummary | null;
  versions: PlanVersionSummary[];
  nodes: PlanNodeView[];
  edges: PlanEdge[];
  criticalPath: CriticalPath;
  /** Tasks of this job running now (delegated, not supervisors) and the job's cap (`team.max_agents`). */
  running: number;
  maxAgents: number;
  /** Every file lease the job's tasks held or hold, oldest first. */
  leases: PlanLeaseView[];
  /** Tasks the job dispatched that are not nodes of the version shown (plain delegate calls). */
  otherTasks: Array<{ taskId: string; label: string | null; profile: string; state: TaskState }>;
}

const RUNNING: ReadonlySet<string> = new Set(["running", "cancel_requested"]);

function summary(p: JobPlan): PlanVersionSummary {
  return { version: p.version, createdAt: p.createdAt, createdBy: p.createdBy, note: p.note, nodes: p.nodes.length };
}

/** Depth of each node: the longest chain of in-plan dependencies before it. */
function depths(plan: JobPlan): Map<string, number> {
  const byLabel = new Map(plan.nodes.map((n) => [n.label, n]));
  const out = new Map<string, number>();
  const visit = (label: string, guard: Set<string>): number => {
    const known = out.get(label);
    if (known !== undefined) return known;
    if (guard.has(label)) return 0; // plans are validated acyclic; never loop on bad data
    guard.add(label);
    const deps = byLabel.get(label)!.dependsOn.filter((d) => byLabel.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => visit(x, guard))) : 0;
    out.set(label, d);
    return d;
  };
  for (const n of plan.nodes) visit(n.label, new Set());
  return out;
}

const TwinStartedSchema = z.object({ sessions: z.array(z.string().nullable()), endpoints: z.array(z.array(z.string())), cap: z.number() }).passthrough();
const TwinSettledSchema = z
  .object({
    winner: z.string().nullable(),
    used: z.string().nullable(),
    outcome: z.enum(["verified", "none_passed", "both_failed"]),
    runs: z.array(z.object({ sessionId: z.string().nullable(), finished: z.boolean(), state: z.string(), verification: z.string().nullable(), servedEndpoints: z.array(z.string()) }).passthrough()),
  })
  .passthrough();
const TwinSkippedSchema = z.object({ reason: z.string() }).passthrough();

/** A redundant node's twin runs, from its task events (validated: stored rows are runtime input) and sessions. */
function twinsOf(sy: Switchyard, t: StoredTask): TwinRunsView | null {
  const events = sy.tasks.events(t.row.id, 500);
  const last = (type: string) => events.filter((e) => e.type === type).at(-1);
  const started = TwinStartedSchema.safeParse(last(REDUNDANCY_STARTED)?.data);
  if (!started.success) {
    const skipped = TwinSkippedSchema.safeParse(last(REDUNDANCY_SKIPPED)?.data);
    if (skipped.success) return { status: "skipped", reason: skipped.data.reason, cap: null, runs: [] };
    const stop = t.result?.stopReason ?? "";
    if (stop.startsWith("redundancy_budget_insufficient")) return { status: "refused", reason: stop.slice(stop.indexOf(":") + 1).trim(), cap: null, runs: [] };
    return null;
  }
  const settled = TwinSettledSchema.safeParse(last(REDUNDANCY_SETTLED)?.data);
  const s = settled.success ? settled.data : null;
  const runs = started.data.sessions.map((sessionId, i): TwinRunView => {
    const r = s?.runs.find((x) => x.sessionId === sessionId);
    const session = sessionId ? sy.sessions.get(sessionId) : null;
    return {
      sessionId,
      endpoints: started.data.endpoints[i] ?? [],
      servedEndpoints: r?.servedEndpoints ?? [],
      state: r?.finished ? r.state : null,
      verification: r?.verification ?? null,
      sessionStatus: session?.status ?? null,
      stopReason: session?.stopReason ?? null,
      winner: Boolean(s?.winner && s.winner === sessionId),
      used: Boolean(s?.used && s.used === sessionId),
    };
  });
  return { status: s ? s.outcome : "racing", reason: null, cap: started.data.cap, runs };
}

function upstreamOf(sy: Switchyard, taskId: string): PlanNodeView["upstream"] {
  const e = sy.tasks.events(taskId, 500).filter((x) => x.type === UPSTREAM_CONTEXT_EVENT).at(-1);
  const p = e ? UpstreamContextEventSchema.safeParse(e.data) : null;
  return p?.success ? { artifactRef: p.data.artifactRef, baseCommits: p.data.baseCommits } : null;
}

/**
 * A job's plan (the latest version, or `opts.version`) with each node's task state, the critical
 * path, file leases, and waiting reasons. Null when the job does not exist; `plan` is null when
 * the job has not recorded a plan (its tasks are then all in `otherTasks`).
 */
export function jobPlan(sy: Switchyard, jobId: string, opts: { version?: number } = {}): JobPlanView | null {
  const job = sy.tasks.get(jobId);
  if (!job || job.spec.profile !== "supervise") return null;
  const store = new PlanStore(sy.db);
  const versions = store.list(jobId);
  const plan = opts.version !== undefined ? (versions.find((v) => v.version === opts.version) ?? null) : (versions.at(-1) ?? null);
  if (opts.version !== undefined && !plan) return null;

  const children = sy.tasks.childrenOf(jobId);
  const byLabel = new Map<string, StoredTask>();
  for (const c of children) if (c.spec.label) byLabel.set(c.spec.label, c);
  const labelOf = new Map(children.map((c) => [c.row.id, c.spec.label ?? null]));
  const running = children.filter((c) => c.spec.profile !== "supervise" && RUNNING.has(c.row.state)).length;
  const maxAgents = maxAgentsPerJob(contextOfTask(sy, jobId));
  const leaseStore = new FileLeaseStore(sy.db);
  const leases: PlanLeaseView[] = leaseStore.forJob(jobId).map((l) => ({ ...l, taskLabel: labelOf.get(l.taskId) ?? null }));

  const cp = plan ? criticalPath(plan.nodes) : { labels: [], cost: 0 };
  const onPath = new Set(cp.labels);
  const pathEdges = new Set(cp.labels.slice(1).map((to, i) => `${cp.labels[i]}>${to}`));
  const depth = plan ? depths(plan) : new Map<string, number>();
  const planLabels = new Set(plan?.nodes.map((n) => n.label) ?? []);

  const waitingOf = (t: StoredTask, dependsOn: string[]): PlanWait | null => {
    const reason = t.row.state_reason;
    const name = (id: string) => labelOf.get(id) ?? id;
    if (t.row.state === "waiting_for_dependencies") {
      if (reason?.startsWith(`${AWAITING_ACCEPTANCE}:`)) {
        const ids = reason.slice(AWAITING_ACCEPTANCE.length + 1).split(",").filter(Boolean);
        const on = ids.map(name);
        return { kind: "acceptance", on, taskIds: ids, text: `waits until ${on.join(", ")} ${on.length === 1 ? "is" : "are"} accepted (accept or reject the upstream result)` };
      }
      const open = sy.tasks
        .getMany(sy.tasks.dependenciesOf(t.row.id))
        .filter((d) => !isTerminal(d.row.state))
        .map((d) => d.spec.label ?? d.row.id);
      const on = open.length ? open : dependsOn;
      return { kind: "dependencies", on, text: `waits for ${on.join(", ")} to finish` };
    }
    if (t.row.state === "waiting_for_capacity") return { kind: "capacity", reason, text: `waits for model capacity${reason ? ` (${reason})` : ""}` };
    if (t.row.state !== "queued") return null;
    if (reason?.startsWith(`${WAITING_FOR_FILE_LEASE}:`)) {
      const holder = reason.slice(WAITING_FOR_FILE_LEASE.length + 1);
      const held = leases.filter((l) => l.taskId === holder && l.live).at(-1) ?? leases.filter((l) => l.taskId === holder).at(-1);
      const holderLabel = labelOf.get(holder) ?? null;
      // Leases key repositories <project>/<alias>; the view shows the alias the user wrote.
      const repoKeyOf = held?.repository ?? t.row.writable_repo;
      const repository = repoKeyOf === null ? null : splitRepoKey(repoKeyOf).alias;
      return {
        kind: "file_lease",
        holderTaskId: holder,
        holderLabel,
        repository,
        globs: held?.globs ?? [],
        text: `waits for the file lease ${holderLabel ?? holder} holds${held ? ` on ${held.globs.join(", ")} in ${repository}` : ""}`,
      };
    }
    // A project's max_concurrent_tasks: capacity of the project's own (the reason names it).
    if (reason?.startsWith(`${WAITING_FOR_PROJECT_CAP}:`)) return { kind: "capacity", reason, text: `waits for a slot: ${reason.slice(WAITING_FOR_PROJECT_CAP.length + 1).trim()}` };
    if (running >= maxAgents) return { kind: "agent_cap", running, cap: maxAgents, text: `waits for a free agent slot (${running} of ${maxAgents} running)` };
    return { kind: "worker", text: "ready; waits for a worker to claim it" };
  };

  const nodes: PlanNodeView[] = (plan?.nodes ?? []).map((n) => {
    const t = byLabel.get(n.label);
    const row = t?.row as (TaskRow & { tier?: string | null }) | undefined;
    return {
      label: n.label,
      profile: n.profile,
      goal: n.goal,
      acceptanceCriteria: n.acceptanceCriteria,
      dependsOn: n.dependsOn,
      writableRepository: n.writableRepository,
      allowedPaths: n.allowedPaths,
      difficulty: n.difficulty,
      importance: n.importance,
      requiresAcceptedInputs: n.requiresAcceptedInputs,
      weight: n.weight,
      depth: depth.get(n.label) ?? 0,
      onCriticalPath: onPath.has(n.label),
      taskId: t?.row.id ?? null,
      state: t?.row.state ?? "not_dispatched",
      stateReason: row?.state_reason ?? null,
      tier: row?.tier ?? null,
      acceptanceStatus: t?.result?.acceptanceStatus ?? null,
      verificationStatus: t?.result?.verificationStatus ?? null,
      startedAt: row?.started_at ?? null,
      finishedAt: row?.finished_at ?? null,
      waiting: t ? waitingOf(t, n.dependsOn) : null,
      leaseWaits: t ? sy.tasks.events(t.row.id, 500).filter((e) => e.type === "waiting_for_file_lease").length : 0,
      upstream: t ? upstreamOf(sy, t.row.id) : null,
      redundancy: n.redundancy,
      twins: t && n.redundancy > 1 ? twinsOf(sy, t) : null,
    };
  });

  const edges: PlanEdge[] = (plan?.nodes ?? []).flatMap((n) =>
    n.dependsOn.map((from) => ({ from, to: n.label, external: !planLabels.has(from), onCriticalPath: pathEdges.has(`${from}>${n.label}`) })),
  );

  return {
    jobId,
    jobState: job.row.state,
    goal: job.spec.goal,
    plan: plan ? summary(plan) : null,
    versions: versions.map(summary),
    nodes,
    edges,
    criticalPath: cp,
    running,
    maxAgents,
    leases,
    otherTasks: children.filter((c) => !c.spec.label || !planLabels.has(c.spec.label)).map((c) => ({ taskId: c.row.id, label: c.spec.label ?? null, profile: c.spec.profile, state: c.row.state })),
  };
}

export type { CriticalPath, FileLease, JobPlan };
