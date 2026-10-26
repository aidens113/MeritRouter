import { afterEach, expect, it } from "vitest";
import path from "node:path";
import net from "node:net";
import { makeEnv, type Env } from "./helpers.js";
import { openDatabase, immediate, type Db } from "../src/storage/db.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { ProjectLabPortReservations } from "../src/labs/port-reservations.js";
import { allocatePorts } from "../src/labs/ports.js";
const envs:Env[]=[],dbs:Db[]=[];
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const env of envs.splice(0))env.cleanup();});
function fixture(){const env=makeEnv();envs.push(env);const global=openDatabase(path.join(env.dir,"global"),{durability:"full"});dbs.push(global);const owner=createCoordinationStoreIdentity();initializeStoreRole(global,owner);
 const local=(slug:string)=>{const root=path.join(env.dir,slug),db=openDatabase(path.join(root,".MeritRouter","state"),{durability:"full"});dbs.push(db);const identity=createProjectStoreIdentity(owner.installationId,slug);initializeStoreRole(db,identity);registerProjectStore(global,identity,root);
  db.prepare("INSERT INTO labs(id,project_id,name,state,root,recipe_json,repositories_json,ports_json,env_json,goal,created_at,updated_at,last_activity) VALUES('secret-lab',?,'private-name','creating',?,'{}','[]','{}','{}','private-goal',1,1,1)").run(slug,root);
  return {db,identity,ports:new ProjectLabPortReservations(global,db,identity,{assertCurrent(){},assertPinned(){}})};
 };return {global,a:local("alpha"),b:local("beta")};}
it("coordinates duplicate private Lab identities without sharing their names or content",()=>{
 const {global,a,b}=fixture();expect(a.ports.reserve("secret-lab","private-web",23456)).toBe(true);expect(a.ports.reserve("secret-lab","private-web",23456)).toBe(true);
 expect(b.ports.reserve("secret-lab","private-web",23456)).toBe(false);expect(b.ports.reserve("secret-lab","private-web",23457)).toBe(true);
 const rows=global.prepare("SELECT * FROM project_lab_ports").all();expect(rows).toHaveLength(2);const text=JSON.stringify(rows);for(const secret of ["secret-lab","private-web","private-name","private-goal"])expect(text).not.toContain(secret);
 expect(global.prepare("SELECT count(*) n FROM labs").get()).toEqual({n:0});
});
it("retains global ownership after local rollback and refuses unknown process evidence",()=>{
 const {global,a}=fixture();expect(()=>immediate(a.db,()=>{expect(a.ports.reserve("secret-lab","web",23456)).toBe(true);throw Error("local commit failed");})).toThrow(/local commit/);
 expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:1});
 a.db.prepare("INSERT INTO lab_command_owners(id,project_id,lab_id,kind,logical_name,token,command_digest,worktree_path,handle_json,phase,created_at,updated_at) VALUES('unknown','alpha','secret-lab','lab-service','web',?,?,'retained','{}','prepared',1,1)").run("a".repeat(48),"b".repeat(64));
 expect(()=>a.ports.release("secret-lab")).toThrow(/quiescence/);expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:1});
 a.db.prepare("DELETE FROM lab_command_owners").run();
 a.db.prepare("INSERT INTO lab_capacity_owners(reservation_id,project_id,lab_id,service_name,command_token,process_id,handle_json,created_at,updated_at) VALUES('unknown-capacity','alpha','secret-lab','web',?,NULL,'{}',1,1)").run("c".repeat(48));
 expect(()=>a.ports.release("secret-lab")).toThrow(/quiescence/);a.db.prepare("DELETE FROM lab_capacity_owners").run();
 a.db.prepare("UPDATE labs SET state='running'").run();expect(()=>a.ports.release("secret-lab")).toThrow(/quiescence/);
 a.db.prepare("UPDATE labs SET state='stopped'").run();a.ports.release("secret-lab");expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:0});
});
it("rejects foreign stores and stale generations without clearing held ports",async()=>{
 const {global,a,b}=fixture();expect(a.ports.reserve("secret-lab","web",23456)).toBe(true);
 await expect(allocatePorts(b.db,"secret-lab",["web"],[23456,23458],a.ports)).rejects.toThrow(/explicit shared/);
 await expect(allocatePorts(a.db,"secret-lab",["web"],[23456,23458])).rejects.toThrow(/explicit shared/);
 global.prepare("UPDATE project_store_registrations SET generation=2 WHERE project_uuid=?").run(a.identity.projectId);
 expect(()=>a.ports.release("secret-lab")).toThrow(/generation/);expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:1});
});
it("checks actual OS occupancy and recovers the exact stopped allocation across broker recreation",async()=>{
 const {global,a,b}=fixture(),server=net.createServer();await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:0},resolve);});
 const port=(server.address() as net.AddressInfo).port;
 try{await expect(allocatePorts(a.db,"secret-lab",["web"],[port,port],a.ports)).rejects.toThrow(/range exhausted/);expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:0});}
 finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 expect(await allocatePorts(a.db,"secret-lab",["web"],[port,port],a.ports)).toEqual({web:port});
 const reopened=new ProjectLabPortReservations(global,a.db,a.identity,{assertCurrent(){},assertPinned(){}});
 expect(await allocatePorts(a.db,"secret-lab",["web"],[port,port],reopened)).toEqual({web:port});
 await expect(allocatePorts(b.db,"secret-lab",["web"],[port,port],b.ports)).rejects.toThrow(/range exhausted/);
 expect(global.prepare("SELECT count(*) n FROM project_lab_ports").get()).toEqual({n:1});
});
