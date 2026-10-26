import { createHash } from "node:crypto";
import { z } from "zod";
import { immediate, type Db } from "../storage/db.js";
import { ProjectEvidenceScope } from "../storage/project-evidence-scope.js";
import { canonicalJson } from "../storage/tasks.js";
import { readStoreIdentity, readProjectStoreRegistration, assertCriticalStoreDurability, ProjectStoreIdentitySchema, type ProjectStoreIdentity } from "../projects/store-identity.js";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const label=z.string().min(1).max(256);
const portSchema=z.number().int().min(1).max(65535);
const Receipt=z.object({port:portSchema,reservation_id:z.string(),installation_uuid:z.uuid(),project_uuid:z.uuid(),store_uuid:z.uuid(),generation:z.number().int().positive(),lab_digest:z.string().regex(/^[a-f0-9]{64}$/),name_digest:z.string().regex(/^[a-f0-9]{64}$/),created_at:z.number().int().nonnegative()}).strict();

/** Host-wide numeric port ownership. Private Lab names, recipes and process evidence stay local. */
export class ProjectLabPortReservations {
 private readonly identity:ProjectStoreIdentity;
 private readonly scope:ProjectEvidenceScope;
 constructor(private readonly global:Db,private readonly local:Db,identity:ProjectStoreIdentity,private readonly authority:{assertCurrent():void;assertPinned():void},private readonly now:()=>number=Date.now){
  this.identity=Object.freeze(ProjectStoreIdentitySchema.parse(identity));this.scope=new ProjectEvidenceScope(local);
  if(global===local||canonicalJson(readStoreIdentity(local))!==canonicalJson(this.identity))throw new Error("Port reservations require an exact separate project store");
  this.owner();
 }
 private owner(){assertCriticalStoreDurability(this.global);const owner=readStoreIdentity(this.global);if(owner?.role!=="coordination"||owner.installationId!==this.identity.installationId)throw new Error("Port reservations require matching coordination authority");}
 usesDatabase(db:Db):boolean{return db===this.local;}
 private binding(labId:string,name:string){const lab=hash(label.parse(labId)),named=hash(label.parse(name));return {lab,named,id:hash(canonicalJson({owner:this.identity,lab,name:named}))};}
 private localLab(labId:string,release=false){
  if(release)this.authority.assertPinned();else this.authority.assertCurrent();this.scope.assert();
  const row=z.object({project_id:z.string(),state:z.string()}).strict().parse(this.local.prepare("SELECT project_id,state FROM labs WHERE id=?").get(label.parse(labId)));
  if(row.project_id!==this.identity.slug)throw new Error("Lab port owner is unavailable in this project");
  return row;
 }
 private receipt(raw:unknown,labId:string,name:string){const row=Receipt.parse(raw),bound=this.binding(labId,name);if(row.reservation_id!==bound.id||row.installation_uuid!==this.identity.installationId||row.project_uuid!==this.identity.projectId||row.store_uuid!==this.identity.storeId||row.generation!==this.identity.generation||row.lab_digest!==bound.lab||row.name_digest!==bound.named)throw new Error("Lab port receipt binding mismatch");return row;}
 private quiescent(labId:string){
  const lab=this.localLab(labId,true);
  if(!["creating","stopped","failed","destroyed"].includes(lab.state)
   ||this.local.prepare("SELECT 1 FROM lab_command_owners WHERE lab_id=? LIMIT 1").get(labId)
   ||this.local.prepare("SELECT 1 FROM lab_capacity_owners WHERE lab_id=? LIMIT 1").get(labId)
   ||this.local.prepare("SELECT 1 FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped' LIMIT 1").get(labId)
   ||this.local.prepare("SELECT 1 FROM lab_services WHERE lab_id=? AND (state NOT IN ('stopped','failed') OR pid IS NOT NULL OR token IS NOT NULL) LIMIT 1").get(labId))throw new Error("Lab port release requires durable process quiescence");
 }
 private mutation<T>(fn:()=>T):T{
  this.owner();if(this.global.inTransaction)throw new Error("Port authority requires an independent coordination transaction");
  return immediate(this.global,()=>{const registration=readProjectStoreRegistration(this.global,this.identity.projectId);if(!registration||registration.state!=="registered"||registration.storeId!==this.identity.storeId||registration.generation!==this.identity.generation)throw new Error("Lab port project generation is unavailable");return fn();});
 }
 /** Called while local selection is held; no local reads occur inside the global transaction. */
 reserve(labId:string,name:string,port:number):boolean{
  portSchema.parse(port);return immediate(this.local,()=>{this.localLab(labId);this.quiescent(labId);const bound=this.binding(labId,name);
   return this.mutation(()=>{const old=this.global.prepare("SELECT * FROM project_lab_ports WHERE reservation_id=?").get(bound.id);if(old){const row=this.receipt(old,labId,name);if(row.port!==port)throw new Error("Lab port binding already has another numeric port");return true;}
    return this.global.prepare("INSERT OR IGNORE INTO project_lab_ports(port,reservation_id,installation_uuid,project_uuid,store_uuid,generation,lab_digest,name_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(port,bound.id,this.identity.installationId,this.identity.projectId,this.identity.storeId,this.identity.generation,bound.lab,bound.named,this.now()).changes===1;
   });
  });
 }
 current(labId:string,name:string):number|null{this.localLab(labId);this.owner();const raw=this.global.prepare("SELECT * FROM project_lab_ports WHERE reservation_id=?").get(this.binding(labId,name).id);return raw?this.receipt(raw,labId,name).port:null;}
 /** No age-based reclamation: unknown command/process evidence keeps the reservation. */
 release(labId:string,name?:string):void{
  immediate(this.local,()=>{this.quiescent(labId);const lab=hash(label.parse(labId)),named=name===undefined?null:hash(label.parse(name));
   this.mutation(()=>{this.global.prepare("DELETE FROM project_lab_ports WHERE installation_uuid=? AND project_uuid=? AND store_uuid=? AND generation=? AND lab_digest=? AND (? IS NULL OR name_digest=?)").run(this.identity.installationId,this.identity.projectId,this.identity.storeId,this.identity.generation,lab,named,named);});
  });
 }
}
