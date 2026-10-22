import type { ChatMessage } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import { compileOutputSchema } from "../core/validate.js";
import { evidenceUniverse, OUTPUT_CONTRACT } from "../core/worker-output.js";
import { loadSources, readersFor, renderSources } from "../context/sources.js";
import { planLimits } from "../routing/select.js";
import { charterFor, roleForProfile } from "../roles/index.js";
import { runAgentLoop } from "../harness/loop.js";
import { artifactTool, brainReadTools, repoTools, type HarnessEnv, type HarnessTool } from "../harness/tools.js";
import { webTools } from "../harness/web-tools.js";
import { requestBudgetTool } from "../harness/budget-tools.js";
import { brainContext, submitResultTool, workerActor, workerBrainEnv } from "../harness/worker.js";
import { baseResult, type RunContext, type RunOutcome } from "./types.js";
import { taskBrief } from "./prompts.js";
import { baseCommitsFor, contextManifest } from "./completion.js";
import { criterionTexts } from "../core/task.js";

/** Read-only repository investigation (inspect, analyze, review) on the shared agent harness. */
export async function runReadOnly(ctx: RunContext): Promise<RunOutcome> {
  const { spec, profile } = ctx;
  const role = roleForProfile(spec.profile);
  const readers = readersFor(ctx.cfg, spec);
  const sources = await loadSources(ctx.cfg, spec, ctx.artifacts, readers);
  const manifestRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, kind: "context_manifest", label: "context sources", value: contextManifest(sources) });
  const universe = evidenceUniverse(sources);
  const validator = spec.constraints.outputSchema ? compileOutputSchema(spec.constraints.outputSchema) : undefined;
  const allowArtifacts = profile.tools === "repository_read_and_artifacts";
  const brain = workerBrainEnv(ctx, role);
  const env: HarnessEnv = { ctx, role, readers, universe, allowArtifacts, edits: new Set(), ...(brain ? { brain } : {}) };
  const tools: HarnessTool[] = [...repoTools(spec.repositoryAliases), ...(allowArtifacts ? [artifactTool()] : []), ...(brain ? brainReadTools() : []), ...webTools(), requestBudgetTool()];
  const maxTokens = Math.min(profile.max_output_tokens, spec.budget?.maxOutputTokens ?? Infinity);
  const limits = planLimits(ctx.plan, ctx.cfg.routing.max_endpoint_fallbacks);
  const inputBudget = Math.max(2000, limits.contextLimitTokens - maxTokens - estimateTokens([], tools.map((t) => t.def)) - 500);

  const fresh: ChatMessage[] = [
    {
      role: "system",
      content: `${charterFor(ctx.cfg, role)}\n\n## Tools\nInvestigate the repositories (${spec.repositoryAliases.join(", ")}) with the read-only tools, then call submit_result exactly once. You cannot modify anything.\n\n## Result\n${OUTPUT_CONTRACT}`,
    },
    { role: "user", content: `${taskBrief(spec, ctx.retry)}\nProvided context:\n${renderSources(sources) || "(none)"}\n${brainContext(env)}` },
  ];
  // A resumed session continues its own transcript (the fresh one above still registered the evidence).
  const messages = ctx.resume ? ctx.resume.plan.messages : fresh;
  const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
  const loop = await runAgentLoop({
    env,
    executionId,
    messages,
    tools,
    ...(ctx.resume ? { resume: { plan: ctx.resume.plan, actor: workerActor(ctx, role), pointer: null } } : {}),
    terminal: submitResultTool(spec, universe, validator),
    maxTokens,
    inputBudget,
    maxInvalidTerminal: ctx.cfg.execution.max_invalid_output_retries,
    purpose: "tool_loop",
  });
  ctx.gate.admission.finishExecution(executionId, loop.kind);
  const transcriptRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "transcript", label: "tool loop transcript", value: loop.messages });
  const common = { artifactRefs: [manifestRef, transcriptRef], baseCommits: await baseCommitsFor(ctx) };

  if (loop.kind === "terminal") {
    const v = loop.value;
    return {
      state: "completed",
      result: baseResult({
        ...common,
        executionStatus: "completed",
        acceptanceStatus: v.acceptanceStatus,
        stopReason: "worker_submitted",
        summary: v.output.summary,
        findings: v.output.findings,
        ...(v.output.data !== undefined ? { data: v.output.data } : {}),
        unresolvedCriteria: v.unresolvedCriteria,
      }),
      evidence: { universe: env.universe, output: v.output },
    };
  }
  if (loop.kind === "budget_exhausted") {
    return {
      state: "budget_exhausted",
      result: baseResult({ ...common, executionStatus: "budget_exhausted", stopReason: `model request budget (${ctx.budget.maxModelRequests}) exhausted before submit_result`, unresolvedCriteria: criterionTexts(spec) }),
    };
  }
  return {
    state: "failed",
    result: baseResult({ ...common, executionStatus: "failed", stopReason: "invalid_output", summary: `worker output failed validation: ${loop.errors.join("; ")}`, unresolvedCriteria: criterionTexts(spec) }),
  };
}
