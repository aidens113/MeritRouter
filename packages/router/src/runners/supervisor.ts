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
import { dirtyPaths, git, headSha } from "../workspaces/git.js";
import { runAgentLoop, type TerminalTool } from "../harness/loop.js";
import type { ResumeInput } from "../harness/resume.js";
import type { ResumeToolRef } from "../sessions/events.js";
import { artifactTool, brainReadTools, brainSupervisorTools, commandTool, editTools, repoTools, type HarnessEnv, type HarnessTool } from "../harness/tools.js";
import { labHarnessTools } from "../labs/tools.js";
import { webTools } from "../harness/web-tools.js";
import { ensureCarves, jobDepth, mergeHooks, subJobSection, supervisorTools, type IntegrationRepo, type SupervisorState } from "../harness/supervisor-tools.js";
import { coordinationGuard, sharedFilesOf } from "../harness/coordination-edits.js";
import { MergeQueue, type MergeItem } from "../workspaces/merge-queue.js";
import { newId } from "../storage/db.js";
import { isSimulatedCrash } from "../core/faults.js";
import { parseDoc, replaceSection, section, workingDocTemplate } from "../brain/protocol.js";
import { minimalEnv, runProcess } from "./coding/process.js";
import { baseResult, type RunContext, type RunOutcome } from "./types.js";
import { WorkspacePointer } from "./session-workspace.js";
import { criterionTexts } from "../core/task.js";
import { maxAgentsPerJob } from "../config/schema.js";
import picomatch from "picomatch";
import { taskWriteScope } from "../harness/task-scope.js";

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

/**
 * Legacy resume state for jobs interrupted before sessions were resumable (S2): the transcript
 * and detail persisted in `job_state`. Read only when the job has no session to resume; never
 * written any more.
 */
function loadLegacyState(ctx: RunContext): { messages: ChatMessage[]; repos: IntegrationRepo[]; children: Record<string, string>; briefChecks: string[] } | null {
  const row = ctx.tasks.db.prepare("SELECT messages_json, detail_json FROM job_state WHERE task_id = ?").get(ctx.taskId) as { messages_json: string; detail_json: string | null } | undefined;
  if (!row) return null;
  const d = row.detail_json ? (JSON.parse(row.detail_json) as { repos?: IntegrationRepo[]; children?: Record<string, string>; briefChecks?: string[] }) : {};
  return { messages: JSON.parse(row.messages_json) as ChatMessage[], repos: d.repos ?? [], children: d.children ?? {}, briefChecks: d.briefChecks ?? [] };
}

/** The job's integration repositories as its resumed session last recorded them. */
function sessionRepos(ctx: RunContext): IntegrationRepo[] {
  const repos = ctx.resume?.plan.workspace?.repos ?? [];
  return repos.flatMap((r) => (r.baseCommit ? [{ alias: r.alias, worktree: r.worktree, branch: r.branch ?? `${ctx.cfg.supervisor.branch_prefix}${ctx.taskId}`, baseSha: r.baseCommit }] : []));
}

/** Questions this job asked, answered and still open, for a resumed supervisor. */
function questionNotes(ctx: RunContext): string {
  const qs = ctx.tasks.db.prepare("SELECT id, question, answer FROM job_questions WHERE task_id = ? ORDER BY id").all(ctx.taskId) as Array<{ id: number; question: string; answer: string | null }>;
  const answered = qs.filter((q) => q.answer !== null).map((q) => `- "${q.question}" -> ${q.answer}`);
  const open = qs.filter((q) => q.answer === null).map((q) => `- "${q.question}" (still unanswered; ask again with ask_user to keep waiting)`);
  return `${answered.length ? `\nAnswers from the user so far:\n${answered.join("\n")}` : ""}${open.length ? `\nOpen questions:\n${open.join("\n")}` : ""}`;
}

/** The stored state of an ask_user call interrupted before its outcome was recorded. */
function questionState(ctx: RunContext, ref: ResumeToolRef): string {
  const asked = (ref.args && typeof ref.args === "object" ? (ref.args as Record<string, unknown>).question : undefined) as string | undefined;
  const row = asked
    ? (ctx.tasks.db.prepare("SELECT answer, answered_by FROM job_questions WHERE task_id = ? AND question = ? ORDER BY id DESC LIMIT 1").get(ctx.taskId, asked) as { answer: string | null; answered_by: string | null } | undefined)
    : undefined;
  if (!row) return "interrupted before the question was recorded; ask again with ask_user if you still need the answer";
  if (row.answer !== null) return `answer from ${row.answered_by ?? "user"}: ${row.answer}`;
  return "interrupted while waiting; the question is still open. Call ask_user again to keep waiting for the answer.";
}

/** Create (or reuse after a restart) the job branch and its integration worktree per writable repo. */
async function integrationRepos(ctx: RunContext, saved: IntegrationRepo[]): Promise<Map<string, IntegrationRepo>> {
  const out = new Map<string, IntegrationRepo>();
  if (ctx.lab && ctx.lab.rootJobId === ctx.taskId) {
    const status = ctx.lab.manager.status(ctx.lab.project, ctx.lab.name);
    for (const repo of status.lab.repositories) {
      if (!ctx.spec.repositoryAliases.includes(repo.alias) || !ctx.cfg.repositoryPaths[repo.alias]?.writable) continue;
      out.set(repo.alias, { alias: repo.alias, worktree: repo.worktree, branch: repo.branch, baseSha: status.heads[repo.alias] ?? repo.base });
    }
    return out;
  }
  for (const r of saved) if (existsSync(r.worktree)) out.set(r.alias, r);
  const root = path.join(ctx.cfg.storageDir, "worktrees");
  mkdirSync(root, { recursive: true });
  for (const alias of ctx.spec.repositoryAliases) {
    const repo = ctx.cfg.repositoryPaths[alias];
    if (!repo?.writable || out.has(alias)) continue;
    const branch = `${ctx.cfg.supervisor.branch_prefix}${ctx.taskId}`;
    const worktree = path.join(root, `job-${ctx.taskId}-${alias}`);
    const exists = (await git(repo.path, ["branch", "--list", branch])).trim().length > 0;
    if (exists && existsSync(worktree)) {
      // A run that died before recording its workspace: reuse the job's worktree.
      const baseSha = ctx.spec.context.baseCommits?.[alias] ?? (await git(repo.path, ["merge-base", "HEAD", branch])).trim();
      out.set(alias, { alias, worktree, branch, baseSha });
      continue;
    }
    const baseSha = ctx.spec.context.baseCommits?.[alias] ?? (await headSha(repo.path));
    await git(repo.path, exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, baseSha]);
    out.set(alias, { alias, worktree, branch, baseSha });
  }
  return out;
}

/** One recovered merge-queue item, for the resumed supervisor. */
function mergeNote(i: MergeItem): string {
  const what = i.state === "integrated" ? `integrated (${i.commits.length} commit(s), head ${(i.afterHead ?? "").slice(0, 7)})` : i.state === "redelegated" ? `conflicted; re-delegated as ${i.redelegatedTo}` : `${i.state}${i.detail.error ? `: ${String(i.detail.error).slice(0, 200)}` : ""}`;
  return `- ${i.taskId} onto ${i.branch}: ${what}`;
}

/**
 * Standalone supervisor: plans, delegates to workers, verifies, integrates their commits onto a
 * job branch, keeps the job's working document, and finishes with a verified summary. Its
 * session records every turn, so an interrupted job resumes from the session where it stopped.
 */
export class SupervisorRunner implements CodingRunner {
  async run(ctx: RunContext): Promise<RunOutcome> {
    const spec = ctx.spec;
    const writeScope = taskWriteScope(spec, ctx.tasks);
    const label = spec.label ?? ctx.taskId;
    const actor: Actor = { agent: `supervisor:${label}`, role: "supervisor", model: null, job: ctx.taskId, task: ctx.taskId, tier: ctx.tier };
    const legacy = ctx.resume ? null : loadLegacyState(ctx);
    const repos = await integrationRepos(ctx, ctx.resume ? sessionRepos(ctx) : (legacy?.repos ?? []));
    // Delegated tasks and their checks come from the task store, so a resumed job knows them.
    const children = new Map(Object.entries(legacy?.children ?? {}));
    const briefChecks = new Set(legacy?.briefChecks ?? []);
    for (const c of ctx.tasks.childrenOf(ctx.taskId)) {
      if (c.spec.label) children.set(c.spec.label, c.row.id);
      for (const check of c.spec.constraints.checks ?? []) briefChecks.add(check);
    }
    // A sub-job (delegated by another supervisor) works in its own section of the parent's document.
    const parentJob = spec.parentTaskId ? ctx.tasks.get(spec.parentTaskId) : undefined;
    const isSubJob = parentJob?.spec.profile === "supervise";
    const depth = jobDepth(ctx.tasks, ctx.taskId);
    const docSection = isSubJob ? subJobSection(label) : null;
    // One merge-queue owner per run: items a dead run left in progress are recovered below.
    const queue = new MergeQueue(ctx.tasks.db, ctx.tasks, newId("mqrun"));
    const state: SupervisorState = { ctx, db: ctx.tasks.db, actor, repos, briefChecks, children, queue, depth, docSection, sharedFiles: sharedFilesOf(ctx.tasks.db, ctx.taskId) };
    ensureCarves(state);
    const pointer = new WorkspacePointer(
      ctx.session,
      await Promise.all([...repos.values()].map(async (r) => ({ alias: r.alias, worktree: r.worktree, branch: r.branch, baseCommit: r.baseSha, head: (await git(r.worktree, ["rev-parse", "HEAD"])).trim() || null }))),
    );

    let brain: HarnessEnv["brain"];
    if (ctx.brain && ctx.access) {
      const b = ctx.brain;
      const access = ctx.access;
      await b.ensure();
      await b.refreshIndex();
      const principal = () => access.principalFor("supervisor", { project: b.project, effort: ctx.effort, task: null, repos: spec.repositoryAliases, jobId: ctx.taskId, tier: ctx.tier });
      const lane = ctx.lab ? `projects/${b.project}/labs/${ctx.lab.name}.md` : null;
      if (lane && !b.exists(lane)) {
        await b.write(principal(), actor, lane, workingDocTemplate({title:`Lab ${ctx.lab!.name}`,statusDetail:"Active root team",owner:actor.agent,scope:spec.goal.slice(0,200),currentState:`Root team: ${ctx.lab!.rootJobId}\n\nGoal: ${spec.goal.slice(0,2000)}\n\nUse lab_status and lab_check for current services and revision evidence.`}), `Create lab lane ${ctx.lab!.name}`);
      }
      const doc = lane ?? b.workingDocPath(ctx.effort);
      if (!b.exists(doc)) {
        // A sub-job whose parent has no document yet starts one like a top-level job.
        await b.createWorkingDoc(principal(), actor, ctx.effort, {
          title: spec.goal.split("\n")[0]!.slice(0, 80),
          statusDetail: "Job started; plan not written yet.",
          owner: actor.agent,
          scope: spec.goal.replace(/\s+/g, " ").slice(0, 200),
          currentState: `**Goal:** ${spec.goal.slice(0, 2000)}\n\n**Acceptance:** ${criterionTexts(spec).join("; ")}\n\nNo plan yet.`,
        });
      }
      if (docSection) {
        // The parent writes the sub-job's section when it delegates; start it here if that failed.
        const text = b.read(principal(), doc).content;
        if (!section(parseDoc(text), docSection)) {
          const body = `**Goal:** ${spec.goal.slice(0, 2000)}\n\n**Acceptance:** ${criterionTexts(spec).join("; ")}`;
          await b.write(principal(), actor, doc, replaceSection(text, docSection, body, "Work Ledger"), `Sub-job: ${label}`).catch(() => undefined);
        }
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
      // supervisor.implementation: delegate limits the edit tools to coordination files, in code.
      ...(primary ? { workspace: { alias: primary.alias, root: primary.worktree, allowedPaths: writeScope ?? null, guard: coordinationGuard({ cfg: ctx.cfg, db: ctx.tasks.db, jobId: ctx.taskId, alias: primary.alias, sharedFiles: () => state.sharedFiles ?? new Set() }) } } : {}),
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
      ...webTools(),
      ...labHarnessTools(),
      // A sub-job rewrites its own section (brain_set_job_section), never the parent's Current State.
      ...(brain ? [...brainReadTools(), ...brainSupervisorTools().filter((t) => !docSection || !["brain_set_current_state", "brain_compact"].includes(t.def.function.name))] : []),
      // Integration and undo commit on the job branch: record the new head after each.
      ...supervisorTools(state).map((t): HarnessTool => {
        if (t.sideEffect !== "edit") return t;
        return {
          ...t,
          run: async (a, e) => {
            try {
              return await t.run(a, e);
            } finally {
              await pointer.refresh();
            }
          },
        };
      }),
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

    // Integrations a dead run of this job left in its merge queue finish (or are retried once)
    // before the model acts again; the resumed model is told what happened.
    let recovered: MergeItem[] = [];
    try {
      recovered = await queue.recover(ctx.taskId, mergeHooks(state, env));
    } catch (err) {
      if (isSimulatedCrash(err)) throw err;
      ctx.tasks.event(ctx.taskId, "merge_recovery_failed", { error: (err as Error).message.slice(0, 500) });
    }
    if (recovered.length) await pointer.refresh();
    const queueNote = recovered.length ? `\nMerge queue after the interruption (integrate_task again reports these without picking twice):\n${recovered.map(mergeNote).join("\n")}` : "";

    const repoNotes = [...repos.values()].map((r) => `- ${r.alias}: branch ${r.branch} (based on ${r.baseSha.slice(0, 12)}), integration worktree is your workspace`).join("\n");
    let messages: ChatMessage[];
    let resume: ResumeInput | undefined;
    if (ctx.resume) {
      messages = ctx.resume.plan.messages;
      resume = {
        plan: ctx.resume.plan,
        actor: state.actor,
        pointer,
        external: (ref) => questionState(ctx, ref),
        notice: `Check your tasks with await_tasks before acting again; delegations are idempotent by label.${questionNotes(ctx)}${queueNote}`,
      };
    } else if (legacy?.messages.length) {
      messages = legacy.messages;
      messages.push({ role: "user", content: `You were interrupted and have been resumed. Check your tasks with await_tasks before acting again; delegations are idempotent by label.${questionNotes(ctx)}${queueNote}` });
    } else {
      const lessons = brain ? brain.brain.search(brain.principal(), spec.goal, { prefix: "global/lessons", limit: 5 }) : [];
      let cs = "";
      try {
        cs = brain?.workingDoc ? brain.brain.read(brain.principal(), brain.workingDoc, { section: docSection ?? "Current State" }).content : "";
      } catch {
        cs = ""; // a sub-job section that could not be written
      }
      const subNote = isSubJob
        ? `\n- Sub-job of job ${spec.parentTaskId} (supervisor level ${depth} of at most ${ctx.cfg.team.max_depth}): your branches fork from the parent job's branches; the parent integrates them when you finish, so finish with everything you want delivered integrated on your branch\n- Your section of the parent's working document: "${docSection}" (rewrite your status with brain_set_job_section; the parent's Current State is not yours)`
        : depth < ctx.cfg.team.max_depth
          ? `\n- You may delegate sub-goals to sub-supervisors (profile supervise); each gets ${ctx.cfg.team.child_budget_share} of your remaining request budget and its own branch forked from yours`
          : "";
      messages = [
        {
          role: "system",
          content: `${charterFor(ctx.cfg, "supervisor")}\n\n## This job\n- Job id: ${ctx.taskId}\n- Working document: brain:${brain?.workingDoc ?? "(brain disabled)"}\n- Repositories:\n${repoNotes || "- none writable (read-only job)"}\n- Model request budget: ${ctx.budget.maxModelRequests} (await_tasks costs none). It is the job's pool: each task you delegate holds its budget (max_requests, default ${ctx.cfg.team.default_task_requests ?? "its tier's cap"}) from it while open, and approved requests for more come out of it\n- ${ctx.cfg.supervisor.implementation === "delegate" ? `Implementation: delegate. Your edit tools change only coordination files (${ctx.cfg.supervisor.coordination_paths.join(", ")}, files your briefs name in shared_files, and files of an integration conflict you fix); delegate every other change, and re-delegate when a worker fails or runs out` : "Implementation: allowed. You may edit files in your integration worktree, but prefer delegating"}\n- Tasks of this job running at once (team.max_agents): ${maxAgentsPerJob(ctx.cfg)}; more wait queued${subNote}\n\nEnd with finish_job.`,
        },
        {
          role: "user",
          content: `Goal:\n${spec.goal}\n\nAcceptance criteria:\n${criterionTexts(spec).map((c, i) => `[${i}] ${c}`).join("\n")}${spec.constraints.checks?.length ? `\n\nJob checks (run on the job branch when you finish):\n${spec.constraints.checks.map((c) => `- ${c}`).join("\n")}` : ""}\n\n${docSection ? `Your section of the parent job's working document (${docSection})` : "Current State of your working document"}:\n${cs || "(none)"}${lessons.length ? `\n\nRelevant lessons:\n${lessons.map((l) => `- brain:${l.path}: ${l.snippet}`).join("\n")}` : ""}`,
        },
      ];
      if (queueNote) messages.push({ role: "user", content: queueNote.trim() });
    }
    for (const c of spec.constraints.checks ?? []) state.briefChecks.add(c);

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
      ...(resume ? { resume } : {}),
      onResponse: async (info) => {
        if (primary) pointer.setHead(primary.alias, await commitAs(primary.worktree, { ...state.actor, model: info.endpointId, request: info.requestId }, `supervisor: edit ${info.edits.slice(0, 5).join(", ")}`));
      },
    });
    ctx.gate.admission.finishExecution(executionId, loop.kind);
    const transcriptRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "transcript", label: "supervisor transcript", value: loop.messages });

    // Final evidence: the job branch's diff and the job's own checks, run here, not claimed.
    const patchRefs: string[] = [];
    const scopeViolation: string[] = [];
    const checks: RunOutcome["result"]["checks"] = [];
    for (const r of repos.values()) {
      if (writeScope) {
        const allowed = picomatch(writeScope, { dot: true });
        const changed = (await git(r.worktree, ["diff", "--name-only", "--no-renames", "-z", r.baseSha])).split("\0").filter(Boolean);
        // Commands can leave tracked or untracked edits without calling an edit tool.
        const paths = new Set([...changed, ...await dirtyPaths(r.worktree)]);
        scopeViolation.push(...[...paths].filter(file => !allowed(file)).map(file => `${r.alias}:${file}`));
      }
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
    if(ctx.lab && ctx.lab.rootJobId===ctx.taskId){
      const status=ctx.lab.manager.status(ctx.lab.project,ctx.lab.name);
      for(const name of Object.keys(status.lab.recipe.checks)){
        const result=status.checks.find(check=>check.name===name&&check.revision===status.heads[check.repository]);
        const repo=status.lab.repositories.find(repo=>repo.alias===result?.repository);
        const clean=repo && !(await dirtyPaths(repo.worktree)).length;
        const logRef=ctx.artifacts.write({taskId:ctx.taskId,executionId,kind:"check_log",label:`lab:${name}`,content:ctx.lab.manager.redact(ctx.lab.project,ctx.lab.name,result?`revision ${result.revision}\nexit ${result.exitCode}\n${result.stdout}\n${result.stderr}`:"No check result exists for this candidate revision."),extension:".log"});
        checks.push({command:`lab:${name}`,exitCode:result&&clean&&!result.killed?result.exitCode:null,logRef,revision:result?.revision??null});
      }
    }
    const finish = loop.kind === "terminal" ? loop.value : null;
    const checksPass = checks.length > 0 && checks.every((c) => c.exitCode === 0);
    const acceptance = scopeViolation.length || checks.some((c) => c.exitCode !== 0) ? "unmet" : finish?.status === "completed" && checksPass ? "met" : "not_verified";
    // A sub-job's branches are integrated by its parent job (integrate_task), not merged by hand.
    const branchNote = [...repos.values()]
      .map((r) => (isSubJob ? `${r.alias}: delivered on ${r.branch}; the parent job ${spec.parentTaskId} integrates it through its merge queue (integrate_task ${label})` : ctx.lab ? `${r.alias}: candidate on ${r.branch}; use lab_promote under the configured promotion policy` : `${r.alias}: review and merge with \`git merge --no-ff ${r.branch}\``))
      .join("; ");

    if (brain?.workingDoc) {
      const validation = checks.length ? checks.map((c) => `\`${c.command}\` -> exit ${c.exitCode}`).join("; ") : "not validated: the job defined no checks";
      await brain.brain
        .appendLedger(brain.principal(), state.actor, brain.workingDoc, {
          title: `${isSubJob ? `Sub-job ${label}` : "Job"} ${finish?.status ?? loop.kind}`,
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
        findings: [...(finish?.verified ?? []).map((v) => ({ description: `Verified: ${v.claim} (${v.evidence})`, evidenceRefs: [] })), ...(scopeViolation.length ? [{ description: `Out-of-scope changes (not allowed by allowedPaths): ${scopeViolation.join(", ")}`, evidenceRefs: [] }] : [])],
        ...(scopeViolation.length ? { scopeViolation } : {}),
        artifactRefs: [transcriptRef],
        patchRefs,
        baseCommits: Object.fromEntries([...repos.values()].map((r) => [r.alias, r.baseSha])),
        checks,
        unresolvedCriteria: acceptance === "met" ? [] : [...(finish?.notVerified ?? []), ...(finish ? [] : criterionTexts(spec))],
      }),
    };
  }
}
