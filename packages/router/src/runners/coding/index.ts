import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedConfig } from "../../config/load.js";
import type { CodingRunner } from "../../core/executor.js";
import { Worktrees, hasRepoAgentConfig } from "../../workspaces/worktree.js";
import { baseResult, type RunContext, type RunOutcome } from "../types.js";
import { startPolicyGateway } from "./policy-gateway.js";
import { minimalEnv, runProcess, type RunResult } from "./process.js";

function brief(ctx: RunContext, readOnlyAliases: string[]): string {
  const s = ctx.spec;
  return `# Task

${s.goal}

## Acceptance criteria
${s.constraints.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

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
 * Bounded coding worker: isolated worktree from a recorded base commit, an agent whose only
 * model access is the job's policy gateway, then patch capture, scope validation, and the
 * supervisor's checks. Acceptance comes from that evidence, never from the agent's exit status.
 */
export class CodingRunnerImpl implements CodingRunner {
  constructor(private readonly cfg: ResolvedConfig) {}

  async run(ctx: RunContext): Promise<RunOutcome> {
    const spec = ctx.spec;
    const alias = spec.writableRepository!;
    const repo = ctx.cfg.repositoryPaths[alias]!;
    const worktrees = new Worktrees(ctx.tasks.db, path.join(ctx.cfg.storageDir, "worktrees"), ctx.now);
    const runNo = ctx.tasks.get(ctx.taskId)!.row.run_count;
    const ws = await worktrees.prepare({ taskId: ctx.taskId, run: runNo, alias, sourcePath: repo.path, ...(spec.context.baseCommits?.[alias] ? { baseCommit: spec.context.baseCommits[alias] } : {}) });
    ctx.tasks.event(ctx.taskId, "worktree_ready", { path: ws.worktreePath, baseSha: ws.baseSha, sourceDirty: ws.sourceDirty });
    const findings: RunOutcome["result"]["findings"] = [];
    if (ws.sourceDirty) {
      findings.push({ description: `The source checkout had ${ws.dirtyPaths.length} uncommitted change(s) that are NOT in this worktree (based on ${ws.baseSha.slice(0, 12)}).`, evidenceRefs: [] });
    }

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
          unresolvedCriteria: spec.constraints.acceptanceCriteria,
          findings,
        }),
      };
    }

    const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    const stopper = new AbortController();
    let stopReason: string | null = null;
    const gateway = await startPolicyGateway(ctx, executionId, {
      maxDenied: ctx.cfg.coding.max_denied_requests,
      onStop: (reason) => {
        stopReason ??= reason;
        stopper.abort(reason);
      },
    });
    const onCtxAbort = () => stopper.abort(String(ctx.signal.reason ?? "aborted"));
    ctx.signal.addEventListener("abort", onCtxAbort);

    const home = path.join(ctx.cfg.storageDir, "agent-home", path.basename(ws.worktreePath));
    mkdirSync(home, { recursive: true });
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
    const eventsRef = ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "agent_output", label: "agent stdout", content: agent.stdout, extension: ".log" });
    const stderrRef = agent.stderr ? ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "agent_output", label: "agent stderr", content: agent.stderr, extension: ".log" }) : null;

    // Evidence: the diff against the recorded base, scope checks, and the supervisor's checks.
    const changes = await worktrees.collect(ws, spec.constraints.allowedPaths ?? [], ctx.cfg.coding.protected_paths);
    const patchRef = changes.patch
      ? ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "patch", label: `patch against ${ws.baseSha.slice(0, 12)}`, content: changes.patch, mediaType: "text/x-diff", extension: ".patch" })
      : null;
    if (changes.outOfScope.length) findings.push({ description: `Out-of-scope changes (not allowed by allowedPaths): ${changes.outOfScope.join(", ")}`, evidenceRefs: patchRef ? [patchRef] : [] });
    if (changes.protectedChanged.length) findings.push({ description: `Tests or evaluator files were modified: ${changes.protectedChanged.join(", ")}. Verify the behaviour independently.`, evidenceRefs: patchRef ? [patchRef] : [] });
    findings.push({ description: `Changed ${changes.changed.length} file(s): ${changes.changed.map((c) => `${c.status} ${c.path}`).join(", ") || "none"}`, evidenceRefs: patchRef ? [patchRef] : [] });

    const aborted = ctx.signal.aborted;
    const checks: RunOutcome["result"]["checks"] = [];
    if (!aborted && changes.changed.length) {
      for (const command of spec.constraints.checks ?? []) {
        const r = await runProcess(command, [], {
          cwd: ws.worktreePath,
          env: minimalEnv({ HOME: home, USERPROFILE: home, CI: "1" }),
          timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000,
          signal: ctx.signal,
          shell: true,
        });
        const logRef = ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "check_log", label: command, content: `$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""}\n\n${r.stdout}\n${r.stderr}`, extension: ".log" });
        checks.push({ command, exitCode: r.killed ? null : r.exitCode, logRef });
      }
    }
    worktrees.setStatus(ctx.taskId, "collected");
    ctx.gate.admission.finishExecution(executionId, "completed", { agentExit: agent.exitCode, killed: agent.killed, gateway: gateway.stats });

    const checksPassed = checks.length > 0 && checks.every((c) => c.exitCode === 0);
    const anyCheckFailed = checks.some((c) => c.exitCode !== 0);
    const acceptance =
      changes.outOfScope.length || anyCheckFailed || changes.changed.length === 0
        ? "unmet"
        : checksPassed && !changes.protectedChanged.length && (spec.constraints.checks?.length ?? 0) === checks.length
          ? "met"
          : "not_verified";
    const budgetStop = stopReason === "task_request_budget_exhausted" || stopReason === "task_token_budget_exhausted";
    const state: RunOutcome["state"] = aborted ? (ctx.signal.reason === "cancel" ? "cancelled" : "interrupted") : budgetStop ? "budget_exhausted" : "completed";
    const summaryTail = agent.stdout.trim().split("\n").slice(-20).join("\n").slice(-2000);
    return {
      state,
      result: baseResult({
        executionStatus: state === "completed" ? "completed" : state,
        acceptanceStatus: acceptance === "met" && state !== "completed" ? "not_verified" : acceptance,
        stopReason: stopReason ? `agent_stopped: ${stopReason}` : agent.killed ? `agent_killed: ${agent.killed}` : `agent_exit_${agent.exitCode}`,
        summary: `${changes.changed.length} file(s) changed in an isolated worktree based on ${ws.baseSha.slice(0, 12)}. Checks: ${checks.length ? checks.map((c) => `${c.command} -> ${c.exitCode}`).join("; ") : "none run"}. Agent output tail:\n${summaryTail}`,
        findings,
        artifactRefs: [eventsRef, ...(stderrRef ? [stderrRef] : [])],
        patchRefs: patchRef ? [patchRef] : [],
        baseCommits: { [alias]: ws.baseSha },
        checks,
        unresolvedCriteria: acceptance === "met" ? [] : spec.constraints.acceptanceCriteria,
      }),
    };
  }
}

export function createCodingRunner(cfg: ResolvedConfig): CodingRunner {
  return new CodingRunnerImpl(cfg);
}
