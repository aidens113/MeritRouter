import type { LeaseRef,LeaseReceipt } from "../storage/task-leases.js";
import type { RoleName } from "../config/schema.js";
import type { ChatTool } from "../gateway/types.js";
import type { ValidateFunction } from "ajv";
import { validateWorkerOutput, type EvidenceUniverse, type ValidatedOutput } from "../core/worker-output.js";
import type { WorkerTask } from "../core/task.js";
import type { RunContext, RunnerResult } from "../runners/types.js";
import { agentLabel } from "../roles/index.js";
import { reportPath } from "../brain/access.js";
import type { Actor } from "../attribution/index.js";
import type { HarnessEnv } from "./tools.js";
import type { TerminalTool } from "./loop.js";
import { criterionTexts } from "../core/task.js";
import { memoryContext, type MemoryContextOptions } from "../context/memory.js";

export const SUBMIT_RESULT_DEF: ChatTool = {
  type: "function",
  function: {
    name: "submit_result",
    description: "Submit your final result. This ends the task.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        findings: {
          type: "array",
          items: { type: "object", properties: { description: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } }, required: ["description", "evidenceRefs"] },
        },
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: { index: { type: "integer" }, status: { type: "string", enum: ["met", "unmet", "unknown"] }, evidenceRefs: { type: "array", items: { type: "string" } }, note: { type: "string" } },
            required: ["index", "status", "evidenceRefs"],
          },
        },
        data: {},
      },
      required: ["summary", "findings", "criteria"],
    },
  },
};

export function submitResultTool(spec: WorkerTask, universe: EvidenceUniverse, dataValidator?: ValidateFunction): TerminalTool<ValidatedOutput> {
  return {
    def: SUBMIT_RESULT_DEF,
    accept: async (args) => {
      const v = validateWorkerOutput(args, { acceptanceCriteria: criterionTexts(spec), universe, ...(dataValidator ? { dataValidator } : {}) });
      return v.ok ? { ok: true, value: v.value } : { ok: false, errors: v.errors };
    },
  };
}

export function workerActor(ctx: RunContext, role: RoleName, model: string | null = null): Actor {
  return { agent: agentLabel(role, ctx.spec.label ?? ctx.taskId), role, model, task: ctx.taskId, job: ctx.jobId, tier: ctx.tier };
}

/** The brain as this worker may see it: its grants, its job's working document, its report path. */
export function workerBrainEnv(ctx: RunContext, role: RoleName): HarnessEnv["brain"] | undefined {
  if (!ctx.brain || !ctx.access) return undefined;
  const brain = ctx.brain;
  const access = ctx.access;
  const g = { project: brain.project, effort: ctx.effort, task: ctx.spec.label ?? ctx.taskId, repos: ctx.spec.repositoryAliases };
  const workingDoc = ctx.lab ? `projects/${brain.project}/labs/${ctx.lab.name}.md` : brain.workingDocPath(ctx.effort);
  const briefGrants = [...(ctx.spec.brain?.grants ?? []), ...(ctx.lab ? [{ pattern: workingDoc, mode: "read" as const }] : [])];
  return {
    brain,
    access,
    principal: () => access.principalFor(role, { ...g, jobId: ctx.jobId, tier: ctx.tier,lease:ctx.taskLease,sessionId:ctx.session?.id, ...(briefGrants.length ? { briefGrants } : {}) }),
    actor: workerActor(ctx, role),
    workingDoc,
  };
}

/** Granted context to put in a worker's first message: its job's Current State, when readable. */
export async function brainContext(env: HarnessEnv, options: MemoryContextOptions = {}): Promise<string> { return memoryContext(env, options); }

export interface ReportContext {
  cfg: RunContext["cfg"];
  brain: RunContext["brain"];
  access: RunContext["access"];
  spec: WorkerTask;
  taskId: string;
  effort: string;
  jobId: string | null;
  tier: RunContext["tier"] | null;
  taskLease?:LeaseRef;taskReceipt?:LeaseReceipt;
}

/** Write the worker's report into its job's working document folder (best effort). */
export async function writeWorkerReport(ctx: ReportContext, role: RoleName, result: RunnerResult, state: string): Promise<string | null> {
  if (!ctx.brain || !ctx.access || !ctx.cfg.brain.worker_reports) return null;
  const label = ctx.spec.label ?? ctx.taskId;
  const g = { project: ctx.brain.project, effort: ctx.effort, task: label, repos: ctx.spec.repositoryAliases };
  let principal;
  try{principal=ctx.access.principalFor(role, { ...g, jobId: ctx.jobId, tier: ctx.tier,lease:ctx.taskLease,reportOnly:true,terminalReceipt:ctx.taskReceipt });}catch{return null;}
  const outcome = state === "completed" ? (result.unresolvedCriteria.length || result.acceptanceStatus === "unmet" ? "Partial" : "Done") : "Blocked";
  const changed = [
    ...result.findings.map((f) => `- ${f.description}${f.evidenceRefs.length ? ` (${f.evidenceRefs.join(", ")})` : ""}`),
    ...result.patchRefs.map((p) => `- Patch: ${p} (base ${Object.entries(result.baseCommits).map(([a, c]) => `${a}@${c.slice(0, 12)}`).join(", ")})`),
  ].join("\n");
  const commands = result.checks.map((c) => `- \`${c.command}\` -> exit ${c.exitCode ?? "killed"} (${c.logRef})`).join("\n");
  const actor: Actor = { agent: agentLabel(role, label), role, model: null, task: ctx.taskId, job: ctx.jobId, tier: ctx.tier };
  try {
    const r = await ctx.brain.writeReport(principal, actor, reportPath(g), {
      label,
      outcome,
      outcomeContext: `${result.stopReason}. ${result.summary.split("\n")[0]!.slice(0, 300)}`,
      changed,
      commands,
      notVerified: result.unresolvedCriteria.map((c) => `- ${c}`).join("\n") || (result.acceptanceStatus === "met" ? "" : "- Acceptance not independently verified."),
      questions: "",
    });
    return `brain:${r.path}`;
  } catch {
    return null;
  }
}
