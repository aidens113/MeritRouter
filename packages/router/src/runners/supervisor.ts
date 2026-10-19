import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatTool } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import type { CodingRunner } from "../core/executor.js";
import { evidenceUniverse } from "../core/worker-output.js";
import { readersFor } from "../context/sources.js";
import { RepoReader } from "../context/repo-reader.js";
import { planLimits } from "../routing/select.js";
import { charterFor } from "../roles/index.js";
import { commitAs, type Actor } from "../attribution/index.js";
import { git, headSha } from "../workspaces/git.js";
import { runAgentLoop, type TerminalTool } from "../harness/loop.js";
import { artifactTool, brainReadTools, brainSupervisorTools, commandTool, editTools, repoTools, type HarnessEnv, type HarnessTool } from "../harness/tools.js";
import { supervisorTools, type IntegrationRepo, type SupervisorState } from "../harness/supervisor-tools.js";
import { minimalEnv, runProcess } from "./coding/process.js";
import { baseResult, type RunContext, type RunOutcome } from "./types.js";

interface Finish {
  status: "completed" | "blocked";
  summary: string;
  verified: Array<{ claim: string; evidence: string }>;
  notVerified: string[];
  followUp: string;
}

const FINISH_DEF: ChatTool = {
  type: "function",
  function: {
    name: "finish_job",
    description: "End the job. List what you verified (with the command or evidence) and what you did not.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
        summary: { type: "string" },
        verified: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, evidence: { type: "string" } }, required: ["claim", "evidence"] } },
        not_verified: { type: "array", items: { type: "string" } },
        follow_up: { type: "string" },
      },
      required: ["status", "summary", "verified", "not_verified"],
    },
  },
};

function loadState(ctx: RunContext): { messages: ChatMessage[]; repos: IntegrationRepo[]; children: Record<string, string>; briefChecks: string[] } | null {
  const row = ctx.tasks.db.prepare("SELECT messages_json, detail_json FROM job_state WHERE task_id = ?").get(ctx.taskId) as { messages_json: string; detail_json: string | null } | undefined;
  if (!row) return null;
  const d = row.detail_json ? (JSON.parse(row.detail_json) as { repos?: IntegrationRepo[]; children?: Record<string, string>; briefChecks?: string[] }) : {};
  return { messages: JSON.parse(row.messages_json) as ChatMessage[], repos: d.repos ?? [], children: d.children ?? {}, briefChecks: d.briefChecks ?? [] };
}

function saveState(ctx: RunContext, messages: ChatMessage[], s: SupervisorState): void {
  ctx.tasks.db
    .prepare("INSERT INTO job_state (task_id, messages_json, detail_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET messages_json = excluded.messages_json, detail_json = excluded.detail_json, updated_at = excluded.updated_at")
    .run(ctx.taskId, JSON.stringify(messages), JSON.stringify({ repos: [...s.repos.values()], children: Object.fromEntries(s.children), briefChecks: [...s.briefChecks] }), Date.now());
}

/** Create (or reuse after a restart) the job branch and its integration worktree per writable repo. */
async function integrationRepos(ctx: RunContext, saved: IntegrationRepo[]): Promise<Map<string, IntegrationRepo>> {
  const out = new Map<string, IntegrationRepo>();
  for (const r of saved) if (existsSync(r.worktree)) out.set(r.alias, r);
  const root = path.join(ctx.cfg.storageDir, "worktrees");
  mkdirSync(root, { recursive: true });
  for (const alias of ctx.spec.repositoryAliases) {
    const repo = ctx.cfg.repositoryPaths[alias];
    if (!repo?.writable || out.has(alias)) continue;
    const branch = `${ctx.cfg.supervisor.branch_prefix}${ctx.taskId}`;
    const worktree = path.join(root, `job-${ctx.taskId}-${alias}`);
    const baseSha = ctx.spec.context.baseCommits?.[alias] ?? (await headSha(repo.path));
    const exists = (await git(repo.path, ["branch", "--list", branch])).trim().length > 0;
    await git(repo.path, exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, baseSha]);
    out.set(alias, { alias, worktree, branch, baseSha });
  }
  return out;
}

/**
 * Standalone supervisor: plans, delegates to workers, verifies, integrates their commits onto a
 * job branch, keeps the job's working document, and finishes with a verified summary. Its own
 * transcript is persisted every turn, so an interrupted job resumes where it stopped.
 */
export class SupervisorRunner implements CodingRunner {
  async run(ctx: RunContext): Promise<RunOutcome> {
    const spec = ctx.spec;
    const label = spec.label ?? ctx.taskId;
    const actor: Actor = { agent: `supervisor:${label}`, role: "supervisor", model: null, job: ctx.taskId, task: ctx.taskId, tier: ctx.tier };
    const saved = loadState(ctx);
    const repos = await integrationRepos(ctx, saved?.repos ?? []);
    const state: SupervisorState = { ctx, db: ctx.tasks.db, actor, repos, briefChecks: new Set(saved?.briefChecks ?? []), children: new Map(Object.entries(saved?.children ?? {})) };

    let brain: HarnessEnv["brain"];
    if (ctx.brain && ctx.access) {
      const b = ctx.brain;
      const access = ctx.access;
      await b.ensure();
      await b.refreshIndex();
      const principal = () => access.principalFor("supervisor", { project: b.project, effort: ctx.effort, task: null, repos: spec.repositoryAliases, jobId: ctx.taskId, tier: ctx.tier });
      const doc = b.workingDocPath(ctx.effort);
      if (!b.exists(doc)) {
        await b.createWorkingDoc(principal(), actor, ctx.effort, {
          title: spec.goal.split("\n")[0]!.slice(0, 80),
          statusDetail: "Job started; plan not written yet.",
          owner: actor.agent,
          scope: spec.goal.replace(/\s+/g, " ").slice(0, 200),
          currentState: `**Goal:** ${spec.goal.slice(0, 2000)}\n\n**Acceptance:** ${spec.constraints.acceptanceCriteria.join("; ")}\n\nNo plan yet.`,
        });
      }
      brain = { brain: b, access, principal, actor, workingDoc: doc };
    }

    const readers = readersFor(ctx.cfg, spec);
    for (const r of repos.values()) readers.set(r.alias, new RepoReader(r.alias, r.worktree, null));
    const primary = [...repos.values()][0];
    const patterns = [...ctx.cfg.supervisor.allowed_commands, ...ctx.cfg.coding.allowed_commands];
    const env: HarnessEnv = {
      ctx,
      role: "supervisor",
      readers,
      universe: evidenceUniverse([]),
      allowArtifacts: true,
      ...(primary ? { workspace: { alias: primary.alias, root: primary.worktree, allowedPaths: null } } : {}),
      ...(primary && patterns.length ? { commands: { patterns, cwd: primary.worktree, timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000 } } : {}),
      edits: new Set(),
      ...(brain ? { brain } : {}),
    };
    // The supervisor's commits use the same actor object the loop updates per response.
    if (brain) state.actor = brain.actor;
    const tools: HarnessTool[] = [
      ...repoTools([...readers.keys()]),
      ...(primary ? editTools() : []),
      ...(env.commands ? [commandTool(patterns)] : []),
      artifactTool(),
      ...(brain ? [...brainReadTools(), ...brainSupervisorTools()] : []),
      ...supervisorTools(state),
    ];

    const terminal: TerminalTool<Finish> = {
      def: FINISH_DEF,
      accept: async (raw) => {
        const a = raw as Record<string, unknown>;
        const errors: string[] = [];
        const verified = Array.isArray(a.verified) ? (a.verified as Finish["verified"]) : [];
        if (a.status === "completed" && verified.length === 0) errors.push("a completed job must list what you verified and how (command and result, or evidence)");
        const running = [...state.children.values()].filter((id) => {
          const t = ctx.services!.getTask(id);
          return t && ["queued", "waiting_for_dependencies", "waiting_for_capacity", "running", "cancel_requested"].includes(t.state);
        });
        if (running.length) errors.push(`tasks still running: ${running.join(", ")}; await or cancel them first`);
        if (errors.length) return { ok: false, errors };
        return {
          ok: true,
          value: {
            status: a.status === "blocked" ? "blocked" : "completed",
            summary: String(a.summary ?? ""),
            verified,
            notVerified: Array.isArray(a.not_verified) ? (a.not_verified as string[]) : [],
            followUp: String(a.follow_up ?? "none"),
          },
        };
      },
    };

    const repoNotes = [...repos.values()].map((r) => `- ${r.alias}: branch ${r.branch} (based on ${r.baseSha.slice(0, 12)}), integration worktree is your workspace`).join("\n");
    let messages: ChatMessage[];
    if (saved?.messages.length) {
      messages = saved.messages;
      messages.push({ role: "user", content: "You were interrupted and have been resumed. Check your tasks with await_tasks before acting again; delegations are idempotent by label." });
    } else {
      const lessons = brain ? brain.brain.search(brain.principal(), spec.goal, { prefix: "global/lessons", limit: 5 }) : [];
      const cs = brain?.workingDoc ? brain.brain.read(brain.principal(), brain.workingDoc, { section: "Current State" }).content : "";
      messages = [
        {
          role: "system",
          content: `${charterFor(ctx.cfg, "supervisor")}\n\n## This job\n- Job id: ${ctx.taskId}\n- Working document: brain:${brain?.workingDoc ?? "(brain disabled)"}\n- Repositories:\n${repoNotes || "- none writable (read-only job)"}\n- Model request budget: ${ctx.budget.maxModelRequests} (await_tasks costs none)\n- Workers per job at once: ${ctx.cfg.supervisor.max_workers_per_job}\n\nEnd with finish_job.`,
        },
        {
          role: "user",
          content: `Goal:\n${spec.goal}\n\nAcceptance criteria:\n${spec.constraints.acceptanceCriteria.map((c, i) => `[${i}] ${c}`).join("\n")}${spec.constraints.checks?.length ? `\n\nJob checks (run on the job branch when you finish):\n${spec.constraints.checks.map((c) => `- ${c}`).join("\n")}` : ""}\n\nCurrent State of your working document:\n${cs || "(none)"}${lessons.length ? `\n\nRelevant lessons:\n${lessons.map((l) => `- brain:${l.path}: ${l.snippet}`).join("\n")}` : ""}`,
        },
      ];
    }
    for (const c of spec.constraints.checks ?? []) state.briefChecks.add(c);
    saveState(ctx, messages, state);

    const maxTokens = ctx.profile.max_output_tokens;
    const limits = planLimits(ctx.plan, ctx.cfg.routing.max_endpoint_fallbacks);
    const inputBudget = Math.max(4000, limits.contextLimitTokens - maxTokens - estimateTokens([], tools.map((t) => t.def)) - 1000);
    const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
    const loop = await runAgentLoop({
      env,
      executionId,
      messages,
      tools,
      terminal,
      maxTokens,
      inputBudget,
      maxInvalidTerminal: 3,
      purpose: "supervisor",
      persist: (m) => saveState(ctx, m, state),
      onResponse: async (info) => {
        if (primary) await commitAs(primary.worktree, { ...state.actor, model: info.endpointId, request: info.requestId }, `supervisor: edit ${info.edits.slice(0, 5).join(", ")}`);
      },
    });
    ctx.gate.admission.finishExecution(executionId, loop.kind);
    const transcriptRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "transcript", label: "supervisor transcript", value: loop.messages });

    // Final evidence: the job branch's diff and the job's own checks, run here, not claimed.
    const patchRefs: string[] = [];
    const checks: RunOutcome["result"]["checks"] = [];
    for (const r of repos.values()) {
      const patch = await git(r.worktree, ["diff", "--binary", r.baseSha, "HEAD"]);
      if (patch) patchRefs.push(ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "patch", label: `${r.alias} ${r.branch} vs ${r.baseSha.slice(0, 12)}`, content: patch, mediaType: "text/x-diff", extension: ".patch" }));
    }
    if (primary && !ctx.signal.aborted) {
      for (const command of spec.constraints.checks ?? []) {
        const res = await runProcess(command, [], { cwd: primary.worktree, env: minimalEnv({ CI: "1" }), timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000, signal: ctx.signal, shell: true });
        const logRef = ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "check_log", label: command, content: `$ ${command}\nexit ${res.exitCode}\n${res.stdout}\n${res.stderr}`, extension: ".log" });
        checks.push({ command, exitCode: res.killed ? null : res.exitCode, logRef });
      }
    }
    const finish = loop.kind === "terminal" ? loop.value : null;
    const checksPass = checks.length > 0 && checks.every((c) => c.exitCode === 0);
    const acceptance = checks.some((c) => c.exitCode !== 0) ? "unmet" : finish?.status === "completed" && checksPass ? "met" : "not_verified";
    const branchNote = [...repos.values()].map((r) => `${r.alias}: review and merge with \`git merge --no-ff ${r.branch}\``).join("; ");

    if (brain?.workingDoc) {
      const validation = checks.length ? checks.map((c) => `\`${c.command}\` -> exit ${c.exitCode}`).join("; ") : "not validated: the job defined no checks";
      await brain.brain
        .appendLedger(brain.principal(), state.actor, brain.workingDoc, {
          title: `Job ${finish?.status ?? loop.kind}`,
          agent: state.actor.agent,
          changed: [...repos.values()].map((r) => r.branch).join(", ") || "nothing",
          why: spec.goal.replace(/\s+/g, " ").slice(0, 160),
          validation,
          outcome: finish?.status === "completed" && acceptance !== "unmet" ? "Accepted" : finish?.status === "blocked" ? "Blocked" : "Partial",
          followUp: finish?.followUp ?? "resume or re-run the job",
        })
        .catch(() => undefined);
    }

    const state2: RunOutcome["state"] = loop.kind === "budget_exhausted" ? "budget_exhausted" : finish ? "completed" : "failed";
    return {
      state: state2,
      result: baseResult({
        executionStatus: state2 === "completed" ? "completed" : state2 === "budget_exhausted" ? "budget_exhausted" : "failed",
        acceptanceStatus: acceptance,
        stopReason: finish ? `supervisor_${finish.status}` : loop.kind === "budget_exhausted" ? "supervisor request budget exhausted" : "invalid_finish",
        summary: `${finish?.summary ?? "The supervisor did not finish."}${branchNote ? `\n\n${branchNote}` : ""}`,
        findings: (finish?.verified ?? []).map((v) => ({ description: `Verified: ${v.claim} (${v.evidence})`, evidenceRefs: [] })),
        artifactRefs: [transcriptRef],
        patchRefs,
        baseCommits: Object.fromEntries([...repos.values()].map((r) => [r.alias, r.baseSha])),
        checks,
        unresolvedCriteria: acceptance === "met" ? [] : [...(finish?.notVerified ?? []), ...(finish ? [] : spec.constraints.acceptanceCriteria)],
      }),
    };
  }
}
