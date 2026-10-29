import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerTaskSchema } from "../src/core/task.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { syntheticResult, TaskStore } from "../src/storage/tasks.js";
import { AWAITING_INTEGRATION } from "../src/storage/integration-obligations.js";
import { MergeQueue } from "../src/workspaces/merge-queue.js";

let directory: string | undefined;
let db: Db | undefined;
afterEach(() => {
  db?.close(); db = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
  cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
}).trim();

it.each(["pass", "nonzero", "throw"] as const)("does not publish integration or release dependents until checks settle: %s", async outcome => {
  directory = mkdtempSync(path.join(tmpdir(), "merit-merge-check-publication-"));
  git(directory, "init", "-q"); git(directory, "config", "core.autocrlf", "false");
  writeFileSync(path.join(directory, "app.txt"), "base\n"); git(directory, "add", "app.txt"); git(directory, "commit", "-qm", "base");
  const base = git(directory, "rev-parse", "HEAD"), target = path.join(directory, "target"), source = path.join(directory, "source");
  git(directory, "worktree", "add", "-qb", "integration", target, base);
  git(directory, "worktree", "add", "--detach", source, base);
  writeFileSync(path.join(source, "feature.txt"), "feature\n"); git(source, "add", "feature.txt"); git(source, "commit", "-qm", "feature");
  const sourceHead = git(source, "rev-parse", "HEAD");
  db = openDatabase(path.join(directory, "state"));
  const tasks = new TaskStore(db), now = Date.now();
  tasks.submit([
    { id: "job", profile: "supervise", repositoryAliases: ["core"] },
    { id: "upstream", profile: "implement", repositoryAliases: ["core"], writableRepository: "core", parentTaskId: "job" },
    { id: "dependent", profile: "inspect", repositoryAliases: ["core"], parentTaskId: "job", dependsOn: ["upstream"] },
  ].map(spec => WorkerTaskSchema.parse({ ...spec, goal: spec.id, constraints: { acceptanceCriteria: ["fixture"] } })), { project: "fixture" });
  db.prepare("UPDATE tasks SET state='running',lease_owner='fixture',lease_expires_at=? WHERE id='job'").run(now + 120_000);
  db.prepare("UPDATE tasks SET state='completed',result_json=?,finished_at=?,updated_at=? WHERE id='upstream'").run(JSON.stringify({
    ...syntheticResult("upstream", "completed", "fixture"), acceptanceStatus: "met", patchRefs: ["artifact:fixture"], changedPaths: ["feature.txt"],
  }), now, now);
  db.prepare(`INSERT INTO workspaces (task_id,repo_alias,source_path,worktree_path,base_sha,source_dirty,dirty_paths_json,status,created_at,updated_at)
    VALUES ('upstream','core',?,?,?,0,'[]','collected',?,?)`).run(directory, source, base, now, now);
  const queue = new MergeQueue(db, tasks, "fixture-owner");
  const item = queue.enqueue({ jobId: "job", taskId: "upstream", kind: "task", repo: "core", branch: "integration", integrationWorktree: target,
    sourceWorktree: source, sourceBase: base, sourceHead, commits: [sourceHead], acceptance: null });
  let begin!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { begin = resolve; });
  const settled = new Promise<void>(resolve => { release = resolve; });
  const running = queue.run(item.id, {
    committer: { name: "Fixture", email: "fixture@example.invalid" },
    integrated: (_item, head) => tasks.event("upstream", "integrated", { repository: "core", branch: "integration", head }),
    checks: async () => {
      begin(); await settled;
      if (outcome === "throw") throw new Error("fixture check filing failed");
      return [{ command: "fixture check", exitCode: outcome === "nonzero" ? 1 : 0 }];
    },
  });
  const limits = { maxConcurrent: 4, maxWritersPerRepo: 1, leaseMs: 30_000, defaultTimeoutMs: 60_000 };
  let pendingState: string | undefined, pendingEvents: string[] = [], pendingDependent: string | undefined, pendingReason: string | null = null;
  try {
    await checking;
    pendingState = queue.get(item.id)?.state;
    pendingEvents = tasks.events("upstream").map(event => event.type);
    tasks.claim("dependent-worker", limits);
    pendingDependent = tasks.get("dependent")!.row.state;
    pendingReason = tasks.get("dependent")!.row.state_reason;
  } finally { release(); }
  const result = await running;
  expect(pendingDependent).toBe("waiting_for_dependencies");
  expect(pendingReason).toBe(`${AWAITING_INTEGRATION}:upstream`);
  expect(pendingState).toBe("picked");
  expect(pendingEvents).not.toContain("integrated");
  expect(pendingEvents).not.toContain("merge_integrated");
  if (outcome === "throw") {
    expect(result.state).toBe("failed");
    expect(git(target, "rev-parse", "HEAD")).toBe(base);
    expect(tasks.events("upstream").map(event => event.type)).not.toContain("integrated");
    expect(tasks.events("upstream").map(event => event.type)).not.toContain("merge_integrated");
    tasks.claim("dependent-worker", limits);
    expect(tasks.get("dependent")!.row.state).toBe("waiting_for_dependencies");
  } else {
    expect(result.state).toBe("integrated");
    expect(git(target, "rev-parse", "HEAD")).toBe(result.afterHead);
    expect(result.detail.checks).toEqual([{ command: "fixture check", exitCode: outcome === "nonzero" ? 1 : 0 }]);
    expect(tasks.events("upstream").map(event => event.type)).toContain("integrated");
    tasks.claim("dependent-worker", limits);
    expect(tasks.get("dependent")!.row.state).not.toBe("waiting_for_dependencies");
  }
}, 60_000);
