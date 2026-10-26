import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./tasks.js";
import { SqliteTaskLeases } from "./sqlite-task-leases.js";
import { LeaseRefSchema, type LeaseRef, type LeaseReceipt } from "./task-leases.js";
import { ExecutionGrantInputSchema, ProjectExecutionGrants, ExecutionGrantCapacityError, type ExecutionGrant, type ExecutionGrantInput, type ExecutionGrantRef, type ExecutionGrantRenewal } from "./project-execution-grants.js";
import { CoordinatedFairClaims, ProjectFairnessDeferred, type ProjectFairCandidate } from "./fair-claim.js";
import { ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "../projects/store-identity.js";
import { assertStoreRole } from "./store-role.js";
import { isTerminal } from "../core/task.js";
import type { Db } from "./db.js";
import type { ProviderSlotAdmission } from "../routing/claim-capacity.js";
import type { ResolvedConfig } from "../config/load.js";
import { maxAgentsPerJob } from "../config/schema.js";
import { projectLimits } from "../projects/schema.js";
import { batchKey } from "../runners/batch.js";
import { redundancyFor } from "./plans.js";
import { immediate } from "./db.js";
import type { ClaimAdmission, StoredTask, TaskStore } from "./tasks.js";
import { QueueClaimSchema, QueueCompanionsSchema, QueueTasksSchema, type QueueClaim, type QueueCompanions, type TaskQueue, type StoredTaskDTO } from "./task-queue.js";

/** Canonical batch compatibility includes project visibility. */
export function projectBatchKey(task: StoredTask): string | null {
  const key = batchKey(task.spec);
  return key === null ? null : JSON.stringify([task.row.project_id, key]);
}

/** Policy dependencies remain local to the SQLite adapter and its shared claim transaction. */
export class SqliteTaskQueue implements TaskQueue {
  constructor(private readonly cfg: ResolvedConfig, private readonly tasks: TaskStore,
    private readonly providerSlots: ClaimAdmission | null = null,
    private readonly projectConfig: ((slug: string) => ResolvedConfig | undefined) | null = null) {}

  async claim(raw: QueueClaim): Promise<StoredTaskDTO[]> {
    const { owner } = QueueClaimSchema.parse(raw);
    return immediate(this.tasks.db, () => QueueTasksSchema.parse(this.tasks.claim(owner, {
      maxConcurrent: this.cfg.execution.max_concurrent_tasks,
      maxWritersPerRepo: this.cfg.execution.max_concurrent_writers_per_repository,
      leaseMs: this.cfg.execution.lease_seconds * 1000,
      defaultTimeoutMs: this.cfg.execution.job_timeout_seconds * 1000,
      supervisorProfiles: Object.entries(this.cfg.profiles).filter(([, p]) => p?.mode === "supervisor").map(([n]) => n),
      maxSupervisors: this.cfg.supervisor.max_concurrent_jobs,
      supervisorTimeoutMs: this.cfg.supervisor.job_timeout_seconds * 1000,
      maxAgentsPerJob: (slug: string) => maxAgentsPerJob(this.projectConfig?.(slug) ?? this.cfg),
      ...(this.providerSlots ? { providerSlots: this.providerSlots } : {}),
      projectLimits: (slug: string) => {
        const limits = projectLimits(this.cfg, slug);
        return { priority: limits.priority, maxConcurrent: limits.max_concurrent_tasks };
      },
    })));
  }

  async claimCompanions(raw: QueueCompanions): Promise<StoredTaskDTO[]> {
    const input = QueueCompanionsSchema.parse(raw);
    return immediate(this.tasks.db, () => {
      const leader = this.tasks.dispatchable(input.leader.taskId, input.owner, input.leader.runCount, input.leader.incarnation, input.leader.project);
      if (!leader) return [];
      const profile = this.cfg.profiles[leader.spec.profile];
      const key = profile?.mode === "completion" && profile.batching.enabled && !this.redundant(leader) ? projectBatchKey(leader) : null;
      if (!key) return [];
      const excluded = new Set(input.excludeTaskIds);
      // Existing TaskStore policy deliberately lets companions share their leader's execution slot.
      return QueueTasksSchema.parse(this.tasks.claimCompanions(input.owner, leader,
        task => !excluded.has(task.row.id) && projectBatchKey(task) === key && !this.redundant(task),
        profile!.batching.max_items - 1, this.cfg.execution.lease_seconds * 1000, this.cfg.execution.job_timeout_seconds * 1000));
    });
  }

  private redundant(task: StoredTask): boolean { return redundancyFor(this.tasks.db, task.spec) > 1; }
}

export interface ProjectQueueLocalInput {
  identity:ProjectStoreIdentity;cfg:ResolvedConfig;db:Db;tasks:TaskStore;assertCurrent():void;assertPinned?():void;
}
export interface ProjectQueueLocalOptions {
  providerSlots?:ProviderSlotAdmission;
  /** Trusted prevalidated physical owner digests; source paths and globs remain local. */
  repositoryDigests?(task:StoredTask):readonly string[];
}
const ClaimRow=z.object({grant_id:z.uuid(),nonce:z.uuid(),project_id:z.string(),project_uuid:z.uuid(),store_uuid:z.uuid(),store_generation:z.number().int().positive(),binding_json:z.string().max(65536),phase:z.enum(["claimed","started","terminal_pending","terminal"]),started_token:z.uuid().nullable(),terminal_state:z.enum(["completed","revoked"]).nullable(),created_at:z.number().int().nonnegative(),updated_at:z.number().int().nonnegative()}).strict();
type LocalClaim=z.infer<typeof ClaimRow> & {input:ExecutionGrantInput};
interface QueueProofScopes {
  delegation?:{db:Db;binding:string};
  renewal?:{db:Db;ref:ExecutionGrantRef;proof:string;maximum:number};
}
const leaseOf=(task:StoredTask):LeaseRef=>LeaseRefSchema.parse({taskId:task.row.id,owner:task.row.lease_owner,runCount:task.row.run_count,incarnation:task.row.lease_incarnation,project:task.row.project_id});
const sameLease=(a:LeaseRef,b:LeaseRef)=>canonicalJson(a)===canonicalJson(b);

/** Local SQLite queue plus immutable global execution admission. No private root-store fallback. */
export class SqliteProjectTaskQueue {
  readonly taskLeases:SqliteTaskLeases;
  private pending:Promise<void>|null=null;
  private reconcileError:unknown;
  constructor(readonly local:ProjectQueueLocalInput,private readonly grants:ProjectExecutionGrants,private readonly fairness:CoordinatedFairClaims,private readonly scopes:QueueProofScopes,private readonly options:ProjectQueueLocalOptions={}){
    ProjectStoreIdentitySchema.parse(local.identity);this.assertLocal();
    if(local.cfg.team.provider_concurrency_enabled&&!options.providerSlots)throw new Error("Project queue requires explicit provider admission");
    this.taskLeases=new SqliteTaskLeases(local.cfg,local.tasks,()=>local.tasks.serverNow(),{
      renewing:(lease,now)=>this.renewGrant(lease,now),
      committed:receipt=>this.changed(receipt.lease?[receipt.lease.taskId]:receipt.affected.map(item=>item.target.taskId)),
      drain:()=>this.drain(),
    });
  }
  private assertLocal(ending=false):void{
    (ending?(this.local.assertPinned??this.local.assertCurrent):this.local.assertCurrent)();
    if(this.local.tasks.db!==this.local.db||this.grants.db===this.local.db)throw new Error("Project queue has foreign stores");
    assertStoreRole(this.local.db,this.local.identity);
  }
  hint():ProjectFairCandidate|null{
    this.assertLocal();const now=this.local.tasks.serverNow();
    const row=z.object({oldest:z.number().int().nonnegative().nullable()}).parse(this.local.db.prepare("SELECT MIN(created_at) oldest FROM tasks WHERE cancel_requested=0 AND (state IN ('queued','waiting_for_dependencies') OR (state='waiting_for_capacity' AND COALESCE(next_attempt_at,0)<=?))").get(now));
    if(row.oldest===null)return null;
    return {project:this.local.identity,oldestReadyAt:row.oldest,priority:projectLimits(this.local.cfg,this.local.identity.slug).priority};
  }
  /** A raw project queue is never an autonomous fairness bypass. */
  async claim(_input:QueueClaim):Promise<StoredTaskDTO[]>{throw new Error("Project claims require an explicit coordination fair turn");}
  async claimTurn(raw:QueueClaim,candidates:readonly ProjectFairCandidate[]):Promise<StoredTaskDTO[]>{
    const {owner}=QueueClaimSchema.parse(raw);this.assertLocal();
    if(this.local.db.inTransaction)throw new Error("Project claim requires an independent local transaction");
    this.fairness.publish(candidates);
    try{return immediate(this.local.db,()=>{
      this.assertLocal();const cfg=this.local.cfg,admission=this.options.providerSlots;
      const buffered:ClaimAdmission|undefined=admission?{check:(row,spec)=>admission.check(row,spec),claimed:()=>{}}:undefined;
      const claimed=this.local.tasks.claim(owner,{maxConcurrent:cfg.execution.max_concurrent_tasks,maxWritersPerRepo:cfg.execution.max_concurrent_writers_per_repository,leaseMs:cfg.execution.lease_seconds*1000,defaultTimeoutMs:cfg.execution.job_timeout_seconds*1000,limit:1,supervisorProfiles:Object.entries(cfg.profiles).filter(([,p])=>p?.mode==="supervisor").map(([name])=>name),maxSupervisors:cfg.supervisor.max_concurrent_jobs,supervisorTimeoutMs:cfg.supervisor.job_timeout_seconds*1000,maxAgentsPerJob:maxAgentsPerJob(cfg),...(buffered?{providerSlots:buffered}:{}),projectLimits:()=>({priority:1})},{project:this.local.identity,order:"project_fifo"});
      if(!claimed.length)return [];
      if(claimed.length!==1)throw new Error("Sealed project claim must select exactly one leader before companions");
      const leader=claimed[0]!,profile=cfg.profiles[leader.spec.profile]!,key=profile.mode==="completion"&&profile.batching.enabled&&!this.redundant(leader)?projectBatchKey(leader):null;
      const companions=key?this.local.tasks.claimCompanions(owner,leader,task=>projectBatchKey(task)===key&&!this.redundant(task),profile.batching.max_items-1,cfg.execution.lease_seconds*1000,cfg.execution.job_timeout_seconds*1000):[];
      const members=QueueTasksSchema.parse([leader,...companions]);
      if(members.some(task=>task.row.project_id!==this.local.identity.slug))throw new Error("Project claim returned foreign participants");
      const supervisor=profile.mode==="supervisor",delegated=supervisor&&!!leader.spec.parentTaskId;
      if(delegated)this.validateDelegation(leader);
      const repositories=this.options.repositoryDigests?.(leader)??[];
      if(leader.row.writable_repo&&(!this.options.repositoryDigests||!repositories.length))throw new Error("Writer claim lacks physical repository authority");
      const expiresAt=Math.min(...members.map(task=>Math.min(task.row.lease_expires_at!,task.row.deadline_at??Number.MAX_SAFE_INTEGER)));
      const input=ExecutionGrantInputSchema.parse({grantId:randomUUID(),project:this.local.identity,leases:members.map(leaseOf),role:supervisor?"supervisor":"worker",executionUnit:members.length>1?"completion_batch":"single",...(delegated?{delegatedSupervisor:true}:{}),repositoryDigests:[...repositories],expiresAt});
      const previous=this.scopes.delegation;this.scopes.delegation={db:this.local.db,binding:canonicalJson(input)};
      let reserved:ReturnType<ProjectExecutionGrants["reserve"]>;
      try{reserved=this.fairness.reserve(input,candidates);}finally{this.scopes.delegation=previous;}
      if(reserved.disposition!=="fresh")throw new Error("Replayed global grant cannot create another local claim");
      const now=this.local.tasks.serverNow(),ref=reserved.grant.ref;
      this.local.db.prepare("INSERT INTO project_execution_claims(grant_id,nonce,project_id,project_uuid,store_uuid,store_generation,binding_json,phase,started_token,terminal_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'claimed',NULL,NULL,?,?)").run(ref.grantId,ref.nonce,this.local.identity.slug,this.local.identity.projectId,this.local.identity.storeId,this.local.identity.generation,canonicalJson(input),now,now);
      const put=this.local.db.prepare("INSERT INTO project_execution_claim_members(grant_id,project_id,task_id,lease_incarnation,run_count,lease_owner) VALUES(?,?,?,?,?,?)");
      for(const lease of input.leases)put.run(ref.grantId,lease.project,lease.taskId,lease.incarnation,lease.runCount,lease.owner);
      return members;
    });}catch(error){if(error instanceof ProjectFairnessDeferred||error instanceof ExecutionGrantCapacityError)return [];throw error;}
  }
  /** The immutable group was already sealed in claimTurn; no later companion can join it. */
  async claimCompanions(raw:QueueCompanions):Promise<StoredTaskDTO[]>{
    const input=QueueCompanionsSchema.parse(raw);this.assertLocal();
    const task=this.local.tasks.dispatchable(input.leader.taskId,input.owner,input.leader.runCount,input.leader.incarnation,input.leader.project);
    if(task)this.claimsFor([leaseOf(task)],false);
    return [];
  }
  private redundant(task:StoredTask):boolean{return redundancyFor(this.local.db,task.spec)>1;}
  private validateDelegation(task:StoredTask):void{
    const visited=new Set([task.row.id]);let parentId=task.spec.parentTaskId,depth=1;
    while(parentId){
      if(visited.has(parentId))throw new Error("Delegated supervisor lineage contains a cycle");visited.add(parentId);
      const parent=this.local.tasks.get(parentId);
      if(!parent||parent.row.project_id!==this.local.identity.slug||this.local.cfg.profiles[parent.spec.profile]?.mode!=="supervisor"||isTerminal(parent.row.state)||parent.row.cancel_requested)throw new Error("Delegated supervisor lacks a live same-project supervisor lineage");
      if(++depth>this.local.cfg.team.max_depth)throw new Error("Delegated supervisor exceeds project depth policy");
      parentId=parent.spec.parentTaskId;
    }
    if(depth===1)throw new Error("Delegated supervisor lacks a parent");
    const running=z.object({n:z.number()}).parse(this.local.db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(spec_json,'$.parentTaskId')=? AND state IN ('running','cancel_requested') AND lease_expires_at>?").get(task.spec.parentTaskId,this.local.tasks.serverNow())).n;
    if(running>maxAgentsPerJob(this.local.cfg))throw new Error("Delegated supervisor exceeds parent agent policy");
  }
  private readClaim(id:string):LocalClaim{
    const row=ClaimRow.parse(this.local.db.prepare("SELECT * FROM project_execution_claims WHERE grant_id=?").get(id)),input=ExecutionGrantInputSchema.parse(JSON.parse(row.binding_json)),p=this.local.identity;
    if(row.project_id!==p.slug||row.project_uuid!==p.projectId||row.store_uuid!==p.storeId||row.store_generation!==p.generation||canonicalJson(input.project)!==canonicalJson(p)||input.grantId!==row.grant_id)throw new Error("Local execution claim belongs to another store generation");
    const members=z.array(z.object({task_id:z.string(),lease_incarnation:z.string(),run_count:z.number(),lease_owner:z.string(),project_id:z.string()}).strict()).parse(this.local.db.prepare("SELECT task_id,lease_incarnation,run_count,lease_owner,project_id FROM project_execution_claim_members WHERE grant_id=?").all(id));
    if(members.length!==input.leases.length||input.leases.some(lease=>members.filter(member=>member.task_id===lease.taskId&&member.lease_incarnation===lease.incarnation&&member.run_count===lease.runCount&&member.lease_owner===lease.owner&&member.project_id===lease.project).length!==1))throw new Error("Local execution claim participant binding changed");
    return {...row,input};
  }
  private claimsFor(leases:readonly LeaseRef[],whole=true):LocalClaim[]{
    if(!leases.length||new Set(leases.map(lease=>lease.taskId)).size!==leases.length)throw new Error("Execution requires unique local participants");
    const ids=new Set<string>();for(const lease of leases){
      LeaseRefSchema.parse(lease);if(lease.project!==this.local.identity.slug)throw new Error("Foreign project execution lease");
      const member=z.object({grant_id:z.uuid()}).parse(this.local.db.prepare("SELECT grant_id FROM project_execution_claim_members WHERE task_id=? AND lease_incarnation=? AND run_count=? AND lease_owner=? AND project_id=?").get(lease.taskId,lease.incarnation,lease.runCount,lease.owner,lease.project));ids.add(member.grant_id);
    }
    const claims=[...ids].map(id=>this.readClaim(id)),bound=claims.flatMap(claim=>claim.input.leases);
    if(whole&&(bound.length!==leases.length||bound.some(lease=>leases.filter(value=>sameLease(value,lease)).length!==1)))throw new Error("Execution participant set must equal the whole sealed grant set");
    return claims;
  }
  refsForRequest(leases:readonly LeaseRef[]):readonly ExecutionGrantRef[]{
    this.assertLocal();const claims=this.claimsFor(leases);
    if(claims.some(claim=>claim.phase!=="started"))throw new Error("Request lacks committed execution start authority");
    for(const lease of leases)if(!this.local.tasks.dispatchable(lease.taskId,lease.owner,lease.runCount,lease.incarnation,lease.project))throw new Error("Request execution lease is no longer current");
    return claims.map(claim=>({grantId:claim.grant_id,nonce:claim.nonce}));
  }
  /** The local claim committed before this fresh consume, and the marker commits before Executor entry. */
  authorizeStart(raw:readonly StoredTask[]):"fresh"|"already_started"{
    const members=QueueTasksSchema.parse(raw);this.assertLocal();if(this.local.db.inTransaction)throw new Error("Execution admission requires a committed local claim");
    return immediate(this.local.db,()=>{
      this.assertLocal();const leases=members.map(leaseOf),claims=this.claimsFor(leases);
      if(claims.every(claim=>claim.phase==="started"))return "already_started";
      if(claims.some(claim=>claim.phase!=="claimed"))throw new Error("Mixed or terminal execution admission");
      const current=leases.map(lease=>{const task=this.local.tasks.dispatchable(lease.taskId,lease.owner,lease.runCount,lease.incarnation,lease.project);if(!task)throw new Error("Execution claim was cancelled, expired or replaced");return task;});
      const isWorker=claims.some(claim=>claim.input.role==="worker"),platform=isWorker&&this.options.providerSlots?this.options.providerSlots.selectedPlatform(current[0]!.row,current[0]!.spec):null;
      const refs=claims.map(claim=>({grantId:claim.grant_id,nonce:claim.nonce}));
      immediate(this.grants.db,()=>{
        for(const ref of refs)if(this.grants.consume(ref).disposition!=="fresh")throw new Error("Replayed global consume cannot start an executor");
        if(isWorker&&this.options.providerSlots)this.options.providerSlots.claimedGroup(current,leases[0]!.owner,refs,platform);
      });
      const token=randomUUID(),put=this.local.db.prepare("UPDATE project_execution_claims SET phase='started',started_token=?,updated_at=? WHERE grant_id=? AND nonce=? AND phase='claimed' AND started_token IS NULL");
      for(const claim of claims)if(put.run(token,this.local.tasks.serverNow(),claim.grant_id,claim.nonce).changes!==1)throw new Error("Execution start marker compare-and-set lost");
      return "fresh";
    });
  }
  private renewGrant(lease:LeaseRef,now:number):void{
    this.assertLocal();if(!this.local.db.inTransaction)throw new Error("Execution renewal requires local IMMEDIATE");
    for(const claim of this.claimsFor([lease],false)){
      if(claim.phase!=="started")throw new Error("Execution renewal lacks started claim");
      const grant=this.grants.read(claim.grant_id);if(!grant||grant.ref.nonce!==claim.nonce||grant.state!=="active")throw new Error("Execution renewal grant was retired");
      let maximum=Number.MAX_SAFE_INTEGER;for(const participant of claim.input.leases){
        const task=this.local.tasks.dispatchable(participant.taskId,participant.owner,participant.runCount,participant.incarnation,participant.project);
        if(!task||task.row.cancel_requested)throw new Error("Execution renewal participant lost authority");
        maximum=Math.min(maximum,task.row.lease_expires_at!,task.row.deadline_at??Number.MAX_SAFE_INTEGER);
      }
      if(maximum<=grant.authorityExpiresAt){if(grant.authorityExpiresAt<=now)throw new Error("Execution renewal grant authority expired");return;}
      const proof:ExecutionGrantRenewal={project:this.local.identity,leases:claim.input.leases,expectedSequence:grant.renewalSequence,expiresAt:maximum};
      const previous=this.scopes.renewal;this.scopes.renewal={db:this.local.db,ref:grant.ref,proof:canonicalJson(proof),maximum};
      try{this.grants.renew(grant.ref,proof);}finally{this.scopes.renewal=previous;}
    }
  }
  /** IDs are lookup hints only; exact persisted grant/lease state is rechecked after the caller's commit. */
  changed(_ids:readonly string[]):void{
    if(this.pending)return;
    this.pending=Promise.resolve().then(()=>{this.reconcile();this.reconcileError=undefined;}).catch(error=>{this.reconcileError=error;}).finally(()=>{this.pending=null;});
  }
  reconcile():void{
    this.assertLocal(true);if(this.local.db.inTransaction)throw new Error("Execution reconciliation requires committed local state");
    const rows=z.array(z.object({grant_id:z.uuid()}).strict()).parse(this.local.db.prepare("SELECT grant_id FROM project_execution_claims WHERE phase!='terminal' ORDER BY created_at,grant_id LIMIT 1000").all());
    for(const row of rows){
      const terminal=immediate(this.local.db,()=>{
        const claim=this.readClaim(row.grant_id);let all=true,completed=true;
        for(const lease of claim.input.leases){const task=this.local.tasks.get(lease.taskId);if(!task){all=false;break;}
          if(task.row.lease_incarnation===lease.incarnation&&task.row.run_count===lease.runCount&&['running','cancel_requested'].includes(task.row.state)&&task.row.lease_owner===lease.owner){all=false;break;}
          if(task.row.run_count<lease.runCount){all=false;break;}
          if(task.row.lease_incarnation!==lease.incarnation||task.row.run_count!==lease.runCount||task.row.state!=="completed")completed=false;
        }
        if(!all)return null;
        const state=completed?"completed":"revoked";
        this.local.db.prepare("UPDATE project_execution_claims SET phase='terminal_pending',terminal_state=?,updated_at=? WHERE grant_id=? AND phase!='terminal'").run(state,this.local.tasks.serverNow(),claim.grant_id);
        return state;
      });
      if(!terminal)continue;
      // The authoritative terminal task state/outbox is already committed locally.
      immediate(this.local.db,()=>{
        const claim=this.readClaim(row.grant_id);if(claim.phase!=="terminal_pending"||claim.terminal_state!==terminal)throw new Error("Execution terminal outbox changed");
        const ref={grantId:claim.grant_id,nonce:claim.nonce},global=this.grants.read(ref.grantId);
        if(!global||global.ref.nonce!==ref.nonce||canonicalJson(global.input)!==canonicalJson(claim.input))throw new Error("Execution terminal outbox grant binding changed");
        let finished=terminal;
        if(global.state==="completed"||global.state==="revoked")finished=global.state;
        else if(terminal==="completed")this.grants.complete(ref);else this.grants.revoke(ref);
        this.local.db.prepare("UPDATE project_execution_claims SET phase='terminal',terminal_state=?,updated_at=? WHERE grant_id=? AND phase='terminal_pending'").run(finished,this.local.tasks.serverNow(),claim.grant_id);
      });
    }
  }
  async drain():Promise<void>{await this.pending;this.reconcile();if(this.reconcileError)throw this.reconcileError;}
}

/** Host wiring for per-project ports and preverified synchronous global-authority callbacks. */
export class ProjectQueueBindings {
  readonly fairness:CoordinatedFairClaims;
  private readonly scopes:QueueProofScopes={};
  private readonly locals=new Map<string,SqliteProjectTaskQueue>();
  constructor(readonly grants:ProjectExecutionGrants){this.fairness=new CoordinatedFairClaims(grants.db,grants);}
  readonly delegationAuthority=(input:ExecutionGrantInput):boolean=>{const scope=this.scopes.delegation;return !!scope&&scope.db.inTransaction&&scope.binding===canonicalJson(input);};
  readonly renewalAuthority=(grant:ExecutionGrant,proof:ExecutionGrantRenewal):number|null=>{const scope=this.scopes.renewal;return scope&&scope.db.inTransaction&&canonicalJson(scope.ref)===canonicalJson(grant.ref)&&scope.proof===canonicalJson(proof)?scope.maximum:null;};
  bindLocal(input:ProjectQueueLocalInput,options:ProjectQueueLocalOptions={}):SqliteProjectTaskQueue{
    const existing=this.locals.get(input.identity.projectId);
    if(existing){if(existing.local.db!==input.db||existing.local.tasks!==input.tasks||canonicalJson(existing.local.identity)!==canonicalJson(input.identity))throw new Error("Project queue binding changed; drain original runtime first");return existing;}
    const port=new SqliteProjectTaskQueue(input,this.grants,this.fairness,this.scopes,options);this.locals.set(input.identity.projectId,port);return port;
  }
  forProject(project:ProjectStoreIdentity):SqliteProjectTaskQueue{const port=this.locals.get(project.projectId);if(!port||canonicalJson(port.local.identity)!==canonicalJson(project))throw new Error("Project queue has not been bound to this exact runtime");return port;}
}
