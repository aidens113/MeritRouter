import { afterEach, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { makeEnv, summarizeTask, type Env } from "./helpers.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity } from "../src/projects/store-identity.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { SessionStore } from "../src/sessions/store.js";
import { RequestCaptures } from "../src/storage/request-captures.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { usageSummary } from "../src/storage/usage.js";

const environments:Env[]=[], databases:Db[]=[];
afterEach(()=>{for(const db of databases.splice(0))if(db.open)db.close();for(const env of environments.splice(0))env.cleanup();});
function fixture(){
 const env=makeEnv();environments.push(env);const owner=createCoordinationStoreIdentity();
 const local=(slug:string)=>{const root=path.join(env.dir,slug,".MeritRouter"),state=path.join(root,"state"),db=openDatabase(state,{durability:"full"});databases.push(db);initializeStoreRole(db,createProjectStoreIdentity(owner.installationId,slug));const tasks=new TaskStore(db);tasks.submit([WorkerTaskSchema.parse(summarizeTask({id:"same-task"}))],{project:slug});return {db,root,state,artifacts:new ArtifactStore(db,state),sessions:new SessionStore(db,state)};};
 return {env,owner,a:local("alpha"),b:local("beta")};
}
it("keeps duplicate task evidence and taskless sessions in their canonical project roots",()=>{
 const {a,b}=fixture();for(const [project,local] of [["alpha",a],["beta",b]] as const){
  const ref=local.artifacts.write({taskId:"same-task",kind:"result",label:project,content:project});expect(local.artifacts.read(ref)?.content.toString()).toBe(project);
  const session=local.sessions.create({role:"summarizer",agentLabel:project});session.end("completed","done");
  expect(local.db.prepare("SELECT project_id FROM sessions").get()).toEqual({project_id:project});
  expect(local.sessions.get(session.id)?.logPath).toContain(path.join(local.root,"sessions"));
  expect(existsSync(path.join(local.state,"sessions"))).toBe(false);expect(existsSync(path.join(local.state,"artifacts"))).toBe(false);
 }expect(a.sessions.list()).toHaveLength(1);expect(b.sessions.list()).toHaveLength(1);
});
it("rejects foreign owners before creating evidence files",()=>{
 const {a}=fixture();expect(()=>a.artifacts.write({taskId:"missing",kind:"result",label:"x",content:"secret"})).toThrow(/task/);
 expect(()=>a.sessions.create({taskId:"missing",role:"summarizer",agentLabel:"x"})).toThrow(/task/);
 expect(()=>a.sessions.forTask("missing")).toThrow(/task/);expect(()=>a.artifacts.readScoped("missing","beta")).toThrow(/another project/);
 expect(existsSync(path.join(a.root,"sessions"))).toBe(false);expect(existsSync(a.artifacts.root)).toBe(false);
});
it("refuses coordination-role private APIs even when their tables are empty",()=>{
 const {env,owner}=fixture(),db=openDatabase(path.join(env.dir,"global"),{durability:"full"});databases.push(db);initializeStoreRole(db,owner);
 expect(()=>new ArtifactStore(db,env.dir).write({kind:"x",label:"x",content:"private"})).toThrow(/explicit project/);
 expect(()=>new SessionStore(db,env.dir).list()).toThrow(/explicit project/);
 expect(()=>new SessionStore(db,env.dir).forTask("missing")).toThrow(/explicit project/);
 expect(()=>new RequestCaptures(db).prune()).toThrow(/explicit project/);expect(()=>usageSummary(db,0)).toThrow(/explicit project/);
});
it("rejects redirected and hardlinked evidence instead of following foreign bytes",()=>{
 const {a,b}=fixture();mkdirSync(b.artifacts.root,{recursive:true});symlinkSync(b.artifacts.root,a.artifacts.root,"junction");
 expect(()=>a.artifacts.write({kind:"result",label:"x",content:"private"})).toThrow(/redirected/);
 const ref=b.artifacts.write({kind:"result",label:"x",content:"private"}),row=b.artifacts.get(ref)!;linkSync(b.artifacts.absolutePath(row),path.join(b.root,"copied-link"));expect(()=>b.artifacts.read(ref)).toThrow(/hardlinked/);
});
it("revalidates cached stores and recorders after the physical database acquires a foreign alias",()=>{
 const {a}=fixture(),session=a.sessions.create({role:"summarizer",agentLabel:"alpha"});
 linkSync(a.db.name,a.db.name+".alias");expect(()=>a.sessions.list()).toThrow(/database file changed/);
 expect(()=>session.end("completed","done")).toThrow(/database file changed/);
 expect(()=>a.artifacts.write({kind:"x",label:"x",content:"x"})).toThrow(/database file changed/);
});
it("refuses a changed generation and a stored log pointer into another project",()=>{
 const {a,b}=fixture(),session=a.sessions.create({role:"summarizer",agentLabel:"alpha"});
 const foreign=b.sessions.create({role:"summarizer",agentLabel:"beta"});
 a.db.prepare("UPDATE sessions SET log_path=? WHERE id=?").run(b.sessions.get(foreign.id)!.logPath,session.id);
 expect(()=>a.sessions.get(session.id)).toThrow(/escapes/);expect(()=>session.end("completed","done")).toThrow(/pointer/);
 const manifest=JSON.parse(a.db.prepare("SELECT manifest_json FROM store_identity").pluck().get() as string);manifest.generation++;
 a.db.prepare("UPDATE store_identity SET manifest_json=?").run(JSON.stringify(manifest));expect(()=>a.artifacts.get("missing")).toThrow(/generation/);
});
