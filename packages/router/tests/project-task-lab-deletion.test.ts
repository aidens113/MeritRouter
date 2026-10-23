import { afterEach, expect, it } from "vitest";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { deleteProject, previewProjectDeletion } from "../src/admin/insights.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, commitAll, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
async function retained() {
  const node = JSON.stringify(process.execPath);
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" },
    projects: { alpha: { repositories: { app: { path: "repo" } } }, beta: {
      repositories: { app: { path: "repo" } }, labs: { ephemeral: { enabled: true, checks: ["health"] } },
      lab: { checks: { health: `${node} -e "process.exit(0)"` } }
    } } }), files: { "value.txt": "before" } });
  sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const taskId = "delete_lab_task";
  sy.tasks.submit([WorkerTaskSchema.parse({ id: taskId, profile: "implement", goal: "change fixture", repositoryAliases: ["app"], writableRepository: "app", constraints: { allowedPaths: ["value.txt"], acceptanceCriteria: ["changed"] } })], { project: "beta" });
  sy.db.prepare("UPDATE tasks SET state='running',lease_owner='fixture',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id=?").run(Date.now()+120000,Date.now()+120000,taskId);
  const base = (await git(env.repo,["rev-parse","HEAD"])).trim();
  const workspace = await new Worktrees(sy.db,path.join(env.cfg.storageDir,"worktrees")).prepare({ taskId, run:1, alias:"app",sourcePath:env.repo,baseCommit:base });
  writeFileSync(path.join(workspace.worktreePath,"value.txt"),"after");
  commitAll(workspace.worktreePath,`fixture change\n\nAgent: fixture\nModel: fake/model\nTask: ${taskId}`);
  const commit=(await git(workspace.worktreePath,["rev-parse","HEAD"])).trim(),tree=(await git(workspace.worktreePath,["rev-parse","HEAD^{tree}"])).trim();
  sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('exec-delete','task','implement','running',1)").run();
  sy.db.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES ('exec-delete',?,?)").run(taskId,taskId);
  sy.db.prepare("INSERT INTO sessions(id,task_id,role,agent_label,profile,status,log_path,workspace_json,created_at,updated_at,project_id) VALUES ('session-delete',?,'implementer','fixture','implement','running','sessions/session-delete.jsonl',?,1,1,'beta')").run(taskId,JSON.stringify({repos:[{alias:"app",worktree:workspace.worktreePath,branch:null,baseCommit:base,head:commit}]}));
  const handle=await sy.labs.taskAttempts.register({taskId,project:"beta",runCount:1,leaseOwner:"fixture",executionId:"exec-delete",sessionId:"session-delete",sourceWorktree:workspace.worktreePath,writableAlias:"app",repositories:[{alias:"app",sourcePath:env.repo,baseCommit:base,head:commit}]});
  const patchDigest=createHash("sha256").update(await git(workspace.worktreePath,["diff","--binary",base,commit])).digest("hex");
  await sy.labs.taskAttempts.submit(handle,{commit,tree,patchDigest});
  const op=sy.labs.taskAttempts.requestCheck(handle,{checks:["health"]}); await sy.labs.processControls();
  const result=await sy.labs.taskAttempts.wait(handle,op.id); expect(result.status).toBe("passed"); expect(result.cleanup).toBe("complete");
  sy.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(taskId);
  return { taskId, lab:sy.labs.store.byId(result.labId)!,source:workspace.worktreePath,commit };
}
it("confirmed project deletion immediately removes owned stopped task Labs and preserves repository branches",async()=>{
  const f=await retained(); expect(await sy!.labs.taskAttempts.prune()).toEqual([]);
  const preview=await previewProjectDeletion(sy!,"beta"); expect(preview.blockers).toEqual([]); expect(preview.removes.join(" ")).toContain("Stopped task verification Labs");
  const result=await deleteProject(sy!,"beta",{confirm:"beta"}); expect(result.problems).toEqual([]);
  expect(existsSync(f.lab.root)).toBe(false); expect(existsSync(f.source)).toBe(false); expect(sy!.tasks.get(f.taskId)).toBeUndefined();
  expect(sy!.db.prepare("SELECT 1 FROM task_lab_operations").get()).toBeUndefined();
  expect(existsSync(env!.repo)).toBe(true); expect((await git(env!.repo,["show-ref","--verify",`refs/heads/${f.lab.repositories[0]!.branch}`])).trim()).toContain(f.commit);
  expect(sy!.db.pragma("foreign_key_check")).toEqual([]);
},60000);
it("dirty task Lab blocks deletion with config and recovery evidence retained",async()=>{
  const f=await retained(), original=readFileSync(env!.cfg.configPath,"utf8");
  writeFileSync(path.join(f.lab.repositories[0]!.worktree,"value.txt"),"private uncommitted change");
  await expect(deleteProject(sy!,"beta",{confirm:"beta"})).rejects.toThrow("could not be proved safe");
  expect(readFileSync(env!.cfg.configPath,"utf8")).toBe(original); expect(existsSync(f.lab.root)).toBe(true); expect(sy!.tasks.get(f.taskId)).toBeDefined();
  expect(readFileSync(path.join(f.lab.repositories[0]!.worktree,"value.txt"),"utf8")).toBe("private uncommitted change");
},60000);


it("preview and confirmation refuse an unresolved active task Lab before cleanup",async()=>{
  const f=await retained(),original=readFileSync(env!.cfg.configPath,"utf8");
  sy!.db.prepare("UPDATE labs SET state='running' WHERE id=?").run(f.lab.id);
  expect((await previewProjectDeletion(sy!,"beta")).blockers.join(" ")).toContain("unresolved lab");
  await expect(deleteProject(sy!,"beta",{confirm:"beta"})).rejects.toThrow("finish owned task-Lab cleanup");
  expect(readFileSync(env!.cfg.configPath,"utf8")).toBe(original); expect(existsSync(f.lab.root)).toBe(true);
  sy!.db.prepare("UPDATE labs SET state='stopped' WHERE id=?").run(f.lab.id);
},60000);
