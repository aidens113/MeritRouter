import picomatch from "picomatch";
import type { Db } from "../storage/db.js";
import type { RunContext } from "../runners/types.js";
import { PROFILE_NAMES } from "../config/schema.js";
import { git } from "../workspaces/git.js";
import { blame, commitsMatching, revertCommits, undoLines, type Actor } from "../attribution/index.js";
import { formatBrief } from "../brain/protocol.js";
import { minimalEnv, runProcess } from "../runners/coding/process.js";
import { commandAllowed, type HarnessEnv, type HarnessTool } from "./tools.js";

export interface IntegrationRepo {
  alias: string;
  worktree: string;
  branch: string;
  baseSha: string;
}

export interface SupervisorState {
  ctx: RunContext;
  db: Db;
  actor: Actor;
  repos: Map<string, IntegrationRepo>;
  /** Checks named in this job's briefs; the supervisor may run them. */
  briefChecks: Set<string>;
  /** label -> task id for tasks this job dispatched. */
  children: Map<string, string>;
}

const MAX = 14_000;
const cap = (t: string) => (t.length > MAX ? `${t.slice(0, MAX)}\n[truncated]` : t);
const str = (v: unknown, n: string) => {
  if (typeof v !== "string" || !v) throw new Error(`${n} is required`);
  return v;
};
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: HarnessTool["run"]): HarnessTool {
  return { def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, run };
}

/** Resolve a label or id to one of this job's own tasks; other jobs' tasks are refused. */
function ownTask(s: SupervisorState, ref: unknown): string {
  const key = String(ref ?? "");
  const id = s.children.get(key) ?? key;
  if (![...s.children.values()].includes(id)) throw new Error(`${key} is not a task of this job`);
  return id;
}

function repoFor(s: SupervisorState, alias: unknown): IntegrationRepo {
  const a = typeof alias === "string" && alias ? alias : [...s.repos.keys()][0];
  const r = a ? s.repos.get(a) : undefined;
  if (!r) throw new Error(`no integration worktree for ${String(alias)}; writable repositories: ${[...s.repos.keys()].join(", ") || "none"}`);
  return r;
}

/** The literal directory part of a glob, before its first wildcard. */
function staticPrefix(glob: string): string {
  const cut = glob.search(/[*?{[!]/);
  const head = cut < 0 ? glob : glob.slice(0, cut);
  return cut < 0 ? head : head.slice(0, head.lastIndexOf("/") + 1);
}

/**
 * Conservative overlap test: two path sets may overlap when one's literal prefix contains the
 * other's (may report overlap where none exists; never misses one).
 */
export function overlaps(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => {
    const px = staticPrefix(x);
    const py = staticPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }));
}

function summarizeResult(id: string, s: SupervisorState): string {
  const t = s.ctx.services!.getTask(id);
  if (!t) return `${id}: unknown`;
  const r = t.result;
  if (!r) return `${id} (${t.spec.label ?? t.spec.profile}): ${t.state}`;
  return [
    `${id} (${t.spec.label ?? t.spec.profile}): ${r.executionStatus}, acceptance ${r.acceptanceStatus}, ${r.stopReason}`,
    `  summary: ${r.summary.split("\n").slice(0, 3).join(" ").slice(0, 400)}`,
    ...r.findings.slice(0, 5).map((f) => `  finding: ${f.description.slice(0, 200)}${f.evidenceRefs.length ? ` [${f.evidenceRefs.slice(0, 3).join(", ")}]` : ""}`),
    ...(r.patchRefs.length ? [`  patch: ${r.patchRefs.join(", ")} (base ${Object.values(r.baseCommits).map((c) => c.slice(0, 12)).join(", ")})`] : []),
    ...r.checks.map((c) => `  check: ${c.command} -> ${c.exitCode} (${c.logRef})`),
    ...(r.unresolvedCriteria.length ? [`  unresolved: ${r.unresolvedCriteria.join("; ")}`] : []),
    `  requests ${r.usage.modelRequests}, served by ${r.servedEndpoints.join(", ") || "none"}`,
  ].join("\n");
}

/** Tools only supervisors get: delegation, waiting, integration, attribution, undo, questions. */
export function supervisorTools(s: SupervisorState): HarnessTool[] {
  const svc = s.ctx.services!;
  const jobId = s.ctx.taskId;
  const activeChildren = () =>
    [...s.children.values()].filter((id) => {
      const t = svc.getTask(id);
      return t && !["completed", "failed", "cancelled", "budget_exhausted", "interrupted"].includes(t.state);
    });

  return [
    tool(
      "delegate",
      "Dispatch worker tasks. Each brief is recorded in the job's working document first. Coding briefs must name allowedPaths and should name checks; concurrent coding briefs may not overlap paths in the same repository.",
      {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "short unique id, e.g. fix-parser" },
              profile: { type: "string", enum: PROFILE_NAMES.filter((p) => p !== "supervise") },
              goal: { type: "string" },
              acceptance_criteria: { type: "array", items: { type: "string" } },
              file_refs: { type: "array", items: { type: "string" }, description: "<alias>:<path>[#Lx-Ly]" },
              repositories: { type: "array", items: { type: "string" } },
              writable_repository: { type: "string" },
              allowed_paths: { type: "array", items: { type: "string" } },
              must_not_touch: { type: "array", items: { type: "string" } },
              checks: { type: "array", items: { type: "string" } },
              difficulty: { type: "string", enum: ["T1", "T2", "T3", "T4"] },
              depends_on: { type: "array", items: { type: "string" }, description: "labels of earlier tasks" },
              brain_grants: { type: "array", items: { type: "object", properties: { pattern: { type: "string" }, mode: { type: "string", enum: ["read", "append"] } } } },
            },
            required: ["label", "profile", "goal", "acceptance_criteria"],
          },
        },
      },
      ["tasks"],
      async (a, env) => {
        const items = Array.isArray(a.tasks) ? (a.tasks as Array<Record<string, unknown>>) : [];
        if (!items.length) throw new Error("tasks is empty");
        const limit = s.ctx.cfg.supervisor.max_workers_per_job;
        if (activeChildren().length + items.length > limit) throw new Error(`at most ${limit} workers may run for one job; await some first`);
        // Partition by file: concurrent coding briefs in one repository must not overlap.
        const active = activeChildren().map((id) => svc.getTask(id)!.spec).filter((t) => t.writableRepository);
        const pending: Array<{ label: string | undefined; repo: string; paths: string[] }> = active.map((t) => ({ label: t.label, repo: t.writableRepository!, paths: t.constraints.allowedPaths ?? [] }));
        for (const it of items) {
          if (it.profile !== "implement") continue;
          const repo = String(it.writable_repository ?? [...s.repos.keys()][0] ?? "");
          const paths = (it.allowed_paths as string[] | undefined) ?? [];
          if (!paths.length) throw new Error(`${String(it.label)}: implement briefs need allowed_paths`);
          // A task that depends on another runs after it, so their paths may overlap.
          const deps = new Set((it.depends_on as string[] | undefined) ?? []);
          const clash = pending.find((t) => t.repo === repo && !deps.has(t.label ?? "") && overlaps(t.paths, paths));
          if (clash) throw new Error(`${String(it.label)} overlaps ${clash.label ?? "an active task"} in ${repo}; add it to depends_on or narrow allowed_paths`);
          pending.push({ label: String(it.label), repo, paths });
        }
        const doc = env.brain?.workingDoc ?? null;
        const specs = items.map((it) => {
          const label = str(it.label, "label").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
          const repos = (it.repositories as string[] | undefined) ?? [...new Set([...s.repos.keys(), ...s.ctx.spec.repositoryAliases])];
          const writable = it.profile === "implement" ? String(it.writable_repository ?? [...s.repos.keys()][0] ?? "") : undefined;
          const baseCommits: Record<string, string> = {};
          if (writable && s.repos.get(writable)) baseCommits[writable] = "HEAD_OF_JOB";
          const checks = (it.checks as string[] | undefined) ?? [];
          for (const c of checks) s.briefChecks.add(c);
          const deps = ((it.depends_on as string[] | undefined) ?? []).map((l) => s.children.get(l) ?? l);
          return {
            label,
            brief: formatBrief({
              label,
              repository: writable ?? repos.join(", "),
              task: `${it.profile}: ${String(it.goal)}`,
              requiredReads: ((it.file_refs as string[] | undefined) ?? []).join(", ") || "as needed",
              owns: ((it.allowed_paths as string[] | undefined) ?? []).join(", ") || "nothing (read-only)",
              mustNotTouch: ((it.must_not_touch as string[] | undefined) ?? []).join(", ") || "everything else",
              done: `${(it.acceptance_criteria as string[]).join("; ")}${checks.length ? `; checks: ${checks.join(", ")}` : ""}`,
              reportTo: `projects/${s.ctx.brain?.project ?? "default"}/working/${s.ctx.effort}/reports/${label}.md`,
            }),
            spec: {
              profile: it.profile,
              label,
              goal: String(it.goal),
              parentTaskId: jobId,
              idempotencyKey: `${jobId}:${label}`,
              repositoryAliases: repos,
              ...(writable ? { writableRepository: writable } : {}),
              context: { ...(it.file_refs ? { fileRefs: it.file_refs } : {}), baseCommits },
              constraints: { acceptanceCriteria: it.acceptance_criteria, ...(it.allowed_paths ? { allowedPaths: it.allowed_paths } : {}), ...(checks.length ? { checks } : {}) },
              ...(it.difficulty ? { hints: { difficulty: it.difficulty } } : {}),
              ...(deps.length ? { dependsOn: deps } : {}),
              brain: { effort: s.ctx.effort, ...(it.brain_grants ? { grants: it.brain_grants } : {}) },
            } as Record<string, unknown>,
          };
        });
        // Workers start from the job branch as integrated so far.
        for (const sp of specs) {
          const bc = (sp.spec.context as { baseCommits: Record<string, string> }).baseCommits;
          for (const alias of Object.keys(bc)) bc[alias] = (await git(s.repos.get(alias)!.worktree, ["rev-parse", "HEAD"])).trim();
        }
        if (doc && env.brain) for (const sp of specs) await env.brain.brain.addBrief(env.brain.principal(), env.brain.actor, doc, sp.brief);
        const out = await svc.submitTasks(specs.map((sp) => sp.spec));
        out.forEach((o, i) => s.children.set(specs[i]!.label, o.taskId));
        return out.map((o, i) => `${specs[i]!.label} -> ${o.taskId} (${o.state}${o.deduplicated ? ", already submitted" : ""})`).join("\n");
      },
    ),

    tool("await_tasks", "Wait (without model requests) until the given tasks, or all of this job's active tasks, finish or the timeout passes. Returns compact results.", { task_ids: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "integer" } }, [], async (a) => {
      const ids = Array.isArray(a.task_ids) && a.task_ids.length ? (a.task_ids as string[]).map((x) => ownTask(s, x)) : [...s.children.values()];
      if (!ids.length) return "no tasks dispatched yet";
      const r = await svc.awaitResults(ids, { timeoutSeconds: Math.min(Number(a.timeout_seconds) || 1800, 3600), signal: s.ctx.signal, uncapped: true });
      return cap([...r.completed.map((c) => summarizeResult(c.taskId, s)), ...r.pending.map((p) => `${p.taskId}: still ${p.state}`)].join("\n"));
    }),

    tool("task_result", "Full result of one task (findings, evidence, checks, patch references).", { task_id: { type: "string" } }, ["task_id"], async (a) => {
      const id = ownTask(s, a.task_id);
      const t = svc.getTask(id);
      if (!t) throw new Error("unknown task");
      return cap(JSON.stringify({ state: t.state, spec: { label: t.spec.label, profile: t.spec.profile, goal: t.spec.goal }, result: t.result }, null, 1));
    }),

    tool("cancel_tasks", "Cancel tasks this job dispatched.", { task_ids: { type: "array", items: { type: "string" } } }, ["task_ids"], async (a) => {
      svc.cancelTasks((a.task_ids as string[]).map((x) => ownTask(s, x)));
      return "cancellation requested";
    }),

    tool("integrate_task", "Cherry-pick a finished coding task's commits onto the job branch. Per-line attribution is kept. On conflict nothing changes and the conflict is reported. Patches with out-of-scope edits are refused; patches that changed tests need accept_test_changes after you reviewed them.", { task_id: { type: "string" }, accept_test_changes: { type: "boolean" } }, ["task_id"], async (a) => {
      const id = ownTask(s, a.task_id);
      const t = svc.getTask(id);
      if (!t?.result) throw new Error("task has not finished");
      const findings = t.result.findings.map((f) => f.description);
      const outOfScope = findings.find((f) => f.startsWith("Out-of-scope changes"));
      if (outOfScope) throw new Error(`refused: ${outOfScope}. Undo those files in a follow-up task or re-delegate with the right allowed_paths.`);
      const tests = findings.find((f) => f.startsWith("Tests or evaluator files were modified"));
      if (tests && a.accept_test_changes !== true) throw new Error(`${tests} Review the change, then call integrate_task again with accept_test_changes: true if it is legitimate.`);
      const ws = s.db.prepare("SELECT worktree_path, base_sha, repo_alias FROM workspaces WHERE task_id = ?").get(id) as { worktree_path: string; base_sha: string; repo_alias: string } | undefined;
      if (!ws) throw new Error("task has no worktree (not a coding task?)");
      const repo = repoFor(s, ws.repo_alias);
      const commits = (await git(ws.worktree_path, ["rev-list", "--reverse", `${ws.base_sha}..HEAD`])).split("\n").filter(Boolean);
      if (!commits.length) return "nothing to integrate: the task made no commits";
      const env = { GIT_COMMITTER_NAME: s.actor.agent, GIT_COMMITTER_EMAIL: `${s.actor.agent.replace(/[^A-Za-z0-9._-]+/g, ".")}@switchyard.local` };
      try {
        await git(repo.worktree, ["cherry-pick", "-x", "--allow-empty", ...commits], { env });
      } catch (err) {
        const conflicts = await git(repo.worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
        await git(repo.worktree, ["cherry-pick", "--abort"]).catch(() => undefined);
        return `conflict integrating ${id}; nothing was changed. Conflicting files: ${conflicts.trim().split("\n").join(", ") || "unknown"}. Re-delegate based on the current job branch, or edit the files yourself. (${(err as Error).message.slice(0, 200)})`;
      }
      return `integrated ${commits.length} commit(s) from ${id} onto ${repo.branch}; head is now ${(await git(repo.worktree, ["rev-parse", "--short", "HEAD"])).trim()}`;
    }),

    tool("run_check", "Run a check command in the job's integration worktree (commands from your briefs' checks or the supervisor allowlist).", { command: { type: "string" }, repository: { type: "string" } }, ["command"], async (a) => {
      const repo = repoFor(s, a.repository);
      const command = str(a.command, "command");
      const allowed = s.briefChecks.has(command) || commandAllowed(command, [...s.ctx.cfg.supervisor.allowed_commands, ...s.ctx.cfg.coding.allowed_commands]);
      if (!allowed) throw new Error("command not allowed: use a check from one of your briefs or add it to supervisor.allowed_commands");
      const r = await runProcess(command, [], { cwd: repo.worktree, env: minimalEnv({ CI: "1" }), timeoutMs: s.ctx.cfg.execution.check_timeout_seconds * 1000, signal: s.ctx.signal, shell: true });
      const log = s.ctx.artifacts.write({ taskId: jobId, kind: "check_log", label: command, content: `$ ${command}\nexit ${r.exitCode}\n${r.stdout}\n${r.stderr}`, extension: ".log" });
      return cap(`$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""} (log ${log})\n${r.stdout.slice(-6000)}\n${r.stderr.slice(-3000)}`);
    }),

    tool("blame", "Who wrote each line of a file on the job branch: agent, model, task, grouped into ranges.", { path: { type: "string" }, repository: { type: "string" } }, ["path"], async (a) => {
      const repo = repoFor(s, a.repository);
      const lines = await blame(repo.worktree, str(a.path, "path"));
      const ranges: string[] = [];
      let start = 0;
      for (let i = 1; i <= lines.length; i++) {
        const prev = lines[i - 1]!;
        const cur = lines[i];
        if (!cur || cur.commit !== prev.commit) {
          ranges.push(`L${lines[start]!.line}-L${prev.line}: ${prev.agent ?? prev.authorName} (${prev.model ?? prev.role ?? "?"}) ${prev.commit.slice(0, 10)}`);
          start = i;
        }
      }
      return cap(ranges.join("\n"));
    }),

    tool(
      "undo",
      "Undo changes on the job branch at your discretion: a whole task, everything a model did, one commit, or specific lines of a file. Every undo is a new commit with your reason; changes made before this job are never touched.",
      { kind: { type: "string", enum: ["task", "model", "agent", "commit", "lines"] }, target: { type: "string", description: "task id/label, model endpoint id, agent, or commit" }, path: { type: "string" }, ranges: { type: "array", items: { type: "array", items: { type: "integer" } } }, reason: { type: "string" }, repository: { type: "string" } },
      ["kind", "reason"],
      async (a) => {
        const repo = repoFor(s, a.repository);
        const reason = str(a.reason, "reason");
        if (a.kind === "lines") {
          const ranges = ((a.ranges as number[][] | undefined) ?? []).map((r) => [r[0]!, r[1] ?? r[0]!] as [number, number]);
          const r = await undoLines(repo.worktree, str(a.path, "path"), ranges, s.actor, reason, { sinceCommit: repo.baseSha });
          return `undid lines ${r.undone.join(", ") || "none"}${r.skipped.length ? `; skipped ${r.skipped.map((x) => `${x.line} (${x.why})`).join(", ")}` : ""}${r.commit ? ` in ${r.commit.slice(0, 10)}` : ""}`;
        }
        const target = str(a.target, "target");
        let commits: string[];
        if (a.kind === "commit") {
          // Only commits made during this job (after its base) may be undone.
          const sha = (await git(repo.worktree, ["rev-parse", "--verify", `${target}^{commit}`])).trim();
          const jobCommits = new Set((await git(repo.worktree, ["rev-list", `${repo.baseSha}..HEAD`])).split("\n").filter(Boolean));
          if (!jobCommits.has(sha)) throw new Error(`${target} is not a commit made during this job; changes from before the job are never undone`);
          commits = [sha];
        }
        else {
          const key = a.kind === "task" ? "Task" : a.kind === "model" ? "Model" : "Agent";
          const value = a.kind === "task" ? (s.children.get(target) ?? target) : target;
          commits = (await commitsMatching(repo.worktree, `${repo.baseSha}..HEAD`, { [key]: value })).map((c) => c.commit);
        }
        if (!commits.length) return "no matching commits on the job branch";
        const c = await revertCommits(repo.worktree, commits, s.actor, reason);
        return `reverted ${commits.length} commit(s) in ${c?.slice(0, 10) ?? "(nothing to commit)"}`;
      },
    ),

    tool("ask_user", "Ask the user a question and wait for the answer. Use only when a decision belongs to them.", { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, ["question"], async (a) => {
      const id = Number(
        s.db.prepare("INSERT INTO job_questions (task_id, question, options_json, asked_at) VALUES (?, ?, ?, ?)").run(jobId, str(a.question, "question"), a.options ? JSON.stringify(a.options) : null, Date.now()).lastInsertRowid,
      );
      s.ctx.tasks.event(jobId, "question", { id, question: a.question });
      const until = Date.now() + s.ctx.cfg.supervisor.question_timeout_seconds * 1000;
      while (Date.now() < until && !s.ctx.signal.aborted) {
        const row = s.db.prepare("SELECT answer, answered_by FROM job_questions WHERE id = ?").get(id) as { answer: string | null; answered_by: string | null };
        if (row.answer !== null) return `answer from ${row.answered_by ?? "user"}: ${row.answer}`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return "no answer arrived; decide with a sensible default and record it";
    }),
  ];
}

export type { HarnessEnv };
