import path from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { ProjectQueueBindings } from "../src/storage/sqlite-task-queue.js";
import { ProjectExecutionGrants,type ExecutionGrantLimits } from "../src/storage/project-execution-grants.js";
import { openDatabase,type Db } from "../src/storage/db.js";
import { initializeStoreRole,assertStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity,createProjectStoreIdentity,registerProjectStore,readProjectStoreRegistration } from "../src/projects/store-identity.js";
import { projectContext } from "../src/projects/context.js";
import { projectRuntimePaths } from "../src/projects/runtime-paths.js";
import { TaskStore,syntheticResult } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { purgeProjectRows } from "../src/projects/deletion.js";
import { capturedLease,leaseOperationId,recoveryOperationId } from "../src/storage/task-leases.js";
import { baseConfig,makeEnv,summarizeTask,type Env } from "./helpers.js";
const envs:Env[]=[],dbs:Db[]=[],ports:Array<ReturnType<ProjectQueueBindings["bindLocal"]>>=[];
afterEach(async()=>{await Promise.allSettled(ports.splice(0).map(port=>port.drain()));for(const db of dbs.splice(0))if(db.open)db.close();for(const env of envs.splice(0))env.cleanup();vi.restoreAllMocks();});
function fixture(options:{batch?:boolean;maxTasks?:number}={}){
 const raw=baseConfig({repositories:{},projects:{alpha:{priority:2},beta:{priority:1}},team:{provider_concurrency_enabled:false}});
 const profiles=raw.profiles as Record<string,Record<string,unknown>>;profiles.summarize={...profiles.summarize,batching:{enabled:options.batch??false,max_items:4}};profiles.supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:30,classify:"never"};
 const env=makeEnv({config:raw});envs.push(env);let now=Date.now();
 const global=openDatabase(path.join(env.dir,"global"),{durability:"full"});dbs.push(global);const installation=createCoordinationStoreIdentity();initializeStoreRole(global,installation);
 const limits:ExecutionGrantLimits={maxTasks:options.maxTasks??4,maxSupervisors:1,maxWritersPerRepository:1,projectMaxTasks:null};let bindings!:ProjectQueueBindings;
 const grants=new ProjectExecutionGrants(global,()=>limits,()=>now,(grant,proof)=>bindings.renewalAuthority(grant,proof),input=>bindings.delegationAuthority(input));bindings=new ProjectQueueBindings(grants);
 function local(slug:string){const identity=createProjectStoreIdentity(installation.installationId,slug),root=path.join(env.dir,slug),paths=projectRuntimePaths(root),db=openDatabase(paths.state,{durability:"full"});dbs.push(db);initializeStoreRole(db,identity);registerProjectStore(global,identity,root);const cfg=projectContext(env.cfg,{project:{slug,name:slug,legacy:false},projectDirectory:root,storageDir:paths.state,brain:{...env.cfg.brain,project:slug,path:paths.brain}}),tasks=new TaskStore(db,()=>now);
  const assert=()=>{expect(global.inTransaction).toBe(false);const r=readProjectStoreRegistration(global,identity.projectId);if(!r||r.state!=="registered"||r.storeId!==identity.storeId||r.generation!==identity.generation)throw Error("stale fixture registration");assertStoreRole(db,identity);};
  const port=bindings.bindLocal({identity,cfg,db,tasks,assertCurrent:assert,assertPinned:assert});ports.push(port);return{identity,cfg,db,tasks,port};}
 const alpha=local("alpha"),beta=local("beta");const hints=()=>[alpha.port.hint(),beta.port.hint()].filter((v):v is NonNullable<typeof v>=>v!==null);
 const submit=(target:typeof alpha,id:string,extra:Record<string,unknown>={})=>target.tasks.submit([WorkerTaskSchema.parse(summarizeTask({id,goal:`private-${target.identity.slug}-${id}`,...extra}))],{project:target.identity.slug});
 const claim=async(target=alpha)=>{const tasks=await target.port.claimTurn({owner:"worker"},hints());return tasks;};
 return{env,global,grants,bindings,limits,alpha,beta,hints,submit,claim,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
it("seals a local claim, consumes it once after commit and keeps all private graph state local",async()=>{
 const f=fixture();f.submit(f.alpha,"same");f.advance(1);f.submit(f.beta,"same");const a=await f.claim(f.alpha);expect(a).toHaveLength(1);
 expect(f.global.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({n:0});expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'claim_%' OR key LIKE 'worker:%'").get()).toEqual({n:0});
 expect(f.alpha.port.authorizeStart(a)).toBe("fresh");expect(f.alpha.port.authorizeStart(a)).toBe("already_started");
 expect(f.alpha.port.refsForRequest(a.map(capturedLease))).toHaveLength(1);
 expect(()=>f.beta.port.refsForRequest(a.map(capturedLease))).toThrow();assertStoreRole(f.alpha.db,f.alpha.identity);assertStoreRole(f.beta.db,f.beta.identity);
});
it("keeps a failed local claim commit as a conservative global hold without executing",async()=>{
 const f=fixture({maxTasks:1});f.submit(f.alpha,"one");f.alpha.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON project_execution_claims BEGIN SELECT RAISE(ABORT,'fixture local claim rollback'); END");
 await expect(f.claim()).rejects.toThrow("fixture local claim rollback");expect(f.alpha.tasks.get("one")!.row).toMatchObject({state:"queued",run_count:0});
 expect(f.global.prepare("SELECT state FROM project_execution_grants").all()).toEqual([{state:"reserved"}]);expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM project_execution_claims").get()).toEqual({n:0});
 f.alpha.db.exec("DROP TRIGGER fail_claim");expect(await f.claim()).toEqual([]);
});
it("refuses replayed global consume and a lost started-marker commit before executor admission",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const first=await f.claim(),id=(f.global.prepare("SELECT id FROM project_execution_grants").get() as{id:string}).id,grant=f.grants.read(id)!;
 f.grants.consume(grant.ref);expect(()=>f.alpha.port.authorizeStart(first)).toThrow(/Replayed global consume/);
 expect(f.alpha.db.prepare("SELECT phase FROM project_execution_claims").get()).toEqual({phase:"claimed"});
 await f.alpha.port.taskLeases.interrupt({lease:capturedLease(first[0]!),operationId:leaseOperationId(f.now()),reason:"fixture"});f.alpha.port.reconcile();
 f.alpha.tasks.resume("one");const next=await f.claim();f.alpha.db.exec("CREATE TRIGGER fail_start BEFORE UPDATE OF phase ON project_execution_claims WHEN NEW.phase='started' BEGIN SELECT RAISE(ABORT,'fixture local start rollback'); END");
 expect(()=>f.alpha.port.authorizeStart(next)).toThrow("fixture local start rollback");expect(f.alpha.db.prepare("SELECT phase FROM project_execution_claims WHERE phase!='terminal'").get()).toEqual({phase:"claimed"});
});
it("seals completion companions before reserving one immutable batch unit",async()=>{
 const f=fixture({batch:true,maxTasks:1});for(const id of["one","two","three"])f.submit(f.alpha,id);
 const tasks=await f.claim();expect(tasks).toHaveLength(3);const grant=f.grants.read((f.global.prepare("SELECT id FROM project_execution_grants").get() as{id:string}).id)!;
 expect(grant.input.executionUnit).toBe("completion_batch");expect(grant.input.leases).toHaveLength(3);
 expect(()=>f.alpha.port.authorizeStart(tasks.slice(0,1))).toThrow(/whole sealed grant set/);expect(f.alpha.port.authorizeStart(tasks)).toBe("fresh");
 expect(await f.alpha.port.claimCompanions({owner:"worker",leader:{taskId:tasks[0]!.row.id,runCount:tasks[0]!.row.run_count,incarnation:tasks[0]!.row.lease_incarnation,project:"alpha"},excludeTaskIds:[]})).toEqual([]);
});
it("renews local and global authority in local-to-global order and retires only after durable terminal state",async()=>{
 const f=fixture({maxTasks:1});f.submit(f.alpha,"one");const tasks=await f.claim();f.alpha.port.authorizeStart(tasks);const lease=capturedLease(tasks[0]!);f.advance(10000);
 await f.alpha.port.taskLeases.renew({lease,operationId:leaseOperationId(f.now())});const grant=f.grants.read((f.global.prepare("SELECT id FROM project_execution_grants").get() as{id:string}).id)!;expect(grant.renewalSequence).toBe(1);
 await f.alpha.port.taskLeases.finish({lease,operationId:leaseOperationId(f.now()),state:"completed",result:syntheticResult(lease.taskId,"completed","fixture")});await f.alpha.port.drain();
 expect(f.grants.read(grant.ref.grantId)?.state).toBe("completed");expect(f.alpha.db.prepare("SELECT phase FROM project_execution_claims").get()).toEqual({phase:"terminal"});
});
it("refuses purge until an actual queue claim is durably terminal and reconciled",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const tasks=await f.claim();f.alpha.port.authorizeStart(tasks);
 const before=f.global.prepare("SELECT * FROM project_execution_grants").all();
 expect(()=>purgeProjectRows(f.alpha.db,"alpha",[])).toThrow(/terminal reconciliation/);
 expect(f.alpha.tasks.get("one")).not.toBeNull();expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM project_execution_claim_members").get()).toEqual({n:1});expect(f.global.prepare("SELECT * FROM project_execution_grants").all()).toEqual(before);
 const lease=capturedLease(tasks[0]!);await f.alpha.port.taskLeases.finish({lease,operationId:leaseOperationId(f.now()),state:"completed",result:syntheticResult(lease.taskId,"completed","fixture")});await f.alpha.port.drain();
 expect(f.alpha.db.prepare("SELECT phase FROM project_execution_claims").get()).toEqual({phase:"terminal"});
 const terminal=f.global.prepare("SELECT * FROM project_execution_grants").all();expect(purgeProjectRows(f.alpha.db,"alpha",[]).tasks).toBe(1);
 expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM project_execution_claim_members").get()).toEqual({n:0});expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM project_execution_claims").get()).toEqual({n:0});expect(f.alpha.tasks.get("one")).toBeUndefined();expect(f.global.prepare("SELECT * FROM project_execution_grants").all()).toEqual(terminal);
});
it("persists weighted global fan-out across independent project queues without local fairness metadata",async()=>{
 const f=fixture({maxTasks:1});for(let i=0;i<6;i++){f.submit(f.alpha,`a${i}`);f.submit(f.beta,`b${i}`);}const counts={alpha:0,beta:0};
 for(let i=0;i<6;i++){const hints=f.hints(),chosen=f.bindings.fairness.choose(hints)!,target=chosen.project.slug==="alpha"?f.alpha:f.beta;const tasks=await target.port.claimTurn({owner:"worker"},hints);expect(tasks).toHaveLength(1);counts[target.identity.slug as keyof typeof counts]++;target.port.authorizeStart(tasks);await target.port.taskLeases.finish({lease:capturedLease(tasks[0]!),operationId:leaseOperationId(f.now()),state:"completed",result:syntheticResult(tasks[0]!.row.id,"completed","fixture")});await target.port.drain();}
 expect(counts).toEqual({alpha:4,beta:2});for(const p of[f.alpha,f.beta])expect(p.db.prepare("SELECT * FROM meta WHERE key LIKE 'claim_%'").all()).toEqual([]);
 expect(f.global.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'claim_pass:%'").get()).toEqual({n:2});expect(JSON.stringify(f.global.prepare("SELECT * FROM meta").all())).not.toContain("private-");
});
it("cancels an exact claimed attempt before start without consuming or executing it",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const tasks=await f.claim(),lease=capturedLease(tasks[0]!);
 await f.alpha.port.taskLeases.cancel({operationId:leaseOperationId(f.now()),actor:"control",project:"alpha",targets:[{taskId:lease.taskId,incarnation:lease.incarnation,runCount:lease.runCount}]});
 expect(()=>f.alpha.port.authorizeStart(tasks)).toThrow(/cancelled, expired or replaced/);
 await f.alpha.port.taskLeases.interrupt({lease,operationId:leaseOperationId(f.now()),reason:"cancelled before start"});await f.alpha.port.drain();
 expect(f.alpha.tasks.get("one")!.row.state).toBe("cancelled");expect(f.global.prepare("SELECT state FROM project_execution_grants").get()).toEqual({state:"revoked"});
});
it("keeps a durable started marker across port reconstruction and never consumes it twice",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const tasks=await f.claim();f.alpha.port.authorizeStart(tasks);
 const rebuilt=new ProjectQueueBindings(f.grants).bindLocal(f.alpha.port.local);ports.push(rebuilt);
 expect(rebuilt.authorizeStart(tasks)).toBe("already_started");expect(f.global.prepare("SELECT COUNT(*) n FROM project_execution_grants").get()).toEqual({n:1});
});
it("admits a delegated supervisor with validated local lineage without spending worker or root supervisor slots",async()=>{
 const f=fixture({maxTasks:1});f.submit(f.alpha,"parent",{profile:"supervise"});const parent=await f.claim();f.alpha.port.authorizeStart(parent);
 f.submit(f.alpha,"child",{profile:"supervise",parentTaskId:"parent"});const child=await f.claim();expect(child).toHaveLength(1);expect(f.alpha.port.authorizeStart(child)).toBe("fresh");
 const grants=f.global.prepare("SELECT id FROM project_execution_grants").all() as Array<{id:string}>;expect(grants.map(row=>f.grants.read(row.id)!.input.delegatedSupervisor??false).sort()).toEqual([false,true]);
 f.submit(f.alpha,"worker");expect((await f.claim()).map(task=>task.row.id)).toEqual(["worker"]);
 f.submit(f.alpha,"grandchild",{profile:"supervise",parentTaskId:"child"});await expect(f.claim()).rejects.toThrow(/depth policy/);expect(f.alpha.tasks.get("grandchild")!.row.run_count).toBe(0);
});
it.each(["missing","foreign","worker"] as const)("refuses %s parent lineage rather than accepting a delegated flag",async kind=>{
 const f=fixture();if(kind==="foreign")f.submit(f.beta,"parent",{profile:"supervise"});if(kind==="worker")f.submit(f.alpha,"parent");
 f.submit(f.alpha,"child",{profile:"supervise",parentTaskId:"parent"});
 if(kind==="worker"){const parent=await f.claim();f.alpha.port.authorizeStart(parent);await f.alpha.port.taskLeases.finish({lease:capturedLease(parent[0]!),operationId:leaseOperationId(f.now()),state:"completed",result:syntheticResult(parent[0]!.row.id,"completed","fixture")});await f.alpha.port.drain();}
 await expect(f.claim()).rejects.toThrow(/same-project supervisor lineage/);expect(f.alpha.tasks.get("child")!.row).toMatchObject({state:"queued",run_count:0});
});
it("permits an already queued child of an interrupted parent while preserving maxAgents",async()=>{
 const f=fixture();f.submit(f.alpha,"parent",{profile:"supervise"});const parent=await f.claim();f.alpha.port.authorizeStart(parent);
 await f.alpha.port.taskLeases.interrupt({lease:capturedLease(parent[0]!),operationId:leaseOperationId(f.now()),reason:"parent paused"});await f.alpha.port.drain();
 f.submit(f.alpha,"child",{profile:"supervise",parentTaskId:"parent"});expect((await f.claim()).map(task=>task.row.id)).toEqual(["child"]);
});

it("retains exact physical request holds when a terminal outbox acknowledges an already revoked grant",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const tasks=await f.claim();f.alpha.port.authorizeStart(tasks);const refs=f.alpha.port.refsForRequest(tasks.map(capturedLease));
 const {ProviderCapacity}=await import("../src/gateway/capacity.js");const capacity=new ProviderCapacity(f.now);capacity.attachCoordination(f.global,()=>({provider_concurrency_enabled:true,provider_concurrency_start:1,provider_concurrency_max:1,provider_concurrency_increase_after:5,provider_concurrency_limits:{}}),()=>60000,f.grants);
 const slot=capacity.tryAcquire({id:"held-request",taskIds:["one"],leaseOwner:"worker",priority:0,since:null,leases:tasks.map(capturedLease),executionGrants:refs},"fixture");expect(slot).toHaveProperty("nonce");
 f.grants.revoke(refs[0]!);await f.alpha.port.taskLeases.finish({lease:capturedLease(tasks[0]!),operationId:leaseOperationId(f.now()),state:"completed",result:syntheticResult("one","completed","fixture")});await f.alpha.port.drain();
 expect(f.alpha.db.prepare("SELECT phase,terminal_state FROM project_execution_claims").get()).toEqual({phase:"terminal",terminal_state:"revoked"});expect(capacity.usage("fixture").requests).toBe(1);
});
it("enforces the actual local parent agent cap before reserving another delegated unit",async()=>{
 const f=fixture();f.alpha.cfg.team.max_agents=1;f.submit(f.alpha,"parent",{profile:"supervise"});const parent=await f.claim();f.alpha.port.authorizeStart(parent);
 f.submit(f.alpha,"first-child",{profile:"supervise",parentTaskId:"parent"});const child=await f.claim();f.alpha.port.authorizeStart(child);f.submit(f.alpha,"second-child",{profile:"supervise",parentTaskId:"parent"});
 expect(await f.claim()).toEqual([]);expect(f.alpha.tasks.get("second-child")!.row.run_count).toBe(0);expect(f.global.prepare("SELECT COUNT(*) n FROM project_execution_grants").get()).toEqual({n:2});
});
import { ProjectRuntimeRegistry,type ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { createProjectRuntimeServices } from "../src/projects/runtime-services.js";
import { ProjectScheduler } from "../src/core/project-scheduler.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { ProviderHealth } from "../src/gateway/gate.js";
import { ProviderSlotAdmission } from "../src/routing/claim-capacity.js";
import { PaidSpend } from "../src/paid/spend.js";
import { KeyVault } from "../src/providers/vault.js";
import { Catalog } from "../src/models/catalog.js";
import { SqliteRequestAccountingBroker } from "../src/admission/sqlite-accounting-broker.js";
import { limitScopes } from "../src/providers/limits.js";
import { baseResult,type RunContext } from "../src/runners/types.js";
import { reply,goodOutput } from "./helpers.js";
const activeSchedulers:ProjectScheduler[]=[],activeRegistries:ProjectRuntimeRegistry[]=[],releaseCalls:Array<()=>void>=[];
afterEach(async()=>{for(const release of releaseCalls.splice(0))release();await Promise.all(activeSchedulers.splice(0).map(s=>s.stop()));await Promise.all(activeRegistries.splice(0).map(r=>r.close()));});
function runtimeFixture(options:{batch?:boolean;headroom?:boolean;supervisor?:(ctx:RunContext)=>Promise<void>}={}){
 const raw=baseConfig({repositories:{},projects:{alpha:{priority:2},beta:{priority:1}},team:{provider_concurrency_enabled:options.headroom??false,provider_concurrency_start:1,provider_concurrency_max:1}}),profiles=raw.profiles as Record<string,Record<string,unknown>>;
 profiles.summarize={...profiles.summarize,batching:{enabled:options.batch??false,max_items:4}};profiles.supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:30,classify:"never"};
 const env=makeEnv({config:raw});envs.push(env);let now=Date.now();const globalDir=path.join(env.dir,"global"),global=openDatabase(globalDir,{durability:"full"});dbs.push(global);const installation=createCoordinationStoreIdentity();initializeStoreRole(global,installation);
 let bindings!:ProjectQueueBindings;const limits={maxTasks:4,maxSupervisors:1,maxWritersPerRepository:1,projectMaxTasks:null};const grants=new ProjectExecutionGrants(global,()=>limits,()=>now,(g,p)=>bindings.renewalAuthority(g,p),input=>bindings.delegationAuthority(input));bindings=new ProjectQueueBindings(grants);
 const calls:string[]=[],vault=new KeyVault(global,globalDir),spend=new PaidSpend(global,env.cfg,vault,()=>now);let barrier:Promise<void>|null=null,release=()=>{};
 const providers=new ProviderRuntime(env.cfg,global,vault,{now:()=>now,client:{complete:async request=>{const text=JSON.stringify(request.chat.messages);calls.push(text);await barrier;const ids=[...text.matchAll(/<item id=\\?"(i\d+)\\?">/g)].map(m=>m[1]!);const output=ids.length?{items:ids.map(id=>({id,result:goodOutput(1,"inline")}))}:goodOutput(1,"inline");return{...reply(JSON.stringify(output),{model:request.model,provider:"openrouter"}),rateLimits:{family:"openrouter",observedAt:now,retryAfterMs:null,windows:[]}};}}});
 const health=new ProviderHealth(()=>now,()=>providers.statuses(),p=>providers.statusPlatform(p)),catalog=new Catalog(global,env.cfg.modelsPath,{requireConfirmationForHeuristicParams:false}),endpoint=catalog.endpoints().find(e=>e.providerId==="openrouter")!;
 const broker=new SqliteRequestAccountingBroker(global,{cfg:env.cfg,spend,now:()=>now,authorize:(id,keyRef)=>{const credential=keyRef?providers.credentials().get(keyRef):null,provider=providers.provider("openrouter")!;return{endpointId:id,keyRef,provider:"openrouter",platform:"openrouter",enabled:!!credential?.enabled,providerUsageScopes:credential?limitScopes(provider,credential,{model:endpoint.route.model}).map(scope=>scope.id):[],paid:null};}});
 const admissions=new Map<string,ProviderSlotAdmission>();
 const contexts=new Map<string,ReturnType<typeof projectContext>>();for(const slug of["alpha","beta"]){const identity=createProjectStoreIdentity(installation.installationId,slug),root=path.join(env.dir,slug),paths=projectRuntimePaths(root),local=openDatabase(paths.state,{durability:"full"});initializeStoreRole(local,identity);local.close();registerProjectStore(global,identity,root);contexts.set(slug,projectContext(env.cfg,{project:{slug,name:slug,legacy:false},projectDirectory:root,brain:{...env.cfg.brain,project:slug,path:paths.brain}}));}
 const registry=new ProjectRuntimeRegistry(global,{context:slug=>contexts.get(slug)!,build:input=>createProjectRuntimeServices(input,{coordinationDb:global,coordinationConfig:env.cfg,catalog,health,direct:{providers,spend},grants,broker,owner:"worker",now:()=>now,executionGrants:(input,request)=>bindings.forProject(input.identity).refsForRequest(request.participants.map(p=>p.lease)),privateServices:local=>{const admission=options.headroom?new ProviderSlotAdmission(local.cfg,local.router,health.capacity,()=>now):undefined;if(admission)admissions.set(local.identity.slug,admission);const port=bindings.bindLocal(local,{...(admission?{providerSlots:admission}:{})});return{coding:null,supervisor:options.supervisor?{run:async ctx=>{await options.supervisor!(ctx);return{state:"completed",result:baseResult({stopReason:"fixture supervisor",summary:ctx.taskId})};}}:null,brain:null,access:null,services:null,servicesForLease:lease=>{if(!local.tasks.dispatchable(lease.taskId,lease.owner,lease.runCount,lease.incarnation,lease.project))throw Error("stale fixture actor");const denied=()=>{throw Error("fixture graph tools disabled");};return{submitTasks:async()=>denied(),awaitResults:async()=>denied(),getTask:()=>null,cancelTasks:denied,acceptTask:denied,rejectTask:denied};},taskLeases:port.taskLeases,onSettled:()=>{}};}})});activeRegistries.push(registry);
 const scheduler=new ProjectScheduler(env.cfg,registry,bindings,{owner:"worker",now:()=>now,maxTurnsPerTick:4});activeSchedulers.push(scheduler);
 const alpha=registry.forSlug("alpha"),beta=registry.forSlug("beta");
 const submit=(bundle:ProjectRuntimeBundle,id:string,extra:Record<string,unknown>={})=>bundle.tasks.submit([WorkerTaskSchema.parse(summarizeTask({id,goal:`private-${bundle.project}-${id}`,context:{inlineText:`private-context-${bundle.project}`},routing:{endpointId:endpoint.id,tier:"T1"},...extra}))],{project:bundle.project});
 const hold=()=>{barrier=new Promise<void>(resolve=>{release=resolve;});releaseCalls.push(()=>release());};
 return{env,global,grants,bindings,limits,registry,scheduler,alpha,beta,calls,admissions,submit,hold,release:()=>release(),now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
async function until(test:()=>boolean,ms=8000){const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error("project queue fixture observation deadline");await new Promise(resolve=>setTimeout(resolve,5));}}
it("fair fan-out starts actual independent local Executors and records duplicate task IDs only locally",async()=>{
 const f=runtimeFixture();f.submit(f.alpha,"same");f.advance(1);f.submit(f.beta,"same");await f.scheduler.tick();await until(()=>f.alpha.tasks.get("same")!.row.state==="completed"&&f.beta.tasks.get("same")!.row.state==="completed");
 expect(f.alpha.executor).not.toBe(f.beta.executor);expect(f.calls).toHaveLength(2);for(const bundle of[f.alpha,f.beta]){expect(bundle.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({n:1});expect(bundle.sessions!.forTask("same").length).toBeGreaterThan(0);assertStoreRole(bundle.db,bundle.identity);}
 for(const table of["tasks","sessions","model_requests","request_captures"])expect(f.global.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
 expect(JSON.stringify(f.global.prepare("SELECT * FROM meta").all())).not.toContain("private-");
},15000);
it("runs a sealed completion batch through one actual provider request and one global execution unit",async()=>{
 const f=runtimeFixture({batch:true,headroom:true});f.limits.maxTasks=1;f.submit(f.alpha,"one");f.submit(f.alpha,"two");await f.scheduler.tick();await until(()=>f.alpha.tasks.get("one")!.row.state==="completed"&&f.alpha.tasks.get("two")!.row.state==="completed");
 expect(f.calls).toHaveLength(1);const rows=f.global.prepare("SELECT id FROM project_execution_grants").all() as Array<{id:string}>;expect(rows).toHaveLength(1);expect(f.grants.read(rows[0]!.id)!.input.leases).toHaveLength(2);expect(f.alpha.db.prepare("SELECT COUNT(*) n FROM model_requests").get()).toEqual({n:1});
},15000);
it("defers a lost provider headroom race without starting a second Executor or refunding a physical request",async()=>{
 const f=runtimeFixture({headroom:true});vi.spyOn(f.admissions.get("beta")!,"check").mockReturnValue(null);f.hold();f.submit(f.alpha,"same");f.advance(1);f.submit(f.beta,"same");await f.scheduler.tick();await until(()=>f.calls.length===1);
 expect(f.beta.tasks.get("same")!.row.state).toBe("waiting_for_capacity");expect(f.global.prepare("SELECT COUNT(*) n FROM provider_slots WHERE kind='request'").get()).toEqual({n:1});expect(f.beta.sessions!.forTask("same")).toHaveLength(0);
 f.release();await until(()=>f.alpha.tasks.get("same")!.row.state==="completed");f.advance(1500);await f.scheduler.tick();await until(()=>f.beta.tasks.get("same")!.row.state==="completed");expect(f.calls).toHaveLength(2);
},15000);
it("makes real nested supervisor progress while the parent occupies the only root-supervisor slot",async()=>{
 const order:string[]=[];let childDone!:()=>void;const childStarted=new Promise<void>(resolve=>{childDone=resolve;});
 const f=runtimeFixture({supervisor:async ctx=>{order.push(ctx.taskId);if(ctx.taskId==="parent")await childStarted;else childDone();}});f.limits.maxTasks=1;
 f.submit(f.alpha,"parent",{profile:"supervise"});f.submit(f.alpha,"child",{profile:"supervise",parentTaskId:"parent"});await f.scheduler.tick();await until(()=>f.alpha.tasks.get("parent")!.row.state==="completed"&&f.alpha.tasks.get("child")!.row.state==="completed");
 expect(order).toEqual(["parent","child"]);const grants=f.global.prepare("SELECT id FROM project_execution_grants").all() as Array<{id:string}>;expect(grants.map(row=>f.grants.read(row.id)!.input.delegatedSupervisor??false).sort()).toEqual([false,true]);expect(f.calls).toHaveLength(0);
},15000);
it("stops after awaited admission before any actual Executor entry",async()=>{
 const f=runtimeFixture(),port=f.bindings.forProject(f.alpha.identity),admit=port.authorizeStart.bind(port);let stopping:Promise<void>|undefined;
 vi.spyOn(port,"authorizeStart").mockImplementation(members=>{const result=admit(members);stopping=f.scheduler.stop();return result;});
 f.submit(f.alpha,"one");await f.scheduler.tick();await stopping;await port.drain();
 expect(f.calls).toHaveLength(0);expect(f.alpha.sessions!.forTask("one")).toHaveLength(0);expect(f.alpha.tasks.get("one")!.row.state).toBe("interrupted");expect(f.global.prepare("SELECT state FROM project_execution_grants").all()).toEqual([{state:"revoked"}]);
},15000);
it("reopens exact local/global stores without replaying an admitted execution",async()=>{
 const f=fixture();f.submit(f.alpha,"one");const tasks=await f.claim();f.alpha.port.authorizeStart(tasks);await f.alpha.port.drain();
 const localDir=path.dirname(f.alpha.db.name),globalDir=path.dirname(f.global.name);f.alpha.db.close();f.global.close();
 const global=openDatabase(globalDir,{fileMustExist:true,durability:"full"});dbs.push(global);const local=openDatabase(localDir,{fileMustExist:true,expectedIdentity:f.alpha.identity,durability:"full"});dbs.push(local);
 let bindings!:ProjectQueueBindings;const grants=new ProjectExecutionGrants(global,()=>f.limits,f.now,(grant,proof)=>bindings.renewalAuthority(grant,proof),input=>bindings.delegationAuthority(input));bindings=new ProjectQueueBindings(grants);
 const store=new TaskStore(local,f.now),assert=()=>{expect(global.inTransaction).toBe(false);assertStoreRole(local,f.alpha.identity);expect(readProjectStoreRegistration(global,f.alpha.identity.projectId)?.generation).toBe(f.alpha.identity.generation);};
 const port=bindings.bindLocal({identity:f.alpha.identity,cfg:f.alpha.cfg,db:local,tasks:store,assertCurrent:assert,assertPinned:assert});ports.push(port);
 expect(port.authorizeStart(tasks)).toBe("already_started");f.advance(3600000);expect(global.prepare("SELECT state FROM project_execution_grants").all()).toEqual([{state:"active"}]);
 await port.taskLeases.recover({operationId:recoveryOperationId(f.now()),mode:"expired_only"});await port.drain();expect(global.prepare("SELECT state FROM project_execution_grants").all()).toEqual([{state:"revoked"}]);
 expect(()=>port.refsForRequest(tasks.map(capturedLease))).toThrow();
});
