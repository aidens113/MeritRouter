import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Admission } from "../src/admission/admission.js";
import { ProjectRequestLedger, type ProjectRequestCheckpoint } from "../src/admission/project-request-ledger.js";
import { requestAttemptId, type ReserveRequestDTO } from "../src/admission/request-ledger.js";
import { SqliteRequestAccountingBroker } from "../src/admission/sqlite-accounting-broker.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { initializeStoreRole, assertStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { baseConfig, makeEnv, summarizeTask, reply, type Env } from "./helpers.js";
const dbs: Db[] = [], envs: Env[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if(db.open) db.close(); for(const env of envs.splice(0)) env.cleanup(); });
function setup(fault?: ProjectRequestCheckpoint, paid=false) {
 const env = makeEnv({config:baseConfig({repositories:{},paid:{enabled:true,budgets:{per_week_usd:5}},brain:{path:"brain",project:"alpha"},projects:{alpha:{}}})});envs.push(env);
 const now=1800000000000, globalDir=path.join(env.dir,"global");
 const global=openDatabase(globalDir,{durability:"full"}),local=openDatabase(path.join(env.dir,"local"),{durability:"full"});dbs.push(global,local);
 const coordination=createCoordinationStoreIdentity(),identity=createProjectStoreIdentity(coordination.installationId,"alpha");initializeStoreRole(global,coordination);initializeStoreRole(local,identity);registerProjectStore(global,identity,path.join(env.dir,"project"));
 const tasks=new TaskStore(local,()=>now);tasks.submit([WorkerTaskSchema.parse(summarizeTask({id:"one"}))],{project:"alpha"});
 local.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id='one'").run(now+60000,now+60000);
 const admission=new Admission(local,tasks,env.cfg,()=>now),executionId=admission.createExecution("task","summarize",[{taskId:"one",itemId:"one"}]);
 const broker=new SqliteRequestAccountingBroker(global,{cfg:env.cfg,spend:new PaidSpend(global,env.cfg,new KeyVault(global,globalDir),()=>now),now:()=>now,authorize:()=>({endpointId:"fixture/model",keyRef:paid?"fixture-key":null,provider:"fixture",platform:"fixture",enabled:true,providerUsageScopes:paid?["provider:fixture"]:[],paid:paid?{price:{in:2,out:8,cacheWriteIn:null},maxSearches:0,monthlyCapUsd:null,prepaidBalanceUsd:null,balanceCheckedAt:null}:null})});
 const input:ReserveRequestDTO={requestId:requestAttemptId(now),payloadDigest:"a".repeat(64),keyRef:"",providerReservationId:null,executionId,profile:"summarize",purpose:"test",gatewayModel:"fixture/model",endpointId:"fixture/model",tier:"T1",estInputTokens:100,reservedOutputTokens:30,participants:[{taskId:"one",leaseOwner:"worker",lease:capturedLease(tasks.get("one")!),budget:{maxModelRequests:4,maxInputTokens:null,maxOutputTokens:null,maxPaidUsd:null},estInputTokens:100,reservedOutputTokens:30}]};
 if(paid){input.providerReservationId="fixture-quota";global.prepare("INSERT INTO provider_usage(scope,at,tokens,reservation) VALUES(?,?,?,?)").run("provider:fixture",now,130,"fixture-quota");input.keyRef="fixture-key";input.paid={key:{ref:"fixture-key",label:"fixture",enabled:true,monthlyCapUsd:null,prepaidBalanceUsd:null,balanceCheckedAt:null},provider:"fixture",worstCaseUsd:.1,price:{in:2,out:8,cacheWriteIn:null}};}
 input.slot={id:"fixture-slot",nonce:"fixture-nonce"};
 global.prepare("INSERT INTO provider_slots(id,platform,kind,holder,task_id,lease_owner,priority,since,seen_at,lease_json,nonce,project_uuid,store_uuid,store_generation) VALUES('fixture-slot','fixture','request','holder','one','worker',0,?,?,?,'fixture-nonce',?,?,?)").run(now,now,JSON.stringify([input.participants[0]!.lease]),identity.projectId,identity.storeId,identity.generation);
 let thrown=false; const ledger=new ProjectRequestLedger(admission,{identity,cfg:env.cfg,broker,checkpoint:phase=>{if(phase===fault&&!thrown){thrown=true;throw new Error("injected "+phase);}}});
 return {env,global,local,identity,tasks,admission,broker,input,ledger,newLedger:()=>new ProjectRequestLedger(admission,{identity,cfg:env.cfg,broker})};
}
it("settles private outcomes locally and never recreates process transport authority",async()=>{
 const f=setup(),r=await f.ledger.reserve(f.input);expect(f.admission.taskTotals("one").requests).toBe(1);
 expect(await f.ledger.beginDispatch(r,"dispatch")).toEqual({disposition:"fresh"});f.ledger.assertDispatch(r,"dispatch");expect(()=>f.ledger.assertDispatch(r,"dispatch")).toThrow();
 const outcome={kind:"succeeded" as const,servedEndpointId:f.input.endpointId,response:reply("private-canary",{usage:{inputTokens:80,outputTokens:20}})};
 await f.ledger.reconcile(r,outcome);await f.ledger.reconcile(r,outcome);expect(await f.ledger.receipt(r.requestId)).toEqual({state:"settled"});expect(f.admission.taskTotals("one").requests).toBe(1);
 expect(()=>f.newLedger().assertDispatch(r,"dispatch")).toThrow();assertStoreRole(f.local,f.identity);
 expect(JSON.stringify(f.global.prepare("SELECT * FROM physical_requests").all())).not.toContain("private-canary");
});
it.each(["local_prepared","global_reserved","local_bound"] as const)("recovers %s without duplicate admission",async phase=>{
 const f=setup(phase);await expect(f.ledger.reserve(f.input)).rejects.toThrow("injected");const recovered=f.newLedger();await recovered.recover(f.input.requestId);expect(f.admission.taskTotals("one").requests).toBe(1);expect(f.global.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({n:1});
});
it("retains durable dispatch intent but grants no transport after local postcommit failure",async()=>{
 const f=setup("local_dispatched"),r=await f.ledger.reserve(f.input);await expect(f.ledger.beginDispatch(r,"dispatch")).rejects.toThrow("injected");expect(()=>f.ledger.assertDispatch(r,"dispatch")).toThrow();expect(f.broker.readReceipt(r.requestId)?.state).toBe("dispatch_intent");expect(await f.newLedger().beginDispatch(r,"dispatch")).toEqual({disposition:"replayed"});
});
it.each(["outcome_saved","global_settled","local_applied"] as const)("recovers %s exactly once",async phase=>{
 const f=setup(phase),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");await expect(f.ledger.reconcile(r,{kind:"succeeded",servedEndpointId:f.input.endpointId,response:reply("ignored",{usage:{inputTokens:80,outputTokens:20}})})).rejects.toThrow("injected");await f.newLedger().recover(r.requestId);expect(await f.ledger.receipt(r.requestId)).toEqual({state:"settled"});expect(f.admission.taskTotals("one").requests).toBe(1);
});
it("revokes cancelled participants before fresh transport",async()=>{
 const f=setup(),r=await f.ledger.reserve(f.input);f.local.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='one'").run();await expect(f.ledger.beginDispatch(r,"dispatch")).rejects.toThrow();expect(()=>f.ledger.assertDispatch(r,"dispatch")).toThrow();expect(f.broker.readReceipt(r.requestId)?.state).toBe("reserved");
});


it("preserves global settlement when private outcome insertion aborts",async()=>{
 const f=setup(),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");
 f.local.exec("CREATE TRIGGER fail_private_outcome BEFORE UPDATE OF outcome_json ON project_request_protocol BEGIN SELECT RAISE(ABORT,'private outcome unavailable'); END");
 const outcome={kind:"succeeded" as const,servedEndpointId:f.input.endpointId,response:reply("private",{usage:{inputTokens:80,outputTokens:20}})};
 await expect(f.ledger.reconcile(r,outcome)).rejects.toThrow("private outcome unavailable");expect(f.broker.readReceipt(r.requestId)?.state).toBe("settled");expect(await f.ledger.receipt(r.requestId)).toEqual({state:"uncertain"});
 f.local.exec("DROP TRIGGER fail_private_outcome");await f.newLedger().recover(r.requestId);expect(await f.ledger.receipt(r.requestId)).toEqual({state:"settled"});
});
it("keeps global intent when the local dispatch marker transaction aborts",async()=>{
 const f=setup(),r=await f.ledger.reserve(f.input);f.local.exec("CREATE TRIGGER fail_local_intent BEFORE UPDATE OF dispatch_id ON project_request_protocol BEGIN SELECT RAISE(ABORT,'local intent unavailable'); END");
 await expect(f.ledger.beginDispatch(r,"dispatch")).rejects.toThrow("local intent unavailable");expect(f.broker.readReceipt(r.requestId)?.state).toBe("dispatch_intent");expect(()=>f.ledger.assertDispatch(r,"dispatch")).toThrow();f.local.exec("DROP TRIGGER fail_local_intent");await f.newLedger().recover(r.requestId);expect(await f.ledger.receipt(r.requestId)).toEqual({state:"uncertain"});
});
it("retains preparations in the actual task request cap before shared admission",async()=>{
 const f=setup("local_prepared");await expect(f.ledger.reserve(f.input)).rejects.toThrow("injected");expect(f.admission.taskTotals("one").requests).toBe(1);expect(f.global.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({n:0});
 const second={...f.input,requestId:requestAttemptId(),participants:f.input.participants.map(p=>({...p,budget:{...p.budget,maxModelRequests:1}}))};await expect(f.newLedger().reserve(second)).rejects.toThrow();expect(f.admission.taskTotals("one").requests).toBe(1);
});

it("projects paid spend only locally and fences an unpriceable physical charge globally",async()=>{
 const f=setup(undefined,true),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");
 await expect(f.ledger.reconcile(r,{kind:"succeeded",servedEndpointId:f.input.endpointId,response:reply("private",{usage:{inputTokens:80,outputTokens:20,cacheCreationInputTokens:10}})})).rejects.toThrow();
 expect(f.broker.readReceipt(r.requestId)).toMatchObject({state:"dispatch_intent",costQuarantined:true,unboundedCost:true,actualUsd:null});expect(await f.ledger.receipt(r.requestId)).toEqual({state:"quarantined"});expect(f.local.prepare("SELECT COUNT(*) n FROM paid_spend").get()).toEqual({n:0});expect(f.local.prepare("SELECT COUNT(*) n FROM project_request_spend").get()).toEqual({n:1});assertStoreRole(f.local,f.identity);
});
it("projects known paid costs once without shared credentials in the project database",async()=>{
 const f=setup(undefined,true),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");const outcome={kind:"succeeded" as const,servedEndpointId:f.input.endpointId,response:reply("private",{usage:{inputTokens:80,outputTokens:20,reportedCostUsd:.01}})};await f.ledger.reconcile(r,outcome);await f.newLedger().recover(r.requestId);
 expect(f.local.prepare("SELECT actual_usd FROM project_request_spend").get()).toEqual({actual_usd:.01});expect(f.global.prepare("SELECT actual_usd FROM broker_paid_spend").get()).toEqual({actual_usd:.01});for(const table of ["paid_spend","paid_keys","provider_slots"])expect(f.local.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});assertStoreRole(f.local,f.identity);
});

it("projects one physical batch into two exact original participant charges",async()=>{
 const f=setup();f.tasks.submit([WorkerTaskSchema.parse(summarizeTask({id:"two"}))],{project:"alpha"});f.local.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id='two'").run(1800000060000,1800000060000);f.local.prepare("INSERT INTO execution_members(execution_id,task_id,item_id) VALUES(?,'two','two')").run(f.input.executionId);
 f.input.participants.push({...f.input.participants[0]!,taskId:"two",lease:capturedLease(f.tasks.get("two")!),estInputTokens:200,reservedOutputTokens:60});f.input.estInputTokens=300;f.input.reservedOutputTokens=90;f.global.prepare("UPDATE provider_slots SET lease_json=?").run(JSON.stringify(f.input.participants.map(p=>p.lease)));
 const r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");await f.ledger.reconcile(r,{kind:"succeeded",servedEndpointId:f.input.endpointId,response:reply("ignored",{usage:{inputTokens:300,outputTokens:90}})});
 expect(f.local.prepare("SELECT task_id,input_tokens,output_tokens FROM request_charges ORDER BY task_id").all()).toEqual([{task_id:"one",input_tokens:100,output_tokens:30},{task_id:"two",input_tokens:200,output_tokens:60}]);expect(f.global.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({n:1});assertStoreRole(f.local,f.identity);
});

it.each(["deadline","incarnation"] as const)("revokes %s changes after durable intent before transport",async reason=>{
 const f=setup(),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");if(reason==="deadline")f.local.prepare("UPDATE tasks SET deadline_at=1 WHERE id='one'").run();else f.local.prepare("UPDATE tasks SET lease_incarnation=? WHERE id='one'").run("d".repeat(32));expect(()=>f.ledger.assertDispatch(r,"dispatch")).toThrow();expect(f.broker.readReceipt(r.requestId)?.state).toBe("dispatch_intent");expect(()=>f.newLedger().assertDispatch(r,"dispatch")).toThrow();
});

it("fences live unpriced evidence before touching a closed project database and persists across global reopen",async()=>{
 const f=setup(undefined,true),r=await f.ledger.reserve(f.input);await f.ledger.beginDispatch(r,"dispatch");f.ledger.assertDispatch(r,"dispatch");f.local.close();
 await expect(f.ledger.reconcile(r,{kind:"succeeded",servedEndpointId:f.input.endpointId,response:reply("private",{usage:{inputTokens:80,outputTokens:20,cacheCreationInputTokens:10}})})).rejects.toThrow();
 expect(f.broker.readReceipt(r.requestId)).toMatchObject({state:"dispatch_intent",costQuarantined:true,unboundedCost:true,actualUsd:null});
 f.global.close();const reopened=openDatabase(path.join(f.env.dir,"global"),{durability:"full"});dbs.push(reopened);const spend=new PaidSpend(reopened,f.env.cfg,new KeyVault(reopened,path.join(f.env.dir,"global")),()=>1800000000000);expect(spend.globalDenial(0)).not.toBeNull();expect(reopened.prepare("SELECT unbounded_cost,cost_quarantined FROM physical_requests WHERE id=?").get(r.requestId)).toEqual({unbounded_cost:1,cost_quarantined:1});
});

