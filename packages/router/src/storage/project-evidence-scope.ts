import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { readStoreIdentity, assertCriticalStoreDurability, type StoreIdentity } from "../projects/store-identity.js";

const same=(a:string,b:string)=>process.platform==="win32" ? a.toLowerCase()===b.toLowerCase() : a===b;
const segment=z.string().min(1).max(256).refine(value=>value!=="."&&value!==".."&&!/[\\/:\0]/.test(value),"Invalid evidence path component");
/** Physical private-store ownership; an unbound legacy connection keeps its existing semantics. */
export class ProjectEvidenceScope {
  private readonly identity:StoreIdentity|null;
  private readonly filePin:{dev:bigint;ino:bigint;birth:bigint}|null;
  constructor(private readonly db:Db){this.identity=readStoreIdentity(db);const stat=this.identity?.role==="project"?lstatSync(db.name,{bigint:true}):null;this.filePin=stat?{dev:stat.dev,ino:stat.ino,birth:stat.birthtimeNs}:null;}
  get project():string|null{return this.identity?.role==="project" ? this.identity.slug : null;}
  assert():void{
    if(this.filePin){const stat=lstatSync(this.db.name,{bigint:true});if(stat.isSymbolicLink()||stat.nlink!==1n||stat.dev!==this.filePin.dev||stat.ino!==this.filePin.ino||stat.birthtimeNs!==this.filePin.birth)throw new Error("Private evidence database file changed");}
    const current=readStoreIdentity(this.db);
    if(this.identity?.role==="coordination"||current?.role==="coordination")throw new Error("Private evidence requires an explicit project store");
    if(JSON.stringify(current)!==JSON.stringify(this.identity))throw new Error("Private evidence store generation changed");
    if(current)assertCriticalStoreDurability(this.db);
  }
  assertProject(project:string):void{this.assert();if(this.project!==null&&project!==this.project)throw new Error("Evidence belongs to another project");}
  assertTask(taskId:string|null|undefined):void{
    this.assert();if(this.project===null||taskId==null)return;
    segment.parse(taskId);
    const row=z.object({project_id:z.string()}).strict().safeParse(this.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(taskId));
    if(!row.success||row.data.project_id!==this.project)throw new Error("Evidence task is unavailable in this project");
  }
  assertExecution(executionId:string|null|undefined,taskId?:string|null):void{
    this.assert();if(this.project===null||executionId==null)return;
    const found=this.db.prepare("SELECT 1 FROM executions WHERE id=?").get(z.string().min(1).max(256).parse(executionId));
    if(!found||taskId&&!this.db.prepare("SELECT 1 FROM execution_members WHERE execution_id=? AND task_id=?").get(executionId,taskId))throw new Error("Evidence execution is unavailable in this project");
  }
  /** Registered split DBs use <project>/.MeritRouter/state; all evidence has one canonical root. */
  rootFor(supplied:string):string{
    if(this.project===null)return supplied;
    this.assert();const state=path.dirname(path.resolve(this.db.name)),root=path.dirname(state);
    if(path.basename(state)!=="state"||path.basename(root).toLowerCase()!==".meritrouter")throw new Error("Project evidence requires a registered runtime layout");
    const resolved=path.resolve(supplied),relative=path.relative(root,resolved);
    if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("Evidence directory escapes its project runtime");
    return root;
  }
  path(file:string,root:string):void{
    this.assert();if(this.project===null)return;
    const base=path.resolve(root),target=path.resolve(file),relative=path.relative(base,target);
    if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("Evidence path escapes its owner");
    const parts=relative.split(path.sep).filter(Boolean);parts.forEach(value=>segment.parse(value));
    let current=path.parse(target).root;
    for(const component of [null,...target.slice(current.length).split(path.sep).filter(Boolean)]){
      if(component!==null)current=path.join(current,component);
      try{
        const stat=lstatSync(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1||!same(realpathSync(current),path.resolve(current)))throw new Error("Evidence path is redirected or hardlinked");
      }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")break;throw error;}
    }
  }
}
