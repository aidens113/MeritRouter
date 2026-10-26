import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import type { ProjectRuntimeBundle, ProjectRuntimeRegistry } from "../projects/runtime-registry.js";
import type { ProjectStoreIdentity } from "../projects/store-identity.js";
import { ProviderClaimCapacityError } from "../gateway/capacity.js";
import { ProjectQueueBindings, type SqliteProjectTaskQueue } from "../storage/sqlite-task-queue.js";
import { capturedLease, leaseOperationId } from "../storage/task-leases.js";
import type { ProjectFairCandidate } from "../storage/fair-claim.js";
import type { StoredTask } from "../storage/tasks.js";
import { Scheduler } from "./scheduler.js";

export interface ProjectSchedulerOptions {
  owner:string;
  now?:()=>number;
  maxTurnsPerTick?:number;
  onTick?():void;
  onUnavailable?(projectId:string,code:"runtime_unavailable"|"queue_unavailable"):void;
}
interface Entry {bundle:ProjectRuntimeBundle;port:SqliteProjectTaskQueue;scheduler:Scheduler;turn:readonly ProjectFairCandidate[]|null;claims:number;retryAt:number;backoff:number}

/** Global fair fan-out over actual project-local queues and Executors; no global task facade. */
export class ProjectScheduler {
  private readonly entries=new Map<string,Entry>();
  private timer:NodeJS.Timeout|null=null;
  private ticking:Promise<void>|null=null;
  private stopping:Promise<void>|null=null;
  private stopped=false;
  private again=false;
  private readonly now:()=>number;
  private readonly owner:string;
  constructor(private readonly cfg:ResolvedConfig,private readonly registry:ProjectRuntimeRegistry,readonly bindings:ProjectQueueBindings,private readonly options:ProjectSchedulerOptions){
    this.owner=z.string().min(1).max(200).parse(options.owner);this.now=options.now??Date.now;
    if(registry.coordinationDb!==bindings.grants.db)throw new Error("Project scheduler requires exact coordination services");
  }
  start(intervalMs=1000):void{
    if(this.timer||this.stopping)return;this.stopped=false;
    this.timer=setInterval(()=>this.kick(),z.number().int().min(10).max(60000).parse(intervalMs));this.timer.unref?.();this.kick();
  }
  kick():void{if(this.timer)void this.tick().catch(()=>undefined);}
  tick():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(this.ticking){this.again=true;return this.ticking;}
    this.again=false;
    const run=this.runTick().finally(()=>{this.ticking=null;if(this.again&&this.timer)queueMicrotask(()=>this.kick());});this.ticking=run;return run;
  }
  private heartbeat():void{
    this.registry.coordinationDb.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`worker:${this.owner}`,String(this.now()));
  }
  private entry(id:string):Entry{
    const bundle=this.registry.openRegistered(id),port=this.bindings.forProject(bundle.identity),old=this.entries.get(id);
    if(port.local.db!==bundle.db||port.local.tasks!==bundle.tasks||port.taskLeases!==bundle.taskLeases)throw new Error("Project executor lacks its exact queue lease binding");
    if(old){if(old.bundle!==bundle)throw new Error("Project scheduler bundle changed without drain");return old;}
    let entry!:Entry;
    const queue={claim:async(input:{owner:string})=>{const turn=entry.turn;entry.turn=null;if(!turn)return [];const tasks=await port.claimTurn(input,turn);if(tasks.length)entry.claims++;return tasks;},claimCompanions:port.claimCompanions.bind(port)};
    const scheduler=new Scheduler(bundle.cfg,bundle.tasks,bundle.executor,this.owner,()=>bundle.assertCurrent(),bundle.sessions,null,slug=>slug===bundle.identity.slug?bundle.cfg:undefined,queue,{
      managed:true,heartbeat:active=>{if(active)this.heartbeat();},wake:()=>this.kick(),beforeDispatch:members=>this.beforeDispatch(port,members),
    });
    entry={bundle,port,scheduler,turn:null,claims:0,retryAt:0,backoff:1000};this.entries.set(id,entry);return entry;
  }
  private async beforeDispatch(port:SqliteProjectTaskQueue,members:readonly StoredTask[]):Promise<"fresh"|"already_started"|"deferred">{
    try{return port.authorizeStart(members);}catch(error){
      if(!(error instanceof ProviderClaimCapacityError))throw error;
      // No executor or transport began. End the exact committed claims locally first;
      // the durable terminal outbox retires only their logical execution reservations.
      for(const member of members)await port.taskLeases.defer({lease:capturedLease(member),operationId:leaseOperationId(port.local.tasks.serverNow()),nextAttemptAt:port.local.tasks.serverNow()+1000,reason:"waiting_for_provider_slot"});
      port.reconcile();return "deferred";
    }
  }
  private async runTick():Promise<void>{
    if(this.registry.coordinationDb.inTransaction)throw new Error("Project fan-out cannot query local stores inside coordination transaction");
    this.heartbeat();this.options.onTick?.();
    const ids=z.array(z.object({id:z.uuid()}).strict()).max(1000).parse(this.registry.coordinationDb.prepare("SELECT project_uuid id FROM project_store_registrations WHERE state='registered' ORDER BY project_uuid").all());
    const available:Entry[]=[];
    for(const {id} of ids){
      try{const entry=this.entry(id);if(entry.retryAt>this.now())continue;entry.port.reconcile();available.push(entry);}
      catch{this.options.onUnavailable?.(id,"runtime_unavailable");}
    }
    const skipped=new Set<string>(),turns=z.number().int().positive().max(10000).parse(this.options.maxTurnsPerTick??Math.max(1,this.cfg.execution.max_concurrent_tasks+this.cfg.supervisor.max_concurrent_jobs+available.length));
    for(let n=0;n<turns&&!this.stopped;n++){
      const candidates:ProjectFairCandidate[]=[];
      for(const entry of available){if(skipped.has(entry.bundle.identity.projectId))continue;try{const hint=entry.port.hint();if(hint)candidates.push(hint);}catch{skipped.add(entry.bundle.identity.projectId);this.options.onUnavailable?.(entry.bundle.identity.projectId,"runtime_unavailable");}}
      const chosen=this.bindings.fairness.choose(candidates);if(!chosen)break;
      const entry=available.find(value=>value.bundle.identity.projectId===chosen.project.projectId)!;
      const before=entry.claims;entry.turn=candidates;
      try{entry.scheduler.start();await entry.scheduler.tick();entry.backoff=1000;if(entry.claims===before)skipped.add(chosen.project.projectId);}
      catch{entry.retryAt=this.now()+entry.backoff;entry.backoff=Math.min(60000,entry.backoff*2);skipped.add(chosen.project.projectId);this.options.onUnavailable?.(chosen.project.projectId,"queue_unavailable");}
      finally{entry.turn=null;}
    }
  }
  forProject(identity:ProjectStoreIdentity):Scheduler{const entry=this.entry(identity.projectId);if(entry.bundle.identity.storeId!==identity.storeId||entry.bundle.identity.generation!==identity.generation)throw new Error("Project scheduler generation changed");return entry.scheduler;}
  get busy():number{return [...this.entries.values()].reduce((total,entry)=>total+entry.scheduler.busy,0);}
  stop():Promise<void>{
    if(this.stopping)return this.stopping;this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;
    // Signal every child synchronously, including the one awaiting admission in this tick.
    const children=[...this.entries.values()].map(entry=>entry.scheduler.stop());
    this.stopping=(async()=>{await this.ticking?.catch(()=>undefined);await Promise.all(children);this.registry.coordinationDb.prepare("DELETE FROM meta WHERE key=?").run(`worker:${this.owner}`);})().finally(()=>{this.stopping=null;});return this.stopping;
  }
}
