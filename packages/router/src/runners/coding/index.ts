import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../../config/load.js";
import type { CodingRunner } from "../../core/executor.js";
import { hasRepoAgentConfig } from "../../workspaces/worktree.js";
import { commitAs } from "../../attribution/index.js";
import { workerActor } from "../../harness/worker.js";
import { baseResult, type RunContext, type RunOutcome } from "../types.js";
import { startPolicyGateway } from "./policy-gateway.js";
import { minimalEnv, runProcess, type RunResult } from "./process.js";
import { agentHome, finishCoding, prepareWorkspace, sourceDirtyFinding } from "./finish.js";
import { NativeCodingRunner } from "./native.js";
import { WorkspacePointer } from "../session-workspace.js";
import { criterionTexts } from "../../core/task.js";

function brief(ctx: RunContext, readOnlyAliases: string[]): string {
  const s = ctx.spec;
  return `# Task

${s.goal}

## Acceptance criteria
${criterionTexts(s).map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Rules
- Edit only files matching: ${(s.constraints.allowedPaths ?? []).join(", ")}. Changes elsewhere are rejected.
- Do not modify tests, fixtures, or evaluation scripts unless a criterion requires it; if you do, say so explicitly in your final message.
- Do not commit; leave your changes in the working tree.
${s.constraints.checks?.length ? `- These checks will be run after you finish (you may not be able to run them yourself):\n${s.constraints.checks.map((c) => `  - \`${c}\``).join("\n")}` : ""}
${readOnlyAliases.length ? `- Other repositories (${readOnlyAliases.join(", ")}) are context only and are not available in this workspace.` : ""}
- Finish with a short summary of what you changed and anything unresolved.
`;
}

/** OpenCode config pinned to the job's policy gateway; passed inline so it outranks project files. */
export function openCodeConfig(gatewayUrl: string, model: string, ctx: RunContext, allowedCommands: string[]) {
  const limits = ctx.plan.candidates[0];
  const bash: Record<string, string> = { "*": "deny" };
  for (const c of allowedCommands) bash[c] = "allow";
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    enabled_providers: ["switchyard"],
    provider: {
      switchyard: {
        npm: "@ai-sdk/openai-compatible",
        name: "SwitchYard job gateway",
        options: { baseURL: gatewayUrl, apiKey: "{env:SWITCHYARD_JOB_TOKEN}" },
        models: {
          [model]: {
            name: "SwitchYard worker",
            limit: { context: limits?.contextLimitTokens ?? 32000, output: Math.min(limits?.outputLimitTokens ?? 4096, ctx.profile.max_output_tokens) },
          },
        },
      },
    },
    model: `switchyard/${model}`,
    small_model: `switchyard/${model}`,
    permission: { edit: "allow", bash, webfetch: "deny" },
    mcp: {},
  };
}

/**
 * External coding agent (OpenCode, or any command) whose only model access is the job's policy
 * gateway. The worktree is committed before each new model request, attributed to the model that
 * served the previous one, so per-line attribution works for external agents too.
 */
export class ExternalCodingRunner implements CodingRunner {
  async run(ctx: RunContext): Promise<RunOutcome> {
    const spec = ctx.spec;
    const alias = spec.writableRepository!;
    const { ws, worktrees } = await prepareWorkspace(ctx);
    const pointer = new WorkspacePointer(ctx.session, [{ alias, worktree: ws.worktreePath, branch: null, baseCommit: ws.baseSha, head: ws.baseSha }]);
    const findings = sourceDirtyFinding(ws);
    const agentConfig = hasRepoAgentConfig(ws.worktreePath);
    if (agentConfig.length && !ctx.cfg.coding.allow_repo_agent_config) {
      worktrees.setStatus(ctx.taskId, "blocked");
      return {
        state: "failed",
        result: baseResult({
          executionStatus: "failed",
          stopReason: "repo_agent_config_present",
          summary: `The repository contains agent configuration (${agentConfig.join(", ")}) that could add model providers; set coding.allow_repo_agent_config to run anyway.`,
          baseCommits: { [alias]: ws.baseSha },
          unresolvedCriteria: criterionTexts(spec),
          findings,
        }),
      };
    }

    const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    // The agent's own tool calls run inside its process: the session sees them only in the
    // transcript it sends with each request, not in the tool journal.
    ctx.session?.note("external coding agent: tool calls are not journaled; they appear in the transcript", { runner: ctx.cfg.coding.runner, executionId });
    const snapshot = async (served: { endpointId: string; requestId: string } | null, note: string) => {
      const actor = served ? { ...workerActor(ctx, "implementer", served.endpointId), request: served.requestId } : { ...workerActor(ctx, "implementer"), role: "tool" };
      pointer.setHead(alias, await commitAs(ws.worktreePath, actor, `implementer: ${note}`).catch(() => null));
    };
    const stopper = new AbortController();
    let stopReason: string | null = null;
    const gateway = await startPolicyGateway(ctx, executionId, {
      maxDenied: ctx.cfg.coding.max_denied_requests,
      onStop: (reason) => {
        stopReason ??= reason;
        stopper.abort(reason);
      },
      beforeRequest: (last) => (last ? snapshot(last, "edits from previous response") : Promise.resolve()),
    });
    const onCtxAbort = () => stopper.abort(String(ctx.signal.reason ?? "aborted"));
    ctx.signal.addEventListener("abort", onCtxAbort);

    const home = agentHome(ctx, ws);
    const promptFile = path.join(home, "TASK.md");
    writeFileSync(promptFile, brief(ctx, spec.repositoryAliases.filter((a) => a !== alias)));
    const deadline = ctx.tasks.get(ctx.taskId)!.row.deadline_at ?? ctx.now() + ctx.cfg.execution.job_timeout_seconds * 1000;
    const timeoutMs = Math.max(10_000, deadline - ctx.now() - ctx.cfg.execution.check_timeout_seconds * 1000 * Math.min(1, spec.constraints.checks?.length ?? 0));
    const env = minimalEnv({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      SWITCHYARD_JOB_TOKEN: gateway.token,
      SWITCHYARD_BASE_URL: gateway.baseUrl,
      SWITCHYARD_MODEL: gateway.model,
      SWITCHYARD_PROMPT_FILE: promptFile,
      SWITCHYARD_WORKTREE: ws.worktreePath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(gateway.baseUrl, gateway.model, ctx, ctx.cfg.coding.allowed_commands)),
    });

    let agent: RunResult;
    try {
      agent =
        ctx.cfg.coding.runner === "opencode"
          ? await runProcess(ctx.cfg.coding.command, ["run", "--model", `switchyard/${gateway.model}`, "--format", "json", "--dir", ws.worktreePath, "--file", promptFile, "Complete the task described in the attached TASK.md."], {
              cwd: ws.worktreePath,
              env,
              timeoutMs,
              signal: stopper.signal,
              shell: process.platform === "win32",
            })
          : await runProcess(ctx.cfg.coding.command, [], { cwd: ws.worktreePath, env, timeoutMs, signal: stopper.signal, shell: true });
    } finally {
      ctx.signal.removeEventListener("abort", onCtxAbort);
      await gateway.close();
    }
    // Whatever the agent changed after its last request belongs to the last response.
    await snapshot(gateway.stats.lastServed, "final edits");
    const eventsRef = ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "agent_output", label: "agent stdout", content: agent.stdout, extension: ".log" });
    const stderrRef = agent.stderr ? ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "agent_output", label: "agent stderr", content: agent.stderr, extension: ".log" }) : null;
    ctx.gate.admission.finishExecution(executionId, "completed", { agentExit: agent.exitCode, killed: agent.killed, gateway: gateway.stats });
    const budgetStop = stopReason === "task_request_budget_exhausted" || stopReason === "task_token_budget_exhausted";
    const tail = agent.stdout.trim().split("\n").slice(-20).join("\n").slice(-2000);
    return finishCoding(ctx, {
      ws,
      worktrees,
      executionId,
      findings,
      artifactRefs: [eventsRef, ...(stderrRef ? [stderrRef] : [])],
      stopReason: stopReason ? `agent_stopped: ${stopReason}` : agent.killed ? `agent_killed: ${agent.killed}` : `agent_exit_${agent.exitCode}`,
      state: budgetStop ? "budget_exhausted" : "completed",
      summaryLead: tail ? `Agent output tail:\n${tail}` : "",
    });
  }
}

/** The native harness by default; OpenCode or a custom command when configured. */
export function createCodingRunner(cfg: ResolvedConfig): CodingRunner {
  return cfg.coding.runner === "native" ? new NativeCodingRunner() : new ExternalCodingRunner();
}

/** @deprecated use createCodingRunner */
export const CodingRunnerImpl = ExternalCodingRunner;
