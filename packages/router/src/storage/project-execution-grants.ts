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
 repositoryDigests:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(128),expiresAt:z.number().int().positive()}).strict()
 .refine(v=>v.leases.every(l=>l.project===v.project.slug)&&new Set(v.leases.map(l=>l.taskId)).size===v.leases.length)
 .refine(v=>v.repositoryDigests.length===0||v.leases.length===1,"Writer grants require exactly one task lease");
export type ExecutionGrantInput=z.infer<typeof ExecutionGrantInputSchema>;
const State=z.enum(["reserved","active","revoked","completed"]);
export interface ExecutionGrant {ref:ExecutionGrantRef;input:ExecutionGrantInput;state:z.infer<typeof State>}
const Limits=z.object({maxTasks:z.number().int().positive(),maxSupervisors:z.number().int().nonnegative(),maxWritersPerRepository:z.number().int().positive(),projectMaxTasks:z.number().int().positive().nullable()}).strict();
export type ExecutionGrantLimits=z.infer<typeof Limits>;
/** Synchronous coordination authority. Limits are supplied by the trusted host, never the claim DTO. */
export class ProjectExecutionGrants {
 constructor(readonly db:Db,private readonly limits:(project:ExecutionGrantInput["project"])=>ExecutionGrantLimits,private readonly now:()=>number=Date.now){this.owner();}
 private owner(){assertCriticalStoreDurability(this.db);const identity=readStoreIdentity(this.db);if(identity?.role!=="coordination")throw new Error("Execution grants require coordination store");return identity;}
 private transaction<T>(fn:()=>T):T{this.owner();return this.db.inTransaction?fn():immediate(this.db,fn);}
 private registered(input:ExecutionGrantInput):void{const owner=this.owner(),r=readProjectStoreRegistration(this.db,input.project.projectId);
 if(!r||r.state!=="registered"||r.installationId!==owner.installationId||input.project.installationId!==owner.installationId||r.storeId!==input.project.storeId||r.generation!==input.project.generation||r.slug!==input.project.slug)throw new Error("Execution grant project generation unavailable");}
 read(id:string):ExecutionGrant|null{this.owner();const raw=this.db.prepare("SELECT id,nonce,binding_json,state,project_uuid,store_uuid,store_generation,role,repositories_json,expires_at,created_at,updated_at FROM project_execution_grants WHERE id=?").get(z.uuid().parse(id));if(!raw)return null;
 const row=z.object({id:z.uuid(),nonce:z.uuid(),binding_json:z.string().max(65536),state:State,project_uuid:z.uuid(),store_uuid:z.uuid(),store_generation:z.number().int().positive(),role:z.enum(["worker","supervisor"]),repositories_json:z.string().max(65536),expires_at:z.number().int().positive(),created_at:z.number().int().nonnegative(),updated_at:z.number().int().nonnegative()}).strict().parse(raw);const input=ExecutionGrantInputSchema.parse(JSON.parse(row.binding_json));if(input.grantId!==id||row.id!==id||row.project_uuid!==input.project.projectId||row.store_uuid!==input.project.storeId||row.store_generation!==input.project.generation||row.role!==input.role||row.expires_at!==input.expiresAt||canonicalJson(JSON.parse(row.repositories_json))!==canonicalJson(input.repositoryDigests))throw new Error("Execution grant identity changed");return {ref:{grantId:id,nonce:row.nonce},input,state:row.state};}
 reserve(value:ExecutionGrantInput):{disposition:"fresh"|"replayed";grant:ExecutionGrant}{const input=ExecutionGrantInputSchema.parse(value);return this.transaction(()=>{
 const old=this.read(input.grantId);if(old){if(canonicalJson(old.input)!==canonicalJson(input))throw new Error("Execution grant binding conflict");return {disposition:"replayed",grant:old};}
 this.registered(input);if(input.expiresAt<=this.now())throw new Error("Execution grant expired");const limits=Limits.parse(this.limits(input.project));
 const rows=z.array(z.object({id:z.string()}).strict()).parse(this.db.prepare("SELECT id FROM project_execution_grants WHERE state IN ('reserved','active')").all());const held=rows.map(r=>this.read(r.id)!);
 if(held.reduce((n,g)=>n+g.input.leases.length,0)+input.leases.length>limits.maxTasks||held.filter(g=>g.input.role==="supervisor").reduce((n,g)=>n+g.input.leases.length,0)+(input.role==="supervisor"?input.leases.length:0)>limits.maxSupervisors||limits.projectMaxTasks!==null&&held.filter(g=>g.input.project.projectId===input.project.projectId).reduce((n,g)=>n+g.input.leases.length,0)+input.leases.length>limits.projectMaxTasks)throw new Error("Execution grant capacity exhausted");
 for(const repo of input.repositoryDigests)if(held.filter(g=>g.input.repositoryDigests.includes(repo)).length>=limits.maxWritersPerRepository)throw new Error("Execution repository writer capacity exhausted");
 const nonce=randomUUID(),now=this.now();this.db.prepare("INSERT INTO project_execution_grants(id,nonce,binding_json,project_uuid,store_uuid,store_generation,role,repositories_json,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?,?)").run(input.grantId,nonce,canonicalJson(input),input.project.projectId,input.project.storeId,input.project.generation,input.role,JSON.stringify(input.repositoryDigests),input.expiresAt,now,now);
 return {disposition:"fresh",grant:this.read(input.grantId)!};});}
 private exact(value:ExecutionGrantRef):ExecutionGrant{const ref=ExecutionGrantRefSchema.parse(value),grant=this.read(ref.grantId);if(!grant||grant.ref.nonce!==ref.nonce)throw new Error("Execution grant nonce lost");return grant;}
 consume(ref:ExecutionGrantRef):{disposition:"fresh"|"replayed";grant:ExecutionGrant}{return this.transaction(()=>{const grant=this.exact(ref);this.registered(grant.input);if(grant.state==="active")return {disposition:"replayed",grant};if(grant.state!=="reserved"||grant.input.expiresAt<=this.now())throw new Error("Execution grant cannot start");this.db.prepare("UPDATE project_execution_grants SET state='active',updated_at=? WHERE id=?").run(this.now(),ref.grantId);return {disposition:"fresh",grant:this.exact(ref)};});}
 assertActive(ref:ExecutionGrantRef):ExecutionGrant{return this.transaction(()=>{const grant=this.exact(ref);this.registered(grant.input);if(grant.state!=="active"||grant.input.expiresAt<=this.now())throw new Error("Execution grant inactive or expired");
 const limits=Limits.parse(this.limits(grant.input.project));const rows=z.array(z.object({id:z.string()}).strict()).parse(this.db.prepare("SELECT id FROM project_execution_grants WHERE state IN ('reserved','active')").all());const held=rows.map(r=>this.read(r.id)!);
 if(held.reduce((n,g)=>n+g.input.leases.length,0)>limits.maxTasks||held.filter(g=>g.input.role==="supervisor").reduce((n,g)=>n+g.input.leases.length,0)>limits.maxSupervisors||limits.projectMaxTasks!==null&&held.filter(g=>g.input.project.projectId===grant.input.project.projectId).reduce((n,g)=>n+g.input.leases.length,0)>limits.projectMaxTasks)throw new Error("Execution grant live capacity exhausted");
 for(const repo of grant.input.repositoryDigests)if(held.filter(g=>g.input.repositoryDigests.includes(repo)).length>limits.maxWritersPerRepository)throw new Error("Execution grant live writer capacity exhausted");return grant;});}
 revoke(ref:ExecutionGrantRef):void{this.finish(ref,"revoked");}
 complete(ref:ExecutionGrantRef):void{this.finish(ref,"completed");}
 private finish(ref:ExecutionGrantRef,state:"revoked"|"completed"):void{this.transaction(()=>{const grant=this.exact(ref);if(grant.state===state)return;if(grant.state==="revoked"||grant.state==="completed")throw new Error("Execution grant already finished");this.db.prepare("UPDATE project_execution_grants SET state=?,updated_at=? WHERE id=?").run(state,this.now(),ref.grantId);});}
}
