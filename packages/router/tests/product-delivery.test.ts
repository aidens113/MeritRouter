import { afterEach, describe, expect, it } from "vitest";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { productCandidateDigest, type ProductCandidate } from "../src/verification/product-evidence.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{await sy?.close();env?.cleanup();sy=undefined;env=undefined;});
const digest="a".repeat(64);
const candidate:ProductCandidate={repositories:{core:{head:"a".repeat(40),tree:"b".repeat(40)}},testDigest:digest,recipeDigest:digest,environmentDigest:digest,dependencyDigest:digest,fixtureDigest:digest,browserGeneration:null};
const spec:DeliverySpec={schemaVersion:1,id:"delivery",revision:1,source:{ref:"brain:spec.md",digest},originalInstruction:"Deliver a working UI",ownerId:"initiator",users:["user"],platforms:["browser"],workflows:["click button"],dataInvariants:[],interfaceContracts:[],visualRequirements:[],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"button",priority:"required",behavior:"Button changes state",applicability:{status:"applicable"},requiredEvidence:["journey"]}]};
async function fixture(){
  const cfg=baseConfig();env=makeEnv({config:{...cfg,profiles:{...cfg.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:30,max_model_requests:20}}}});
  sy=open(env,new ScriptedClient(()=>reply("{}")));
  const [task]=await sy.submitTasks([{profile:"supervise",goal:"Working UI",repositoryAliases:["core"],supervisionScope:"subtask",constraints:{acceptanceCriteria:["Button changes state"]}}]);
  return {store:new ProductDeliveries(sy.db),id:task!.taskId};
}
describe("persisted product delivery",()=>{
  it("blocks unobserved handoff and final accept, then preserves rejection separately",async()=>{
    const {store,id}=await fixture();store.saveSpec(id,"demo",spec);store.setCandidate(id,"demo",candidate);
    expect(()=>store.transition(id,"demo","handoff")).toThrow();
    const decision={schemaVersion:1,decision:"accept",actor:{id:"initiator",role:"initiator"},specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),reason:"reviewed",at:Date.now()};
    expect(()=>store.finalDecision(id,"demo",decision)).toThrow(/unresolved/);
    const at=Date.now();store.recordEvidence(id,"demo",{schemaVersion:1,id:"journey",criterionIds:["button"],kind:"journey",specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),actor:{id:"runtime",role:"runtime"},basis:"observed",outcome:"pass",startedAt:at,completedAt:at,expiresAt:null,artifactRefs:["artifact:journey"],observations:["Click changes state"],unknowns:[],subjectActorIds:["worker"]});
    expect(store.status(id,"demo")?.readiness?.status).toBe("ready_for_final_review");
    expect(()=>store.finalDecision(id,"demo",{...decision,actor:{id:"worker",role:"worker"}})).toThrow();
    store.finalDecision(id,"demo",decision);store.finalDecision(id,"demo",{...decision,decision:"reject",reason:"Actual layout unusable"});
    expect(store.status(id,"demo")).toMatchObject({stage:"validate",finalDecision:{decision:"reject"}});
    expect(new ProductDeliveries(sy!.db).status(id,"demo")?.finalDecision?.reason).toBe("Actual layout unusable");
  });
  it("scopes by project and invalidates evidence/decision on CAS spec changes",async()=>{
    const {store,id}=await fixture();store.saveSpec(id,"demo",spec);store.setCandidate(id,"demo",candidate);
    expect(store.status(id,"wrong")).toBeNull();expect(()=>store.setCandidate(id,"wrong",candidate)).toThrow();
    const changed={...spec,revision:2};expect(()=>store.saveSpec(id,"demo",changed)).toThrow(/conflict/);
    store.saveSpec(id,"demo",changed,deliverySpecDigest(spec));
    expect(store.status(id,"demo")).toMatchObject({candidate:null,evidence:[],finalDecision:null,stage:"specify"});
    expect(()=>store.transition(id,"demo","implement")).toThrow(/skip/);
  });
});
