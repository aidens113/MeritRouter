import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Switchyard } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { PlanStore } from "../src/storage/plans.js";
import { planRecovery } from "../src/admin/plan-recovery.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const JOB = "job_recovery";
const FAILED_AT = 1_700_000_100_500;
function git(...args: string[]): string { return execFileSync("git", args, { cwd: env!.repo, encoding: "utf8", windowsHide: true }).trim(); }
function commit(file: string, seconds: number, agent = "supervisor:recorded", task = JOB): string {
  writeFileSync(path.join(env!.repo, file), `${file} ${seconds} ${agent} ${task}\n`);
  git("add", "--", file);
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", `Change ${file}\n\nAgent: ${agent}\nRole: ${agent.startsWith("supervisor:") ? "supervisor" : "implementer"}\nTask: ${task}`], {
    cwd: env!.repo, windowsHide: true, env: { ...process.env, GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` },
  });
  return git("rev-parse", "HEAD");
}

describe("plan supervisor recovery evidence", () => {
  it("requires later scoped changes reachable on the job branch with the recorded supervisor and job attribution", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    sy.tasks.submit([WorkerTaskSchema.parse({ id: JOB, profile: "supervise", goal: "recover", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } })]);
    const labels = ["yes", "early", "same-second", "wrong-agent", "wrong-job", "other-branch", "untouched"];
    new PlanStore(sy.db).record(JOB, labels.map((label) => ({ label, profile: "implement", goal: label, acceptanceCriteria: ["done"], dependsOn: [], writableRepository: "core", allowedPaths: [`${label}.txt`], requiresAcceptedInputs: false, weight: 1 })));
    sy.tasks.submit(labels.map((label) => WorkerTaskSchema.parse({ id: `t_${label}`, label, parentTaskId: JOB, profile: "implement", goal: label, repositoryAliases: ["core"], writableRepository: "core", constraints: { allowedPaths: [`${label}.txt`], acceptanceCriteria: ["done"] } })));
    for (const label of labels) sy.db.prepare("UPDATE tasks SET state = 'failed', finished_at = ? WHERE id = ?").run(FAILED_AT, `t_${label}`);
    const base = git("rev-parse", "HEAD");
    const branch = "switchyard/job-recovery";
    git("checkout", "-q", "-b", branch);
    const recorder = sy.sessions.create({ taskId: JOB, jobId: JOB, role: "supervisor", agentLabel: "supervisor:recorded", profile: "supervise" });
    recorder.setWorkspace({ repos: [{ alias: "core", worktree: env.repo, branch, baseCommit: base, head: base }] });
    commit("early.txt", 1_700_000_090);
    commit("same-second.txt", 1_700_000_100);
    commit("wrong-agent.txt", 1_700_000_110, "implementer:worker");
    commit("wrong-job.txt", 1_700_000_111, "supervisor:recorded", "another-job");
    commit("unrelated.txt", 1_700_000_112);
    writeFileSync(path.join(env.repo, "outside-scope.txt"), "Unrelated file in the same supervisor commit\n");
    git("add", "--", "outside-scope.txt");
    const recovered = commit("yes.txt", 1_700_000_113);
    git("checkout", "-q", "-b", "other-branch");
    commit("other-branch.txt", 1_700_000_114);
    const before = sy.tasks.get("t_yes")!;
    const result = await planRecovery(sy, JOB);
    expect(result.errors).toEqual([]);
    expect(result.evidence).toEqual([{ taskId: "t_yes", repository: "core", commit: recovered, agent: "supervisor:recorded", changedAt: 1_700_000_113_000, paths: ["yes.txt"] }]);
    expect(sy.tasks.get("t_yes")).toEqual(before);
    expect(await planRecovery(sy, "nonexistent")).toEqual({ evidence: [], errors: [], commitLimit: 500 });
    git("branch", "-D", branch);
    const missing = await planRecovery(sy, JOB);
    expect(missing.evidence).toEqual([]);
    expect(missing.errors).toHaveLength(1);
  });
});
