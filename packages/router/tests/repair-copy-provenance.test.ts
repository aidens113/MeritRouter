import path from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema, type RepairSource } from "../src/core/task.js";
import { Worktrees, type Workspace } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { commitAs } from "../src/attribution/index.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { hydrateRepairWorkspace, resolveRepairSource, verifyRepairHydration } from "../src/workspaces/repair-hydration.js";
import { repairSourceDigest } from "../src/workspaces/repair-copy-provenance.js";
import type { RunContext } from "../src/runners/types.js";
import type { ModelEndpoint } from "../src/models/catalog.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async()=>{await sy?.close();sy=undefined;env?.cleanup();env=undefined;});
const limits={maxConcurrent:10,maxWritersPerRepo:10,leaseMs:600000,defaultTimeoutMs:3600000,supervisorProfiles:["supervise"],maxSupervisors:4,supervisorTimeoutMs:3600000};
const constraints={allowedPaths:["src/**"],acceptanceCriteria:["fixture"]};

async function fixture() {
 env=makeEnv();sy=open(env,new ScriptedClient(()=>{throw Error("No provider calls allowed");}));
 const submit=(id:string,profile="implement",repairSource?:RepairSource)=>sy!.tasks.submit([WorkerTaskSchema.parse({id,profile,goal:id,repositoryAliases:["core"],...(profile==="implement"?{parentTaskId:"job",writableRepository:"core"}:{}),constraints,...(repairSource?{context:{repairSource}}:{})})],{project:env!.cfg.brain.project});
 submit("job","supervise");sy.tasks.claim("job-owner",limits);
 const parent=sy.tasks.get("job")!;
 const parentCtx={cfg:env.cfg,tasks:sy.tasks,artifacts:sy.artifacts,taskId:"job",taskLease:capturedLease(parent),spec:parent.spec,signal:new AbortController().signal,now:Date.now} as RunContext;
 submit("source");sy.tasks.claim("source-owner",limits);const task=sy.tasks.get("source")!;
 const wt=new Worktrees(sy.db,path.join(env.cfg.storageDir,"worktrees"));
 const original=await wt.prepare({taskId:"source",run:1,alias:"core",sourcePath:env.repo});
 const actor={agent:"implementer:source",role:"implementer",task:"source",job:"job",tier:"T2"};
 const session=sy.sessions.create({taskId:"source",jobId:"job",role:"implementer",agentLabel:actor.agent,profile:"implement",tier:"T2"});
 const workspace={alias:"core",worktree:original.worktreePath,baseCommit:original.baseSha,head:original.baseSha,branch:null};session.setWorkspace({repos:[workspace]});
 const args={path:"src/recovered.ts",content:"export const recovered = true;\n"},call={id:"original-write",type:"function" as const,function:{name:"write_file",arguments:JSON.stringify(args)}};
 const executionId=sy.admission.createExecution("task","implement",[{taskId:"source",itemId:"source"}]);
 session.syncMessages([{role:"user",content:"Original source"}]);session.modelRequest({executionId,purpose:"coding",chat:{messages:[{role:"user",content:"Original source"}],max_tokens:1000}});
 session.modelResponse({requestId:"origin-request",endpoint:{id:"fixture/original"} as ModelEndpoint,estimatedInputTokens:10,attempts:[],response:reply(null,{model:"original",provider:"fixture",toolCalls:[call]})});
 const intent=session.toolIntent({callId:call.id,name:"write_file",args,sideEffect:"edit"});writeFileSync(path.join(original.worktreePath,args.path),args.content);session.toolOutcome(intent,{ok:true,output:"wrote original source"});
 sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,endpoint_id,served_model,served_provider,project_id) VALUES('origin-request',?,'coding','fixture/original','succeeded',?,10,1000,'fixture/original','original','fixture',?)").run(executionId,Date.now(),task.row.project_id);
 sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,run_count,lease_incarnation) VALUES('origin-request','source',10,20,1,?)").run(task.row.lease_incarnation);
 const originCommit=(await commitAs(original.worktreePath,actor,"implementer: recovered edits after interruption"))!;
 session.setWorkspace({repos:[{...workspace,head:originCommit}]});session.end("failed","deadline_exceeded");sy.tasks.finish("source","source-owner",syntheticResult("source","failed","deadline_exceeded"),"failed");
 const inspect={project:task.row.project_id,taskId:"source",alias:"core",commit:originCommit},proof=await sy.inspectRecoveredEditProvenance(inspect);
 await sy.attestRecoveredEditProvenance({...inspect,operationId:"fixture-origin",expectedDigest:proof.digest,reason:"Fixture exact original proof"});
 const descriptor=await resolveRepairSource(parentCtx,"source","core",constraints,"job");
 const create=async(id:string,source:RepairSource)=>{
  submit(id,"implement",source);sy!.tasks.claim(`${id}-owner`,limits);
  const target=sy!.tasks.get(id)!,ws=await wt.prepare({taskId:id,run:1,alias:"core",sourcePath:env!.repo});
  const ctx={...parentCtx,taskId:id,taskLease:capturedLease(target),spec:target.spec} as RunContext;
  return {id,ws,ctx,source};
 };
 const finish=(target:Awaited<ReturnType<typeof create>>,head:string)=>{
  const s=sy!.sessions.create({taskId:target.id,jobId:"job",role:"implementer",agentLabel:`implementer:${target.id}`,profile:"implement",tier:"T2"});
  s.setWorkspace({repos:[{alias:"core",worktree:target.ws.worktreePath,baseCommit:target.ws.baseSha,head,branch:null}]});s.end("failed","deadline_exceeded");
  sy!.tasks.finish(target.id,`${target.id}-owner`,syntheticResult(target.id,"failed","deadline_exceeded"),"failed");return s;
 };
 const legacyCopy=async(id:string,source:RepairSource)=>{
  const target=await create(id,source),receipt={digest:repairSourceDigest(source),worktree:target.ws.worktreePath,base:target.ws.baseSha};
  sy!.tasks.event(id,"repair_hydration",{...receipt,status:"started"});
  for(const commit of source.commits)await git(target.ws.worktreePath,["cherry-pick","-x","--allow-empty",commit],{env:{GIT_COMMITTER_NAME:"Fixture old hydration",GIT_COMMITTER_EMAIL:"fixture@test"}});
  const head=(await git(target.ws.worktreePath,["rev-parse","HEAD"])).trim(),tree=(await git(target.ws.worktreePath,["rev-parse",`${head}^{tree}`])).trim();
  sy!.tasks.event(id,"repair_hydration",{...receipt,status:"completed",head,tree});
  const author=finish(target,head);return {...target,head,tree,author};
 };
 return {parentCtx,wt,original,originCommit,inspect,proof,descriptor,create,finish,legacyCopy};
}

it("accepts an already-created failed legacy copy and creates its next repair with original Model/Request before publication",async()=>{
 const f=await fixture(),oldBytes=await git(f.original.worktreePath,["cat-file","commit",f.originCommit]);
 const a=await f.legacyCopy("copy-a",f.descriptor),copyBytes=await git(a.ws.worktreePath,["cat-file","commit",a.head]);
 const source=await resolveRepairSource(f.parentCtx,a.id,"core",constraints,"job");
 const b=await f.create("copy-b",source),before=sy!.db.prepare("SELECT * FROM request_charges").all();
 await hydrateRepairWorkspace(b.ctx,b.ws);await verifyRepairHydration(b.ctx,b.ws);
 const message=await git(b.ws.worktreePath,["show","-s","--format=%B","HEAD"]);
 expect(message).toContain("Model: fixture/original");expect(message).toContain("Request: origin-request");expect(message).toContain("Task: source");
 expect(message.match(/^Agent: /gm)).toHaveLength(1);expect(message.match(/^Model: /gm)).toHaveLength(1);
 expect(sy!.db.prepare("SELECT * FROM request_charges").all()).toEqual(before);expect(sy!.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({n:1});
 expect(await git(f.original.worktreePath,["cat-file","commit",f.originCommit])).toBe(oldBytes);expect(await git(a.ws.worktreePath,["cat-file","commit",a.head])).toBe(copyBytes);
 expect((await sy!.inspectRecoveredEditProvenance(f.inspect)).digest).toBe(f.proof.digest);
},60000);

it("proves two existing missing-Model copy generations through their completed hydration lineage",async()=>{
 const f=await fixture(),a=await f.legacyCopy("copy-a",f.descriptor),aSource=await resolveRepairSource(f.parentCtx,a.id,"core",constraints,"job"),b=await f.legacyCopy("copy-b",aSource);
 expect((await resolveRepairSource(f.parentCtx,b.id,"core",constraints,"job")).head).toBe(b.head);
},60000);

it.each(["receipt","incomplete","descriptor","origin","foreign","cycle"] as const)("refuses unverified copy %s evidence",async variant=>{
 const f=await fixture(),a=await f.legacyCopy("copy-a",f.descriptor);
 if(variant==="receipt")sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.digest',?) WHERE task_id=? AND type='repair_hydration'").run("0".repeat(64),a.id);
 if(variant==="incomplete")sy!.db.prepare("DELETE FROM events WHERE task_id=? AND type='repair_hydration' AND json_extract(data_json,'$.status')='completed'").run(a.id);
 if(variant==="descriptor"||variant==="foreign"||variant==="cycle"){
  const spec=sy!.tasks.get(a.id)!.spec;spec.context.repairSource={...f.descriptor,...(variant==="descriptor"?{tree:"0".repeat(40)}:variant==="foreign"?{project:"foreign"}:{taskId:a.id,head:a.head,tree:a.tree,commits:[a.head]})};
  sy!.db.prepare("UPDATE tasks SET spec_json=? WHERE id=?").run(JSON.stringify(spec),a.id);
  if(variant==="cycle")sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.digest',?) WHERE task_id=? AND type='repair_hydration'").run(repairSourceDigest(spec.context.repairSource),a.id);
 }
 if(variant==="origin")sy!.db.prepare("DELETE FROM events WHERE task_id='source' AND type='recovered_edit_provenance_attested'").run();
 await expect(resolveRepairSource(f.parentCtx,a.id,"core",constraints,"job")).rejects.toThrow();
},60000);

it.each(["footer","delta","actor"] as const)("refuses a copy whose completed prefix has forged %s",async variant=>{
 const f=await fixture(),a=await f.legacyCopy("copy-a",f.descriptor);
 let message=await git(a.ws.worktreePath,["show","-s","--format=%B",a.head]),tree=a.tree;
 if(variant==="footer")message=message.replace(`(cherry picked from commit ${f.originCommit})`,`(cherry picked from commit ${"0".repeat(40)})`);
 if(variant==="actor")message+="\nAgent: forged\n";
 if(variant==="delta"){writeFileSync(path.join(a.ws.worktreePath,"src/recovered.ts"),"forged copied bytes\n");await git(a.ws.worktreePath,["add","-A"]);tree=(await git(a.ws.worktreePath,["write-tree"])).trim();}
 const commit=(await git(a.ws.worktreePath,["commit-tree",tree,"-p",a.ws.baseSha],{input:message,env:{GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@test",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@test"}})).trim();
 await git(a.ws.worktreePath,["update-ref","HEAD",commit,a.head]);
 sy!.db.prepare("UPDATE sessions SET workspace_json=json_set(workspace_json,'$.repos[0].head',?) WHERE id=?").run(commit,a.author.id);
 sy!.db.prepare("UPDATE events SET data_json=json_set(data_json,'$.head',?,'$.tree',?) WHERE task_id=? AND type='repair_hydration' AND json_extract(data_json,'$.status')='completed'").run(commit,tree,a.id);
 await expect(resolveRepairSource(f.parentCtx,a.id,"core",constraints,"job")).rejects.toThrow();
},60000);
