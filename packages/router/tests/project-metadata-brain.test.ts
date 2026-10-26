import { BrainAccess } from "../src/brain/access.js";
import type { PromotionReviewPort } from "../src/brain/promotion.js";
import { PROMOTION_RUBRIC_VERSION } from "../src/verification/promotion-review.js";
import { afterEach, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as attribution from "../src/attribution/index.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { parseConfig } from "../src/config/load.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { unpackSelectedCommitOutcome } from "../src/attribution/selected-commit.js";
import { Brain } from "../src/brain/brain.js";
import { openDatabase } from "../src/storage/db.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import * as gitModule from "../src/workspaces/git.js";
import { git } from "../src/workspaces/git.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";

let environment:Env|undefined,db:ReturnType<typeof openDatabase>|undefined;
afterEach(()=>{vi.restoreAllMocks();db?.close();db=undefined;environment?.cleanup();environment=undefined;});
const actor={agent:"human:fixture",role:"human"};
it.each(["write","remove","initialize","same"] as const)("pending publication blocks Brain %s before file or search-index effects",async operation=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);
  const brain=new Brain(environment.cfg,db);await brain.ensure();
  const rel="global/lessons/retained.md",file=path.join(brain.root,...rel.split("/"));
  await brain.write({kind:"human"},actor,rel,"# Retained\n\nOriginal text.\n");
  writeFileSync(path.join(brain.root,"pending.txt"),"retained publication");
  const outcome=await commitSelectedApplication(brain.root,{actor,message:"Pending fixture",paths:["pending.txt"]},{refPublished:async()=>{throw Error("retain pending");}});
  expect(outcome.kind).toBe("reconciliation_required");
  const readme=path.join(brain.root,"README.md");
  if(operation==="initialize")unlinkSync(readme);
  const before={head:await git(brain.root,["rev-parse","HEAD"]),text:readFileSync(file),rows:db.prepare("SELECT * FROM brain_files ORDER BY path").all()};
  const action=operation==="same" ? brain.write({kind:"human"},actor,rel,"# Retained\n\nOriginal text.\n") : operation==="write" ? brain.write({kind:"human"},actor,rel,"# Changed\n") : operation==="remove" ? brain.remove({kind:"human"},actor,rel,"test removal") : new Brain(environment.cfg,db).ensure();
  await expect(action).rejects.toMatchObject({detail:{kind:"pending_publication"}});
  expect({head:await git(brain.root,["rev-parse","HEAD"]),text:readFileSync(file),rows:db.prepare("SELECT * FROM brain_files ORDER BY path").all()}).toEqual(before);
  if(operation==="initialize")expect(existsSync(readme)).toBe(false);
});

it("bootstraps under the original host capability without waiting on a queued ordinary initializer", async () => {
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);
  const first=new Brain(environment.cfg,db);await first.ensure();
  const second=new Brain(environment.cfg,db);let queued:Promise<void>|undefined;
  await withRepositoryMutation([first.root],async mutation=>{
    queued=second.ensure();
    await second.ensure({mutation});
  });
  await queued;
  expect(existsSync(path.join(first.root,"README.md"))).toBe(true);
},120_000);

for(const uncertain of [false,true])it(`nested project removal ${uncertain?"preserves SQL recovery context when README publication becomes uncertain":"publishes excluded index before configured project purge"}`,async()=>{
  environment=makeEnv({config:baseConfig({repositories:{},projects:{demo:{repositories:{core:{path:"repo"}}},removed:{repositories:{core:{path:"repo"}}}}})});
  db=openDatabase(environment.cfg.storageDir);const cfg=new ProjectRegistry(environment.cfg).require("demo"),brain=new Brain(cfg,db);await brain.ensure();
  const rel="projects/removed/facts/retained.md";
  await brain.write({kind:"human"},actor,rel,"# Retained recovery record\n");
  const rows=db.prepare("SELECT * FROM brain_files WHERE path = ?").all(rel);expect(rows).toHaveLength(1);
  expect(readFileSync(path.join(brain.root,"README.md"),"utf8")).toContain("projects/removed/README.md");
  if(uncertain){const original=attribution.commitAs;vi.spyOn(attribution,"commitAs").mockImplementation(async(repo,who,message,options={},control={})=>{
    if(message!=="Regenerate brain index")return original(repo,who,message,options,control);
    return unpackSelectedCommitOutcome(await commitSelectedApplication(repo,{actor:who,message,paths:options.paths},{...control,refPublished:async()=>{throw Error("retain README publication");}}));
  });}
  const remove=withRepositoryMutation([brain.root],mutation=>brain.removeProjectFolder("removed",actor,"delete fixture",{mutation,deferPush:true}));
  if(uncertain){await expect(remove).rejects.toMatchObject({detail:{kind:"reconciliation_required"}});expect(db.prepare("SELECT * FROM brain_files WHERE path = ?").all(rel)).toEqual(rows);}
  else {await expect(remove).resolves.toMatchObject({files:1});expect(readFileSync(path.join(brain.root,"README.md"),"utf8")).not.toContain("projects/removed/README.md");expect(db.prepare("SELECT * FROM brain_files WHERE path = ?").all(rel)).toEqual([]);}
  expect(cfg.projectResolution?.projects.map(project=>project.slug)).toContain("removed");
},120_000);

it("blocks a Git-backed non-committing mount behind its actual owner's retained publication",async()=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);
  const cfg=parseConfig(baseConfig({brain:{path:"brain",project:"demo",mounts:[{prefix:"projects/demo/facts",path:"repo",commit:false}]}}),environment.cfg.configPath);
  const brain=new Brain(cfg,db);await brain.ensure();const file=path.join(environment.repo,"README.md"),before=readFileSync(file);
  writeFileSync(path.join(environment.repo,"pending.txt"),"retained");
  expect((await commitSelectedApplication(environment.repo,{actor,message:"Retain external owner",paths:["pending.txt"]},{refPublished:async()=>{throw Error("retain external publication");}})).kind).toBe("reconciliation_required");
  await expect(brain.write({kind:"human"},actor,"projects/demo/facts/README.md","# Bad\n")).rejects.toMatchObject({detail:{kind:"pending_publication"}});
  expect(readFileSync(file)).toEqual(before);
},120_000);
it("refuses a host capability for a missing Brain before creating its directory or Git repository",async()=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);const brain=new Brain(environment.cfg,db);
  await expect(withRepositoryMutation([environment.repo],mutation=>brain.ensure({mutation}))).rejects.toBeDefined();
  expect(existsSync(brain.root)).toBe(false);
});

it("defers optional remote push until the host has released its outer repository lease",async()=>{
  environment=makeEnv({config:baseConfig({brain:{path:"brain",project:"demo",push:true}})});db=openDatabase(environment.cfg.storageDir);
  const brain=new Brain(environment.cfg,db);await brain.ensure();const original=gitModule.git;let pushes=0;
  vi.spyOn(gitModule,"git").mockImplementation(async(...args)=>{
    if(args[1][0]==="push"){expect(existsSync(path.join(brain.root,".git","meritrouter-mutation.lock"))).toBe(false);pushes++;return "";}
    return original(...args);
  });
  await withRepositoryMutation([brain.root],async mutation=>{await brain.regenerateIndex(actor,{mutation,deferPush:true});expect(pushes).toBe(0);});
  await brain.pushPending();expect(pushes).toBe(1);
},120_000);

it.each([null,false,0,""])("refuses forged falsy host capability %j before initializing a Brain",async forged=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);const brain=new Brain(environment.cfg,db);
  await expect(brain.ensure({mutation:forged as never})).rejects.toMatchObject({detail:{kind:"invalid_capability"}});
  expect(existsSync(brain.root)).toBe(false);
});

it("refreshes an identical entry index without changing bytes, mtime, HEAD or commit provenance",async()=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);const brain=new Brain(environment.cfg,db);await brain.ensure();
  const rel="projects/demo/facts/same.md",file=path.join(brain.root,...rel.split("/")),text="# Unchanged\n\nRetain exact bytes.\n";
  await brain.write({kind:"human"},actor,rel,text);const before={bytes:readFileSync(file),mtime:statSync(file).mtimeMs,head:await git(brain.root,["rev-parse","HEAD"]),history:await git(brain.root,["log","-1","--format=%B"])};
  db.prepare("DELETE FROM brain_fts WHERE path = ?").run(rel);db.prepare("DELETE FROM brain_files WHERE path = ?").run(rel);
  const commit=vi.spyOn(attribution,"commitAs");
  await expect(brain.write({kind:"human"},actor,rel,text,undefined,{expectedDigest:"wrong"})).rejects.toMatchObject({code:"brain_conflict"});
  expect(db.prepare("SELECT title FROM brain_files WHERE path = ?").get(rel)).toBeUndefined();
  const result=await brain.write({kind:"human"},{agent:"human:other",role:"human"},rel,text);
  expect(result.commit).toBeNull();expect(commit).not.toHaveBeenCalled();
  expect({bytes:readFileSync(file),mtime:statSync(file).mtimeMs,head:await git(brain.root,["rev-parse","HEAD"]),history:await git(brain.root,["log","-1","--format=%B"])}).toEqual(before);
  expect(db.prepare("SELECT title FROM brain_files WHERE path = ?").get(rel)).toEqual({title:"Unchanged"});
},120_000);

it("does not collapse existing CRLF bytes into the LF no-op comparison",async()=>{
  environment=makeEnv({config:baseConfig({brain:{path:"brain",project:"demo",commit:false}})});db=openDatabase(environment.cfg.storageDir);const brain=new Brain(environment.cfg,db);await brain.ensure();
  const rel="projects/demo/facts/endings.md",file=path.join(brain.root,...rel.split("/"));await brain.write({kind:"human"},actor,rel,"# Endings\r\n");
  expect(readFileSync(file,"utf8")).toBe("# Endings\r\n");
  await brain.write({kind:"human"},actor,rel,"# Endings\n");
  expect(readFileSync(file,"utf8")).toBe("# Endings\n");
},120_000);

it("queues actual promotion settlement and a second alias Brain report before acquiring common authority",async()=>{
  environment=makeEnv();db=openDatabase(environment.cfg.storageDir);
  const port:PromotionReviewPort={async start(){return{kind:"started",reviewTaskId:"t_review_fixture",reviewer:"fixture:beta"};},result(){return{kind:"verdict",verdict:"pass",reasons:[],reviewer:"fixture:beta",reviewerModel:"beta",rubric:PROMOTION_RUBRIC_VERSION};}};
  const brain=new Brain(environment.cfg,db,Date.now,{reviewer:port});await brain.ensure();
  const source="projects/demo/decisions/retries.md";await brain.write({kind:"human"},actor,source,"# Retries\n\nJittered retries resolved an outage.\n");
  const principal=new BrainAccess(db,environment.cfg).principalFor("supervisor",{project:"demo",effort:"job",repos:["core"],task:null,jobId:"job",tier:"T3"});
  const proposal=await brain.promoteLesson(principal,{agent:"supervisor:job",role:"supervisor",model:"fixture:alpha"},"Retry idempotent calls with jitter","Retry idempotent remote calls with jittered exponential backoff and cap attempts so an outage cannot consume the entire request budget.",[source]);
  expect(proposal.status).toBe("pending_review");
  const alias=path.join(environment.dir,"brain-alias");symlinkSync(brain.root,alias,process.platform==="win32"?"junction":"dir");
  const second=new Brain({...environment.cfg,brain:{...environment.cfg.brain,path:alias}},db);await second.ensure();
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;});
  const original=attribution.commitAs;let held=false;
  vi.spyOn(attribution,"commitAs").mockImplementation(async(...args)=>{if(!held&&args[2].startsWith("Update promotion")){held=true;enter();await unblock;}return original(...args);});
  const settlement=brain.promotions.settle();void settlement.catch(()=>undefined);await entered;
  const nativeGit=gitModule.git;let ordinaryAdmissionAttempts=0;
  vi.spyOn(gitModule,"git").mockImplementation(async(...args)=>{if(args[1][0]==="rev-parse"&&args[1][1]==="--absolute-git-dir")ordinaryAdmissionAttempts++;return nativeGit(...args);});
  let reportSettled=false;
  const report=second.writeReport({kind:"human"},{agent:"worker:report",role:"inspector"},"projects/demo/working/job/reports/worker.md",{label:"worker",outcome:"Done",outcomeContext:"checked",changed:"report",commands:"fixture execution",notVerified:"external providers",questions:"none"});
  void report.then(()=>{reportSettled=true;},()=>{reportSettled=true;});
  try {await new Promise(resolve=>setTimeout(resolve,10500));expect(reportSettled).toBe(false);expect(ordinaryAdmissionAttempts).toBe(0);}
  finally {release();await Promise.allSettled([settlement,report]);}
  expect(await settlement).toBe(1);await expect(report).resolves.toMatchObject({path:"projects/demo/working/job/reports/worker.md"});
  expect(brain.promotions.get(proposal.id!)?.status).toBe("approved");expect(readFileSync(path.join(brain.root,"projects/demo/working/job/reports/worker.md"),"utf8")).toContain("checked");
},120_000);
