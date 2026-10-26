import * as gitModule from "../src/workspaces/git.js";
import { integrationTools } from "../src/harness/integration-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { SupervisorState } from "../src/harness/supervisor-tools.js";
import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../src/workspaces/git.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { commitAs } from "../src/attribution/index.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { hydrateRepairWorkspace,resolveRepairSource,verifyRepairHydration } from "../src/workspaces/repair-hydration.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import type { RunContext } from "../src/runners/types.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig,makeEnv,open,ScriptedClient,reply,type Env } from "./helpers.js";
let env:Env|undefined,sy:MeritRouter|undefined;
it("reuses an existing host mutation capability for hydration and verification",async()=>{
 const f=await fixture();
 await withRepositoryMutation([f.ws.worktreePath,f.original.worktreePath],async mutation=>{
   await hydrateRepairWorkspace(f.ctx,f.ws,{mutation});
   await verifyRepairHydration(f.ctx,f.ws,{mutation});
 });
 expect(await git(f.ws.worktreePath,["show","HEAD:ui/page11.tsx"])).toContain("retained");
});
it.each(["source","target"] as const)("refuses pending %s publication before hydration receipts or target writes",async owner=>{
 const f=await fixture();
 const root=owner==="source" ? f.original.worktreePath : f.ws.worktreePath;
 writeFileSync(path.join(root,"pending.txt"),"retained publication");
 const outcome=await commitSelectedApplication(root,{actor:{agent:"implementer:fixture",role:"implementer",model:"fake/model",task:"fixture"},message:"Pending fixture",paths:["pending.txt"]},{refPublished:async()=>{throw Error("retain pending");}});
 expect(outcome.kind).toBe("reconciliation_required");
 const head=await git(f.ws.worktreePath,["rev-parse","HEAD"]);
 const before=sy!.db.prepare("SELECT * FROM events WHERE task_id=? AND type='repair_hydration'").all(f.ctx.taskId);
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toMatchObject({detail:{kind:"pending_publication"}});
 expect(await git(f.ws.worktreePath,["rev-parse","HEAD"])).toBe(head);
 expect(sy!.db.prepare("SELECT * FROM events WHERE task_id=? AND type='repair_hydration'").all(f.ctx.taskId)).toEqual(before);
});
afterEach(async()=>{vi.restoreAllMocks();await sy?.close();sy=undefined;env?.cleanup();env=undefined;});
const limits={maxConcurrent:8,maxWritersPerRepo:8,leaseMs:600000,defaultTimeoutMs:3600000,supervisorProfiles:["supervise"],maxSupervisors:4,supervisorTimeoutMs:3600000};
async function fixture(newer=false,variant="ordinary"){
 const cfg=baseConfig();(cfg.profiles as Record<string,unknown>).supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:40,classify:"never",min_tier:"T3"};
 env=makeEnv({config:cfg});sy=open(env,new ScriptedClient(()=>reply("unused")),{worker:false});
 const [parent]=await sy.submitTasks([{profile:"supervise",goal:"Repair candidate",repositoryAliases:["core"],constraints:{acceptanceCriteria:["working app"]}}]);sy.tasks.claim("parent",limits);
 const parentId=parent!.taskId;
 const spec={profile:"implement",parentTaskId:parentId,goal:"Repair",repositoryAliases:["core"],writableRepository:"core",constraints:{allowedPaths:["ui/**","tests/**"],acceptanceCriteria:["all files"]}};
 const [source]=await sy.submitTasks([{...spec,label:"source"}]);sy.tasks.claim("source",limits);
 if(variant==="rename-target"){
   const {mkdirSync}=await import("node:fs");mkdirSync(path.join(env.repo,"ui"),{recursive:true});
   writeFileSync(path.join(env.repo,"ui/page0.tsx"),Array.from({length:40},(_,i)=>`export const stable${i}="baseline${i}";`).join("\n")+"\n");
   await commitAs(env.repo,{agent:"implementer:seed",role:"implementer",model:"fake/model",task:"seed"},"Base source file");
 }
 const base=(await git(env.repo,["rev-parse","HEAD"])).trim();
 const wt=new Worktrees(sy.db,path.join(env.cfg.storageDir,"worktrees"));
 const original=await wt.prepare({taskId:source!.taskId,run:1,alias:"core",sourcePath:env.repo,baseCommit:base});
 const {mkdirSync}=await import("node:fs");mkdirSync(path.join(original.worktreePath,"ui"),{recursive:true});
 for(let i=0;i<(variant==="rename-target" ? 1 : 12);i++)writeFileSync(path.join(original.worktreePath,`ui/page${i}.tsx`),variant==="rename-target" ? Array.from({length:40},(_,line)=>`export const stable${line}="${line===20 ? "changed" : `baseline${line}`}";`).join("\n")+"\n" : `export const page${i} = "retained";\n`);
 if(variant==="oversize")writeFileSync(path.join(original.worktreePath,"ui/page0.tsx"),"x".repeat(9*1024*1024));
 let head=(await commitAs(original.worktreePath,{agent:"implementer:source",role:"implementer",model:"fake/model",task:source!.taskId,job:parentId},"UI candidate"))!;
 if(variant==="transient-large"){
   const file=path.join(original.worktreePath,"ui/transient.ts");
   writeFileSync(file,"x".repeat(4.5*1024*1024));
   await commitAs(original.worktreePath,{agent:"implementer:source",role:"implementer",model:"fake/model",task:source!.taskId},"Large temporary addition");
   const {unlinkSync}=await import("node:fs");unlinkSync(file);
   head=(await commitAs(original.worktreePath,{agent:"implementer:source",role:"implementer",model:"fake/model",task:source!.taskId},"Revert large addition"))!;
 }
 if(variant==="merge"){const old=head;head=(await git(original.worktreePath,["commit-tree",(await git(original.worktreePath,["rev-parse","HEAD^{tree}"])).trim(),"-p",head,"-p",base,"-m",`Merge\n\nAgent: implementer:source\nModel: fake/model\nTask: ${source!.taskId}`],{env:{GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@test",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@test"}})).trim();await git(original.worktreePath,["update-ref","HEAD",head,old]);}
 const session=sy.sessions.create({taskId:source!.taskId,jobId:parentId,role:"implementer",agentLabel:"implementer:source",profile:"implement",tier:"T2"});session.setWorkspace({repos:[{alias:"core",worktree:original.worktreePath,branch:null,baseCommit:base,head}]});session.end("failed","budget_exhausted");
 const failed=syntheticResult(source!.taskId,"budget_exhausted","budget_exhausted");failed.acceptanceStatus="unmet";sy.tasks.finish(source!.taskId,"source",failed,"budget_exhausted");
 const controller=new AbortController();
 const parentCtx={spec:sy.tasks.get(parentId)!.spec,services:{getTask:(id:string)=>{const t=sy!.tasks.get(id);return t ? {spec:t.spec,state:t.row.state,result:t.result}:null;}},taskId:parentId,taskLease:capturedLease(sy.tasks.get(parentId)!),cfg:env.cfg,tasks:sy.tasks,artifacts:sy.artifacts,now:Date.now,signal:controller.signal} as RunContext;
 const descriptor=await resolveRepairSource(parentCtx,source!.taskId,"core",spec.constraints,parentId);
 let current=base;
 if(variant==="rename-target"){
   mkdirSync(path.join(env.repo,"outside"),{recursive:true});
   const {renameSync}=await import("node:fs");renameSync(path.join(env.repo,"ui/page0.tsx"),path.join(env.repo,"outside/page0.tsx"));
   current=(await commitAs(env.repo,{agent:"implementer:rename",role:"implementer",model:"fake/model",task:"rename"},"Move base file outside repair scope"))!;
 }
 if(newer){writeFileSync(path.join(env.repo,"api.txt"),"newer API\n");current=(await commitAs(env.repo,{agent:"implementer:api",role:"implementer",model:"fake/model",task:"api"},"API"))!;}
 const [repair]=await sy.submitTasks([{...spec,label:"repair",context:{baseCommits:{core:current},repairSource:descriptor}}]);sy.tasks.claim("repair",limits);
 const ctx={...parentCtx,taskId:repair!.taskId,taskLease:capturedLease(sy.tasks.get(repair!.taskId)!),spec:sy.tasks.get(repair!.taskId)!.spec} as RunContext;
 const ws=await wt.prepare({taskId:repair!.taskId,run:1,alias:"core",sourcePath:env.repo,baseCommit:current});
 return {ctx,parentCtx,source:source!.taskId,original,ws,wt,base,current,descriptor,controller};
}
it.each([false,true])("hydrates all12 inherited files and keeps integration base/new API (%s)",async(newer)=>{
 const f=await fixture(newer);await hydrateRepairWorkspace(f.ctx,f.ws);
 expect(f.ws.baseSha).toBe(f.current);await verifyRepairHydration(f.ctx,f.ws);
 writeFileSync(path.join(f.ws.worktreePath,"ui/page0.tsx"),'export const page0 = "fixed import";\n');
 await commitAs(f.ws.worktreePath,{agent:"implementer:repair",role:"implementer",model:"fake/repair",task:f.ctx.taskId},"Fix one import");
 const changes=await f.wt.collect(f.ws,["ui/**"],[]);expect(changes.changed).toHaveLength(12);
 const commits=(await git(f.ws.worktreePath,["rev-list","--reverse",`${f.current}..HEAD`])).trim().split("\n");expect(commits).toHaveLength(2);
 const result=syntheticResult(f.ctx.taskId,"completed","worker_submitted");result.acceptanceStatus="met";result.scopeViolation=[];result.protectedPathsChanged=[];
 sy!.tasks.finish(f.ctx.taskId,"repair",result,"completed");
 const repo={alias:"core",worktree:env!.repo,branch:(await git(env!.repo,["symbolic-ref","--short","HEAD"])).trim(),baseSha:f.current};
 const state={ctx:f.parentCtx,db:sy!.db,actor:{agent:"supervisor:fixture",role:"supervisor"},repos:new Map([["core",repo]]),briefChecks:new Set(),children:new Map([["repair",f.ctx.taskId]])} as SupervisorState;
 const seam={ownTask:(ref:unknown)=>{if(ref!==f.ctx.taskId)throw Error("not owned");return f.ctx.taskId;},repoFor:()=>repo,identity:()=>({kind:"supervisor" as const,id:f.ctx.spec.parentTaskId!}),redelegate:async()=>null};
 expect(await integrationTools(state,seam)[0]!.run({task_id:f.ctx.taskId},{ctx:f.parentCtx} as HarnessEnv)).toContain("integrated");
 expect(await git(env!.repo,["show","HEAD:ui/page11.tsx"])).toContain("retained");
 expect(await git(env!.repo,["show","HEAD:ui/page0.tsx"])).toContain("fixed import");
 if(newer)expect(await git(env!.repo,["show","HEAD:api.txt"])).toContain("newer API");
 expect(await git(env!.repo,["log","--format=%B",`${f.current}..HEAD`])).toContain(`Task: ${f.source}`);
 expect(sy!.tasks.get(f.source)!.result!.acceptanceStatus).toBe("unmet");
});
it("refuses a changed source head and an inherited scope narrowing",async()=>{
 const f=await fixture();await expect(resolveRepairSource(f.parentCtx,f.source,"core",{allowedPaths:["ui/page0.tsx"]},f.ctx.spec.parentTaskId!)).rejects.toThrow(/scope/);
 writeFileSync(path.join(f.original.worktreePath,"ui/page0.tsx"),"changed");await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/dirty/);
});
it("refuses partial/crashed receipt without replay",async()=>{
 const f=await fixture();sy!.tasks.event(f.ctx.taskId,"repair_hydration",{status:"started",digest:"0".repeat(64),worktree:f.ws.worktreePath,base:f.ws.baseSha});
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/incomplete/);
 expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(f.current);
});
it("cancellation refuses hydration before effects",async()=>{
 const f=await fixture();f.controller.abort("cancel");await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/aborted/);
 expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(f.current);
});
it("completed hydration resume is idempotent",async()=>{
 const f=await fixture();await hydrateRepairWorkspace(f.ctx,f.ws);const before=await git(f.ws.worktreePath,["rev-parse","HEAD"]);
 await hydrateRepairWorkspace(f.ctx,f.ws);expect(await git(f.ws.worktreePath,["rev-parse","HEAD"])).toBe(before);
});

it.each(["foreign-parent","foreign-project","active","lab","changed-head","merge-active","unfinished-effect"])("refuses %s source before mutation",async(condition)=>{
 const f=await fixture();
 const t=sy!.tasks.get(f.source)!;
 if(condition==="foreign-parent"||condition==="lab") {const spec={...t.spec,...(condition==="foreign-parent"?{parentTaskId:"foreign"}:{lab:"example"})};sy!.db.prepare("UPDATE tasks SET spec_json=? WHERE id=?").run(JSON.stringify(spec),f.source);}
 if(condition==="foreign-project")sy!.db.prepare("UPDATE tasks SET project_id='foreign' WHERE id=?").run(f.source);
 if(condition==="active")sy!.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.source);
 if(condition==="changed-head"){writeFileSync(path.join(f.original.worktreePath,"ui/page0.tsx"),"changed");await commitAs(f.original.worktreePath,{agent:"implementer:source",role:"implementer",model:"fake/model",task:f.source},"Later unproven change");}
 if(condition==="merge-active"){const {MergeQueue}=await import("../src/workspaces/merge-queue.js");new MergeQueue(sy!.db,sy!.tasks,"fixture").enqueue({jobId:f.ctx.spec.parentTaskId!,taskId:f.source,kind:"task",repo:"core",branch:"main",integrationWorktree:env!.repo,sourceWorktree:f.original.worktreePath,sourceBase:f.base,sourceHead:f.descriptor.head,commits:f.descriptor.commits,acceptance:null});}
 if(condition==="unfinished-effect"){const session=sy!.sessions.forTask(f.source).at(-1)!;const {appendFileSync}=await import("node:fs");appendFileSync(session.logPath,JSON.stringify({seq:session.lastSeq+1,at:Date.now(),type:"tool_intent",data:{callId:"unfinished",name:"apply_edits",args:{},sideEffect:"edit",idempotent:false}})+"\n");}
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow();
 expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(f.current);
});
it("retains protected inherited file detection and refuses cancelled partial replay",async()=>{
 const f=await fixture();const original=gitModule.git;
 vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,opts)=>{const result=await original(cwd,args,opts);if(args[0]==="cherry-pick")f.controller.abort("cancel");return result;});
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/aborted/);
 await expect(verifyRepairHydration(f.ctx,f.ws)).rejects.toThrow(/incomplete/);
 const changes=await f.wt.collect(f.ws,["ui/**"],["ui/page0.tsx"]);expect(changes.protectedChanged).toEqual(["ui/page0.tsx"]);
});

it.each(["merge","oversize"])("refuses bounded source variant %s",async(variant)=>{
 await expect(fixture(false,variant)).rejects.toThrow();
});
it("a conflict leaves a typed failed receipt and no resumable model workspace",async()=>{
 const f=await fixture();const original=gitModule.git;
 vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,opts)=>{if(args[0]==="cherry-pick")throw Error("fixture conflict");return original(cwd,args,opts);});
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/conflict/);
 await expect(verifyRepairHydration(f.ctx,f.ws)).rejects.toThrow(/incomplete/);
 expect((await original(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(f.current);
});
it.each(["running","uncertain"])("refuses unquiesced %s source action",async(status)=>{
 const f=await fixture();const t=sy!.tasks.get(f.source)!;
 const action={id:"fixture-unquiesced",project:t.row.project_id,taskId:f.source,status,action:{command:"npm test",cwd:f.original.worktreePath,timeoutMs:300000,reason:"fixture source command",source:"0".repeat(64),lease:{taskId:f.source,owner:"fixture",runCount:1,project:t.row.project_id,incarnation:t.row.lease_incarnation},jobId:f.ctx.spec.parentTaskId!},decisionReason:null,decidedBy:null,output:null,exitCode:null,createdAt:Date.now()};
 sy!.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(action.id,t.row.project_id,f.source,action.id,JSON.stringify(action),Date.now());
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/quiescent/);
 expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(f.current);
});

it("refuses source edit following a newer target rename outside repair scope",async()=>{
 const f=await fixture(false,"rename-target");
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/hydrated target path outside scope: outside\/page0.tsx/);
 await expect(verifyRepairHydration(f.ctx,f.ws)).rejects.toThrow(/incomplete/);
 const receipts=sy!.tasks.events(f.ctx.taskId,100).filter(e=>e.type==="repair_hydration");
 expect(receipts.map(e=>(e.data as {status:string}).status)).toEqual(["started","failed"]);
});
it("refuses cumulative add-and-revert patch bytes despite a small final net diff",async()=>{
 await expect(fixture(false,"transient-large")).rejects.toThrow();
});
it("rechecks source authority after the final awaited cherry-pick",async()=>{
 const f=await fixture();const original=gitModule.git;
 vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,opts)=>{
   const output=await original(cwd,args,opts);
   if(args[0]==="cherry-pick")sy!.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.source);
   return output;
 });
 await expect(hydrateRepairWorkspace(f.ctx,f.ws)).rejects.toThrow(/source became active/);
 await expect(verifyRepairHydration(f.ctx,f.ws)).rejects.toThrow(/incomplete/);
});
it("resumes a completed hydration after a repair commit under a fresh lease without replay",async()=>{
 const f=await fixture();await hydrateRepairWorkspace(f.ctx,f.ws);
 writeFileSync(path.join(f.ws.worktreePath,"ui/page0.tsx"),'export const page0="fixed";\n');
 const head=(await commitAs(f.ws.worktreePath,{agent:"implementer:repair",role:"implementer",model:"fake/model",task:f.ctx.taskId},"Repair after hydration"))!;
 const before=f.ctx.taskLease!.runCount;
 expect(sy!.tasks.interrupt(f.ctx.taskId,"repair","fixture restart")).toBe(true);
 sy!.tasks.resume(f.ctx.taskId);sy!.tasks.claim("repair-resumed",limits);
 f.ctx.taskLease=capturedLease(sy!.tasks.get(f.ctx.taskId)!);
 expect(f.ctx.taskLease.runCount).toBe(before+1);
 const {resumeWorkspace}=await import("../src/runners/coding/finish.js");
 const resumed=await resumeWorkspace(f.ctx,{repos:[{alias:"core",worktree:f.ws.worktreePath,branch:null,baseCommit:f.ws.baseSha,head}]});
 expect(resumed!.head).toBe(head);
 await hydrateRepairWorkspace(f.ctx,f.ws);
 expect((await git(f.ws.worktreePath,["rev-parse","HEAD"])).trim()).toBe(head);
});
