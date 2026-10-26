import type { ResolvedConfig } from "../config/load.js";
import { Executor,type ExecutorDeps } from "../core/executor.js";
import { Admission } from "../admission/admission.js";
import { ProjectRequestLedger } from "../admission/project-request-ledger.js";
import type { RequestAccountingBroker } from "../admission/accounting-broker.js";
import { TaskStore } from "../storage/tasks.js";
import { SessionStore } from "../sessions/store.js";
import { ArtifactStore } from "../storage/artifacts.js";
import { ContractStore } from "../verification/contract.js";
import { Gate,type ProviderHealth,type DirectRuntime,type GateRequest } from "../gateway/gate.js";
import type { Catalog } from "../models/catalog.js";
import { TaskRouter } from "../routing/router.js";
import { immediate,type Db } from "../storage/db.js";
import type { ExecutionGrantRef,ProjectExecutionGrants } from "../storage/project-execution-grants.js";
import { assertStoreRole } from "../storage/store-role.js";
import { createSplitProjectRuntimeStore,projectStoresForTask } from "./runtime-store.js";
import type { ProjectRuntimeBundle,ProjectRuntimeConstruction } from "./runtime-registry.js";

export type ProjectPrivateExecutorServices=Pick<ExecutorDeps,"coding"|"supervisor"|"brain"|"access"|"services"|"onSettled"> & Partial<Pick<ExecutorDeps,"web"|"labs"|"ensureLabsSupervisor"|"taskLeases"|"servicesForLease">>;
export interface ProjectRuntimeServiceHost {
 coordinationDb:Db;coordinationConfig:ResolvedConfig;catalog:Catalog;health:ProviderHealth;direct:DirectRuntime;
 grants:ProjectExecutionGrants;broker:RequestAccountingBroker;owner:string;now?:()=>number;
 executionGrants(input:ProjectRuntimeConstruction,request:GateRequest):readonly ExecutionGrantRef[];
 /** Scope every callback to this exact local project; never return installation task/session stores. */
 privateServices(input:ProjectRuntimeConstruction & {tasks:TaskStore;sessions:SessionStore;artifacts:ArtifactStore;contracts:ContractStore;admission:Admission;gate:Gate;router:TaskRouter}):ProjectPrivateExecutorServices;
}
/** One complete local execution service graph sharing only explicit coordination facilities. */
export function createProjectRuntimeServices(input:ProjectRuntimeConstruction,host:ProjectRuntimeServiceHost):ProjectRuntimeBundle{
 const {identity,cfg,paths,db}=input,now=host.now??Date.now;assertStoreRole(db,identity);
 if(host.coordinationDb===db||host.grants.db!==host.coordinationDb)throw new Error("Project runtime requires separate matching coordination services");
 immediate(db,()=>db.prepare("INSERT INTO projects(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").run(identity.slug,cfg.project.name,now()));
 const tasks=new TaskStore(db,now),sessions=new SessionStore(db,paths.root,now),artifacts=new ArtifactStore(db,paths.root,now),contracts=new ContractStore(db),admission=new Admission(db,tasks,cfg,now);
 const ledger=new ProjectRequestLedger(admission,{identity,cfg,broker:host.broker});
 const gate=new Gate(db,cfg,admission,host.health,host.direct,ledger,undefined,{coordinationDb:host.coordinationDb,coordinationConfig:host.coordinationConfig,identity,capacityGrants:host.grants,assertRuntime:()=>{input.assertCurrent();return undefined;},executionGrants:request=>host.executionGrants(input,request)});
 const request=gate.request.bind(gate);gate.request=value=>{input.assertCurrent();return request(value);};
 const router=new TaskRouter(cfg,db,host.catalog,gate,artifacts,now);
 const local={...input,tasks,sessions,artifacts,contracts,admission,gate,router},privateServices=host.privateServices(local);
 const executor=new Executor({...privateServices,cfg,db,gate,catalog:host.catalog,router,tasks,artifacts,owner:host.owner,now,sessions,contracts});
 const store=createSplitProjectRuntimeStore(identity,{db,tasks,sessions,artifacts,contracts});
 let closing=false,closingPromise:Promise<void>|null=null;const pending=new Set<Promise<void>>();
 const single=executor.runSingle.bind(executor),batch=executor.runBatch.bind(executor);
 const track=(work:()=>Promise<void>):Promise<void>=>{if(closing)return Promise.reject(new Error("Project executor is closing"));const p=Promise.resolve().then(work);pending.add(p);void p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
 // Keep actual Executor identity while tracking every public execution entry, including scheduler callers.
 executor.runSingle=task=>track(()=>{input.assertCurrent();projectStoresForTask(store,task,cfg);return single(task);});executor.runBatch=items=>track(()=>{input.assertCurrent();if(!items.length)throw new Error("Project batch cannot be empty");for(const task of items)projectStoresForTask(store,task,cfg);return batch(items);});
 return Object.freeze({...store,assertCurrent:input.assertCurrent,assertPinned:input.assertPinned??input.assertCurrent,identity,cfg,paths,admission,ledger,gate,router,executor,taskLeases:executor.taskLeases,brain:privateServices.brain,access:privateServices.access,
  runSingle:executor.runSingle.bind(executor),runBatch:executor.runBatch.bind(executor),
  drain:()=>{if(closingPromise)return closingPromise;closing=true;closingPromise=(async()=>{executor.abortAll("shutdown");while(pending.size)await Promise.allSettled([...pending]);await executor.flush();await gate.close();await ledger.drain();})();return closingPromise;}});
}
