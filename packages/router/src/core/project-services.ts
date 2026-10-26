import { MAX_PLAN_NODES } from "../storage/plans.js";
import { loadConfig } from "../config/load.js";
import { z } from "zod";
import { immediate } from "../storage/db.js";
import { LeaseRefSchema,type LeaseRef } from "../storage/task-leases.js";
import type { StoredTask } from "../storage/tasks.js";
import type { WorkerTask,WorkerResult } from "./task.js";
import { isTerminal } from "./task.js";
import { validateTask } from "./validate.js";
import { parentImportance,recordAcceptanceDecision,verificationBudgetShortfall } from "./acceptance.js";
import type { ProjectRuntimeBundle } from "../projects/runtime-registry.js";
import type { SupervisorServices,AcceptanceDecisionInput } from "../runners/types.js";
import { currentSupervisorAuthority,projectToolIdentity } from "./supervisor-authority.js";

export interface ProjectRunServicePolicies {
 knownEndpoint(id:string):boolean;
 /** Recheck trusted Lab/supervision/task policy under the local insertion transaction. */
 beforeSubmit(spec:WorkerTask):void;
 bindSubmitted(task:StoredTask):void;
 /** Actual local Lab/workspace/check metadata fence, never a model-supplied waiver. */
 beforeAccept(task:StoredTask):void;
 changed(ids:readonly string[]):void;
}
const bindings=new WeakMap<SupervisorServices,{runtime:ProjectRuntimeBundle;lease:LeaseRef}>();
export function assertProjectServiceBinding(services:SupervisorServices|null,db:ProjectRuntimeBundle["db"],lease:LeaseRef):void {
 if(!projectToolIdentity(db,lease.project))return;
 const bound=services?bindings.get(services):null;
 if(!bound||bound.runtime.db!==db||JSON.stringify(bound.lease)!==JSON.stringify(lease))throw new Error("Split supervisor requires exact lease-bound project services");
 bound.runtime.assertCurrent();
}
/** Actual callbacks over one pinned local service graph; installation service methods are never delegated. */
export function createProjectRunServices(runtime:ProjectRuntimeBundle,value:LeaseRef,policies:ProjectRunServicePolicies):SupervisorServices {
 const lease=LeaseRefSchema.parse(value),now=()=>runtime.tasks.serverNow(),observed=new Map<string,string>();
 const authority=()=>{runtime.assertCurrent();if(runtime.tasks.db!==runtime.db||runtime.admission.db!==runtime.db||lease.project!==runtime.identity.slug||!currentSupervisorAuthority(runtime.db,runtime.cfg,lease,now()))throw new Error("Active owning project supervisor authority required");};
 const owned=(id:string,allowSelf=false):StoredTask=>{
  authority();const task=runtime.tasks.get(z.string().min(1).parse(id));if(!task||task.row.project_id!==runtime.identity.slug||(!allowSelf&&id===lease.taskId))throw new Error("Task is outside the owning supervisor graph");
  const seen=new Set<string>();let cur:StoredTask|undefined=task;
  while(cur&&cur.row.id!==lease.taskId){if(seen.has(cur.row.id)||cur.row.project_id!==runtime.identity.slug)throw new Error("Invalid supervisor descendant graph");seen.add(cur.row.id);cur=cur.spec.parentTaskId?runtime.tasks.get(cur.spec.parentTaskId):undefined;}
  if(!cur)throw new Error("Task is outside the owning supervisor graph");const old=observed.get(id);if(old&&old!==task.row.lease_incarnation)throw new Error("Owned task incarnation changed");observed.set(id,task.row.lease_incarnation);return task;
 };
 const session=(id:string|undefined)=>{if(!id)return;const row=runtime.sessions?.get(id);if(!row||row.taskId!==lease.taskId||row.role!=="supervisor"||row.status!=="running")throw new Error("Delegating session does not belong to current supervisor");};
 const collect=(ids:string[])=>{const completed:WorkerResult[]=[],pending:Array<{taskId:string;state:string}>=[];for(const id of ids){const task=owned(id);if((isTerminal(task.row.state)||task.row.state==="interrupted")&&task.result)completed.push(task.result);else pending.push({taskId:id,state:task.row.state});}return {completed,pending};};
 const decide=(id:string,input:AcceptanceDecisionInput,decision:"accept"|"reject")=>immediate(runtime.db,()=>{const task=owned(id);const parsed=z.object({by:z.object({kind:z.literal("supervisor"),id:z.string()}).strict(),reason:z.string().nullable().optional()}).strict().parse(input);const result=recordAcceptanceDecision({cfg:runtime.cfg,tasks:runtime.tasks,contracts:runtime.contracts,now,beforeAccept:current=>{owned(current.row.id);if(policies.beforeAccept(current)!==undefined)throw new Error("Acceptance policy must be synchronous");}},task.row.id,decision,{by:{kind:"supervisor",id:lease.taskId},reason:parsed.reason});policies.changed([id]);return result;});
 const services:SupervisorServices={
  submitTasks:async(raw,opts={})=>{
   authority();const options=z.object({purpose:z.literal("work").optional(),parentSessionId:z.string().optional()}).strict().parse(opts);session(options.parentSessionId);
   const values=z.array(z.record(z.string(),z.unknown())).min(1).max(MAX_PLAN_NODES).parse(raw);
   for(const value of values){if(value.parentTaskId!==undefined&&value.parentTaskId!==lease.taskId)throw new Error("Model cannot change the owning parent");if(value.project!==undefined||value.projectId!==undefined)throw new Error("Model cannot choose another project");}
   const specs:WorkerTask[]=[];for(const value of values)specs.push(await validateTask(runtime.cfg,{...value,parentTaskId:lease.taskId},runtime.artifacts,{knownEndpoint:policies.knownEndpoint}));
   const prospective=new Set(specs.flatMap(spec=>spec.id?[spec.id]:[]));
   const result=immediate(runtime.db,()=>{authority();session(options.parentSessionId);for(const spec of specs){if(spec.id&&runtime.tasks.get(spec.id))owned(spec.id);for(const dep of spec.dependsOn??[])if(!prospective.has(dep))owned(dep);const shortfall=verificationBudgetShortfall(runtime.cfg,spec,parentImportance(runtime.tasks,runtime.contracts,spec));if(shortfall)throw new Error(shortfall);if(policies.beforeSubmit(spec)!==undefined)throw new Error("Submission policy must be synchronous");}
    const outcomes=runtime.tasks.submit(specs,{project:runtime.identity.slug});for(const out of outcomes)if(!out.deduplicated){const task=runtime.tasks.get(out.taskId)!;if(policies.bindSubmitted(task)!==undefined)throw new Error("Task binding policy must be synchronous");if(options.parentSessionId)runtime.tasks.event(out.taskId,"delegated_by_session",{sessionId:options.parentSessionId});}return outcomes;});policies.changed(result.map(row=>row.taskId));return result;
  },
  getTask:id=>{const task=owned(id,true);return {spec:task.spec,state:task.row.state,result:task.result};},
  awaitResults:async(ids,opts={})=>{const input=z.array(z.string().min(1)).max(MAX_PLAN_NODES).parse(ids),options=z.object({timeoutSeconds:z.number().finite().min(0).max(3600).optional(),signal:z.custom<AbortSignal>(v=>v instanceof AbortSignal).optional(),uncapped:z.boolean().optional()}).strict().parse(opts),start=Date.now(),until=start+(options.timeoutSeconds??30)*1000;for(;;){const result=collect(input);if(!result.pending.length||Date.now()>=until||options.signal?.aborted)return {...result,timedOut:result.pending.length>0&&Date.now()>=until,waitedSeconds:(Date.now()-start)/1000};await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,until-Date.now()))));}},
  cancelTasks:ids=>immediate(runtime.db,()=>{
   authority();const targets=ids.map(id=>owned(id));
   // This repeats the tool's protection inside the same mutation transaction for direct callers.
   for(const target of targets){const blocked=runtime.db.prepare(`WITH RECURSIVE owned(id) AS (SELECT id FROM tasks WHERE id=? AND project_id=? UNION SELECT t.id FROM tasks t JOIN owned p ON json_extract(t.spec_json,'$.parentTaskId')=p.id WHERE t.project_id=?) SELECT w.value_json FROM worker_action_requests w JOIN tasks t ON t.id=w.task_id WHERE w.project_id=? AND w.task_id IN(SELECT id FROM owned) AND t.state='running' AND t.cancel_requested=0 AND t.lease_expires_at>? AND json_extract(w.value_json,'$.action.lease.owner')=t.lease_owner AND json_extract(w.value_json,'$.action.lease.runCount')=t.run_count AND json_extract(w.value_json,'$.action.lease.incarnation')=t.lease_incarnation AND json_extract(w.value_json,'$.status') IN ('pending','running')`).all(target.row.id,lease.project,lease.project,lease.project,now());
    for(const raw of blocked){const row=z.object({value_json:z.string()}).parse(raw),action=z.object({status:z.enum(["pending","running"]),decidedBy:z.string().nullable()}).passthrough().parse(JSON.parse(row.value_json));
     const {security}=loadConfig(runtime.cfg.configPath); if(action.status==="running"&&action.decidedBy==="operator"||action.status==="pending"&&security.outside_repository==="human_only")throw new Error("Owning supervisor cannot cancel protected operator worker action");}
   }
   const result=runtime.tasks.requestCancel(ids);
   queueMicrotask(()=>{const changed:string[]=[];try{runtime.assertCurrent();for(const target of targets){const current=runtime.tasks.get(target.row.id);if(!current||current.row.lease_incarnation!==target.row.lease_incarnation||current.row.run_count!==target.row.run_count||current.row.lease_owner!==target.row.lease_owner||!current.row.cancel_requested||!["cancel_requested","cancelled"].includes(current.row.state))continue;
    changed.push(current.row.id);if(target.row.lease_owner)runtime.executor.abortLease({taskId:target.row.id,owner:target.row.lease_owner,project:lease.project,runCount:target.row.run_count,incarnation:target.row.lease_incarnation},"cancel");}if(changed.length)policies.changed(changed);}catch{/* A closed/replaced store cannot authorize an abort or publish a speculative cancellation. */}});
   return result;
  }),
  acceptTask:(id,input)=>decide(id,input,"accept"),rejectTask:(id,input)=>decide(id,input,"reject")
 };
 authority();bindings.set(services,{runtime,lease});return Object.freeze(services);
}

/** Minimal split worker compatibility: reads derive from local task policy; supplied service callbacks are unused. */
export function createProjectWorkerReadServices(local:Pick<ProjectRuntimeBundle,"db"|"tasks"|"cfg">,value:LeaseRef):SupervisorServices {
 const lease=LeaseRefSchema.parse(value),identity=projectToolIdentity(local.db,lease.project);
 if(!identity||local.tasks.db!==local.db||local.cfg.brain.project!==identity.slug)throw new Error("Worker read services require a pinned local project store");
 const observed=new Map<string,string>();
 const denied=()=>{throw new Error("Worker service cannot mutate or await the supervisor graph; captured supervisor services required");};
 const services:SupervisorServices={submitTasks:async()=>denied(),awaitResults:async()=>denied(),cancelTasks:denied,acceptTask:denied,rejectTask:denied,
  getTask:id=>{
   projectToolIdentity(local.db,identity.slug);
   if(!local.tasks.dispatchable(lease.taskId,lease.owner,lease.runCount,lease.incarnation,lease.project))throw new Error("Worker read services lost captured task authority");
   const actor=local.tasks.get(lease.taskId)!;const allowed=new Set([lease.taskId,...actor.spec.dependsOn??[]]);let current=actor;const seen=new Set<string>();
   while(current.spec.parentTaskId){const parent=local.tasks.get(current.spec.parentTaskId);if(!parent||parent.row.project_id!==identity.slug||seen.has(parent.row.id))throw new Error("Worker parent scope is unavailable or invalid");seen.add(parent.row.id);allowed.add(parent.row.id);current=parent;}
   const key=z.string().min(1).parse(id);if(!allowed.has(key))throw new Error("Task is outside the worker's local task/parent scope");
   const task=local.tasks.get(key);if(!task||task.row.project_id!==identity.slug)return null;const old=observed.get(key);if(old&&old!==task.row.lease_incarnation)throw new Error("Worker read target incarnation changed");observed.set(key,task.row.lease_incarnation);return {spec:task.spec,state:task.row.state,result:task.result};
  }};return Object.freeze(services);
}
