import Database from "better-sqlite3";
import { lstatSync,realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { openDatabase,databasePath,type Db } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import type { StoredTask } from "../storage/tasks.js";
import { assertStoreRole } from "../storage/store-role.js";
import { LeaseRefSchema,type LeaseRef } from "../storage/task-leases.js";
import { readProjectStoreRegistration,readStoreIdentity,ProjectStoreIdentitySchema,type ProjectStoreIdentity } from "./store-identity.js";
import { projectRuntimePaths,type ProjectRuntimePaths } from "./runtime-paths.js";
import { projectContext,type ProjectContext } from "./context.js";
import type { ProjectRuntimeStore } from "./runtime-store.js";
import type { Admission } from "../admission/admission.js";
import type { ProjectRequestLedger } from "../admission/project-request-ledger.js";
import type { Gate } from "../gateway/gate.js";
import type { TaskRouter } from "../routing/router.js";
import type { Executor, ExecutorDeps } from "../core/executor.js";

export interface ProjectRuntimeBundle extends ProjectRuntimeStore {
 assertCurrent():void;
 assertPinned():void;
 readonly identity:ProjectStoreIdentity;readonly cfg:ProjectContext;readonly paths:ProjectRuntimePaths;
 readonly brain:ExecutorDeps["brain"];readonly access:ExecutorDeps["access"];readonly taskLeases:Executor["taskLeases"];
 readonly admission:Admission;readonly ledger:ProjectRequestLedger;readonly gate:Gate;readonly router:TaskRouter;readonly executor:Executor;
 runSingle(task:StoredTask):Promise<void>;runBatch(tasks:StoredTask[]):Promise<void>;
 /** Drain local work/accounting. Registry alone closes its SQLite connection afterwards. */
 drain():Promise<void>;
}
export interface ProjectRuntimeConstruction {assertCurrent():void;assertPinned?():void;identity:ProjectStoreIdentity;cfg:ProjectContext;paths:ProjectRuntimePaths;db:Db}
export interface ProjectRuntimeRegistryOptions {
 context(slug:string):ProjectContext;
 build(input:ProjectRuntimeConstruction):ProjectRuntimeBundle;
 /** Explicit source checkout exclusion, independently of downstream repository aliases. */
 forbiddenProjectDirectories?:readonly string[];
}
const samePath=(a:string,b:string)=>process.platform==="win32"?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
function physical(value:string,kind:"directory"|"file"):string{
 const stat=lstatSync(value);if(stat.isSymbolicLink()||(kind==="directory"?!stat.isDirectory():!stat.isFile()))throw new Error("Project runtime path is redirected or has the wrong kind");
 if(kind==="file"&&stat.nlink!==1)throw new Error("Project database file has unexpected hard links");
 const real=realpathSync(value);if(!samePath(real,value))throw new Error("Project runtime path traverses a redirected ancestor");return real;
}
/** Existing registered stores only. Provisioning/migration is a separate explicit operation. */
export class ProjectRuntimeRegistry {
 private readonly entries=new Map<string,ProjectRuntimeBundle>();private closing=false;private closingPromise:Promise<void>|null=null;
 constructor(readonly coordinationDb:Db,private readonly options:ProjectRuntimeRegistryOptions){if(readStoreIdentity(coordinationDb)?.role!=="coordination")throw new Error("Runtime registry requires explicit coordination store");}
 private readonly releasing=new Set<string>();
 private registration(id:string,allowClosing=false){if(this.closing&&!allowClosing)throw new Error("Project runtime registry is closing");if(!allowClosing&&this.releasing.has(id))throw new Error("Project runtime is being released");const r=readProjectStoreRegistration(this.coordinationDb,z.uuid().parse(id));if(!r||r.state!=="registered")throw new Error("Project runtime is unavailable or requires migration");return r;}
 openRegistered(id:string):ProjectRuntimeBundle{
  const r=this.registration(id),identity=Object.freeze(ProjectStoreIdentitySchema.parse({version:1,role:"project",installationId:r.installationId,projectId:r.projectId,storeId:r.storeId,generation:r.generation,slug:r.slug}));
  const existing=this.entries.get(id);if(existing){if(canonicalJson(existing.identity)!==canonicalJson(identity)||!samePath(existing.paths.projectDirectory,r.projectDirectory))throw new Error("Cached project runtime generation changed; explicit drain required");existing.assertCurrent();return existing;}
  const context=this.options.context(r.slug);if(context.project.slug!==r.slug||context.brain.project!==r.slug||context.projectDirectory===null||!samePath(context.projectDirectory,r.projectDirectory))throw new Error("Configured project runtime directory or scope disagrees with registration");
  if(this.options.forbiddenProjectDirectories?.some(dir=>samePath(dir,r.projectDirectory)))throw new Error("Router source checkout cannot own a project runtime");
  physical(r.projectDirectory,"directory");const paths=projectRuntimePaths(r.projectDirectory);physical(paths.root,"directory");physical(paths.state,"directory");const file=databasePath(paths.state);physical(file,"file");
  // Read role before writable open/migrations so a wrong store is never silently converted.
  const preflight=new Database(file,{readonly:true,fileMustExist:true});try{const found=readStoreIdentity(preflight);if(canonicalJson(found)!==canonicalJson(identity))throw new Error("Registered project store manifest is missing or mismatched");}finally{preflight.close();}
  const initial=lstatSync(file,{bigint:true}),pin={dev:initial.dev,ino:initial.ino,birth:initial.birthtimeNs};
  const db=openDatabase(paths.state,{durability:"full",fileMustExist:true,expectedIdentity:identity});
  const assertPinned=()=>{
   const current=this.registration(id,true);
   if(current.installationId!==identity.installationId||current.projectId!==identity.projectId||current.storeId!==identity.storeId||current.generation!==identity.generation||current.slug!==identity.slug||!samePath(current.projectDirectory,paths.projectDirectory))throw new Error("Pinned runtime registration generation changed");
   physical(paths.projectDirectory,"directory");physical(paths.root,"directory");physical(paths.state,"directory");physical(file,"file");
   const stat=lstatSync(file,{bigint:true});if(stat.dev!==pin.dev||stat.ino!==pin.ino||stat.birthtimeNs!==pin.birth)throw new Error("Pinned project database file was replaced");
   assertStoreRole(db,identity);
  };
  const assertCurrent=()=>{if(this.closing)throw new Error("Project runtime registry is closing");assertPinned();};
  try{
   assertCurrent();
   const cfg=projectContext(context,{project:context.project,projectDirectory:r.projectDirectory,storageDir:paths.state,storage:{...context.storage,durability:"full"},brain:{...context.brain,path:paths.brain,project:r.slug}});
   const bundle=this.options.build({assertCurrent,assertPinned,identity,cfg,paths,db});
   if(bundle.db!==db||bundle.tasks.db!==db||canonicalJson(bundle.identity)!==canonicalJson(identity)||bundle.project!==r.slug)throw new Error("Project runtime factory returned foreign stores");
   assertStoreRole(db,identity);this.entries.set(id,bundle);return bundle;
  }catch(error){db.close();throw error;}
 }
 forSlug(slug:string):ProjectRuntimeBundle{
  if(this.closing)throw new Error("Project runtime registry is closing");
  const rows=z.array(z.object({id:z.uuid()}).strict()).parse(this.coordinationDb.prepare("SELECT project_uuid id FROM project_store_registrations WHERE slug=? AND state='registered'").all(z.string().min(1).max(128).parse(slug)));
  if(rows.length!==1)throw new Error("Project runtime slug is missing or ambiguous");return this.openRegistered(rows[0]!.id);
 }
 forLease(value:LeaseRef):ProjectRuntimeBundle{
  const lease=LeaseRefSchema.parse(value),bundle=this.forSlug(lease.project),task=bundle.tasks.get(lease.taskId);
  if(!task||task.row.project_id!==lease.project||task.row.lease_incarnation!==lease.incarnation||task.row.run_count!==lease.runCount||task.row.lease_owner!==lease.owner)throw new Error("Project runtime lease generation changed");return bundle;
 }
 loaded():readonly ProjectRuntimeBundle[]{return [...this.entries.values()];}
 /** Fence one project against new opens, run `before` (stop its dispatch), drain it and close its store. */
 async release(id:string,before:()=>Promise<void>=async()=>{}):Promise<void>{
  const key=z.uuid().parse(id);if(this.releasing.has(key))throw new Error("Project runtime is already being released");this.releasing.add(key);
  try{await before();const bundle=this.entries.get(key);if(bundle){await bundle.drain();if(bundle.db.open)bundle.db.close();this.entries.delete(key);}}
  finally{this.releasing.delete(key);}
 }
 close():Promise<void>{if(this.closingPromise)return this.closingPromise;this.closing=true;this.closingPromise=(async()=>{const results=await Promise.allSettled([...this.entries.values()].map(async bundle=>{await bundle.drain();if(bundle.db.open)bundle.db.close();}));const errors=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected").map(r=>r.reason);if(errors.length)throw new AggregateError(errors,"Project runtimes could not drain; their stores remain open");this.entries.clear();})();return this.closingPromise;}
}
