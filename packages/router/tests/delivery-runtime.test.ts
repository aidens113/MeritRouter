import { afterEach, expect, it } from "vitest";
import { baseConfig, makeEnv, openWithTestSupervisor, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { productDigest } from "../src/verification/product-spec.js";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{await sy?.close();env?.cleanup();});
it("runs default delegated specification/stages/checks and hands evidence back without FINAL acceptance",async()=>{
  const base=baseConfig();
  env=makeEnv({config:{...base,client_supervision:{},profiles:{...base.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:100,max_model_requests:null,max_output_tokens:8000,classify:"never",min_tier:"T3"}}}});
  const goal="Verify the isolated fixture runtime";
  const spec={schemaVersion:1,id:"fixture",revision:1,source:{ref:"fixture-spec",digest:productDigest(goal)},originalInstruction:goal,ownerId:"initiator",users:["fixture operator"],platforms:["node"],workflows:["run node"],dataInvariants:[],interfaceContracts:[],visualRequirements:[],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"runtime",priority:"required",behavior:"Node starts",applicability:{status:"applicable"},requiredEvidence:["structural"]}]};
  const script:Array<[string,unknown]>=[
    ["set_delivery_spec",{spec}],
    ...["prepare","plan","implement","integrate","validate"].map(stage=>["advance_delivery_stage",{stage}] as [string,unknown]),
    ["validate_delivery",{}],["advance_delivery_stage",{stage:"handoff"}],
    ["finish_job",{status:"completed",summary:"Fixture verified",verified:[{claim:"Node starts",evidence:"validate_delivery ran node --version with exit 0"}],not_verified:[],follow_up:"FINAL supervisor review"}],
  ];
  let index=0;
  const client=new ScriptedClient(req=>{
    if(req.messages.some(message=>message.role==="tool"&&String(message.content).includes('"error"')))throw new Error("Unexpected tool error in delegated lifecycle");
    const [name,args]=script[index++]??["finish_job",{status:"blocked",summary:"Unexpected extra call",verified:[],not_verified:["lifecycle"],follow_up:"inspect"}];
    return reply(null,{toolCalls:[{id:`step-${index}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]});
  });
  sy=openWithTestSupervisor(env,client,{worker:true});
  const submitted=await sy.startJob({goal,repositories:["core"],checks:["node --version"]});
  const result=(await sy.awaitResults([submitted.taskId],{timeoutSeconds:40})).completed[0];
  expect(result,JSON.stringify(client.requests.at(-1)?.messages.filter(message=>message.role==="tool"))).toMatchObject({executionStatus:"completed",acceptanceStatus:"not_verified",stopReason:"supervisor_completed"});
  const state=new ProductDeliveries(sy.db).status(submitted.taskId,"demo");
  expect(state).toMatchObject({stage:"handoff",readiness:{status:"ready_for_final_review"},finalDecision:null});
  expect(state!.evidence.some(receipt=>receipt.kind==="structural"&&receipt.basis==="observed"&&receipt.outcome==="pass")).toBe(true);
  expect(sy.tasks.get(submitted.taskId)!.spec).toMatchObject({deliveryVersion:2,budget:{maxModelRequests:600}});
  expect(index).toBe(9);
},45000);
