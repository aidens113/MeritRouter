import {beforeAll,afterAll,afterEach,expect,it} from "vitest";
import {mkdirSync,writeFileSync,existsSync,readFileSync} from "node:fs";
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
async function fixture(state:"completed"|"failed"="completed",omitted=false){
 const cfg=baseConfig({security:{outside_repository:"human_only"},coding:{runner:"native"},execution:{check_timeout_seconds:omitted?2:5}});
 (cfg.profiles as Record<string,unknown>).supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:40,classify:"never",min_tier:"T3"};
 env=makeEnv({config:cfg});const client=new ScriptedClient(()=>reply("unused"));sy=open(env,client,{worker:false});
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
 const callId="call-original-checks",args={ids:["check:1"],...(omitted?{}:{timeout_ms:2000})};
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
 const reason=state==="failed"?"internal_error: worker action wait cancelled or original lease lost":"worker_submitted";
 session.end(state,reason);
 const result=syntheticResult(source.row.id,state,reason);result.acceptanceStatus="unmet";result.changedPaths=Array.from({length:12},(_,i)=>`ui/page${i}.tsx`);
 sy.tasks.finish(source.row.id,"original-ui",result,state);
 const author=sy.sessions.get(session.id)!,events=sy.sessions.events(session.id,{limit:10000})!.events;
 const pending=events.filter((e):e is Extract<SessionEvent,{type:"tool_intent"}>=>e.type==="tool_intent"&&e.data.name==="run_recipe")[0]!;
 expect(events.some(e=>e.type==="tool_outcome"&&e.data.callId===pending.data.callId)).toBe(false);
 const brokerRow=sy.db.prepare("SELECT * FROM worker_action_requests WHERE id=?").get(request.id) as Record<string,unknown>;
 return {ctx,source:sy.tasks.get(source.row.id)!,author,events,pending,ws,hash:await workerSourceIdentity(ws.worktreePath),brokerRow,parent:parent!.taskId,command,client};
}
beforeAll(async()=>{f=await fixture();},20000);
afterEach(()=>{
 sy.db.prepare("UPDATE tasks SET state=? WHERE id=?").run(f.source.row.state,f.source.row.id);
 sy.db.prepare("UPDATE sessions SET status=?,ended_at=?,last_seq=?,stop_reason=? WHERE id=?").run(f.author.status,f.author.endedAt,f.author.lastSeq,f.author.stopReason,f.author.id);
 sy.db.prepare("DELETE FROM worker_action_requests WHERE task_id=?").run(f.source.row.id);
 sy.db.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run(f.brokerRow.id,f.brokerRow.project_id,f.brokerRow.task_id,f.brokerRow.request_key,f.brokerRow.value_json,f.brokerRow.created_at);
});
afterAll(async()=>{await sy?.close();env?.cleanup();});
const proof=(events=f.events,source=f.source,hash=f.hash,author=f.author)=>quiescentRecipeSource(f.ctx,source,author,events,f.pending,{path:f.ws.worktreePath,alias:"core"},hash);
function mutateAction(update:(value:any)=>void){const value=JSON.parse(f.brokerRow.value_json as string);update(value);const key=createHash("sha256").update(JSON.stringify({...value.action,reason:undefined})).digest("hex");sy.db.prepare("UPDATE worker_action_requests SET value_json=?,request_key=? WHERE id=?").run(JSON.stringify(value),key,value.id);}
it("reconciles real timed-out grouped recipe only for source eligibility, preserving journal/result",async()=>{
 expect(proof()).toBe(true);
 const ctx={...f.ctx,taskId:f.parent,taskLease:capturedLease(sy.tasks.get(f.parent)!)};
 const source=await resolveRepairSource(ctx,f.source.row.id,"core",f.source.spec.constraints,f.parent);
 expect(source.head).toBe(f.author.workspace!.repos[0]!.head);
 expect(sy.tasks.get(f.source.row.id)!.result!.acceptanceStatus).toBe("unmet");
 expect(sy.sessions.events(f.author.id,{limit:10000})!.events).toEqual(f.events);
});
it("reuses a genuinely failed source only after exact host quiescence without replay or history/usage changes",async()=>{
 const originalService=sy,originalEnvironment=env;
 try {
  const failed=await fixture("failed");
  const result=structuredClone(failed.source.result),history=readFileSync(failed.author.logPath);
  const requests=sy.db.prepare("SELECT * FROM model_requests ORDER BY id").all(),charges=sy.db.prepare("SELECT * FROM request_charges ORDER BY request_id,task_id").all();
  const actions=sy.db.prepare("SELECT * FROM worker_action_requests WHERE task_id=? ORDER BY id").all(failed.source.row.id),transport=failed.client.requests.length;
  expect(failed.source.row.state).toBe("failed");expect(failed.author.status).toBe("failed");
  expect(quiescentRecipeSource(failed.ctx,failed.source,failed.author,failed.events,failed.pending,{path:failed.ws.worktreePath,alias:"core"},failed.hash)).toBe(true);
  const ctx={...failed.ctx,taskId:failed.parent,taskLease:capturedLease(sy.tasks.get(failed.parent)!)};
  const source=await resolveRepairSource(ctx,failed.source.row.id,"core",failed.source.spec.constraints,failed.parent);
  expect(source.head).toBe(failed.author.workspace!.repos[0]!.head);
  expect(sy.tasks.get(failed.source.row.id)!.result).toEqual(result);
  expect(readFileSync(failed.author.logPath)).toEqual(history);
  expect(sy.sessions.events(failed.author.id,{limit:10000})!.events).toEqual(failed.events);
  expect(sy.db.prepare("SELECT * FROM model_requests ORDER BY id").all()).toEqual(requests);
  expect(sy.db.prepare("SELECT * FROM request_charges ORDER BY request_id,task_id").all()).toEqual(charges);
  expect(sy.db.prepare("SELECT * FROM worker_action_requests WHERE task_id=? ORDER BY id").all(failed.source.row.id)).toEqual(actions);
  expect(failed.client.requests).toHaveLength(transport);
 } finally {
  if(sy!==originalService){await sy.close();env.cleanup();}
  sy=originalService;env=originalEnvironment;
 }
},20000);
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
 expect(proof(f.events,{...f.source,row:{...f.source.row,state:"running"}})).toBe(false);
});
it.each(["author","persisted-status","persisted-end","persisted-seq","ended-status","ended-time","ended-reason","duplicate-end","after-end","resurrected"])("refuses %s terminal proof disagreement",condition=>{
 const events=structuredClone(f.events),author=structuredClone(f.author),end=events.find((e):e is Extract<SessionEvent,{type:"ended"}>=>e.type==="ended")!;
 if(condition==="author")author.status="failed";
 if(condition==="persisted-status")sy.db.prepare("UPDATE sessions SET status='failed' WHERE id=?").run(author.id);
 if(condition==="persisted-end")sy.db.prepare("UPDATE sessions SET ended_at=ended_at+1 WHERE id=?").run(author.id);
 if(condition==="persisted-seq")sy.db.prepare("UPDATE sessions SET last_seq=last_seq+1 WHERE id=?").run(author.id);
 if(condition==="ended-status")end.data.status="failed";
 if(condition==="ended-time")end.at++;
 if(condition==="ended-reason")end.data.stopReason="another ending";
 if(condition==="duplicate-end")events.push(structuredClone(end));
 if(condition==="after-end")events.push({type:"note",seq:end.seq+1,at:end.at+1,data:{text:"late event"}});
 if(condition==="resurrected")sy.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(f.source.row.id);
 expect(proof(events,f.source,f.hash,author)).toBe(false);
});
it.each(["denied","cancelled","missing-start"])("refuses %s non-execution proof",condition=>{
 mutateAction(v=>{if(condition==="missing-start")delete v.executionStartedAt;else v.status=condition;});
 expect(proof()).toBe(false);
});
it("binds new omitted-default proof to its captured host policy while preserving historical proof and refusing forged policies",async()=>{
 const originalService=sy,originalEnvironment=env;
 try {
  const omitted=await fixture("failed",true);
  const history=readFileSync(omitted.author.logPath),rows=sy.db.prepare("SELECT * FROM worker_action_requests WHERE task_id=?").all(omitted.source.row.id);
  const eligible=(events=omitted.events)=>{
   const pending=events.find((event):event is Extract<SessionEvent,{type:"tool_intent"}>=>(event.type==="tool_intent"&&event.data.callId===omitted.pending.data.callId))!;
   return quiescentRecipeSource(omitted.ctx,omitted.source,omitted.author,events,pending,{path:omitted.ws.worktreePath,alias:"core"},omitted.hash);
  };
  expect(omitted.pending.data.args).toMatchObject({timeout_policy:{version:"configured-v1",default_ms:2000,check_limit_ms:5000}});
  expect(eligible()).toBe(true);
  const historical=structuredClone(omitted.events),past=historical.find(event=>event.type==="tool_intent"&&event.data.callId===omitted.pending.data.callId)!;
  if(past.type==="tool_intent")delete (past.data.args as Record<string,unknown>).timeout_policy;
  expect(eligible(historical)).toBe(true); // Old min(30000, configured2000) command capture.
  omitted.ctx.cfg.execution.check_timeout_seconds=60;
  expect(eligible()).toBe(true); // Later configuration cannot reinterpret a new captured allowance.
  expect(eligible(historical)).toBe(false); // No retrospective policy guess for old receipts.
  for(const alteration of ["version","default","check-limit","extra"]){
   const events=structuredClone(omitted.events),event=events.find(e=>e.type==="tool_intent"&&e.data.callId===omitted.pending.data.callId)!;
   const policy=(event.data as any).args.timeout_policy;
   if(alteration==="version")policy.version="future-policy";
   if(alteration==="default")policy.default_ms=3000;
   if(alteration==="check-limit")policy.check_limit_ms=1;
   if(alteration==="extra")policy.trusted=true;
   expect(eligible(events),alteration).toBe(false);
  }
  expect(readFileSync(omitted.author.logPath)).toEqual(history);
  expect(sy.db.prepare("SELECT * FROM worker_action_requests WHERE task_id=?").all(omitted.source.row.id)).toEqual(rows);
  expect(omitted.client.requests).toHaveLength(0);
 }finally{
  if(sy!==originalService){await sy.close();env.cleanup();}
  sy=originalService;env=originalEnvironment;
 }
},20000);
