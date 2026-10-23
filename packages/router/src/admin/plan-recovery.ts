import picomatch from "picomatch";
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { parseTrailers } from "../attribution/index.js";
import { git } from "../workspaces/git.js";
import { jobDetail } from "./jobs.js";
import { jobPlan } from "./job-plans.js";
import { contextOfTask } from "./projects.js";

export interface PlanRecoveryEvidence {
  taskId: string;
  repository: string;
  commit: string;
  agent: string;
  changedAt: number;
  paths: string[];
}

export interface PlanRecoveryView {
  evidence: PlanRecoveryEvidence[];
  errors: string[];
  /** Only the newest 500 non-merge commits per recorded job branch are inspected. */
  commitLimit: number;
}

const Hash = z.string().regex(/^[a-f0-9]{40,64}$/);
const Branch = z.object({ alias: z.string().min(1), branch: z.string().min(1).max(1024), baseSha: Hash });
const Commit = z.object({ hash: Hash, seconds: z.coerce.number().int().nonnegative(), trailers: z.string() });

/**
 * Evidence of later supervisor changes on the job branch, not independent verification that a
 * failed segment passed. Keep the task's original failure and acceptance intact. Git commit
 * times have one-second precision: same-second changes cannot establish ordering and are omitted.
 */
export async function planRecovery(sy: MeritRouter, jobId: string): Promise<PlanRecoveryView> {
  const out: PlanRecoveryView = { evidence: [], errors: [], commitLimit: 500 };
  const plan = jobPlan(sy, jobId);
  const job = jobDetail(sy, jobId, { transcript: false });
  if (!plan || !job) return out;
  const candidates = plan.nodes.filter((n) => n.taskId && (n.state === "failed" || n.state === "budget_exhausted") && n.finishedAt !== null && n.writableRepository && n.allowedPaths?.length);
  if (!candidates.length) return out;
  const agents = new Set(sy.sessions.forTask(jobId).filter((s) => s.role === "supervisor").map((s) => s.agentLabel));
  if (!agents.size) return out;
  const ctx = contextOfTask(sy, jobId);
  for (const rawBranch of job.branches) {
    const parsedBranch = Branch.safeParse(rawBranch);
    if (!parsedBranch.success) { out.errors.push("Invalid recorded job branch; recovery history skipped"); continue; }
    const branch = parsedBranch.data;
    const repo = Object.hasOwn(ctx.repositoryPaths, branch.alias) ? ctx.repositoryPaths[branch.alias] : undefined;
    const nodes = candidates.filter((n) => n.writableRepository === branch.alias);
    if (!repo || !nodes.length || !Hash.safeParse(branch.baseSha).success) continue;
    try {
      const head = Hash.parse((await git(repo.path, ["rev-parse", "--verify", "--end-of-options", `${branch.branch}^{commit}`])).trim());
      const log = await git(repo.path, ["log", "--no-merges", `--max-count=${out.commitLimit}`, "--format=%H%x1f%ct%x1f%(trailers:unfold)%x1e", `${branch.baseSha}..${head}`, "--"]);
      for (const raw of log.split("\x1e")) {
        if (!raw.trim()) continue;
        const [hash, seconds, trailers] = raw.trim().split("\x1f");
        const c = Commit.parse({ hash, seconds, trailers: trailers ?? "" });
        const t = parseTrailers(c.trailers);
        // Require this job's recorded supervisor identity and task attribution, not a Git author name.
        if (!t.Agent || !agents.has(t.Agent) || t.Task !== jobId || (t.Role && t.Role !== "supervisor")) continue;
        const later = nodes.filter((n) => c.seconds * 1000 > n.finishedAt!);
        if (!later.length) continue;
        const files = (await git(repo.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", c.hash, "--"])).split("\0").filter(Boolean);
        for (const n of later) {
          if (out.evidence.some((e) => e.taskId === n.taskId)) continue;
          const matchesScope = picomatch(n.allowedPaths!, { dot: true });
          const paths = files.filter(file => matchesScope(file));
          if (paths.length) out.evidence.push({ taskId: n.taskId!, repository: branch.alias, commit: c.hash, agent: t.Agent, changedAt: c.seconds * 1000, paths });
        }
      }
    } catch (err) {
      out.errors.push(`${branch.alias}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return out;
}
