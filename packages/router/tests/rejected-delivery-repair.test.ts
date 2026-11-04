import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { productCandidateDigest } from "../src/verification/product-evidence.js";
import { baseConfig, makeEnv, openWithTestSupervisor, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{try{await sy?.close();}finally{vi.restoreAllMocks();env?.cleanup();sy=undefined;env=undefined;}});
const goal="Deliver a checked runtime candidate";
const spec:DeliverySpec={schemaVersion:1,id:"repair",revision:1,source:{ref:"fixture:spec",digest:"a".repeat(64)},originalInstruction:goal,ownerId:"initiator",users:["operator"],platforms:["node"],workflows:["run check"],dataInvariants:[],interfaceContracts:[],visualRequirements:["FINAL observes candidate"],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"runtime",priority:"required",behavior:"Runtime check executes and FINAL observes the candidate",applicability:{status:"applicable"},requiredEvidence:["structural","visual"]}]};
const call=(name:string,args:unknown,id=name)=>({id,type:"function" as const,function:{name,arguments:JSON.stringify(args)}});
const finish=()=>call("finish_job",{status:"completed",summary:"candidate checked",verified:[{claim:"runtime checked",evidence:"validate_delivery"}],not_verified:[]});

it.each([{project:"demo",expired:false},{project:"other",expired:true}])("repairs a rejected completed delivery with its configured allowance and retained budget/history ($project, expired=$expired)",async({project,expired})=>{
  const allowanceSeconds=600;
  let now=Date.now(),expectedRepairDeadline:number|undefined,originalRunCount=0;
  // Runtime delivery tools also read Date.now; share the task clock without
  // replacing real command/worker timers or accepting future evidence.
  vi.spyOn(Date,"now").mockImplementation(()=>now);
  const cfg=baseConfig({coding:{runner:"native"},supervisor:{job_timeout_seconds:allowanceSeconds},team:{provider_concurrency_enabled:false},...(project==="other"?{repositories:{},projects:{demo:{repositories:{}},other:{repositories:{core:{path:"repo",writable:true}}}}}:{})});
  (cfg.profiles as Record<string,unknown>).supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:40,max_output_tokens:4000,classify:"never",min_tier:"T3"};
  env=makeEnv({config:cfg});
  let repair=false,repairObservationMissing=false;
  function visual(id:string){
    const store=new ProductDeliveries(sy!.db,()=>now),state=store.status(id,project)!,at=now;
    store.recordEvidence(id,project,{schemaVersion:1,id:`visual-${repair?"repair":"initial"}`,criterionIds:["runtime"],kind:"visual",specDigest:deliverySpecDigest(state.spec),candidateDigest:productCandidateDigest(state.candidate!),actor:{id:"fixture-final",role:"initiator"},basis:"observed",outcome:"pass",startedAt:at,completedAt:at,expiresAt:null,artifactRefs:[sy!.artifacts.write({taskId:id,kind:"check_log",label:"Independent fixture observation",content:"FINAL observed the exact current candidate",extension:".log"})],observations:["Observed exact candidate"],unknowns:[],subjectActorIds:[`supervisor:${id}`]});
  }
  const client=new ScriptedClient(req=>{
    if(!String(req.messages[0]?.content).startsWith("# Supervisor charter")){
      const turn=req.messages.filter(message=>message.role==="assistant").length;
      return reply(null,{...servedFor(sy!,req),toolCalls:turn===0?[call("read_file",{path:"README.md"})]:[call("submit_result",{summary:"Fixture inspected",findings:[],criteria:[{index:0,status:"met",evidenceRefs:["core:README.md#L1"]}]})]});
    }
    const id=/Job id: (\S+)/.exec(String(req.messages[0]!.content))![1]!;
    const turn=req.messages.filter(message=>message.role==="assistant").length;
    let calls;
    if(!repair){
      if(turn===0)calls=[call("set_delivery_spec",{spec})];
      else if(turn===1)calls=[...(["prepare","plan"].map(stage=>call("advance_delivery_stage",{stage},stage))),call("plan_work",{nodes:[{label:"inspect-runtime",profile:"inspect",goal:"Inspect the runtime fixture",acceptance_criteria:["Fixture observed"],repositories:["core"],difficulty:"T1"}]})];
      else if(turn===2)calls=[call("await_tasks",{timeout_seconds:30}),...["implement","integrate","validate"].map(stage=>call("advance_delivery_stage",{stage},stage))];
      else if(turn===3)calls=[call("validate_delivery",{})];
      else if(turn===4){visual(id);calls=[call("advance_delivery_stage",{stage:"handoff"})];}
      else calls=[finish()];
    }else{
      if(turn===0){
        expect(sy!.tasks.get(id)!.row).toMatchObject({state:"running",run_count:originalRunCount+1,deadline_at:expectedRepairDeadline});
        expect(req.messages.some(message=>String(message.content).includes("FINAL rejected the previous completed delivery"))).toBe(true);
        expect(req.messages.some(message=>String(message.content).includes("Rejected visible behavior"))).toBe(true);
        const previous=sy!.sessions.forTask(id).find(session=>session.status==="completed")!;
        const cwd=previous.workspace!.repos[0]!.worktree;
        // A trusted fixture collaborator supplies the repair commit; the real resumed
        // supervisor must bind fresh physical checks and new FINAL observations to it.
        writeFileSync(path.join(cwd,"README.md"),"# Repaired candidate\n");
        for(const args of [["add","README.md"],["-c","user.name=fixture","-c","user.email=fixture@example.com","commit","-qm","repair rejected behavior"]])execFileSync("git",args,{cwd,stdio:"pipe"});
        calls=[call("validate_delivery",{})];
      }else if(turn===1){
        const state=new ProductDeliveries(sy!.db,()=>now).status(id,project)!;
        repairObservationMissing=state.readiness!.blockers.some(blocker=>blocker.kind==="visual");
        expect(state.finalDecision).toBeNull();expect(repairObservationMissing).toBe(true);
        visual(id);calls=[call("advance_delivery_stage",{stage:"handoff"})];
      }else calls=[finish()];
    }
    return reply(null,{...servedFor(sy!,req),toolCalls:calls});
  });
  sy=openWithTestSupervisor(env,client,{worker:true,now:()=>now},["node --version"]);
  const [job]=await sy.submitTasks([{profile:"supervise",goal,repositoryAliases:["core"],deliveryVersion:2,budget:{maxModelRequests:40},constraints:{acceptanceCriteria:["checked candidate"],checks:["node --version"]}}],{project});
  const id=job!.taskId;
  expect((await sy.awaitResults([id],{timeoutSeconds:90})).completed[0]?.stopReason).toBe("supervisor_completed");
  const store=new ProductDeliveries(sy.db,()=>now),state=store.status(id,project)!,original=sy.sessions.forTask(id).filter(session=>session.role==="supervisor").at(-1)!;
  const originalEvents=sy.sessions.events(original.id);
  expect(()=>sy!.resumeTask(id,project)).toThrow(/FINAL-rejected/);
  store.finalDecision(id,project,{schemaVersion:1,decision:"accept",actor:{id:"FINAL",role:"initiator"},specDigest:deliverySpecDigest(state.spec),candidateDigest:productCandidateDigest(state.candidate!),reason:"initial review",at:now});
  expect(()=>sy!.resumeTask(id,project)).toThrow(/FINAL-rejected/);
  store.finalDecision(id,project,{schemaVersion:1,decision:"reject",actor:{id:"FINAL",role:"initiator"},specDigest:deliverySpecDigest(state.spec),candidateDigest:productCandidateDigest(state.candidate!),reason:"Rejected visible behavior",at:now});
  const completed=sy.tasks.get(id)!,used=sy.admission.taskTotals(id).requests,cap=completed.spec.budget;
  expect(used).toBeGreaterThan(0);expect(cap?.maxModelRequests).toBe(40);expect(cap?.timeoutSeconds).toBeUndefined();
  expect(completed.row.deadline_at).toBe(now+allowanceSeconds*1000);
  originalRunCount=completed.row.run_count;
  if(expired){
    // Advance the injected clock past the actual configured deadline; no stored
    // task/session state is rewritten to make the completed repair eligible.
    now=completed.row.deadline_at!+1;
    expect(completed.row.deadline_at).toBeLessThan(now);
  }
  expectedRepairDeadline=now+allowanceSeconds*1000;
  const accounting=()=>["model_requests","request_charges","paid_spend","budget_requests","task_request_grants","job_budget_carves","execution_members","project_request_protocol","project_request_holds","project_request_spend"].map(table=>sy!.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const beforeAccounting=accounting(),beforeTaskEvents=sy.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(id);
  const beforeDelivery=sy.db.prepare("SELECT * FROM product_deliveries WHERE task_id=? AND project_id=?").get(id,project);
  expect(()=>sy!.resumeTask(id,"foreign")).toThrow();
  expect(()=>sy!.tasks.resume(id)).toThrow(/trusted repair continuation/);
  repair=true;
  expect(sy.resumeTask(id,project)).toBe("queued");
  expect(sy.tasks.get(id)!.row).toMatchObject({state:"queued",state_reason:"resumed",deadline_at:null,run_count:originalRunCount,started_at:completed.row.started_at});
  expect(()=>sy!.resumeTask(id,project)).toThrow();
  expect(sy.admission.taskTotals(id).requests).toBe(used);
  expect(sy.tasks.get(id)!.spec.budget).toEqual(cap);
  expect(sy.tasks.get(id)!.spec).toEqual(completed.spec);
  expect(accounting()).toEqual(beforeAccounting);
  expect(sy.db.prepare("SELECT * FROM product_deliveries WHERE task_id=? AND project_id=?").get(id,project)).toEqual(beforeDelivery);
  expect(sy.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(id).slice(0,beforeTaskEvents.length)).toEqual(beforeTaskEvents);
  expect(sy.tasks.events(id,1000).find(event=>event.type==="delivery_repair_requested")?.data).toMatchObject({previousSessionId:original.id,previousResult:completed.result});
  expect(sy.sessions.get(original.id)).toEqual(original);expect(sy.sessions.events(original.id)).toEqual(originalEvents);
  // Long delivery jobs may have far more than the default event-page size.
  for(let i=0;i<600;i++)sy.tasks.event(id,"fixture_repair_noise",{i});
  expect((await sy.awaitResults([id],{timeoutSeconds:90})).completed[0]?.stopReason).toBe("supervisor_completed");
  const sessions=sy.sessions.forTask(id).filter(session=>session.role==="supervisor");
  expect(sessions).toHaveLength(2);expect(sessions[1]!.previousSessionId).toBe(original.id);
  expect(sessions[1]!.workspace!.repos[0]!.worktree).toBe(original.workspace!.repos[0]!.worktree);
  expect(sy.sessions.get(original.id)?.status).toBe("completed");expect(sy.sessions.events(original.id)).toEqual(originalEvents);
  expect(sy.admission.taskTotals(id).requests).toBeGreaterThan(used);expect(repairObservationMissing).toBe(true);
  expect(store.status(id,project)).toMatchObject({stage:"handoff",finalDecision:null,accepted:false,readiness:{status:"ready_for_final_review"}});
  expect(productCandidateDigest(store.status(id,project)!.candidate!)).not.toBe(productCandidateDigest(state.candidate!));
  expect(sy.tasks.events(id,1000).filter(event=>event.type==="delivery_repair_requested")).toHaveLength(1);
  expect(()=>sy!.resumeTask(id,project)).toThrow();
},120000);

it("does not reopen completed nonproduct supervisors or other completed roles",async()=>{
  const cfg=baseConfig();
  (cfg.profiles as Record<string,unknown>).supervise={mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:40,classify:"never",min_tier:"T3"};
  env=makeEnv({config:cfg});
  const client=new ScriptedClient(()=>reply("{}"));
  sy=openWithTestSupervisor(env,client);
  for(const profile of ["supervise","summarize"]){
    const [task]=await sy.submitTasks([{profile,goal:"Completed nonproduct fixture",repositoryAliases:["core"],constraints:{acceptanceCriteria:["fixture"]}}]);
    sy.db.prepare("UPDATE tasks SET state='completed',finished_at=? WHERE id=?").run(Date.now(),task!.taskId);
    expect(()=>sy!.resumeTask(task!.taskId,"demo")).toThrow(/FINAL-rejected/);
    expect(()=>sy!.tasks.resume(task!.taskId)).toThrow(/trusted repair continuation/);
    expect(sy.tasks.get(task!.taskId)!.row.state).toBe("completed");
    expect(sy.tasks.events(task!.taskId,100).some(event=>event.type==="delivery_repair_requested")).toBe(false);
  }
  expect(client.requests).toHaveLength(0);
});
