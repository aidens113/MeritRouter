import { randomUUID } from "node:crypto";
import { z } from "zod";
import { immediate, type Db } from "./db.js";
import { canonicalJson } from "./tasks.js";
import { LeaseRefSchema } from "./task-leases.js";
import { assertCriticalStoreDurability, readStoreIdentity, readProjectStoreRegistration, ProjectStoreIdentitySchema } from "../projects/store-identity.js";

export const ExecutionGrantRefSchema=z.object({grantId:z.uuid(),nonce:z.uuid()}).strict();
export type ExecutionGrantRef=z.infer<typeof ExecutionGrantRefSchema>;
export const ExecutionGrantInputSchema=z.object({grantId:z.uuid(),project:ProjectStoreIdentitySchema,
 leases:z.array(LeaseRefSchema).min(1).max(128),role:z.enum(["worker","supervisor"]),
 executionUnit:z.enum(["single","completion_batch"]).optional(),delegatedSupervisor:z.literal(true).optional(),
 repositoryDigests:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128),expiresAt:z.number().int().positive()}).strict()
 .refine(v=>v.leases.every(l=>l.project===v.project.slug)&&new Set(v.leases.map(l=>l.taskId)).size===v.leases.length)
 .refine(v=>(v.repositoryDigests.length===0&&v.role!=="supervisor")||v.leases.length===1,"Writer and supervisor grants require exactly one task lease")
 .refine(v=>v.executionUnit!=="single"||v.leases.length===1)
 .refine(v=>v.executionUnit!=="completion_batch"||(v.role==="worker"&&v.repositoryDigests.length===0))
 .refine(v=>!v.delegatedSupervisor||(v.role==="supervisor"&&v.leases.length===1));
export type ExecutionGrantInput=z.infer<typeof ExecutionGrantInputSchema>;
const State=z.enum(["reserved","active","revoked","completed"]);
export interface ExecutionGrant {ref:ExecutionGrantRef;input:ExecutionGrantInput;state:z.infer<typeof State>;authorityExpiresAt:number;renewalSequence:number}
export const ExecutionGrantRenewalSchema=z.object({project:ProjectStoreIdentitySchema,leases:z.array(LeaseRefSchema).min(1).max(128),expectedSequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),expiresAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export type ExecutionGrantRenewal=z.infer<typeof ExecutionGrantRenewalSchema>;
/** Host resolver verifies local lease/deadline/cancel authority while its caller holds local IMMEDIATE. */
export type ExecutionDelegationAuthority=(input:ExecutionGrantInput)=>boolean;
export type ExecutionGrantRenewalAuthority=(grant:ExecutionGrant,proof:ExecutionGrantRenewal)=>number|null;
const Limits=z.object({maxTasks:z.number().int().positive(),maxSupervisors:z.number().int().nonnegative(),maxWritersPerRepository:z.number().int().positive(),projectMaxTasks:z.number().int().positive().nullable()}).strict();
export type ExecutionGrantLimits=z.infer<typeof Limits>;
export class ExecutionGrantCapacityError extends Error { constructor(reason="Execution grant capacity exhausted"){super(reason);this.name="ExecutionGrantCapacityError";} }
/** Synchronous coordination authority. Limits are supplied by the trusted host, never the claim DTO. */
export class ProjectExecutionGrants {
 constructor(readonly db:Db,private readonly limits:(project:ExecutionGrantInput["project"])=>ExecutionGrantLimits,private readonly now:()=>number=Date.now,private readonly renewalAuthority?:ExecutionGrantRenewalAuthority,private readonly delegationAuthority?:ExecutionDelegationAuthority){this.owner();}
 private owner(){assertCriticalStoreDurability(this.db);const identity=readStoreIdentity(this.db);if(identity?.role!=="coordination")throw new Error("Execution grants require coordination store");return identity;}
 private transaction<T>(fn:()=>T):T{this.owner();return this.db.inTransaction?fn():immediate(this.db,fn);}
 private registered(input:ExecutionGrantInput):void{const owner=this.owner(),r=readProjectStoreRegistration(this.db,input.project.projectId);
 if(!r||r.state!=="registered"||r.installationId!==owner.installationId||input.project.installationId!==owner.installationId||r.storeId!==input.project.storeId||r.generation!==input.project.generation||r.slug!==input.project.slug)throw new Error("Execution grant project generation unavailable");}
 read(id:string):ExecutionGrant|null{this.owner();const raw=this.db.prepare("SELECT id,nonce,binding_json,state,project_uuid,store_uuid,store_generation,role,repositories_json,expires_at,created_at,updated_at,authority_expires_at,renewal_sequence FROM project_execution_grants WHERE id=?").get(z.uuid().parse(id));if(!raw)return null;
 const row=z.object({id:z.uuid(),nonce:z.uuid(),binding_json:z.string().max(65536),state:State,project_uuid:z.uuid(),store_uuid:z.uuid(),store_generation:z.number().int().positive(),role:z.enum(["worker","supervisor"]),repositories_json:z.string().max(65536),expires_at:z.number().int().positive(),created_at:z.number().int().nonnegative(),updated_at:z.number().int().nonnegative(),authority_expires_at:z.number().int().positive().nullable(),renewal_sequence:z.number().int().nonnegative()}).strict().parse(raw);const input=ExecutionGrantInputSchema.parse(JSON.parse(row.binding_json));if(input.grantId!==id||row.id!==id||row.project_uuid!==input.project.projectId||row.store_uuid!==input.project.storeId||row.store_generation!==input.project.generation||row.role!==input.role||row.expires_at!==input.expiresAt||canonicalJson(JSON.parse(row.repositories_json))!==canonicalJson(input.repositoryDigests))throw new Error("Execution grant identity changed");if(row.authority_expires_at===null||row.authority_expires_at<input.expiresAt)throw new Error("Execution grant renewal authority invalid");return {ref:{grantId:id,nonce:row.nonce},input,state:row.state,authorityExpiresAt:row.authority_expires_at,renewalSequence:row.renewal_sequence};}
 reserve(value:ExecutionGrantInput):{disposition:"fresh"|"replayed";grant:ExecutionGrant}{const input=ExecutionGrantInputSchema.parse(value);return this.transaction(()=>{
 const old=this.read(input.grantId);if(old){if(canonicalJson(old.input)!==canonicalJson(input))throw new Error("Execution grant binding conflict");return {disposition:"replayed",grant:old};}
 if(input.leases.length>1&&input.executionUnit!=="completion_batch")throw new Error("Multi-lease grants require an explicit sealed completion batch");
 if(input.delegatedSupervisor&&this.delegationAuthority?.(input)!==true)throw new Error("Delegated supervisor grant requires trusted local lineage authority");
 this.registered(input);if(input.expiresAt<=this.now())throw new Error("Execution grant expired");const limits=Limits.parse(this.limits(input.project));
 const rows=z.array(z.object({id:z.string()}).strict()).parse(this.db.prepare("SELECT id FROM project_execution_grants WHERE state IN ('reserved','active')").all());const held=rows.map(r=>this.read(r.id)!);
 if(held.filter(g=>g.input.role==="worker").length+(input.role==="worker"?1:0)>limits.maxTasks||held.filter(g=>g.input.role==="supervisor"&&!g.input.delegatedSupervisor).length+(input.role==="supervisor"&&!input.delegatedSupervisor?1:0)>limits.maxSupervisors||limits.projectMaxTasks!==null&&held.filter(g=>g.input.project.projectId===input.project.projectId&&g.input.role==="worker").length+(input.role==="worker"?1:0)>limits.projectMaxTasks)throw new ExecutionGrantCapacityError();
 for(const repo of input.repositoryDigests)if(held.filter(g=>g.input.repositoryDigests.includes(repo)).length>=limits.maxWritersPerRepository)throw new ExecutionGrantCapacityError("Execution repository writer capacity exhausted");
 const nonce=randomUUID(),now=this.now();this.db.prepare("INSERT INTO project_execution_grants(id,nonce,binding_json,project_uuid,store_uuid,store_generation,role,repositories_json,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?,?)").run(input.grantId,nonce,canonicalJson(input),input.project.projectId,input.project.storeId,input.project.generation,input.role,JSON.stringify(input.repositoryDigests),input.expiresAt,now,now);
 this.db.prepare("UPDATE project_execution_grants SET authority_expires_at=expires_at WHERE id=?").run(input.grantId);
 return {disposition:"fresh",grant:this.read(input.grantId)!};});}
 private exact(value:ExecutionGrantRef):ExecutionGrant{const ref=ExecutionGrantRefSchema.parse(value),grant=this.read(ref.grantId);if(!grant||grant.ref.nonce!==ref.nonce)throw new Error("Execution grant nonce lost");return grant;}
 consume(ref:ExecutionGrantRef):{disposition:"fresh"|"replayed";grant:ExecutionGrant}{return this.transaction(()=>{const grant=this.exact(ref);this.registered(grant.input);if(grant.state==="active")return {disposition:"replayed",grant};if(grant.state!=="reserved"||grant.authorityExpiresAt<=this.now())throw new Error("Execution grant cannot start");this.db.prepare("UPDATE project_execution_grants SET state='active',updated_at=? WHERE id=?").run(this.now(),ref.grantId);return {disposition:"fresh",grant:this.exact(ref)};});}
 assertActive(ref:ExecutionGrantRef):ExecutionGrant{return this.transaction(()=>{const grant=this.exact(ref);this.registered(grant.input);if(grant.state!=="active"||grant.authorityExpiresAt<=this.now())throw new Error("Execution grant inactive or expired");
 const limits=Limits.parse(this.limits(grant.input.project));const rows=z.array(z.object({id:z.string()}).strict()).parse(this.db.prepare("SELECT id FROM project_execution_grants WHERE state IN ('reserved','active')").all());const held=rows.map(r=>this.read(r.id)!);
 if(held.filter(g=>g.input.role==="worker").length>limits.maxTasks||held.filter(g=>g.input.role==="supervisor"&&!g.input.delegatedSupervisor).length>limits.maxSupervisors||limits.projectMaxTasks!==null&&held.filter(g=>g.input.project.projectId===grant.input.project.projectId&&g.input.role==="worker").length>limits.projectMaxTasks)throw new Error("Execution grant live capacity exhausted");
 for(const repo of grant.input.repositoryDigests)if(held.filter(g=>g.input.repositoryDigests.includes(repo)).length>limits.maxWritersPerRepository)throw new Error("Execution grant live writer capacity exhausted");return grant;});}
 /** Never changes original binding, nonce or participants; no expired hold is refunded. */
 renew(value:ExecutionGrantRef,valueProof:ExecutionGrantRenewal):{disposition:"fresh"|"replayed";grant:ExecutionGrant}{
  const ref=ExecutionGrantRefSchema.parse(value),proof=ExecutionGrantRenewalSchema.parse(valueProof);
  return this.transaction(()=>{
   const grant=this.exact(ref);this.registered(grant.input);
   if(canonicalJson(proof.project)!==canonicalJson(grant.input.project)||canonicalJson(proof.leases)!==canonicalJson(grant.input.leases))throw new Error("Execution renewal participant or generation mismatch");
   if(grant.state!=="reserved"&&grant.state!=="active")throw new Error("Execution grant renewal already finished");
   if(grant.renewalSequence===proof.expectedSequence+1&&grant.authorityExpiresAt===proof.expiresAt)return {disposition:"replayed",grant};
   if(grant.renewalSequence!==proof.expectedSequence)throw new Error("Execution renewal sequence conflict");
   if(!this.renewalAuthority)throw new Error("Execution renewal lacks trusted local authority resolver");
   const max=this.renewalAuthority(grant,proof);
   if(max===null||!z.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(max).success||proof.expiresAt>max||proof.expiresAt<=grant.authorityExpiresAt||proof.expiresAt<=this.now())throw new Error("Execution renewal exceeds verified local deadline");
   const updated=this.db.prepare("UPDATE project_execution_grants SET authority_expires_at=?,renewal_sequence=renewal_sequence+1,updated_at=? WHERE id=? AND nonce=? AND renewal_sequence=? AND project_uuid=? AND store_uuid=? AND store_generation=? AND state IN ('reserved','active')")
    .run(proof.expiresAt,this.now(),ref.grantId,ref.nonce,proof.expectedSequence,proof.project.projectId,proof.project.storeId,proof.project.generation);
   if(updated.changes!==1)throw new Error("Execution renewal compare-and-set lost");
   return {disposition:"fresh",grant:this.exact(ref)};
  });
 }
 revoke(ref:ExecutionGrantRef):void{this.finish(ref,"revoked");}
 complete(ref:ExecutionGrantRef):void{this.finish(ref,"completed");}
 private finish(ref:ExecutionGrantRef,state:"revoked"|"completed"):void{this.transaction(()=>{const grant=this.exact(ref);if(grant.state===state)return;if(grant.state==="revoked"||grant.state==="completed")throw new Error("Execution grant already finished");this.db.prepare("UPDATE project_execution_grants SET state=?,updated_at=? WHERE id=?").run(state,this.now(),ref.grantId);});}
}
