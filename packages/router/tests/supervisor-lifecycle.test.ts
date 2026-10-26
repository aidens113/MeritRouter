import * as safeGit from "../src/workspaces/git.js";
import { mkdirSync,writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "../src/workspaces/git.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { MergeQueue } from "../src/workspaces/merge-queue.js";
import { commitAs,revertCommits } from "../src/attribution/index.js";
import { calibrationUndoHook } from "../src/verification/calibration.js";
import * as hydration from "../src/workspaces/repair-hydration.js";
import { syntheticResult } from "../src/storage/tasks.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseConfig, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import type { RunContext } from "../src/runners/types.js";
import type { HarnessEnv, HarnessTool } from "../src/harness/tools.js";
import { supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { assertPlannedBriefs, assertSupervisorTool, supervisorToolPolicy, SUPERVISOR_DISCOVERY_REQUESTS } from "../src/harness/supervisor-lifecycle.js";
import { heldRequests } from "../src/admission/admission.js";
import { PlanStore } from "../src/storage/plans.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { productDigest } from "../src/verification/product-spec.js";
import { jobPlan } from "../src/admin/job-plans.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); env?.cleanup(); sy = undefined; env = undefined; });
const goal = "Deliver a usable isolated fixture";
const specification = { schemaVersion: 1, id: "fixture", revision: 1, source: { ref: "fixture", digest: productDigest(goal) }, originalInstruction: goal, ownerId: "initiator", users: ["operator"], platforms: ["browser"], workflows: ["open fixture"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [], criteria: [{ id: "usable", priority: "required", behavior: "Fixture opens", applicability: { status: "applicable" }, requiredEvidence: ["journey"] }] };
const brief = { label: "inspect", profile: "inspect", goal: "Inspect the fixture", acceptance_criteria: ["Report fixture contents"], repositories: ["core"], difficulty: "T1" };
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

async function fixture(version: 2 | undefined = 2) {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" } } } });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const [task] = await sy.submitTasks([{ profile: "supervise", deliveryVersion: version, goal, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Fixture opens"] } }]);
  const services = { submitTasks: sy.submitTasks.bind(sy), getTask: (id: string) => { const task = sy!.tasks.get(id); return task ? { spec: task.spec, state: task.row.state, result: task.result } : null; } };
  const ctx = { taskId: task!.taskId, spec: sy.tasks.get(task!.taskId)!.spec, tasks: sy.tasks, cfg: sy.cfg, gate: sy.gate, services, now: Date.now, signal: new AbortController().signal, budget: { maxModelRequests: 40 }, artifacts: sy.artifacts } as unknown as RunContext;
  const state: SupervisorState = { ctx, db: sy.db, actor: { agent: "supervisor:fixture", role: "supervisor", task: ctx.taskId, job: ctx.taskId }, repos: new Map([["core", { alias: "core", worktree: env.repo, branch: (await git(env.repo,["symbolic-ref","--short","HEAD"])).trim(), baseSha: "a".repeat(40) }]]), briefChecks: new Set(), children: new Map() };
  const harness = { ctx, role: "supervisor", readers: new Map(), edits: new Set() } as unknown as HarnessEnv;
  const tools = supervisorTools(state);
  const store = new ProductDeliveries(sy.db);
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.def.function.name === name)!;
    assertSupervisorTool(ctx, tool, args);
    return tool.run(args, harness);
  };
  const prepare = () => { store.saveSpec(ctx.taskId, "demo", specification); store.transition(ctx.taskId, "demo", "prepare"); store.transition(ctx.taskId, "demo", "plan"); };
  return { ctx, state, run, prepare, store };
}

async function retainedSource(state:SupervisorState, options:{label?:string;allowed?:string[];changed?:string[];project?:string;parent?:string;active?:boolean}={}) {
  const [out]=await sy!.submitTasks([{profile:"implement",label:options.label ?? "retained-source",parentTaskId:options.parent ?? state.ctx.taskId,goal:"Prior candidate",repositoryAliases:["core"],writableRepository:"core",constraints:{allowedPaths:options.allowed ?? ["app/api/**"],acceptanceCriteria:["candidate"]}}]);
  const result=syntheticResult(out!.taskId,"budget_exhausted","budget_exhausted");result.acceptanceStatus="unmet";
  if(options.changed!==undefined)result.changedPaths=options.changed;
  sy!.db.prepare("UPDATE tasks SET state=?,result_json=? WHERE id=?").run(options.active?"running":"budget_exhausted",JSON.stringify(result),out!.taskId);
  if(options.project)sy!.db.prepare("UPDATE tasks SET project_id=? WHERE id=?").run(options.project,out!.taskId);
  state.children.set(options.label ?? "retained-source",out!.taskId);
  return out!.taskId;
}
const repairBrief=(id:string)=>({label:"api-native-repair",profile:"implement",goal:`Repair the previous task ${id}; read its patch artifact and keep its API implementation`,repositories:["core"],allowed_paths:["app/api/**","INTERFACES.md"],acceptance_criteria:["API repaired"],max_requests:10});

function retainedPatch(taskId:string|null,kind="patch",exactId?:string){
  const ref=sy!.artifacts.write({taskId,kind,label:"retained fixture",content:"artifact body must not be read by reference guard",extension:".patch"});
  if(!exactId)return ref.slice("artifact:".length);
  sy!.db.prepare("UPDATE artifacts SET id=? WHERE id=?").run(exactId,ref.slice("artifact:".length));
  return exactId;
}

async function integratedSource(f:Awaited<ReturnType<typeof fixture>>) {
  const id=await retainedSource(f.state,{changed:["app/api/posts/route.ts"]});
  const base=(await git(env!.repo,["rev-parse","HEAD"])).trim();
  f.state.repos.get("core")!.branch="main";
  const worktrees=new Worktrees(sy!.db,path.join(env!.cfg.storageDir,"worktrees"));
  const ws=await worktrees.prepare({taskId:id,run:1,alias:"core",sourcePath:env!.repo,baseCommit:base});
  mkdirSync(path.join(ws.worktreePath,"app/api/posts"),{recursive:true});writeFileSync(path.join(ws.worktreePath,"app/api/posts/route.ts"),"export const retained=true;\n");
  const head=(await commitAs(ws.worktreePath,{agent:"implementer:source",role:"implementer",model:"fake/model",task:id,job:f.ctx.taskId},"Source implementation"))!;
  const result=syntheticResult(id,"completed","worker_submitted");result.acceptanceStatus="met";result.changedPaths=["app/api/posts/route.ts"];
  sy!.db.prepare("UPDATE tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify(result),id);
  const queue=new MergeQueue(sy!.db,sy!.tasks,"fixture-integrator");
  const item=queue.enqueue({jobId:f.ctx.taskId,taskId:id,kind:"task",repo:"core",branch:"main",integrationWorktree:env!.repo,sourceWorktree:ws.worktreePath,sourceBase:base,sourceHead:head,commits:[head],acceptance:null});
  const integrated=await queue.run(item.id,{committer:{name:"fixture supervisor",email:"fixture@test"},integrated:()=>{}});
  expect(integrated.state).toBe("integrated");
  return {id,base,receipt:item.id,afterHead:integrated.afterHead!};
}

describe("supervisor lifecycle enforcement", () => {
  it("uses the current integrated base for an ordinary follow-up reference without replay",async()=>{
    const f=await fixture();f.prepare();const source=await integratedSource(f);
    const item={...repairBrief(source.id),goal:`Polish UI using the API implemented by task ${source.id}`};
    await expect(f.run("plan_work",{nodes:[item],dispatch:false})).resolves.toContain("draft");
    await expect(f.run("delegate",{tasks:[item]})).resolves.toContain("budget 10 requests");
    const child=sy!.tasks.childrenOf(f.ctx.taskId).find(t=>t.spec.label===item.label)!;
    expect(child.spec.context.repairSource).toBeUndefined();expect(child.spec.context.baseCommits?.core).toBe(source.afterHead);
    expect(await git(env!.repo,["show","HEAD:app/api/posts/route.ts"])).toContain("retained=true");
  });
  it.each(["job","repo","branch","worktree","lock","head","picked","reset","undo"])("does not exempt a %s integration receipt",async(condition)=>{
    const f=await fixture();f.prepare();const source=await integratedSource(f);
    const column={job:"job_id",repo:"repo_alias",branch:"branch",worktree:"integration_worktree",lock:"lock_key",head:"after_head",picked:"state"}[condition];
    if(column)sy!.db.prepare(`UPDATE merge_queue SET ${column}=? WHERE id=?`).run(condition==="picked"?"picked":"wrong",source.receipt);
    if(condition==="reset")await git(env!.repo,["reset","--hard",source.base]);
    if(condition==="undo")await revertCommits(env!.repo,[source.afterHead],{agent:"supervisor:fixture",role:"supervisor"},"Undo retained source",{onUndone:calibrationUndoHook(sy!.db,sy!.tasks,{jobId:f.ctx.taskId,now:Date.now})});
    await expect(f.run("plan_work",{nodes:[repairBrief(source.id)],dispatch:false})).rejects.toThrow(/repair_reference_required/);
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)).toBeNull();
  });
  it("keeps ordinary fresh/disjoint drafts free of Git preflights",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{allowed:["components/**"],changed:["components/Feed.tsx"]});
    const spy=vi.spyOn(safeGit,"git");
    await f.run("plan_work",{nodes:[repairBrief(id)],dispatch:false});
    expect(spy).not.toHaveBeenCalled();
  });
  it("does not exempt when undo evidence arrives during the ancestry preflight",async()=>{
    const f=await fixture();f.prepare();const source=await integratedSource(f);const original=safeGit.git;
    vi.spyOn(safeGit,"git").mockImplementation(async(cwd,args,opts)=>{
      const output=await original(cwd,args,opts);
      if(args[0]==="merge-base")sy!.db.prepare("INSERT INTO verification_signals(task_id,kind,job_id,created_at) VALUES(?,'undone',?,?)").run(source.id,f.ctx.taskId,Date.now());
      return output;
    });
    await expect(f.run("plan_work",{nodes:[repairBrief(source.id)],dispatch:false})).rejects.toThrow(/repair_reference_required/);
  });
  it("does not exempt when the branch resets during the ancestry preflight",async()=>{
    const f=await fixture();f.prepare();const source=await integratedSource(f);const original=safeGit.git;
    vi.spyOn(safeGit,"git").mockImplementation(async(cwd,args,opts)=>{
      const output=await original(cwd,args,opts);
      if(args[0]==="merge-base")await original(env!.repo,["reset","--hard",source.base]);
      return output;
    });
    await expect(f.run("plan_work",{nodes:[repairBrief(source.id)],dispatch:false})).rejects.toThrow(/repair_reference_required/);
  });
  it("acceptance alone does not exempt a retained source",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{changed:["app/api/route.ts"]});
    const result=sy!.tasks.get(id)!.result!;result.acceptanceStatus="met";
    sy!.db.prepare("UPDATE tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify(result),id);
    await expect(f.run("plan_work",{nodes:[repairBrief(id)],dispatch:false})).rejects.toThrow(/repair_reference_required/);
  });

  it.each(["draft","dispatch","delegate"])("requires typed retained source before %s has plan/grant/child effects",async(mode)=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{changed:["app/api/posts/route.ts"]});
    const item=repairBrief(id);
    if(mode==="delegate")await f.run("plan_work",{nodes:[brief],dispatch:false});
    const before={plans:new PlanStore(sy!.db).list(f.ctx.taskId).length,children:sy!.tasks.childrenOf(f.ctx.taskId).length,held:heldRequests(sy!.db,f.ctx.taskId),requests:sy!.admission.taskTotals(f.ctx.taskId).requests};
    await expect(f.run(mode==="delegate"?"delegate":"plan_work",mode==="delegate"?{tasks:[item]}:{nodes:[item],dispatch:mode!=="draft"})).rejects.toThrow(new RegExp(`repair_reference_required:.*repair_from_task.*${id}`));
    expect(new PlanStore(sy!.db).list(f.ctx.taskId)).toHaveLength(before.plans);
    expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(before.children);
    expect(heldRequests(sy!.db,f.ctx.taskId)).toBe(before.held);
    expect(sy!.admission.taskTotals(f.ctx.taskId).requests).toBe(before.requests);
  });
  it.each(["draft","dispatch","delegate"])("requires typed source for exact owned patch references before %s effects",async(mode)=>{
    const f=await fixture();f.prepare();
    const api=await retainedSource(f.state,{label:"retained-api",changed:["app/api/posts/route.ts"]});
    const ui=await retainedSource(f.state,{label:"retained-ui",allowed:["components/**"],changed:["components/Feed.tsx"]});
    const apiPatch=retainedPatch(api,"patch","a_0mvofjo055767581894fc"),uiPatch=retainedPatch(ui,"patch","a_0mvof94fpd683b60c48cf");
    if(mode==="delegate")await f.run("plan_work",{nodes:[brief],dispatch:false});
    const resolver=vi.spyOn(hydration,"resolveRepairSource"),read=vi.spyOn(sy!.artifacts,"read"),scoped=vi.spyOn(sy!.artifacts,"readScoped");
    const before={plans:new PlanStore(sy!.db).list(f.ctx.taskId).length,children:sy!.tasks.childrenOf(f.ctx.taskId).length,held:heldRequests(sy!.db,f.ctx.taskId),requests:sy!.admission.taskTotals(f.ctx.taskId).requests,grants:sy!.db.prepare("SELECT COUNT(*) FROM task_request_grants").pluck().get()};
    for(const [id,patch,allowed]of [[api,apiPatch,["app/api/**"]],[ui,uiPatch,["components/**"]]] as const)for(const prefix of ["","artifact:"]){
      const item={...repairBrief(id),goal:`Create implementation; read patch ${prefix}${patch}`,allowed_paths:[...allowed]};
      await expect(f.run(mode==="delegate"?"delegate":"plan_work",mode==="delegate"?{tasks:[item]}:{nodes:[item],dispatch:mode!=="draft"})).rejects.toThrow(new RegExp(`repair_reference_required:.*repair_from_task.*${id}`));
      expect(new PlanStore(sy!.db).list(f.ctx.taskId)).toHaveLength(before.plans);
      expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(before.children);
      expect(heldRequests(sy!.db,f.ctx.taskId)).toBe(before.held);
      expect(sy!.admission.taskTotals(f.ctx.taskId).requests).toBe(before.requests);
      expect(sy!.db.prepare("SELECT COUNT(*) FROM task_request_grants").pluck().get()).toBe(before.grants);
    }
    expect(resolver).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(scoped).not.toHaveBeenCalled();
    expect(sy!.db.prepare("SELECT COUNT(*) FROM worker_action_requests").pluck().get()).toBe(0);
  });
  it("requires matching typed ownership for a patch reference and leaves hydration to the native resolver",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{label:"patch-source",changed:["app/api/posts.ts"]});
    const patch=retainedPatch(id),item={...repairBrief(id),goal:`Repair using artifact:${patch}`};
    await expect(f.run("plan_work",{nodes:[{...item,repair_from_task:"wrong"}],dispatch:false})).rejects.toThrow(/repair_reference_mismatch/);
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)).toBeNull();
    const source={taskId:id,project:"demo",alias:"core",base:"a".repeat(40),head:"b".repeat(40),tree:"c".repeat(40),commits:["b".repeat(40)]};
    const resolver=vi.spyOn(hydration,"resolveRepairSource").mockResolvedValue(source),read=vi.spyOn(sy!.artifacts,"read"),scoped=vi.spyOn(sy!.artifacts,"readScoped");
    await f.run("plan_work",{nodes:[{...item,repair_from_task:"patch-source"}],dispatch:false});
    await expect(f.run("delegate",{tasks:[{...item,repair_from_task:"patch-source"}]})).resolves.toContain("budget 10 requests");
    expect(resolver).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled();expect(scoped).not.toHaveBeenCalled();
    expect(sy!.tasks.childrenOf(f.ctx.taskId).find(t=>t.spec.label===item.label)!.spec.context.repairSource).toEqual(source);
  });
  it("does not infer source authority from other kinds, unknown, foreign, unowned, active, shared or disjoint patch metadata",async()=>{
    const f=await fixture();f.prepare();const own=await retainedSource(f.state,{label:"own",changed:["app/api/posts.ts"]});
    const foreign=await retainedSource(f.state,{label:"foreign-patch",project:"foreign",changed:["app/api/posts.ts"]});
    const unowned=await retainedSource(f.state,{label:"unowned-patch",parent:"outside-parent",changed:["app/api/posts.ts"]});
    const active=await retainedSource(f.state,{label:"active-patch",active:true,changed:["app/api/posts.ts"]});
    const disjoint=await retainedSource(f.state,{label:"disjoint-patch",allowed:["components/**"],changed:["components/Feed.tsx"]});
    const refs=[retainedPatch(own,"check_log"),retainedPatch(own,"screenshot"),retainedPatch(foreign),retainedPatch(unowned),retainedPatch(active),retainedPatch(disjoint),retainedPatch(null),"a_unknown","a_badmetadata","a_wrongmetadataid",`${retainedPatch(own)}suffix`];
    const original=sy!.artifacts.get.bind(sy!.artifacts);
    vi.spyOn(sy!.artifacts,"get").mockImplementation(ref=>ref==="a_badmetadata"?{id:ref,kind:"patch",task_id:42} as never:ref==="a_wrongmetadataid"?{id:"a_other",kind:"patch",task_id:own} as never:original(ref));
    const read=vi.spyOn(sy!.artifacts,"read"),scoped=vi.spyOn(sy!.artifacts,"readScoped"),gitSpy=vi.spyOn(safeGit,"git"),resolver=vi.spyOn(hydration,"resolveRepairSource");
    const before=sy!.tasks.childrenOf(f.ctx.taskId).length;
    for(const [index,ref]of refs.entries())await expect(f.run("plan_work",{nodes:[{...repairBrief(own),label:`ordinary-patch-${index}`,goal:`Create API using artifact:${ref}`}],dispatch:false})).resolves.toContain("draft");
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)!.nodes.every(node=>node.repairFromTask===null)).toBe(true);
    expect(sy!.tasks.childrenOf(f.ctx.taskId)).toHaveLength(before);
    expect(gitSpy).not.toHaveBeenCalled();expect(resolver).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(scoped).not.toHaveBeenCalled();
  });
  it.each([false,true])("keeps the exact integration/undo exemption for an owned patch reference (undone=%s)",async(undone)=>{
    const f=await fixture();f.prepare();const source=await integratedSource(f),patch=retainedPatch(source.id);
    if(undone)await revertCommits(env!.repo,[source.afterHead],{agent:"supervisor:fixture",role:"supervisor"},"Undo source",{onUndone:calibrationUndoHook(sy!.db,sy!.tasks,{jobId:f.ctx.taskId,now:Date.now})});
    const item={...repairBrief(source.id),goal:`Follow up on artifact:${patch}`};
    if(undone){await expect(f.run("plan_work",{nodes:[item],dispatch:false})).rejects.toThrow(/repair_reference_required/);expect(new PlanStore(sy!.db).latest(f.ctx.taskId)).toBeNull();}
    else await expect(f.run("plan_work",{nodes:[item],dispatch:false})).resolves.toContain("draft");
  });
  it("supports actual-path compatibility and conservative original-scope fallback",async()=>{
    const f=await fixture();f.prepare();
    const actual=await retainedSource(f.state,{label:"wide",allowed:["app/**"],changed:["app/api/posts/route.ts"]});
    const original=await retainedSource(f.state,{label:"original",allowed:["app/api/posts/**"]});
    for(const id of [actual,original])await expect(f.run("plan_work",{nodes:[repairBrief(id)],dispatch:false})).rejects.toThrow(/repair_reference_required/);
    await expect(f.run("plan_work",{nodes:[{...repairBrief(actual),goal:`Boundary is ${actual}suffix` }],dispatch:false})).resolves.toContain("draft");
  });
  it("keeps disjoint contract references and fresh or unowned IDs as ordinary drafts",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{allowed:["components/**"],changed:["components/Feed.tsx"]});
    const foreign=await retainedSource(f.state,{label:"foreign",project:"foreign",changed:["app/api/posts/route.ts"]});
    const unowned=await retainedSource(f.state,{label:"unowned",parent:"outside-parent",changed:["app/api/posts/route.ts"]});
    for(const [index,goal]of [`Use contract from UI task ${id}`,`Inspect history ${foreign} ${unowned}`,"Implement a fresh API",`Do not match ${id}suffix`].entries()){
      await expect(f.run("plan_work",{nodes:[{...repairBrief(id),label:`fresh-${index}`,goal}],dispatch:false})).resolves.toContain("draft");
    }
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)!.nodes.every(n=>n.repairFromTask===null)).toBe(true);
  });
  it("requires the complete retained path set to fit the new target",async()=>{
    const f=await fixture();f.prepare();
    const id=await retainedSource(f.state,{allowed:["app/**","components/**"],changed:["app/api/posts.ts","components/Feed.tsx"]});
    await expect(f.run("plan_work",{nodes:[repairBrief(id)],dispatch:false})).resolves.toContain("draft");
  });
  it("refuses ambiguous omission and mismatching typed source but permits an explicit choice",async()=>{
    const f=await fixture();f.prepare();const a=await retainedSource(f.state,{label:"first",changed:["app/api/a.ts"]}),b=await retainedSource(f.state,{label:"second",changed:["app/api/b.ts"]});
    const item={...repairBrief(a),goal:`Repair ${a}; compare previous attempt ${b}`};
    await expect(f.run("plan_work",{nodes:[item],dispatch:false})).rejects.toThrow(/repair_reference_ambiguous/);
    await expect(f.run("plan_work",{nodes:[{...item,repair_from_task:"foreign-id"}],dispatch:false})).rejects.toThrow(/repair_reference_mismatch/);
    await expect(f.run("plan_work",{nodes:[{...item,repair_from_task:"first"}],dispatch:false})).resolves.toContain("draft");
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)!.nodes[0]!.repairFromTask).toBe("first");
  });
  it("cannot erase a drafted explicit source on an omitted-field partial update",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{changed:["app/api/route.ts"]});const item=repairBrief(id);
    await f.run("plan_work",{nodes:[{...item,repair_from_task:id}],dispatch:false});
    const version=new PlanStore(sy!.db).latest(f.ctx.taskId)!.version;
    await expect(f.run("plan_work",{nodes:[item],dispatch:false})).rejects.toThrow(/repair_reference_required/);
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)!.version).toBe(version);
    await expect(f.run("plan_work",{nodes:[{...item,goal:"Implement revised API without old prose references"}],dispatch:false})).rejects.toThrow(/partial plan update cannot silently remove/);
    expect(new PlanStore(sy!.db).latest(f.ctx.taskId)!.version).toBe(version);
  });
  it("leaves source authority to the native resolver for explicit dispatch",async()=>{
    const f=await fixture();f.prepare();const id=await retainedSource(f.state,{changed:["app/api/route.ts"]});const item={...repairBrief(id),repair_from_task:id};
    const source={taskId:id,project:"demo",alias:"core",base:"a".repeat(40),head:"b".repeat(40),tree:"c".repeat(40),commits:["b".repeat(40)]};
    const resolver=vi.spyOn(hydration,"resolveRepairSource").mockResolvedValue(source);
    await f.run("plan_work",{nodes:[item],dispatch:false});
    await expect(f.run("delegate",{tasks:[item]})).resolves.toContain("budget 10 requests");
    await expect(f.run("delegate",{tasks:[repairBrief(id)]})).resolves.toContain("already submitted");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sy!.tasks.childrenOf(f.ctx.taskId).find(t=>t.spec.label===item.label)!.spec.context.repairSource).toEqual(source);
  });

  it("publishes draft nodes through the actual plan view without staffing, workers, or approvals", async () => {
    const { ctx, run, prepare, store } = await fixture();
    prepare();
    expect(() => store.transition(ctx.taskId, "demo", "implement")).toThrow(/plan_work/);
    const before = sy!.gate.admission.taskTotals(ctx.taskId).requests;
    await expect(run("plan_work", { nodes: [brief], dispatch: false })).resolves.toContain("0 dispatched now (draft");
    expect(sy!.gate.admission.taskTotals(ctx.taskId).requests).toBe(before);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
    expect(jobPlan(sy!, ctx.taskId)?.nodes).toEqual([expect.objectContaining({ label: "inspect", taskId: null, state: "not_dispatched" })]);
    expect(() => store.transition(ctx.taskId, "demo", "implement")).not.toThrow();
    await expect(run("plan_work", { nodes: [brief] })).resolves.toContain("1 dispatched now");
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
  });

  it("retains future phases while dispatching only the supplied phase and its grant", async () => {
    const { ctx, run, prepare } = await fixture();
    prepare();
    const later = { ...brief, label: "later", depends_on: [brief.label], max_requests: 1000 };
    await run("plan_work", { nodes: [brief, later], dispatch: false });
    const phase = { ...brief, max_requests: 10 };
    const before = sy!.admission.taskTotals(ctx.taskId).requests;
    await expect(run("plan_work", { nodes: [phase] })).resolves.toContain("2 node(s); 1 dispatched now");
    expect(jobPlan(sy!, ctx.taskId)?.nodes).toEqual([
      expect.objectContaining({ label: brief.label, taskId: expect.any(String) }),
      expect.objectContaining({ label: "later", taskId: null, state: "not_dispatched", dependsOn: [brief.label] }),
    ]);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
    expect(sy!.admission.taskTotals(ctx.taskId).requests).toBe(before);
    expect(sy!.tasks.childrenOf(ctx.taskId)[0]!.spec.budget?.maxModelRequests).toBe(10);
    expect(heldRequests(sy!.db, ctx.taskId)).toBe(10);
    // Explicit replacement removes only omitted future nodes, retaining dispatched history.
    await run("plan_work", { nodes: [{ ...brief, label: "replacement" }], dispatch: false, replace_undispatched: true });
    expect(new PlanStore(sy!.db).latest(ctx.taskId)?.nodes.map(n => n.label)).toEqual(["replacement", brief.label]);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
  });

  it("validates merged future dependencies and explicit replacement before persistence", async () => {
    const { ctx, run, prepare } = await fixture();
    prepare();
    const later = { ...brief, label: "later", depends_on: [brief.label] };
    await run("plan_work", { nodes: [brief, later], dispatch: false });
    await expect(run("plan_work", { nodes: [{ ...brief, depends_on: ["later"] }], dispatch: false })).rejects.toThrow(/cycle/);
    await expect(run("plan_work", { nodes: [later], dispatch: false, replace_undispatched: true })).rejects.toThrow(/neither a node/);
    await expect(run("plan_work", { nodes: [brief], dispatch: false, replace_undispatched: "true" })).rejects.toThrow();
    expect(new PlanStore(sy!.db).list(ctx.taskId)).toHaveLength(1);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
  });

  it("enforces the node cap on the merged graph without losing the prior plan", async () => {
    const { ctx, run, prepare } = await fixture();
    prepare();
    await run("plan_work", { nodes: Array.from({ length: 50 }, (_, i) => ({ ...brief, label: `phase-${i}` })), dispatch: false });
    await expect(run("plan_work", { nodes: [brief], dispatch: false })).rejects.toThrow();
    expect(new PlanStore(sy!.db).latest(ctx.taskId)?.nodes).toHaveLength(50);
    expect(new PlanStore(sy!.db).list(ctx.taskId)).toHaveLength(1);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
  });

  it("keeps legacy replacement semantics for omitted undispatched nodes", async () => {
    const { ctx, run } = await fixture();
    delete ctx.spec.deliveryVersion;
    sy!.db.prepare("UPDATE tasks SET spec_json=json_remove(spec_json,'$.deliveryVersion') WHERE id=?").run(ctx.taskId);
    await run("plan_work", { nodes: [brief, { ...brief, label: "later" }], dispatch: false });
    await expect(run("plan_work", { nodes: [brief], dispatch: false, replace_undispatched: "true" })).rejects.toThrow();
    await run("plan_work", { nodes: [brief], dispatch: false });
    expect(new PlanStore(sy!.db).latest(ctx.taskId)?.nodes.map(n => n.label)).toEqual([brief.label]);
  });

  it("validates draft scopes and graphs before persistence or dispatch", async () => {
    const { ctx, run } = await fixture();
    for (const nodes of [[{ ...brief, repositories: ["foreign"] }], [{ ...brief, max_requests: -1 }], [{ ...brief, profile: "implement", allowed_paths: [] }], [{ ...brief, depends_on: ["missing"] }], [brief, brief]]) {
      await expect(run("plan_work", { nodes, dispatch: false })).rejects.toThrow();
      expect(new PlanStore(sy!.db).latest(ctx.taskId)).toBeNull();
      expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    }
  });

  it("rejects direct and nested host commands and inspect-with-check before a real plan", async () => {
    const { ctx } = await fixture();
    const tool = (name: string, sideEffect: HarnessTool["sideEffect"] = "read") => ({ def: { type: "function", function: { name, parameters: {} } }, sideEffect } as HarnessTool);
    expect(() => assertSupervisorTool(ctx, tool("run_check", "command"), { command: "node --version" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("batch", "command"), { items: [{ operation: "run_recipe", args: { id: "check:1" } }] })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("delegate", "delegate"), { tasks: [{ ...brief, checks: ["node --version"] }] })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("delegate", "delegate"), { tasks: [brief] })).not.toThrow();
    expect(() => assertSupervisorTool(ctx, tool("batch", "command"), { items: [{ operation: "list_paths", args: {} }] })).not.toThrow();
    for (const name of ["lab_check", "lab_restart", "lab_promote"]) expect(() => assertSupervisorTool(ctx, tool(name, "external"), {})).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("integrate_task", "edit"), { task_id: "old-child" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("lab_http", "external"), { method: "POST" })).toThrow(/plan/);
    expect(() => assertSupervisorTool(ctx, tool("lab_http", "external"), { method: "GET" })).not.toThrow();
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
  });

  it("preserves encoded arrays while rejecting malformed strings and encoded command bypasses before effects", async () => {
    const { ctx, run, prepare } = await fixture();
    await expect(run("delegate", { tasks: JSON.stringify([{ ...brief, checks: ["node --version"] }]) })).rejects.toThrow(/delivery_plan_required/);
    const invalid = ["[", '[{}] trailing note', '{"label":"not-an-array"}', '[null]', '[1]'];
    for (const value of invalid) {
      await expect(run("plan_work", { nodes: value, dispatch: false })).rejects.toThrow(/nodes must be (a JSON array|an array) of objects/);
      await expect(run("delegate", { tasks: value })).rejects.toThrow(/tasks must be (a JSON array|an array) of objects/);
      expect(new PlanStore(sy!.db).latest(ctx.taskId)).toBeNull();
      expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    }
    prepare();
    await expect(run("plan_work", { nodes: JSON.stringify([brief]), dispatch: false })).resolves.toContain("0 dispatched now (draft");
    await expect(run("delegate", { tasks: JSON.stringify([brief]) })).resolves.toContain("inspect ->");
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(1);
    expect(sy!.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
  });

  it("matches actual execution and review briefs to recorded plan nodes", async () => {
    const { ctx, run } = await fixture();
    const implementation = { ...brief, label: "implement", profile: "implement", allowed_paths: ["src/**"] };
    await run("plan_work", { dispatch: false, nodes: [implementation, brief] });
    expect(() => assertPlannedBriefs(ctx, [implementation, brief], "core")).not.toThrow();
    for (const patch of [{ goal: "Another task" }, { allowed_paths: ["**"] }, { checks: ["npm install"] }, { lab_checks: ["runtime"] }, { depends_on: ["inspect"] }, { acceptance_criteria: ["Weaker"] }, { writable_repository: "foreign" }]) {
      expect(() => assertPlannedBriefs(ctx, [{ ...implementation, ...patch }], "core")).toThrow(/plan_conflict/);
    }
    expect(() => assertPlannedBriefs(ctx, [{ ...brief, label: "unplanned-review" }], "core")).toThrow(/plan_required/);
  });

  it("binds repair source to its persisted draft before dispatch", async () => {
    const { ctx,run,prepare } = await fixture(); prepare();
    const repair={...brief,repair_from_task:"original-source"};
    await run("plan_work",{nodes:[repair],dispatch:false});
    expect(()=>assertPlannedBriefs(ctx,[{...repair,repair_from_task:"foreign-source"}],"core")).toThrow(/repairFromTask/);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
  });

  it("bounds discovery using task-wide requests across reopened runner instances", async () => {
    const { ctx, prepare, run } = await fixture();
    vi.spyOn(ctx.gate.admission, "taskTotals").mockReturnValue({ requests: SUPERVISOR_DISCOVERY_REQUESTS } as ReturnType<typeof ctx.gate.admission.taskTotals>);
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).not.toContain("read_files");
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).not.toContain("delegate");
    expect(supervisorToolPolicy({ ...ctx })?.allowedToolNames).toContain("set_delivery_spec");
    prepare();
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).toContain("plan_work");
    await run("plan_work", { nodes: [brief], dispatch: false });
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).not.toContain("read_files");
    expect(supervisorToolPolicy(ctx)?.allowedToolNames).toContain("delegate");
    await expect(run("delegate", { tasks: [{ ...brief, goal: "An unplanned replacement" }] })).rejects.toThrow(/delivery_plan_conflict/);
    expect(sy!.tasks.childrenOf(ctx.taskId)).toHaveLength(0);
    await run("plan_work", { nodes: [brief] });
    expect(supervisorToolPolicy(ctx)).toBeNull();
  });

  it("preserves non-v2 legacy direct dispatch and tool behavior", async () => {
    const { ctx, run, prepare, store } = await fixture(undefined);
    // Explicitly remove the version; fixture's default parameter otherwise selects v2.
    delete ctx.spec.deliveryVersion;
    sy!.db.prepare("UPDATE tasks SET spec_json=json_remove(spec_json,'$.deliveryVersion') WHERE id=?").run(ctx.taskId);
    expect(supervisorToolPolicy(ctx)).toBeNull();
    expect(() => assertPlannedBriefs(ctx, [{ ...brief, profile: "implement" }], "core")).not.toThrow();
    prepare();
    expect(() => store.transition(ctx.taskId, "demo", "implement")).not.toThrow();
    await expect(run("plan_work", { nodes: [brief] })).resolves.toContain("1 dispatched now");
  });
});

it("dispatches the first exact planned phase after the discovery cap without launching remaining draft nodes", async () => {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, client_supervision: {}, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" } } } });
  const later = { ...brief, label: "later-review", goal: "Review after the first phase", depends_on: [brief.label] };
  const script = [
    [call("set_delivery_spec", { spec: specification })],
    [call("advance_delivery_stage", { stage: "prepare" })],
    [call("advance_delivery_stage", { stage: "plan" })],
    [call("plan_work", { nodes: [brief, later], dispatch: false })],
    [call("delivery_status", {}, "status-1")],
    [call("delivery_status", {}, "status-2")],
    [call("delegate", { tasks: [brief] })],
    [call("await_tasks", { timeout_seconds: 30 })],
    [call("finish_job", { status: "blocked", summary: "First phase finished; remaining product work unverified", verified: [{ claim: "First planned worker completed", evidence: "await_tasks result" }], not_verified: ["Remaining plan and product"], follow_up: "Execute remaining plan" })],
  ];
  let turn = 0;
  const client = new ScriptedClient(req => {
    if (String(req.messages[0]?.content).startsWith("# Supervisor charter")) {
      if (turn === SUPERVISOR_DISCOVERY_REQUESTS) expect(req.tools?.map(tool => tool.function.name)).toContain("delegate");
      return reply(null, { ...servedFor(sy!, req), toolCalls: script[turn++]! });
    }
    const workerTurn = req.messages.filter(message => message.role === "assistant").length;
    return reply(null, { ...servedFor(sy!, req), toolCalls: workerTurn === 0 ? [call("read_file", { path: "README.md" })] : [call("submit_result", { summary: "Fixture inspected", findings: [], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:README.md#L1"] }] })] });
  });
  sy = open(env, client, { worker: true });
  const submitted = await sy.startJob({ goal, repositories: ["core"] });
  const outcome = (await sy.awaitResults([submitted.taskId], { timeoutSeconds: 60 })).completed[0];
  expect(outcome, JSON.stringify(client.requests.at(-1)?.messages.filter(message => message.role === "tool"))).toMatchObject({ stopReason: "supervisor_blocked" });
  expect(turn).toBe(9);
  const view = jobPlan(sy, submitted.taskId)!;
  expect(view.nodes).toEqual([
    expect.objectContaining({ label: brief.label, state: "completed", taskId: expect.any(String) }),
    expect.objectContaining({ label: later.label, state: "not_dispatched", taskId: null }),
  ]);
  expect(sy.tasks.childrenOf(submitted.taskId)).toHaveLength(1);
  expect(sy.admission.taskTotals(submitted.taskId).requests).toBeGreaterThan(SUPERVISOR_DISCOVERY_REQUESTS);
}, 70_000);

it.each([[false, false], [false, true], [true, false]])("runs the real supervisor with no pre-plan host effects (blocked %s, encoded arrays %s)", async (immediateBlocked, encoded) => {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, client_supervision: {}, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 40, classify: "never", min_tier: "T3" } } } });
  let turn = 0;
  const script = [
    [call("run_check", { command: "node --version" }), call("batch", { items: [{ id: "files", operation: "list_paths", args: {} }] }, "read-batch"), call("batch", { items: [{ id: "host", operation: "run_recipe", args: { id: "check:1" } }] }, "host-batch"), call("delegate", { tasks: [{ ...brief, checks: ["node --version"] }] })],
    [call("set_delivery_spec", { spec: specification }), call("advance_delivery_stage", { stage: "prepare" }, "prepare"), call("advance_delivery_stage", { stage: "plan" }, "plan")],
    [call("plan_work", { nodes: encoded ? JSON.stringify([brief]) : [brief], dispatch: false })],
    encoded ? [call("delegate", { tasks: JSON.stringify([brief]) })] : [call("plan_work", { nodes: [brief] })],
    [call("await_tasks", { timeout_seconds: 30 })],
    [call("finish_job", { status: "blocked", summary: "Planning/dispatch fixture complete; product not implemented", verified: [{ claim: "Planned inspection ran", evidence: "await_tasks observed child result" }], not_verified: ["Usable product"], follow_up: "Implement product" })],
  ];
  if (immediateBlocked) script.splice(1, script.length - 1, [call("finish_job", { status: "blocked", summary: "Explicit prerequisite blocker", verified: [], not_verified: ["Product"], follow_up: "Resolve prerequisite" })]);
  const client = new ScriptedClient(req => {
    if (String(req.messages[0]?.content).startsWith("# Supervisor charter")) return reply(null, { ...servedFor(sy!, req), toolCalls: script[turn++]! });
    const workerTurn = req.messages.filter(message => message.role === "assistant").length;
    return reply(null, { ...servedFor(sy!, req), toolCalls: workerTurn === 0 ? [call("read_file", { path: "README.md" })] : [call("submit_result", { summary: "Fixture inspected", findings: [], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:README.md#L1"] }] })] });
  });
  sy = open(env, client, { worker: true });
  const job = await sy.startJob({ goal, repositories: ["core"], checks: ["node --version"] });
  const result = (await sy.awaitResults([job.taskId], { timeoutSeconds: 70 })).completed[0];
  expect(result, JSON.stringify(client.requests.at(-1)?.messages)).toMatchObject({ stopReason: "supervisor_blocked" });
  expect(turn).toBe(immediateBlocked ? 2 : 6);
  expect(new PlanStore(sy.db).list(job.taskId)).toHaveLength(immediateBlocked ? 0 : encoded ? 1 : 2);
  expect(sy.tasks.childrenOf(job.taskId)).toHaveLength(immediateBlocked ? 0 : 1);
  if (!immediateBlocked) expect(sy.tasks.childrenOf(job.taskId)[0]!.row.state).toBe("completed");
  const toolMessages = client.requests.filter(req => String(req.messages[0]?.content).startsWith("# Supervisor charter")).at(-1)!.messages.filter(message => message.role === "tool");
  expect(toolMessages.find(message => message.tool_call_id === "read-batch")?.content).toContain('"status":"succeeded"');
  expect(toolMessages.find(message => message.tool_call_id === "host-batch")?.content).toContain("delivery_plan_required");
  expect(sy.db.prepare("SELECT COUNT(*) AS n FROM worker_action_requests").get()).toEqual({ n: 0 });
}, 90_000);
