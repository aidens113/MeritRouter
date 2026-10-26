import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { repoTools, type HarnessEnv } from "../src/harness/tools.js";
import { delegatedSourceSnapshot } from "../src/harness/delegated-source.js";
import { loadSources, readersFor } from "../src/context/sources.js";
import { git } from "../src/workspaces/git.js";
import * as safeGit from "../src/workspaces/git.js";
import * as staffing from "../src/routing/staffing.js";
import { Worktrees } from "../src/workspaces/worktree.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const sourcePath = "app/api/posts/route.ts";
async function fixture() {
  const base=baseConfig();
  env=makeEnv({ files:{"placeholder.txt":"initial"},config:{...base,profiles:{...base.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:100,classify:"never",min_tier:"T3"}}} });
  unlinkSync(path.join(env.repo,"placeholder.txt"));commitAll(env.repo,"Empty canonical tree");
  const client=new ScriptedClient(()=>{throw new Error("No model requests allowed");});
  sy=open(env,client,{worker:false});
  const [submitted]=await sy.submitTasks([{profile:"supervise",goal:"Inspect integrated source",repositoryAliases:["core"],constraints:{acceptanceCriteria:["correct source"]}}]);
  const id=submitted!.taskId,baseSha=(await git(env.repo,["rev-parse","HEAD"])).trim();
  const ws=await new Worktrees(sy.db,path.join(env.cfg.storageDir,"worktrees")).prepare({taskId:id,run:1,alias:"core",sourcePath:env.repo,baseCommit:baseSha});
  await git(ws.worktreePath,["switch","-c",`parent-${id}`]);
  mkdirSync(path.join(ws.worktreePath,"app/api/posts"),{recursive:true});writeFileSync(path.join(ws.worktreePath,sourcePath),"export const subject = 'parent-v1';\n");
  commitAll(ws.worktreePath,"Integrated parent source");
  const head=(await git(ws.worktreePath,["rev-parse","HEAD"])).trim(),branch=(await git(ws.worktreePath,["symbolic-ref","--short","HEAD"])).trim();
  const ctx={taskId:id,spec:sy.tasks.get(id)!.spec,tasks:sy.tasks,cfg:sy.cfg,gate:sy.gate,now:Date.now,signal:new AbortController().signal,budget:{maxModelRequests:100},artifacts:sy.artifacts,
    services:{submitTasks:sy.submitTasks.bind(sy),getTask:(taskId:string)=>{const t=sy!.tasks.get(taskId);return t?{spec:t.spec,state:t.row.state,result:t.result}:null;}}} as unknown as RunContext;
  const state:SupervisorState={ctx,db:sy.db,actor:{agent:"supervisor:fixture",role:"supervisor",task:id,job:id},repos:new Map([["core",{alias:"core",worktree:ws.worktreePath,branch,baseSha}]]),briefChecks:new Set(),children:new Map()};
  const harness={ctx,role:"supervisor",readers:new Map(),edits:new Set()} as unknown as HarnessEnv;
  const tools=supervisorTools(state);
  const run=(name:string,args:Record<string,unknown>)=>tools.find(t=>t.def.function.name===name)!.run(args,harness);
  const brief=(profile="inspect")=>({label:`source-${profile}`,profile,goal:"Inspect parent API",repositories:["core"],file_refs:[`core:${sourcePath}`],acceptance_criteria:["parent source observed"],max_requests:10});
  return {ctx,state,run,head,branch,ws,brief,client};
}

it.each(["inspect","review"])("delegates %s and explicit file context from the parent's committed snapshot without touching canonical",async profile=>{
  const f=await fixture();
  const result=await f.run("plan_work",{nodes:[f.brief(profile)]});
  expect(result).toContain("1 dispatched now");
  const child=sy!.tasks.childrenOf(f.ctx.taskId)[0]!;
  expect(child.spec.context.baseCommits).toEqual({core:f.head});
  const sources=await loadSources(sy!.cfg,child.spec,sy!.artifacts);
  expect(sources[0]).toMatchObject({commit:f.head,dirty:false});expect(sources[0]!.text).toContain("parent-v1");
  const readers=readersFor(sy!.cfg,child.spec),h={readers,ctx:{...f.ctx,spec:child.spec},universe:{refs:new Map()}} as unknown as HarnessEnv;
  const tools=repoTools(child.spec.repositoryAliases),call=(name:string,args:Record<string,unknown>)=>tools.find(t=>t.def.function.name===name)!.run(args,h);
  expect(await call("list_files",{alias:"core"})).toContain(sourcePath);
  expect(await call("read_file",{alias:"core",path:sourcePath})).toContain("parent-v1");
  expect(await call("search",{alias:"core",pattern:"parent-v1"})).toContain(sourcePath);
  await expect(call("read_file",{alias:"foreign",path:sourcePath})).rejects.toThrow(/unknown alias/);
  await expect(call("read_file",{alias:"core",path:"../outside-secret"})).rejects.toThrow(/escapes|reserved filesystem syntax/);
  expect(readdirSync(env!.repo)).toEqual([".git"]);expect(await git(env!.repo,["status","--porcelain"])).toBe("");
  expect(f.client.requests).toHaveLength(0);
});

it("uses one snapshot for staffing and dispatch even when the parent advances between them",async()=>{
  const f=await fixture(),original=staffing.rulebookTier;
  vi.spyOn(staffing,"rulebookTier").mockImplementation(async(cfg,brief,artifacts)=>{
    expect(brief.context?.baseCommits).toEqual({core:f.head});
    const result=await original(cfg,brief,artifacts);
    writeFileSync(path.join(f.ws.worktreePath,sourcePath),"export const subject = 'parent-v2';\n");commitAll(f.ws.worktreePath,"Parent advanced during staffing");
    return result;
  });
  await f.run("plan_work",{nodes:[f.brief()]});
  const child=sy!.tasks.childrenOf(f.ctx.taskId)[0]!;
  expect(child.spec.context.baseCommits?.core).toBe(f.head);
  expect((await readersFor(sy!.cfg,child.spec).get("core")!.readFile(sourcePath)).content).toContain("parent-v1");
  expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).not.toBe(f.head);
  expect(f.client.requests).toHaveLength(0);
  await expect(f.run("plan_work",{nodes:[f.brief()]})).resolves.toContain("0 dispatched now");
  expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(1);
  expect(sy!.tasks.childrenOf(f.ctx.taskId)[0]!.spec.context.baseCommits?.core).toBe(f.head);
});

it("pins direct delegate and keeps coding base behavior",async()=>{
  const f=await fixture();
  await f.run("delegate",{tasks:[f.brief()]});
  await f.run("delegate",{tasks:[{...f.brief("implement"),allowed_paths:["app/api/**"],difficulty:"T2"}]});
  for(const task of sy!.tasks.childrenOf(f.ctx.taskId))expect(task.spec.context.baseCommits).toEqual({core:f.head});
});

it.each(["missing","alias","branch","foreign","linked-foreign","dirty","project"])("refuses %s parent source before a child or grant",async condition=>{
  const f=await fixture(),repo=f.state.repos.get("core")!;
  if(condition==="missing")f.state.repos.clear();
  if(condition==="alias")repo.alias="foreign";
  if(condition==="branch")repo.branch="wrong-branch";
  if(condition==="dirty")writeFileSync(path.join(f.ws.worktreePath,"uncommitted.txt"),"not in committed source");
  if(condition==="project")f.ctx.taskProject="foreign";
  if(condition==="foreign"||condition==="linked-foreign"){
    const foreign=path.join(env!.dir,"foreign");mkdirSync(foreign);execFileSync("git",["init","-q","-b","main"],{cwd:foreign});writeFileSync(path.join(foreign,"secret.txt"),"foreign source secret");commitAll(foreign);
    repo.worktree=foreign;repo.branch="main";
    if(condition==="linked-foreign"){const linked=path.join(env!.dir,"linked-foreign");symlinkSync(foreign,linked,"junction");repo.worktree=linked;}
  }
  const before=sy!.tasks.childrenOf(f.ctx.taskId).length;
  await expect(f.run("delegate",{tasks:[f.brief()]})).rejects.toThrow(/delegated_source_(refused|dirty)/);
  expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(before);
  expect(sy!.db.prepare("SELECT COUNT(*) FROM task_request_grants").pluck().get()).toBe(0);
  expect(f.client.requests).toHaveLength(0);
});

it("rejects widened aliases and wrong-alias file references without adding source permissions",async()=>{
  const f=await fixture();
  await expect(f.run("plan_work",{nodes:[{...f.brief(),repositories:["foreign"]}]})).rejects.toThrow(/parent repository scope/);
  await expect(f.run("delegate",{tasks:[{...f.brief(),file_refs:["foreign:secret.txt"]}]})).rejects.toThrow(/not in repositoryAliases/);
  expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(0);expect(f.client.requests).toHaveLength(0);
});

it("retains an explicitly declared read-only parent source without inventing a writable worktree",async()=>{
  const f=await fixture();f.ctx.cfg.repositoryPaths.core!.writable=false;f.state.repos.clear();f.ctx.spec.context.baseCommits={core:f.head};
  const snapshot=await delegatedSourceSnapshot(f.ctx,f.state.repos,["core"]);
  expect(snapshot).toEqual({core:f.head});
  const readers=readersFor(sy!.cfg,{...f.ctx.spec,context:{baseCommits:snapshot}});
  expect((await readers.get("core")!.readFile(sourcePath)).content).toContain("parent-v1");
});

it("refuses parent HEAD changing while the snapshot fence is checked",async()=>{
  const f=await fixture(),original=safeGit.git;let changed=false;
  vi.spyOn(safeGit,"git").mockImplementation(async(root,args,opts)=>{
    const result=await original(root,args,opts);
    if(root===f.ws.worktreePath&&args[0]==="rev-parse"&&args.includes("HEAD^{commit}")&&!changed){changed=true;writeFileSync(path.join(root,sourcePath),"export const raced = true;\n");commitAll(root,"Raced source HEAD");}
    return result;
  });
  await expect(delegatedSourceSnapshot(f.ctx,f.state.repos,["core"])).rejects.toThrow(/HEAD changed/);
});
