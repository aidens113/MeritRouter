import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deleteProject } from "../src/admin/projects.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import * as gitModule from "../src/workspaces/git.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
const operations = new Set<Promise<unknown>>();
function track<T>(operation: Promise<T>): Promise<T> {
  operations.add(operation); void operation.finally(() => operations.delete(operation)).catch(() => undefined); return operation;
}
afterEach(async () => { await Promise.allSettled([...operations]); vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const native = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
async function fixture() {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" }, projects: {
    alpha: { repositories: { app: { path: "repo" } } }, beta: { repositories: { app: { path: "repo" } } },
  } }) });
  const client = new ScriptedClient(() => reply("must not call provider")); sy = open(env, client);
  await sy.brain.ensure(); await sy.brainFor("beta").ensure();
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "t_deletion", profile: "inspect", goal: "fixture", repositoryAliases: ["app"], constraints: { acceptanceCriteria: ["fixture"] } })], { project: "beta" });
  sy.db.prepare("UPDATE tasks SET state='failed' WHERE id='t_deletion'").run();
  const worktrees = new Worktrees(sy.db, path.join(env.cfg.storageDir, "worktrees")), ws = await worktrees.prepare({ taskId: "t_deletion", run: 1, alias: "app", sourcePath: env.repo });
  const session = sy.sessions.create({ taskId: "t_deletion", role: "implementer", agentLabel: "fixture" });
  session.setWorkspace({ repos: [{ alias: "app", worktree: ws.worktreePath, branch: null, baseCommit: ws.baseSha, head: ws.baseSha }] });
  const execution = sy.admission.createExecution("task", "summarize", [{ taskId: "t_deletion", itemId: "1" }]);
  sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id,input_tokens,output_tokens) VALUES('request_fixture',?,'fixture','fake','succeeded',?,1,1,'beta',3,4)").run(execution, Date.now());
  sy.db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,actual_usd,created_at) VALUES('request_fixture','fixture-key','fake','fake',0.1,0.05,?)").run(Date.now());
  return { ws, client, session };
}
async function pending(root: string) {
  writeFileSync(path.join(root, "pending.txt"), "publication pending\n");
  const out = await commitSelectedApplication(root, { actor: { agent: "fixture", role: "implementer" }, message: "pending", paths: ["pending.txt"] }, { refPublished: async () => { throw new Error("retain"); } });
  if (out.kind !== "reconciliation_required") throw new Error("Expected real post-ref pending receipt");
  return readCommitReceipt(root, out.receiptId);
}
function index(root: string) { return readFileSync(path.resolve(root, native(root, "rev-parse", "--git-path", "index").trim())); }
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return { config: readFileSync(env!.cfg.configPath), source: native(env!.repo, "rev-parse", "HEAD"), workspace: native(f.ws.worktreePath, "rev-parse", "HEAD"), workspaceIndex: index(f.ws.worktreePath), brain: native(sy!.brain.root, "rev-parse", "HEAD"), brainIndex: index(sy!.brain.root),
    tables: Object.fromEntries(["projects", "tasks", "workspaces", "sessions", "session_events", "events", "model_requests", "paid_spend"].map(table => [table, sy!.db.prepare(`SELECT * FROM ${table}`).all()])) };
}

describe("project deletion publication admission", () => {
  it.each(["workspace", "brain"] as const)("refuses pending %s before Lab prune, config, SQL or filesystem cleanup", async scope => {
    const f = await fixture(), receipt = await pending(scope === "workspace" ? f.ws.worktreePath : sy!.brain.root), before = snapshot(f), receiptBytes = () => ["receipt.json", "original.index", "next.index"].map(name => readFileSync(path.join(receipt.directory, name))), bytes = receiptBytes(), prune = vi.spyOn(sy!.labs.taskAttempts, "pruneProject");
    await expect(deleteProject(sy!, "beta", { confirm: "beta" })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(snapshot(f)).toEqual(before); expect(receiptBytes()).toEqual(bytes); expect(prune).not.toHaveBeenCalled(); expect(f.client.requests).toHaveLength(0);
  });

  it("does not erase a worktree after native remove failure or count it as removed", async () => {
    const f = await fixture(), before = snapshot(f), original = gitModule.git;
    vi.spyOn(gitModule, "git").mockImplementation((repo, args, opts) => args[0] === "worktree" && args[1] === "remove" ? Promise.reject(new Error("fixture native removal failed")) : original(repo, args, opts));
    await expect(deleteProject(sy!, "beta", { confirm: "beta" })).rejects.toThrow("fixture native removal failed");
    expect(existsSync(f.ws.worktreePath)).toBe(true); expect(snapshot(f)).toEqual(before);
  });

  it("refuses a foreign retained session owner before writing its lifecycle lock", async () => {
    const f = await fixture(), foreign = path.join(env!.dir, "foreign"); mkdirSync(foreign); native(foreign, "init", "-q"); writeFileSync(path.join(foreign, "x"), "x"); native(foreign, "add", "."); native(foreign, "commit", "-qm", "foreign");
    f.session.setWorkspace({ repos: [{ alias: "app", worktree: foreign, branch: null, baseCommit: null, head: native(foreign, "rev-parse", "HEAD").trim() }] });
    const before = snapshot(f);
    await expect(deleteProject(sy!, "beta", { confirm: "beta" })).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(snapshot(f)).toEqual(before); expect(existsSync(path.join(foreign, ".git", "meritrouter-mutation.lock"))).toBe(false);
  });

  it("deletes confirmed local data and keeps source branches and global accounting", async () => {
    const f = await fixture(), source = native(env!.repo, "rev-parse", "HEAD"), paid = sy!.db.prepare("SELECT * FROM paid_spend").all();
    await git(f.ws.worktreePath, ["branch", "retained-result"]);
    const out = await track(deleteProject(sy!, "beta", { confirm: "beta" }));
    expect(out.removed).toMatchObject({ tasks: 1, sessions: 1, worktrees: 1 }); expect(out.problems).toEqual([]);
    expect(existsSync(f.ws.worktreePath)).toBe(false); expect(sy!.projects.get("beta")).toBeUndefined();
    expect(native(env!.repo, "rev-parse", "HEAD")).toBe(source); expect(native(env!.repo, "show-ref", "--verify", "refs/heads/retained-result")).toBeTruthy();
    expect(sy!.db.prepare("SELECT project_id,status,input_tokens,output_tokens FROM model_requests WHERE id='request_fixture'").get()).toEqual({ project_id: "", status: "succeeded", input_tokens: 3, output_tokens: 4 });
    expect(sy!.db.prepare("SELECT * FROM paid_spend").all()).toEqual(paid); expect(sy!.db.pragma("foreign_key_check")).toEqual([]); expect(f.client.requests).toHaveLength(0);
  }, 90_000);
});
