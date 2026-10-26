import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole, assertStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { ProjectExecutionGrants } from "../src/storage/project-execution-grants.js";
import { TaskStore } from "../src/storage/tasks.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { parseConfig } from "../src/config/load.js";
import { Admission } from "../src/admission/admission.js";
import { ProjectRequestLedger } from "../src/admission/project-request-ledger.js";
import { SqliteRequestAccountingBroker } from "../src/admission/sqlite-accounting-broker.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { limitScopes } from "../src/providers/limits.js";
import { KeyVault } from "../src/providers/vault.js";
import { PaidSpend } from "../src/paid/spend.js";
import { Catalog } from "../src/models/catalog.js";
import { Gate, ProviderHealth, type GateRequest } from "../src/gateway/gate.js";
import { TaskRouter } from "../src/routing/router.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { baseConfig, makeEnv, reply, summarizeTask, type Env } from "./helpers.js";

const databases:Db[]=[],gates:Gate[]=[];
let env:Env|undefined;
afterEach(async()=>{await Promise.all(gates.splice(0).map(gate=>gate.close()));for(const db of databases.splice(0))if(db.open)db.close();env?.cleanup();env=undefined;});
function fixture(){
  env=makeEnv({config:baseConfig({repositories:{},allocation:{max_model_requests_per_hour:2,max_model_requests_per_day:2},brain:{path:"brain",project:"alpha"},projects:{alpha:{},beta:{}}})});
  const now=1800000000000,globalDir=path.join(env.dir,"coordination"),global=openDatabase(globalDir,{durability:"full"});databases.push(global);
  const owner=createCoordinationStoreIdentity();initializeStoreRole(global,owner);
  const calls:string[]=[];
  const vault=new KeyVault(global,globalDir),spend=new PaidSpend(global,env.cfg,vault,()=>now);
  const providers=new ProviderRuntime(env.cfg,global,vault,{now:()=>now,client:{complete:async request=>{
    calls.push(JSON.stringify(request.chat.messages));
    return {...reply("private-output",{model:request.model,provider:"openrouter"}),rateLimits:{family:"openrouter",observedAt:now,retryAfterMs:null,windows:[]}};
  }}});
  const health=new ProviderHealth(()=>now,()=>providers.statuses(),platform=>providers.statusPlatform(platform));
  const grants=new ProjectExecutionGrants(global,()=>({maxTasks:8,maxSupervisors:2,maxWritersPerRepository:2,projectMaxTasks:4}),()=>now);
  const catalog=new Catalog(global,env.cfg.modelsPath,{requireConfirmationForHeuristicParams:false});
  const endpoint=catalog.endpoints().find(item=>item.providerId==="openrouter")!;
  const broker=new SqliteRequestAccountingBroker(global,{cfg:env.cfg,spend,now:()=>now,authorize:(id,keyRef)=>{
    const credential=keyRef ? providers.credentials().get(keyRef) : null,provider=providers.provider("openrouter")!;
    return {endpointId:id,keyRef,provider:"openrouter",platform:"openrouter",enabled:!!credential?.enabled,
      providerUsageScopes:credential ? limitScopes(provider,credential,{model:endpoint.route.model}).map(scope=>scope.id):[],paid:null};
  }});
  function project(slug:string){
    const root=path.join(env!.dir,slug),identity=createProjectStoreIdentity(owner.installationId,slug);
    const cfg=parseConfig(baseConfig({repositories:{},allocation:{max_model_requests_per_hour:2,max_model_requests_per_day:2},brain:{path:path.join(root,".MeritRouter","brain"),project:slug},storage:{directory:path.join(root,".MeritRouter","state")},projects:{alpha:{},beta:{}}}),env!.cfg.configPath);
    const local=openDatabase(cfg.storageDir,{durability:"full"});databases.push(local);initializeStoreRole(local,identity);registerProjectStore(global,identity,root);
    local.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?)").run(slug,slug,now);
    const tasks=new TaskStore(local,()=>now);tasks.submit([WorkerTaskSchema.parse(summarizeTask({id:"same-task"}))],{project:slug});
    local.prepare("UPDATE tasks SET state='running',lease_owner='worker',lease_expires_at=?,deadline_at=?,run_count=1 WHERE id='same-task'").run(now+60000,now+60000);
    const lease=capturedLease(tasks.get("same-task")!),admission=new Admission(local,tasks,cfg,()=>now);
    const executionId=admission.createExecution("task","summarize",[{taskId:"same-task",itemId:"same-task"}]);
    const grant=grants.reserve({grantId:randomUUID(),project:identity,leases:[lease],role:"worker",repositoryDigests:[],expiresAt:now+60000}).grant.ref;grants.consume(grant);
    const ledger=new ProjectRequestLedger(admission,{identity,cfg,broker});
    const context={coordinationDb:global,coordinationConfig:env!.cfg,identity,capacityGrants:grants,executionGrants:()=>[grant]};
    const gate=new Gate(local,cfg,admission,health,{providers,spend},ledger,undefined,context);gates.push(gate);
    const request:GateRequest={executionId,purpose:"execution",plan:{profile:"summarize",tier:"T1",floorB:0,candidates:[endpoint],explanations:[],forced:false,belowFloorEndpoints:new Set()},
      participants:[{taskId:"same-task",leaseOwner:"worker",lease,budget:{maxModelRequests:4,maxInputTokens:null,maxOutputTokens:null,maxPaidUsd:null}}],
      chat:{messages:[{role:"user",content:`private-${slug}`}],max_tokens:100}};
    const router=new TaskRouter(cfg,local,catalog,gate,new ArtifactStore(local,cfg.storageDir,()=>now),()=>now);
    return {local,identity,cfg,gate,admission,ledger,context,request,router,tasks};
  }
  return {global,owner,providers,spend,health,calls,project};
}
it("routes two private project stores through one shared quota without global task or capture copies",async()=>{
  const f=fixture(),alpha=f.project("alpha"),beta=f.project("beta");
  await alpha.router.prepare(alpha.tasks.get("same-task")!,"worker");
  expect(alpha.local.prepare("SELECT classification_json FROM tasks WHERE id='same-task'").get()).toEqual({classification_json:expect.any(String)});
  await alpha.gate.request(alpha.request);await beta.gate.request(beta.request);
  expect(f.calls).toHaveLength(2);expect(f.calls[0]).toContain("private-alpha");expect(f.calls[1]).toContain("private-beta");
  await expect(alpha.gate.request(alpha.request)).rejects.toThrow();expect(f.calls).toHaveLength(2);
  for(const project of [alpha,beta]){
    expect(project.admission.taskTotals("same-task").requests).toBe(1);assertStoreRole(project.local,project.identity);
    const capture=JSON.stringify(project.local.prepare("SELECT * FROM request_captures").all());
    expect(capture).toContain(`private-${project.identity.slug}`);expect(capture).toContain("private-output");
    expect(capture).not.toContain(`private-${project.identity.slug==="alpha" ? "beta":"alpha"}`);
  }
  for(const table of ["tasks","sessions","model_requests","request_captures","classifications"])expect(f.global.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
  expect(f.global.prepare("SELECT COUNT(*) n FROM physical_requests").get()).toEqual({n:2});
  expect(JSON.stringify(f.global.prepare("SELECT * FROM physical_requests").all())).not.toMatch(/private-alpha|private-beta|private-output/);
});
it("refuses cross-project participants before provider transport",async()=>{
  const f=fixture(),alpha=f.project("alpha"),beta=f.project("beta");
  await expect(alpha.gate.request({...alpha.request,participants:beta.request.participants})).rejects.toThrow(/pinned store/);
  expect(f.calls).toEqual([]);
});
it("never reattaches shared split health to a legacy project database",()=>{
  const f=fixture(),alpha=f.project("alpha");
  expect(()=>new Gate(alpha.local,alpha.cfg,alpha.admission,f.health,{providers:f.providers,spend:f.spend})).toThrow(/cannot be rebound/);
  expect(f.calls).toEqual([]);assertStoreRole(alpha.local,alpha.identity);
});
it("rejects project-local provider bookkeeping before it can write shared authority into private storage",()=>{
  const f=fixture(),alpha=f.project("alpha");
  const providers=new ProviderRuntime(alpha.cfg,alpha.local,null,{client:f.providers.client});
  expect(()=>new Gate(alpha.local,alpha.cfg,alpha.admission,f.health,{providers,spend:f.spend},alpha.ledger,undefined,alpha.context)).toThrow(/separate pinned/);
  expect(f.calls).toEqual([]);assertStoreRole(alpha.local,alpha.identity);
});
