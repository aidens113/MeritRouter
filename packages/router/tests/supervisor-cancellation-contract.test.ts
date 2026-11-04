import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { MeritRouter } from "../src/core/service.js";
import type { ChatRequest } from "../src/gateway/types.js";
import { openDatabase, immediate, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { SqliteTaskLeases } from "../src/storage/sqlite-task-leases.js";
import { capturedLease, leaseOperationId } from "../src/storage/task-leases.js";
import { assertSupervisorCancelUnprotected } from "../src/storage/supervisor-cancel-protection.js";
import * as supervisorToolModule from "../src/harness/supervisor-tools.js";
import { baseConfig, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
let env: Env | undefined, sy: MeritRouter | undefined, db: Db | undefined;
afterEach(async () => { vi.restoreAllMocks(); await sy?.close(); sy=undefined; db?.close(); db=undefined; env?.cleanup(); env=undefined; });
const call = (name: string, args: unknown, id = name) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const turns = (req: ChatRequest) => req.messages.filter(m => m.role === "assistant").length;
const isSupervisor = (req: ChatRequest) => String(req.messages[0]!.content).startsWith("# Supervisor charter");
const toolOutputs = (req: ChatRequest) => req.messages.filter(m => m.role === "tool").map(m => String(m.content));
function teamConfig() {
  const cfg = baseConfig({ coding: { runner: "native" }, team: { provider_concurrency_enabled: false } });
  Object.assign(cfg.profiles, { supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" } });
  return cfg;
}

describe("legacy captured cancellation contract",()=>{
  it("awaits the real legacy Executor cancellation port before acknowledging a queued child", async () => {
    env = makeEnv({ config: teamConfig() });
    let replacement = "";
    // Exercise the finish boundary with the same child-creation side effect as merge conflict
    // re-delegation; Git conflict mechanics are independent of this ordering regression.
    vi.spyOn(supervisorToolModule, "drainIntegrations").mockImplementation(async (state) => {
      if (replacement) return [];
      const [child] = await state.ctx.services!.submitTasks([{
        profile: "summarize", label: "conflict-redo", goal: "Redo conflicted integration",
        parentTaskId: state.ctx.taskId, repositoryAliases: [], dependsOn: [state.ctx.taskId],
        context: {}, constraints: { acceptanceCriteria: ["replacement integrated"] },
      }]);
      replacement = child!.taskId;
      state.children.set("conflict-redo", replacement);
      return ["conflict: re-delegated as conflict-redo"];
    });
    const client = new ScriptedClient((req) => {
      const served = servedFor(sy!, req);
      const step = turns(req);
      const calls = step === 0
        ? [call("finish_job", { status: "completed", summary: "candidate", verified: [{ claim: "done", evidence: "integration" }], not_verified: [] })]
        : step === 1 ? [call("cancel_tasks", { task_ids: ["conflict-redo"] })]
        : step === 2 ? [call("await_tasks", { timeout_seconds: 10 })]
        : [call("finish_job", { status: "blocked", summary: "replacement needs repair", verified: [], not_verified: ["conflicted work"] })];
      return reply(null, { ...served, toolCalls: calls });
    });
    sy = open(env, client, { worker: true });
    const job = await sy.startJob({ goal: "Check finish integration ordering", repositories: ["core"] });
    const done = await sy.awaitResults([job.taskId], { timeoutSeconds: 90 });
    expect(done.timedOut).toBe(false);
    expect(done.completed[0]!.stopReason).toBe("supervisor_blocked");
    const history = client.requests.filter(isSupervisor).at(-1)!;
    const outputs = toolOutputs(history);
    expect(outputs).toContain("cancellation requested");
    expect(outputs.join("\n")).not.toContain("Transaction function cannot return a promise");
    expect(sy.tasks.get(replacement)!.row.state).toBe("cancelled");
    const calls = history.messages.flatMap(m => m.role === "assistant" ? m.tool_calls ?? [] : []).filter(c => c.function.name === "cancel_tasks");
    expect(calls).toHaveLength(1);
    const receipts = sy.db.prepare("SELECT response_json FROM task_lease_operations WHERE kind='cancel'").all() as Array<{ response_json: string }>;
    const actual = receipts.map(row => JSON.parse(row.response_json)).filter(receipt => receipt.affected.some((item: { target: { taskId: string } }) => item.target.taskId === replacement));
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({ disposition: "applied", affected: [{ target: { taskId: replacement }, state: "cancelled" }] });
  }, 120_000);

});

function portFixture(policy: "supervisor" | "human_only" = "supervisor") {
  const config=teamConfig(); Object.assign(config,{security:{outside_repository:policy}});
  env=makeEnv({config}); db=openDatabase(env.cfg.storageDir);
  const now=Date.now(), tasks=new TaskStore(db,()=>now), port=new SqliteTaskLeases(env.cfg,tasks,()=>now);
  for(const [id,parent,profile] of [["actor",undefined,"supervise"],["a","actor","summarize"],["b","actor","summarize"],["nested","b","summarize"]] as const)
    tasks.submit([WorkerTaskSchema.parse({id,parentTaskId:parent,profile,goal:"Fixture",repositoryAliases:[],constraints:{acceptanceCriteria:["fixture"]}})],{project:"demo"});
  tasks.claim("owner",{maxConcurrent:10,maxWritersPerRepo:1,leaseMs:60_000,defaultTimeoutMs:60_000,supervisorProfiles:["supervise"],maxSupervisors:2});
  const actor=capturedLease(tasks.get("actor")!);
  const target=(id:string)=>{const row=tasks.get(id)!.row;return {taskId:id,incarnation:row.lease_incarnation,runCount:row.run_count};};
  const action=(id="b",patch:Record<string,unknown>={})=>{
    const lease=capturedLease(tasks.get(id)!);
    const value={status:"pending",decidedBy:null,action:{lease},...patch};
    db!.prepare("INSERT INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run("action","demo",id,"fixture-action",JSON.stringify(value),now);
  };
  const cancel=(ids=["a","b"],operationId=leaseOperationId(now))=>port.cancel({operationId,project:"demo",actor:"supervisor",actorLease:actor,targets:ids.map(target)});
  const policyNow=(outside_repository:"human_only"|"supervisor")=>{const cfg=YAML.parse(readFileSync(env!.cfg.configPath,"utf8"));cfg.security.outside_repository=outside_repository;writeFileSync(env!.cfg.configPath,YAML.stringify(cfg));};
  return {now,tasks,port,actor,target,action,cancel,policyNow};
}

describe("captured legacy service mutation race",()=>{
  it("protects the whole batch when approval appears after tool preflight on the actual async bridge",async()=>{
    env=makeEnv({config:teamConfig()});
    let attempts=0,observed=false;
    const original=SqliteTaskLeases.prototype.cancel;
    vi.spyOn(SqliteTaskLeases.prototype,"cancel").mockImplementation(async function(this: SqliteTaskLeases,input){
      if(input.actor==="supervisor") {
        attempts++;
        // This hook runs after cancel_tasks preflight and TaskRunLeases target capture.
        const child=sy!.tasks.get("race-protected")!;
        const value={status:"running",decidedBy:"operator",action:{lease:capturedLease(child)}};
        sy!.db.prepare("INSERT OR IGNORE INTO worker_action_requests(id,project_id,task_id,request_key,value_json,created_at) VALUES(?,?,?,?,?,?)").run("race-action","demo",child.row.id,"race-action",JSON.stringify(value),Date.now());
        try { return await original.call(this,input); }
        catch(error) {
          expect(String(error)).toContain("operator-approved and running");
          expect(sy!.tasks.get("race-sibling")!.row.cancel_requested).toBe(0);
          expect(sy!.tasks.get("race-protected")!.row.cancel_requested).toBe(0);
          expect(sy!.db.prepare("SELECT id FROM task_lease_operations WHERE id=?").get(input.operationId)).toBeUndefined();
          observed=true;
          throw error;
        }
      }
      return original.call(this,input);
    });
    vi.spyOn(supervisorToolModule,"drainIntegrations").mockImplementation(async state=>{
      if(state.children.has("race-protected"))return [];
      const results=await state.ctx.services!.submitTasks(["race-sibling","race-protected"].map(id=>({id,label:id,parentTaskId:state.ctx.taskId,profile:"summarize",goal:"Fixture",repositoryAliases:[],dependsOn:[state.ctx.taskId],constraints:{acceptanceCriteria:["fixture"]}})));
      for(const result of results){
        // Deterministic leased fixture tasks; no command or independent worker is started.
        sy!.db.prepare("UPDATE tasks SET state='running',lease_owner='race-owner',run_count=1,lease_expires_at=?,deadline_at=? WHERE id=?").run(Date.now()+60_000,Date.now()+60_000,result.taskId);
        state.children.set(result.taskId,result.taskId);
      }
      return [];
    });
    const client=new ScriptedClient(async req=>{
      const step=turns(req),served=servedFor(sy!,req);
      if(step===2){
        // External operator cleanup is separate from the refused supervisor effect.
        sy!.cancelTasks(["race-sibling","race-protected"],"demo");
        for(const id of ["race-sibling","race-protected"]){const task=sy!.tasks.get(id)!;sy!.tasks.interrupt(id,"race-owner","fixture operator cleanup",task.row.run_count);}
      }
      const calls=step===0?[call("finish_job",{status:"completed",summary:"candidate",verified:[],not_verified:[]})]
        :step===1?[call("cancel_tasks",{task_ids:["race-sibling","race-protected"]})]
        :step===2?[call("await_tasks",{timeout_seconds:0})]
        :[call("finish_job",{status:"blocked",summary:"Fixture intentionally blocked",verified:[],not_verified:["Protected work"]})];
      return reply(null,{...served,toolCalls:calls});
    });
    sy=open(env,client,{worker:true});const job=await sy.startJob({goal:"Cancellation race",repositories:["core"]});
    const done=await sy.awaitResults([job.taskId],{timeoutSeconds:90});
    expect(done.timedOut).toBe(false);expect(observed).toBe(true);expect(attempts).toBeGreaterThan(0);
    expect(client.requests.flatMap(toolOutputs).join("\n")).toContain("operator-approved and running");
  },120_000);
});

describe("supervisor cancellation mutation protection",()=>{
  it.each([["a","b"],["b","a"]])("refuses all siblings after an approval races past preflight: %s/%s",async(first,second)=>{
    const f=portFixture();
    immediate(db!,()=>assertSupervisorCancelUnprotected(db!,env!.cfg,"demo",[first,second],f.now));
    // Hold the actual async-port call until after preflight, then install exact operator authority.
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    const operationId=leaseOperationId(f.now),targets=[first,second].map(f.target);
    const pending=barrier.then(()=>f.port.cancel({operationId,project:"demo",actor:"supervisor",actorLease:f.actor,targets}));
    f.action("b",{status:"running",decidedBy:"operator"});release();
    await expect(pending).rejects.toThrow(/operator-approved and running/);
    for(const id of ["a","b"])expect(f.tasks.get(id)!.row.cancel_requested).toBe(0);
    expect(db!.prepare("SELECT id FROM task_lease_operations WHERE id=?").get(operationId)).toBeUndefined();
  });
  it("samples tightened trusted policy inside mutation and protects nested work without expanding effects",async()=>{
    const f=portFixture();f.action("nested");
    immediate(db!,()=>assertSupervisorCancelUnprotected(db!,env!.cfg,"demo",["a","b"],f.now));
    f.policyNow("human_only");
    await expect(f.cancel()).rejects.toThrow(/awaiting human approval/);
    expect(f.tasks.get("a")!.row.cancel_requested).toBe(0);
    expect(f.tasks.get("nested")!.row.cancel_requested).toBe(0);
    f.policyNow("supervisor");await f.cancel(["b"]);
    expect(f.tasks.get("nested")!.row.cancel_requested).toBe(0);
  });
  it("refuses revoked current supervisor role on direct port calls",async()=>{
    const f=portFixture();const cfg=YAML.parse(readFileSync(env!.cfg.configPath,"utf8"));cfg.profiles.supervise.mode="completion";writeFileSync(env!.cfg.configPath,YAML.stringify(cfg));
    await expect(f.cancel()).rejects.toThrow();expect(f.tasks.get("a")!.row.cancel_requested).toBe(0);
  });
  it("ignores a valid stale action generation but fails closed for malformed relevant authority",async()=>{
    const f=portFixture("human_only");const lease=capturedLease(f.tasks.get("b")!);
    f.action("b",{action:{lease:{...lease,runCount:lease.runCount+1}}});
    await f.cancel(["b"]);
    db!.prepare("DELETE FROM worker_action_requests").run();
    f.action("a",{action:{lease:{owner:4}}});
    await expect(f.cancel(["a"])).rejects.toThrow();expect(f.tasks.get("a")!.row.cancel_requested).toBe(0);
  });
  it("replays durable receipts before fresh authority and keeps stale targets per-target unknown",async()=>{
    const f=portFixture(),operationId=leaseOperationId(f.now),targets=[f.target("a")];
    const input={operationId,project:"demo",actor:"supervisor" as const,actorLease:f.actor,targets};
    await f.port.cancel(input);db!.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='actor'").run();
    expect((await f.port.cancel(input)).disposition).toBe("replayed");
    await expect(f.port.cancel({...input,targets:[f.target("b")]})).rejects.toThrow(/different payload/);
    const receipt=await f.port.cancel({operationId:leaseOperationId(f.now),project:"demo",actor:"control",targets:[{...f.target("b"),runCount:999},f.target("nested")]});
    expect(receipt.affected.map(row=>row.state)).toEqual(["unknown","cancel_requested"]);
    expect(f.tasks.get("b")!.row.cancel_requested).toBe(0);
  });
  it("does not repeat pruned cancellation effects or require fresh authority on a replay",async()=>{
    const f=portFixture(),operationId=leaseOperationId(f.now);
    const input={operationId,project:"demo",actor:"supervisor" as const,actorLease:f.actor,targets:[f.target("a")]};
    await f.port.cancel(input);
    db!.prepare("DELETE FROM task_lease_operations WHERE id=?").run(operationId);
    db!.prepare("UPDATE tasks SET cancel_requested=1 WHERE id='actor'").run();
    const before=f.tasks.get("a"),events=f.tasks.events("a");
    expect(await f.port.cancel(input)).toMatchObject({disposition:"replayed",original:"stale",affected:[]});
    expect(f.tasks.get("a")).toEqual(before);
    expect(f.tasks.events("a")).toEqual(events);
    await expect(f.port.cancel({...input,targets:[f.target("b")]})).rejects.toThrow(/different payload/);
    expect(f.tasks.get("b")!.row.cancel_requested).toBe(0);
  });
  it("preserves explicit control cancellation of protected operator work",async()=>{
    const f=portFixture();f.action("b",{status:"running",decidedBy:"operator"});
    const receipt=await f.port.cancel({operationId:leaseOperationId(f.now),project:"demo",actor:"control",targets:[f.target("b")]});
    expect(receipt.disposition).toBe("applied");expect(f.tasks.get("b")!.row.cancel_requested).toBe(1);
    // No OS process was started: this asserts logical control authority, not quiescence.
  });
});
