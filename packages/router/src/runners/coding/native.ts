import type { ChatMessage } from "../../gateway/types.js";
import { estimateTokens } from "../../gateway/types.js";
import type { CodingRunner } from "../../core/executor.js";
import { compileOutputSchema } from "../../core/validate.js";
import { evidenceUniverse, OUTPUT_CONTRACT } from "../../core/worker-output.js";
import { loadSources, readersFor, renderSources } from "../../context/sources.js";
import { RepoReader } from "../../context/repo-reader.js";
import { planLimits } from "../../routing/select.js";
import { charterFor } from "../../roles/index.js";
import { commitAs } from "../../attribution/index.js";
import { runAgentLoop } from "../../harness/loop.js";
import { webTools } from "../../harness/web-tools.js";
import { artifactTool, brainReadTools, commandTool, editTools, repoTools, type HarnessEnv, type HarnessTool } from "../../harness/tools.js";
import { brainContext, submitResultTool, workerActor, workerBrainEnv } from "../../harness/worker.js";
import type { RunContext, RunOutcome } from "../types.js";
import { taskBrief } from "../prompts.js";
import { finishCoding, prepareWorkspace, resumeWorkspace, sourceDirtyFinding } from "./finish.js";
import { WorkspacePointer } from "../session-workspace.js";

/**
 * SwitchYard's own coding worker. Edits go through tools that refuse paths outside
 * allowedPaths (containment in code), every model response that edits files is committed under
 * the agent's identity and serving model, and acceptance comes from the diff and checks.
 */
export class NativeCodingRunner implements CodingRunner {
  async run(ctx: RunContext): Promise<RunOutcome> {
    const spec = ctx.spec;
    const role = "implementer" as const;
    const alias = spec.writableRepository!;
    // A resumed session continues in the worktree it recorded; otherwise a fresh one.
    const reused = ctx.resume ? await resumeWorkspace(ctx, ctx.resume.plan.workspace) : null;
    const { ws, worktrees } = reused ?? (await prepareWorkspace(ctx));
    const pointer = new WorkspacePointer(ctx.session, [{ alias, worktree: ws.worktreePath, branch: null, baseCommit: ws.baseSha, head: reused?.head ?? ws.baseSha }]);
    const readers = readersFor(ctx.cfg, spec);
    readers.set(alias, new RepoReader(alias, ws.worktreePath, null)); // read your own edits
    const sources = await loadSources(ctx.cfg, spec, ctx.artifacts, readersFor(ctx.cfg, spec));
    const universe = evidenceUniverse(sources);
    const validator = spec.constraints.outputSchema ? compileOutputSchema(spec.constraints.outputSchema) : undefined;
    const brain = workerBrainEnv(ctx, role);
    const patterns = ctx.cfg.coding.allowed_commands;
    const env: HarnessEnv = {
      ctx,
      role,
      readers,
      universe,
      allowArtifacts: true,
      workspace: { alias, root: ws.worktreePath, allowedPaths: spec.constraints.allowedPaths ?? [] },
      ...(patterns.length ? { commands: { patterns, cwd: ws.worktreePath, timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000 } } : {}),
      edits: new Set(),
      ...(brain ? { brain } : {}),
    };
    const tools: HarnessTool[] = [...repoTools(spec.repositoryAliases), ...editTools(), ...(patterns.length ? [commandTool(patterns)] : []), artifactTool(), ...(brain ? brainReadTools() : []), ...webTools()];
    const limits = planLimits(ctx.plan, ctx.cfg.routing.max_endpoint_fallbacks);
    // Never ask for more output than the candidate models can produce (coding defaults high).
    const maxTokens = Math.min(ctx.profile.max_output_tokens, spec.budget?.maxOutputTokens ?? Infinity, limits.outputLimitTokens || Infinity);
    const inputBudget = Math.max(2000, limits.contextLimitTokens - maxTokens - estimateTokens([], tools.map((t) => t.def)) - 500);
    const checks = spec.constraints.checks?.length ? `\nChecks that will be run after you finish:\n${spec.constraints.checks.map((c) => `- ${c}`).join("\n")}` : "";
    const fresh: ChatMessage[] = [
      {
        role: "system",
        content: `${charterFor(ctx.cfg, role)}\n\n## Tools\nYour workspace is repository "${alias}" (an isolated worktree). Edit only paths matching: ${(spec.constraints.allowedPaths ?? []).join(", ")}. Read with read_file/search; edit with write_file/replace_in_file/delete_file${patterns.length ? "; run allowed commands with run_command" : ""}. When done, call submit_result once.\n\n## Result\n${OUTPUT_CONTRACT}`,
      },
      { role: "user", content: `${taskBrief(spec, ctx.retry)}${checks}\nProvided context:\n${renderSources(sources) || "(none)"}\n${brainContext(env)}` },
    ];
    const lost = ctx.resume && !reused ? "\nYour previous worktree no longer exists: this is a fresh worktree, and your earlier edits are not in it. Re-apply them." : "";
    const messages = ctx.resume ? ctx.resume.plan.messages : fresh;
    const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    const loop = await runAgentLoop({
      env,
      executionId,
      messages,
      tools,
      ...(ctx.resume ? { resume: { plan: ctx.resume.plan, actor: workerActor(ctx, role), pointer, ...(lost ? { notice: lost } : {}) } } : {}),
      terminal: submitResultTool(spec, universe, validator),
      maxTokens,
      inputBudget,
      maxInvalidTerminal: ctx.cfg.execution.max_invalid_output_retries,
      purpose: "coding",
      onResponse: async (info) => {
        const actor = { ...workerActor(ctx, role, info.endpointId), request: info.requestId };
        pointer.setHead(alias, await commitAs(ws.worktreePath, actor, `${role}: edit ${info.edits.slice(0, 5).join(", ")}${info.edits.length > 5 ? ` (+${info.edits.length - 5})` : ""}`));
      },
    });
    ctx.gate.admission.finishExecution(executionId, loop.kind);
    const transcriptRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "transcript", label: "coding transcript", value: loop.messages });
    const findings = [...sourceDirtyFinding(ws), ...(loop.kind === "terminal" ? loop.value.output.findings : [])];
    return finishCoding(ctx, {
      ws,
      worktrees,
      executionId,
      findings,
      artifactRefs: [transcriptRef],
      stopReason: loop.kind === "terminal" ? "worker_submitted" : loop.kind === "budget_exhausted" ? `model request budget (${ctx.budget.maxModelRequests}) exhausted` : "invalid_output",
      state: loop.kind === "budget_exhausted" ? "budget_exhausted" : "completed",
      summaryLead: loop.kind === "terminal" ? loop.value.output.summary : "",
      universe: env.universe,
      output: loop.kind === "terminal" ? loop.value.output : null,
    });
  }
}
