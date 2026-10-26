import {beforeAll,afterAll,afterEach,expect,it} from "vitest";
import {mkdirSync,writeFileSync,existsSync} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import type {MeritRouter} from "../src/core/service.js";
import type {RunContext} from "../src/runners/types.js";
import type {HarnessEnv} from "../src/harness/tools.js";
import type {SessionEvent} from "../src/sessions/events.js";
import {RepoReader} from "../src/context/repo-reader.js";
import {Worktrees} from "../src/workspaces/worktree.js";
import {commitAs} from "../src/attribution/index.js";
import {capturedLease} from "../src/storage/task-leases.js";
import {syntheticResult} from "../src/storage/tasks.js";
import {WorkerActionRequests,workerSourceIdentity} from "../src/harness/worker-actions.js";
import {executeOperation} from "../src/harness/operation-lifecycle.js";
import {operationRegistry} from "../src/harness/operation-registry.js";
import {journaled} from "../src/harness/journal.js";
import {quiescentRecipeSource} from "../src/harness/repair-operation-quiescence.js";
import {resolveRepairSource} from "../src/workspaces/repair-hydration.js";
import {baseConfig,makeEnv,open,ScriptedClient,reply,type Env} from "./helpers.js";

let env:Env,sy:MeritRouter,f:Awaited<ReturnType<typeof fixture>>;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const limits={maxConcurrent:4,maxWritersPerRepo:4,leaseMs:60000,defaultTimeoutMs:60000,supervisorProfiles:["supervise"],maxSupervisors:2,supervisorTimeoutMs:60000};
async function fixture(){
 const cfg=baseConfig({security:{outside_repository:"human_only"},coding:{runner:"native"},execution:{check_timeout_seconds:5}});
 (cfg.profiles as Record<string,unknown>).supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:40,classify:"never",min_tier:"T3"};
 env=makeEnv({config:cfg});sy=open(env,new ScriptedClient(()=>reply("unused")),{worker:false});
 const [parent]=await sy.submitTasks([{profile:"supervise",goal:"Repair retained UI",repositoryAliases:["core"],constraints:{acceptanceCriteria:["UI works"]}}]);sy.tasks.claim("parent",limits);
 const command=`"${process.execPath}" slow-check.cjs`;
 const [submitted]=await sy.submitTasks([{profile:"implement",label:"original-ui",parentTaskId:parent!.taskId,goal:"Implement UI",repositoryAliases:["core"],writableRepository:"core",constraints:{allowedPaths:["ui/**","slow-check.cjs"],checks:[command],acceptanceCriteria:["UI works"]}}]);
 const source=sy.tasks.claim("original-ui",limits)[0]!;expect(source.row.id).toBe(submitted!.taskId);
 const ws=await new Worktrees(sy.db,path.join(env.cfg.storageDir,"worktrees")).prepare({taskId:source.row.id,run:1,alias:"core",sourcePath:env.repo});
 mkdirSync(path.join(ws.worktreePath,"ui"));for(let i=0;i<12;i++)writeFileSync(path.join(ws.worktreePath,`ui/page${i}.tsx`),`export const page${i}="retained";\n`);
 const marker=path.join(env.dir,"execution-started");
 writeFileSync(path.join(ws.worktreePath,"slow-check.cjs"),`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},10000);`);
 const head=(await commitAs(ws.worktreePath,{agent:"implementer:original-ui",role:"implementer",model:"fake/model",task:source.row.id,job:parent!.taskId},"UI implementation"))!;
 const session=sy.sessions.create({taskId:source.row.id,jobId:parent!.taskId,role:"implementer",agentLabel:"implementer:original-ui",profile:"implement",tier:"T2"});
 session.setWorkspace({repos:[{alias:"core",worktree:ws.worktreePath,branch:null,baseCommit:ws.baseSha,head}]});
 const ctx={cfg:env.cfg,tasks:sy.tasks,taskId:source.row.id,taskLease:capturedLease(source),spec:source.spec,now:Date.now,signal:new AbortController().signal,artifacts:sy.artifacts,session} as RunContext;
 const callId="call-original-checks",args={ids:["check:1"],timeout_ms:2000};
 const harness={ctx,role:"implementer",toolInvocationId:`${session.id}:${callId}`,readers:new Map([["core",new RepoReader("core",ws.worktreePath,null)]]),workspace:{alias:"core",root:ws.worktreePath,allowedPaths:source.spec.constraints.allowedPaths},checks:{commands:[command],cwd:ws.worktreePath,env:{},timeoutMs:5000,maxRuns:10},universe:{refs:new Map()},checkResults:[],edits:new Set(),allowArtifacts:true} as HarnessEnv;
 const operation=journaled(session,{id:callId,function:{name:"run_checks",arguments:JSON.stringify(args)}},args,{sideEffect:"command",idempotent:false},async()=>{
   const result=await executeOperation(operationRegistry().find(def=>def.name==="run_checks")!,args,harness);
   return {ok:result.status==="succeeded",output:JSON.stringify(result)};
 });
 const actions=new WorkerActionRequests(sy.db);let request;const deadline=Date.now()+10000;
 while(!request){request=actions.list({project:source.row.project_id,taskId:source.row.id,status:"pending"})[0];if(Date.now()>deadline)throw Error("pending fixture action missing");await sleep(10);}
 const execution=actions.decide({project:source.row.project_id,id:request.id,decision:"approve",reason:"Explicit isolated quiescence fixture approval",actor:{kind:"operator"},config:env.cfg});
 const outcome=await operation,executed=await execution;
 expect(JSON.parse(outcome.output).status).toBe("unknown_effect");expect(executed.status).toBe("uncertain");expect(executed.quiescedAt).toBeTypeOf("number");expect(existsSync(marker)).toBe(true);
 session.end("completed","worker_submitted");
 const result=syntheticResult(source.row.id,"completed","worker_submitted");result.acceptanceStatus="unmet";result.changedPaths=Array.from({length:12},(_,i)=>`ui/page${i}.tsx`);
 sy.tasks.finish(source.row.id,"original-ui",result,"completed");
 const author=sy.sessions.get(session.id)!,events=sy.sessions.events(session.id,{limit:10000})!.events;
 const pending=events.filter((e):e is Extract<SessionEvent,{type:"tool_intent"}>=>e.type==="tool_intent"&&e.data.name==="run_recipe")[0]!;
 expect(events.some(e=>e.type==="tool_outcome"&&e.data.callId===pending.data.callId)).toBe(false);
 const brokerRow=sy.db.prepare("SELECT * FROM worker_action_requests WHERE id=?").get(request.id) as Record<string,unknown>;
 return {ctx,source:sy.tasks.get(source.row.id)!,author,events,pending,ws,hash:await workerSourceIdentity(ws.worktreePath),brokerRow,parent:parent!.taskId,command};
}
beforeAll(async()=>{f=await fixture();},20000);
afterEach(()=>{
 sy.db.prepare("DELETE FROM worker_action_requests WHERE task_id=?").run(f.source.row.id);
 sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(f.brokerRow.id,f.brokerRow.project_id,f.brokerRow.task_id,f.brokerRow.request_key,f.brokerRow.value_json,f.brokerRow.created_at);
});
afterAll(async()=>{await sy?.close();env?.cleanup();});
const proof=(events=f.events,source=f.source,hash=f.hash)=>quiescentRecipeSource(f.ctx,source,f.author,events,f.pending,{path:f.ws.worktreePath,alias:"core"},hash);
function mutateAction(update:(value:any)=>void){const value=JSON.parse(f.brokerRow.value_json as string);update(value);const key=createHash("sha256").update(JSON.stringify({...value.action,reason:undefined})).digest("hex");sy.db.prepare("UPDATE worker_action_requests SET value_json=?,request_key=? WHERE id=?").run(JSON.stringify(value),key,value.id);}
it("reconciles real timed-out grouped recipe only for source eligibility, preserving journal/result",async()=>{
 expect(proof()).toBe(true);
 const ctx={...f.ctx,taskId:f.parent,taskLease:capturedLease(sy.tasks.get(f.parent)!)};
 const source=await resolveRepairSource(ctx,f.source.row.id,"core",f.source.spec.constraints,f.parent);
 expect(source.head).toBe(f.author.workspace!.repos[0]!.head);
 expect(sy.tasks.get(f.source.row.id)!.result!.acceptanceStatus).toBe("unmet");
 expect(sy.sessions.events(f.author.id,{limit:10000})!.events).toEqual(f.events);
});
it.each(["running","pending","quiescence","foreign","incarnation","run","cwd","call","command","source","timeout","timing","operation"])("refuses %s action proof",condition=>{
 mutateAction(v=>{if(condition==="running"||condition==="pending")v.status=condition;if(condition==="quiescence")delete v.quiescedAt;if(condition==="foreign")v.action.lease.project="foreign";if(condition==="incarnation")v.action.lease.incarnation="0".repeat(32);if(condition==="run")v.action.lease.runCount++;if(condition==="cwd")v.action.cwd+="-other";if(condition==="call")v.action.invocationId+="-other";if(condition==="command")v.action.command="node --version";if(condition==="source")v.action.source="0".repeat(64);if(condition==="timeout")v.action.timeoutMs++;if(condition==="timing")v.quiescedAt=Number.MAX_SAFE_INTEGER;if(condition==="operation")v.action.operation={name:"web_fetch",args:{}};});
 expect(proof()).toBe(false);
});
it("refuses missing or ambiguous actions",()=>{
 sy.db.prepare("DELETE FROM worker_action_requests WHERE id=?").run(f.brokerRow.id);expect(proof()).toBe(false);
 const value=JSON.parse(f.brokerRow.value_json as string);value.id="duplicate-proof";value.action.command+=" ";
 sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(f.brokerRow.id,f.brokerRow.project_id,f.brokerRow.task_id,f.brokerRow.request_key,f.brokerRow.value_json,f.brokerRow.created_at);
 sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(value.id,value.project,value.taskId,"different-key",JSON.stringify(value),Date.now());expect(proof()).toBe(false);
});
it.each(["start","settled","outer","corrupt","foreign-note","duplicate-note"])("refuses %s operation history",condition=>{
 let events=structuredClone(f.events);
 if(condition==="start")events=events.filter(e=>!(e.type==="note"&&e.data.text==="Harness v2 operation started"));
 if(condition==="settled")events=events.filter(e=>!(e.type==="note"&&e.data.text==="Harness v2 operation settled"));
 if(condition==="outer")events=events.filter(e=>!(e.type==="tool_outcome"&&e.data.name==="run_checks"));
 if(condition==="corrupt"){const e=events.find(e=>e.type==="tool_outcome"&&e.data.name==="run_checks")!;if(e.type==="tool_outcome")e.data.output="{";}
 if(condition==="foreign-note"){const e=events.find(e=>e.type==="note"&&e.data.text==="Harness v2 operation settled")!;if(e.type==="note")(e.data.data as any).taskId="foreign";}
 if(condition==="duplicate-note")events.push(structuredClone(events.find(e=>e.type==="note"&&e.data.text==="Harness v2 operation settled")!));
 expect(proof(events)).toBe(false);
});
it("refuses changed current source hash or incomplete source task",()=>{
 expect(proof(f.events,f.source,"0".repeat(64))).toBe(false);
 expect(proof(f.events,{...f.source,row:{...f.source.row,state:"failed"}})).toBe(false);
});
