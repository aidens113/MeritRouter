import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeEnv, commitAll, type Env } from "./helpers.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore, syntheticResult } from "../src/storage/tasks.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { withUpstreamContext, recordedUpstream, INTEGRATED_EVENT, UPSTREAM_CONTEXT_EVENT } from "../src/context/upstream.js";
import { readersFor } from "../src/context/sources.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { MergeQueue } from "../src/workspaces/merge-queue.js";
import { git } from "../src/workspaces/git.js";
import * as gitModule from "../src/workspaces/git.js";

let env: Env | undefined,db: Db | undefined;
afterEach(()=>{vi.restoreAllMocks();db?.close();db=undefined;env?.cleanup();env=undefined;});
async function fixture(){
  env=makeEnv({files:{"placeholder":"initial"}});unlinkSync(path.join(env.repo,"placeholder"));commitAll(env.repo,"Empty canonical tree");
  db=openDatabase(env.cfg.storageDir);const tasks=new TaskStore(db),artifacts=new ArtifactStore(db,env.cfg.storageDir),d={cfg:env.cfg,tasks,artifacts};
  const base=(await git(env.repo,["rev-parse","HEAD"])).trim(),branch=`${env.cfg.supervisor.branch_prefix}job`,parent=path.join(env.dir,"parent");
  await git(env.repo,["worktree","add","-b",branch,parent,base]);
  tasks.submit([WorkerTaskSchema.parse({id:"job",profile:"supervise",goal:"Parent",repositoryAliases:["core"],constraints:{acceptanceCriteria:["parent"]}})],{project:"demo"});
  const submit=(id:string,profile="implement",dependsOn:string[]=[],extra:Record<string,unknown>={})=>tasks.submit([WorkerTaskSchema.parse({id,profile,parentTaskId:"job",goal:id,repositoryAliases:["core"],...(profile==="implement"?{writableRepository:"core"}:{}),context:{baseCommits:{core:base}},constraints:{allowedPaths:["app/**"],acceptanceCriteria:["source"]},dependsOn,...extra})],{project:"demo"});
  const finish=(id:string)=>{const result=syntheticResult(id,"completed","worker_submitted");result.acceptanceStatus="met";tasks.db.prepare("UPDATE tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify(result),id);};
  const workspace=async(id:string,from:string,files:Record<string,string>)=>{
    const ws=await new Worktrees(tasks.db,path.join(env!.cfg.storageDir,"worktrees")).prepare({taskId:id,run:1,alias:"core",sourcePath:env!.repo,baseCommit:from});
    for(const [file,text]of Object.entries(files)){mkdirSync(path.dirname(path.join(ws.worktreePath,file)),{recursive:true});writeFileSync(path.join(ws.worktreePath,file),text);}
    commitAll(ws.worktreePath,`Changes ${id}`);return {ws,head:(await git(ws.worktreePath,["rev-parse","HEAD"])).trim(),base:from};
  };
  const integrate=async(id:string,w:Awaited<ReturnType<typeof workspace>>)=>{
    const queue=new MergeQueue(tasks.db,tasks,"fixture"),item=queue.enqueue({jobId:"job",taskId:id,kind:"task",repo:"core",branch,integrationWorktree:parent,sourceWorktree:w.ws.worktreePath,sourceBase:w.base,sourceHead:w.head,commits:[w.head],acceptance:null});
    const done=await queue.run(item.id,{committer:{name:"fixture",email:"fixture@test"},integrated:()=>{}});expect(done.state).toBe("integrated");
    tasks.event(id,INTEGRATED_EVENT,{repository:"core",branch,head:done.afterHead!});return done.afterHead!;
  };
  return {d,tasks,artifacts,base,branch,parent,submit,finish,workspace,integrate};
}

it("resolves queued UI -> features -> readonly review -> runtime at readiness and freezes through later logs and parent changes",async()=>{
  const f=await fixture();
  f.submit("ui");f.submit("features","implement",["ui"]);f.submit("review","review",["features"]);f.submit("runtime","implement",["review"]);
  const ui=await f.workspace("ui",f.base,{"app/page.tsx":"export const ui = true;\n"});f.finish("ui");await f.integrate("ui",ui);
  const featuresReady=await withUpstreamContext(f.d,f.tasks.get("features")!);
  const features=await f.workspace("features",featuresReady.spec.context.baseCommits!.core!,{"app/features.tsx":"export const features = true;\n"});f.finish("features");const integrated=await f.integrate("features",features);
  const review=await withUpstreamContext(f.d,f.tasks.get("review")!);
  expect(review.spec.context.baseCommits).toEqual({core:integrated});
  const reader=readersFor(f.d.cfg,review.spec).get("core")!;
  expect((await reader.listFiles()).files).toEqual(["app/features.tsx","app/page.tsx"]);expect((await reader.search("features")).matches).toHaveLength(1);
  expect((await reader.readFile("app/page.tsx")).commit).toBe(integrated);f.finish("review");
  for(let n=0;n<550;n++)f.tasks.event("review","later_log",{n});
  writeFileSync(path.join(f.parent,"later.txt"),"Not reviewed");commitAll(f.parent,"Parent moved after review");
  const runtime=await withUpstreamContext(f.d,f.tasks.get("runtime")!);
  expect(runtime.spec.context.baseCommits).toEqual({core:integrated});expect(recordedUpstream(f.d,"runtime")!.baseCommits[0]!.rule).toBe("upstream_snapshot");
  expect((await readersFor(f.d.cfg,runtime.spec).get("core")!.listFiles()).files).not.toContain("later.txt");
  for(let n=0;n<550;n++)f.tasks.event("runtime","later_log",{n});
  writeFileSync(path.join(f.parent,"another.txt"),"Still not reviewed");commitAll(f.parent,"Parent moved again");
  const resumed=await withUpstreamContext(f.d,f.tasks.get("runtime")!);
  expect(resumed.spec.context).toEqual(runtime.spec.context);
  expect(f.tasks.db.prepare("SELECT COUNT(*) FROM events WHERE task_id='runtime' AND type=?").pluck().get(UPSTREAM_CONTEXT_EVENT)).toBe(1);
  expect(readdirSync(env!.repo)).toEqual([".git"]);
});

it("keeps no-dependency dispatch pins unchanged",async()=>{
  const f=await fixture();f.submit("inspect","inspect");
  writeFileSync(path.join(f.parent,"new.txt"),"parent advanced");commitAll(f.parent);
  const before=f.tasks.get("inspect")!,after=await withUpstreamContext(f.d,before);
  expect(after).toBe(before);expect(after.spec.context.baseCommits).toEqual({core:f.base});expect(f.artifacts.listForTask("inspect")).toHaveLength(0);
});

it("reviews a single unintegrated terminal owned head without fabricating acceptance",async()=>{
  const f=await fixture();f.submit("source");f.submit("review","review",["source"]);
  const source=await f.workspace("source",f.base,{"app/source.ts":"export const pending = true;\n"});f.finish("source");
  const result=f.tasks.get("source")!.result!;result.acceptanceStatus="not_verified";f.tasks.db.prepare("UPDATE tasks SET result_json=? WHERE id='source'").run(JSON.stringify(result));
  const review=await withUpstreamContext(f.d,f.tasks.get("review")!);
  expect(review.spec.context.baseCommits).toEqual({core:source.head});expect(f.tasks.get("source")!.result!.acceptanceStatus).toBe("not_verified");
});

it.each(["foreign-project","foreign-parent","missing-workspace","ambiguous","fake-integrated","reset-integration","undone-integration","foreign-repository"])("refuses %s source instead of falling back to stale canonical",async condition=>{
  const f=await fixture();f.submit("source");f.submit("review","review",["source"]);f.finish("source");
  let source:Awaited<ReturnType<typeof f.workspace>>|undefined;
  if(condition!=="missing-workspace")source=await f.workspace("source",f.base,{"app/source.ts":"export const source = true;\n"});
  if(condition==="foreign-project")f.tasks.db.prepare("UPDATE tasks SET project_id='foreign' WHERE id='source'").run();
  if(condition==="foreign-parent"){const t=f.tasks.get("source")!;f.tasks.db.prepare("UPDATE tasks SET spec_json=? WHERE id='source'").run(JSON.stringify({...t.spec,parentTaskId:"other-job"}));}
  if(condition==="ambiguous"){
    f.submit("other");const other=await f.workspace("other",f.base,{"app/other.ts":"export const other = true;\n"});f.finish("other");
    f.submit("ambiguous-review","review",["source","other"]);
    await expect(withUpstreamContext(f.d,f.tasks.get("ambiguous-review")!)).rejects.toThrow(/ambiguous/);expect(other.head).not.toBe(source!.head);return;
  }
  if(condition==="fake-integrated")f.tasks.event("source",INTEGRATED_EVENT,{repository:"core",branch:f.branch,head:source!.head});
  if(condition==="reset-integration"){await f.integrate("source",source!);await git(f.parent,["reset","--hard",f.base]);}
  if(condition==="undone-integration"){
    await f.integrate("source",source!);
    f.tasks.db.prepare("INSERT INTO verification_signals (task_id,kind,job_id,created_at,detail_json) VALUES ('source','undone','job',0,'{}')").run();
  }
  if(condition==="foreign-repository"){
    const foreign=path.join(env!.dir,"foreign");mkdirSync(foreign);await git(foreign,["init","-q"]);
    writeFileSync(path.join(foreign,"foreign.txt"),"foreign");commitAll(foreign);
    f.tasks.db.prepare("UPDATE workspaces SET worktree_path=? WHERE task_id='source'").run(foreign);
  }
  await expect(withUpstreamContext(f.d,f.tasks.get("review")!)).rejects.toThrow(/upstream_source_refused/);
  expect(recordedUpstream(f.d,"review")).toBeNull();expect(f.artifacts.listForTask("review")).toHaveLength(0);
});

it("inherits a standalone readonly dependency's explicit read pin and refuses missing or conflicting readonly subjects",async()=>{
  const f=await fixture();f.submit("reader","review");f.finish("reader");f.submit("runtime","implement",["reader"]);
  expect((await withUpstreamContext(f.d,f.tasks.get("runtime")!)).spec.context.baseCommits).toEqual({core:f.base});
  f.submit("missing-reader","review",[],{context:{}});f.finish("missing-reader");f.submit("missing-runtime","implement",["missing-reader"]);
  await expect(withUpstreamContext(f.d,f.tasks.get("missing-runtime")!)).rejects.toThrow(/no frozen read subject/);
  writeFileSync(path.join(f.parent,"new.txt"),"different subject");commitAll(f.parent);
  const later=(await git(f.parent,["rev-parse","HEAD"])).trim();
  f.submit("later-reader","review",[],{context:{baseCommits:{core:later}}});f.finish("later-reader");
  f.submit("conflicting-runtime","implement",["reader","later-reader"]);
  await expect(withUpstreamContext(f.d,f.tasks.get("conflicting-runtime")!)).rejects.toThrow(/ambiguous/);
});

it("fails closed when an existing frozen context is invalid instead of retargeting after resume",async()=>{
  const f=await fixture();f.submit("reader","review");f.finish("reader");f.submit("runtime","implement",["reader"]);
  await withUpstreamContext(f.d,f.tasks.get("runtime")!);
  f.tasks.db.prepare("UPDATE events SET data_json='{}' WHERE task_id='runtime' AND type=?").run(UPSTREAM_CONTEXT_EVENT);
  await expect(withUpstreamContext(f.d,f.tasks.get("runtime")!)).rejects.toThrow(/refusing to retarget/);
});


it("preserves parentless readonly declared or canonical subjects while still attaching upstream results",async()=>{
  const f=await fixture();f.submit("source");f.finish("source");
  await f.workspace("source",f.base,{"app/source.ts":"export const source = true;\n"});
  for(const pinned of [false,true]){
    const id=pinned?"standalone-pinned":"standalone-canonical";
    f.submit(id,"review",["source"],{parentTaskId:undefined,context:pinned?{baseCommits:{core:f.base}}:{}});
    const read=await withUpstreamContext(f.d,f.tasks.get(id)!);
    expect(read.spec.context.baseCommits).toEqual(pinned?{core:f.base}:undefined);
    expect(read.spec.context.artifactRefs).toHaveLength(1);
    expect(recordedUpstream(f.d,id)!.baseCommits).toEqual([]);
  }
});


it.each(["undo","source-project","source-parent","dependent-project","parent-scope","receipt"])("refuses %s changing during awaited integration proof with unchanged HEAD",async change=>{
  const f=await fixture();f.submit("source");f.submit("review","review",["source"]);f.finish("source");
  const source=await f.workspace("source",f.base,{"app/source.ts":"source\n"});await f.integrate("source",source);
  const original=gitModule.git;let injected=false;
  vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,options)=>{
    const output=await original(cwd,args,options);
    if(args[0]==="merge-base"&&!injected){
      injected=true;
      if(change==="undo")f.tasks.db.prepare("INSERT INTO verification_signals (task_id,kind,job_id,created_at) VALUES ('source','undone','job',0)").run();
      if(change==="source-project")f.tasks.db.prepare("UPDATE tasks SET project_id='foreign' WHERE id='source'").run();
      if(change==="dependent-project")f.tasks.db.prepare("UPDATE tasks SET project_id='foreign' WHERE id='review'").run();
      if(change==="source-parent"||change==="parent-scope"){
        const id=change==="source-parent"?"source":"job",task=f.tasks.get(id)!;
        f.tasks.db.prepare("UPDATE tasks SET spec_json=? WHERE id=?").run(JSON.stringify({...task.spec,...(change==="source-parent"?{parentTaskId:"foreign"}:{repositoryAliases:[]})}),id);
      }
      if(change==="receipt")f.tasks.db.prepare("UPDATE merge_queue SET state='failed' WHERE task_id='source'").run();
    }
    return output;
  });
  await expect(withUpstreamContext(f.d,f.tasks.get("review")!)).rejects.toThrow(/upstream_source_refused/);
  expect(injected).toBe(true);expect(recordedUpstream(f.d,"review")).toBeNull();expect(f.artifacts.listForTask("review")).toHaveLength(0);
});

it("rechecks earlier alias authority after later alias proof awaits",async()=>{
  const f=await fixture();f.d.cfg.repositoryPaths.aux={...f.d.cfg.repositoryPaths.core!};
  f.submit("source");f.submit("review","review",["source"]);f.finish("source");
  for(const id of ["job","source","review"]){
    const task=f.tasks.get(id)!;
    f.tasks.db.prepare("UPDATE tasks SET spec_json=? WHERE id=?").run(JSON.stringify({...task.spec,repositoryAliases:["core","aux"],context:{...task.spec.context,baseCommits:{core:f.base,aux:f.base}}}),id);
  }
  const source=await f.workspace("source",f.base,{"app/source.ts":"source\n"});await f.integrate("source",source);
  const original=gitModule.git;let coreProved=false,injected=false;
  vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,options)=>{
    const output=await original(cwd,args,options);
    if(args[0]==="merge-base")coreProved=true;
    if(coreProved&&args[0]==="rev-parse"&&args.includes(`${f.base}^{commit}`)&&!injected){
      injected=true;f.tasks.db.prepare("INSERT INTO verification_signals (task_id,kind,job_id,created_at) VALUES ('source','undone','job',0)").run();
    }
    return output;
  });
  await expect(withUpstreamContext(f.d,f.tasks.get("review")!)).rejects.toThrow(/upstream_source_refused/);
  expect(injected).toBe(true);expect(f.artifacts.listForTask("review")).toHaveLength(0);expect(recordedUpstream(f.d,"review")).toBeNull();
});

it("reuses the first frozen receipt when concurrent preparation finishes during Git proof",async()=>{
  const f=await fixture();f.submit("source");f.submit("review","review",["source"]);f.finish("source");
  const source=await f.workspace("source",f.base,{"app/source.ts":"source\n"});await f.integrate("source",source);
  const original=gitModule.git;let injected=false;
  vi.spyOn(gitModule,"git").mockImplementation(async(cwd,args,options)=>{
    const output=await original(cwd,args,options);
    if(args[0]==="merge-base"&&!injected){
      injected=true;
      const artifactRef=f.artifacts.writeJson({taskId:"review",kind:"upstream_results",label:"concurrent preparation",value:{schemaVersion:1,taskId:"review",dependencies:[]}});
      f.tasks.event("review",UPSTREAM_CONTEXT_EVENT,{artifactRef,dependencies:["source"],baseCommits:[{alias:"core",commit:f.base,rule:"upstream_head",upstreams:["source"]}]});
    }
    return output;
  });
  expect((await withUpstreamContext(f.d,f.tasks.get("review")!)).spec.context.baseCommits).toEqual({core:f.base});
  expect(injected).toBe(true);expect(f.artifacts.listForTask("review")).toHaveLength(1);
  expect(f.tasks.db.prepare("SELECT COUNT(*) FROM events WHERE task_id='review' AND type=?").pluck().get(UPSTREAM_CONTEXT_EVENT)).toBe(1);
});
