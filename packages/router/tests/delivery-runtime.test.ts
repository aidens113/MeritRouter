import { afterEach, expect, it } from "vitest";
import { baseConfig, commitAll, makeEnv, openWithTestSupervisor, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { productDigest } from "../src/verification/product-spec.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{await sy?.close();env?.cleanup();});
it.each([false,true])("runs default delegated lifecycle and refuses a source-changing final check (mutating %s)",async mutating=>{
  const base=baseConfig();
  env=makeEnv({config:{...base,client_supervision:{},profiles:{...base.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:null,max_output_tokens:8000,classify:"never",min_tier:"T3"}}}});
  const command=mutating?"node check.cjs":"node --version";
  if(mutating){
    writeFileSync(path.join(env.repo,".gitignore"),".check-counter\n");
    writeFileSync(path.join(env.repo,"check.cjs"),"const fs=require('node:fs'); const n=fs.existsSync('.check-counter')?Number(fs.readFileSync('.check-counter','utf8'))+1:1;fs.writeFileSync('.check-counter',String(n));if(n>1){fs.appendFileSync('src/app.ts','\\n// Changed during final check\\n');require('node:child_process').execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am','Check changed source']);}");
    commitAll(env.repo,"Add changing check fixture");
  }
  const goal="Verify the isolated fixture runtime";
  const spec={schemaVersion:1,id:"fixture",revision:1,source:{ref:"fixture-spec",digest:productDigest(goal)},originalInstruction:goal,ownerId:"initiator",users:["fixture operator"],platforms:["node"],workflows:["run node"],dataInvariants:[],interfaceContracts:[],visualRequirements:[],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"runtime",priority:"required",behavior:"Node starts",applicability:{status:"applicable"},requiredEvidence:["structural"]}]};
  const script:Array<[string,unknown]>=[
    ["set_delivery_spec",{spec}],
    ...["prepare","plan"].map(stage=>["advance_delivery_stage",{stage}] as [string,unknown]),
    ["plan_work",{nodes:[{label:"inspect-runtime",profile:"inspect",goal:"Inspect the runtime fixture",acceptance_criteria:["Fixture contents observed"],repositories:["core"],difficulty:"T1"}]}],
    ["await_tasks",{timeout_seconds:30}],
    ...["implement","integrate","validate"].map(stage=>["advance_delivery_stage",{stage}] as [string,unknown]),
    ["validate_delivery",{}],["advance_delivery_stage",{stage:"handoff"}],
    ["finish_job",{status:"completed",summary:"Fixture verified",verified:[{claim:"Node starts",evidence:"validate_delivery ran node --version with exit 0"}],not_verified:[],follow_up:"FINAL supervisor review"}],
  ];
  let index=0;
  const client=new ScriptedClient(req=>{
    if(!String(req.messages[0]?.content).startsWith("# Supervisor charter")){
      const turn=req.messages.filter(message=>message.role==="assistant").length;
      const name=turn===0?"read_file":"submit_result",args=turn===0?{path:"README.md"}:{summary:"Fixture observed",findings:[],criteria:[{index:0,status:"met",evidenceRefs:["core:README.md#L1"]}]};
      return reply(null,{...servedFor(sy!,req),toolCalls:[{id:`worker-${turn}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]});
    }
    if(req.messages.some(message=>message.role==="tool"&&String(message.content).includes('"error"')))throw new Error("Unexpected tool error in delegated lifecycle");
    const [name,args]=script[index++]??["finish_job",{status:"blocked",summary:"Unexpected extra call",verified:[],not_verified:["lifecycle"],follow_up:"inspect"}];
    return reply(null,{toolCalls:[{id:`step-${index}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]});
  });
  sy=openWithTestSupervisor(env,client,{worker:true});
  const submitted=await sy.startJob({goal,repositories:["core"],checks:[command]});
  const result=(await sy.awaitResults([submitted.taskId],{timeoutSeconds:40})).completed[0];
  expect(result,JSON.stringify(client.requests.at(-1)?.messages.filter(message=>message.role==="tool"))).toMatchObject({executionStatus:"completed",acceptanceStatus:mutating?"unmet":"not_verified",stopReason:"supervisor_completed"});
  const state=new ProductDeliveries(sy.db).status(submitted.taskId,"demo");
  if(mutating){
    expect(result!.checks).toContainEqual(expect.objectContaining({command:"candidate_binding",exitCode:null}));
    expect(state).toMatchObject({candidate:null,accepted:false,readiness:null});
    return;
  }
  expect(state).toMatchObject({stage:"handoff",readiness:{status:"ready_for_final_review"},finalDecision:null});
  expect(state!.evidence.some(receipt=>receipt.kind==="structural"&&receipt.basis==="observed"&&receipt.outcome==="pass")).toBe(true);
  expect(sy.tasks.get(submitted.taskId)!.spec).toMatchObject({deliveryVersion:2,budget:{maxModelRequests:600}});
  expect(index).toBe(11);
  const server=buildMcpServer({sy,cfg:env.cfg,project:"demo"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const finalClient=new Client({name:"fixture-final",version:"1"});
  try{
    await finalClient.connect(clientTransport);
    const expected={expectedSpecDigest:state!.readiness!.specDigest,expectedCandidateDigest:state!.readiness!.candidateDigest};
    const decision=await finalClient.callTool({name:"decide_delivery",arguments:{taskId:submitted.taskId,decision:"accept",reason:"Observed fixture output",...expected}});
    expect(decision.isError).toBeFalsy();
    const workspace=sy.sessions.forTask(submitted.taskId).filter(session=>session.role==="supervisor").at(-1)!.workspace!;
    execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","Changed after FINAL observation"],{cwd:workspace.repos[0]!.worktree});
    const stale=await finalClient.callTool({name:"record_delivery_observation",arguments:{taskId:submitted.taskId,criterionIds:["runtime"],kind:"structural",outcome:"pass",artifactRefs:["fixture-observation"],observations:["Observed previous candidate"],...expected}});
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain("delivery_candidate_conflict");
    const staleDecision=await finalClient.callTool({name:"decide_delivery",arguments:{taskId:submitted.taskId,decision:"accept",reason:"Previous observation",...expected}});
    expect(staleDecision.isError).toBe(true);
    expect(JSON.stringify(staleDecision)).toContain("delivery_candidate_conflict");
    expect(new ProductDeliveries(sy.db).status(submitted.taskId,"demo")?.accepted).toBe(false);
  }finally{await finalClient.close();await server.close();}
},45000);
