import type { ResolvedConfig } from "../config/load.js";
import type { ProfileConfig } from "../config/schema.js";
import type { Gate, GateAttempt, GateRequest, GateResponse } from "../gateway/gate.js";
import type { RoutePlan } from "../routing/select.js";
import type { TierName } from "../config/schema.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import type { TaskStore } from "../storage/tasks.js";
import type { EffectiveBudget } from "../admission/admission.js";
import type { AcceptanceStatus, SupervisorDecision, TaskState, WorkerResult, WorkerTask } from "../core/task.js";
import type { EvidenceUniverse, WorkerOutput } from "../core/worker-output.js";
import type { Brain } from "../brain/brain.js";
import type { BrainAccess } from "../brain/access.js";
import type { SessionRecorder } from "../sessions/recorder.js";
import type { AcceptanceContract } from "../verification/contract.js";

/** Who decides a result and why (see `Switchyard.acceptTask`). */
export interface AcceptanceDecisionInput {
  by: SupervisorDecision["by"];
  reason?: string | null;
}

export interface AcceptanceDecisionOutcome {
  taskId: string;
  acceptanceStatus: AcceptanceStatus;
  decision: SupervisorDecision;
}
import type { ResumePlan } from "../sessions/resume.js";
import { faultPoint } from "../core/faults.js";

/** What a supervisor needs from the service (kept as an interface to avoid import cycles). */
export interface SupervisorServices {
  submitTasks(raw: unknown[], opts?: { purpose?: string; parentSessionId?: string }): Promise<Array<{ taskId: string; state: string; deduplicated: boolean }>>;
  awaitResults(ids: string[], opts?: { timeoutSeconds?: number; signal?: AbortSignal; uncapped?: boolean }): Promise<{ completed: WorkerResult[]; pending: Array<{ taskId: string; state: string }>; timedOut: boolean }>;
  getTask(id: string): { spec: WorkerTask; state: string; result: WorkerResult | null } | null;
  cancelTasks(ids: string[]): unknown;
  /** Record the supervisor's (or a human's) acceptance; throws with the refusal reason. */
  acceptTask(id: string, input: AcceptanceDecisionInput): AcceptanceDecisionOutcome;
  rejectTask(id: string, input: AcceptanceDecisionInput): AcceptanceDecisionOutcome;
}

/**
 * What an escalation retry is told about the attempt that failed: data from the previous run,
 * never instructions. Findings and check logs are capped.
 */
export interface RetryContext {
  fromTier: TierName;
  /** invalid_output, budget_exhausted, or acceptance_unmet. */
  reason: string;
  stopReason: string;
  findings: string[];
  unresolvedCriteria: string[];
  failingChecks: Array<{ command: string; exitCode: number | null; logRef: string; logTail: string }>;
  /** Why verification did not accept the result. */
  verificationReasons: string[];
  /** Coding repairs: start the new worktree at the previously submitted revision, not the base. */
  startFrom?: { alias: string; commit: string } | null;
}

export interface RunContext {
  cfg: ResolvedConfig;
  profile: ProfileConfig;
  spec: WorkerTask;
  taskId: string;
  leaseOwner: string;
  budget: EffectiveBudget;
  gate: Gate;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  signal: AbortSignal;
  now: () => number;
  tier: TierName;
  plan: RoutePlan;
  /** Shared knowledge and the effort (working document slug) this task belongs to. */
  brain: Brain | null;
  access: BrainAccess | null;
  effort: string;
  jobId: string | null;
  services: SupervisorServices | null;
  /** Every endpoint attempt made for this task (fallbacks included). */
  attempts: GateAttempt[];
  /** The agent session recording this run; `ask()` logs the transcript, requests, responses, and errors to it. */
  session: SessionRecorder | null;
  /** The task's acceptance contract (absent for supervisor jobs and runs outside the executor). */
  contract?: AcceptanceContract | null;
  /** Set on the escalation retry: what went wrong in the previous attempt. */
  retry?: RetryContext | null;
  /** Labels every request of this run (repair, verification) instead of the runner's own label. */
  purpose?: "repair" | "verification";
  /**
   * Set when this run continues an interrupted session (`session` is that session, reopened):
   * the plan to apply before the next model request. Null for a fresh run.
   */
  resume: { plan: ResumePlan } | null;
}

/**
 * Send one model request for this task through the gate, recording endpoint attempts. With a
 * session, the transcript, the request, and the response (or error) are logged; a recording
 * failure throws.
 */
export async function ask(ctx: RunContext, req: Omit<GateRequest, "plan" | "participants" | "signal"> & { participants?: GateRequest["participants"] }): Promise<GateResponse> {
  const session = ctx.session;
  if (session) {
    session.syncMessages(req.chat.messages);
    session.modelRequest(req);
  }
  faultPoint("after_model_request", ctx.purpose ?? req.purpose);
  let res: GateResponse;
  try {
    res = await ctx.gate.request({
      ...req,
      ...(ctx.purpose ? { purpose: ctx.purpose } : {}),
      plan: ctx.plan,
      participants: req.participants ?? [{ taskId: ctx.taskId, leaseOwner: ctx.leaseOwner, budget: ctx.budget }],
      signal: ctx.signal,
    });
  } catch (err) {
    const attempts = (err as { attempts?: GateAttempt[] }).attempts;
    if (attempts) ctx.attempts.push(...attempts);
    session?.modelError({ executionId: req.executionId, error: err, ...(attempts ? { attempts } : {}) });
    throw err;
  }
  ctx.attempts.push(...res.attempts);
  session?.modelResponse(res);
  faultPoint("after_model_response", ctx.purpose ?? req.purpose);
  return res;
}

/** Runner output before ledger-derived usage is attached by the executor. */
export type RunnerResult = Omit<WorkerResult, "usage" | "servedEndpoints" | "taskId">;

/**
 * Material verification needs that is not part of the stored result: the revision and digest
 * the result was submitted at, the evidence universe the worker had, and its per-criterion
 * self-assessment (criteria by index, as the worker returned them).
 */
export interface RunEvidence {
  revision?: string | null;
  artifactDigest?: string | null;
  universe?: EvidenceUniverse | null;
  output?: Pick<WorkerOutput, "criteria"> | null;
}

export interface RunOutcome {
  state: Extract<TaskState, "completed" | "failed" | "budget_exhausted" | "cancelled" | "interrupted">;
  result: RunnerResult;
  evidence?: RunEvidence;
}

export function baseResult(partial: Partial<RunnerResult> = {}): RunnerResult {
  return {
    executionStatus: "completed",
    acceptanceStatus: "not_verified",
    stopReason: "",
    summary: "",
    findings: [],
    artifactRefs: [],
    patchRefs: [],
    baseCommits: {},
    checks: [],
    unresolvedCriteria: [],
    classification: null,
    routing: null,
    ...partial,
  };
}
