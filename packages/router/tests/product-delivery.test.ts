import { afterEach, describe, expect, it } from "vitest";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { productCandidateDigest, type ProductCandidate } from "../src/verification/product-evidence.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { currentProductCandidate } from "../src/verification/product-candidate.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{await sy?.close();env?.cleanup();sy=undefined;env=undefined;});
const digest="a".repeat(64);
const candidate:ProductCandidate={repositories:{core:{head:"a".repeat(40),tree:"b".repeat(40)}},testDigest:digest,recipeDigest:digest,environmentDigest:digest,dependencyDigest:digest,fixtureDigest:digest,browserGeneration:null};
const spec:DeliverySpec={schemaVersion:1,id:"delivery",revision:1,source:{ref:"brain:spec.md",digest},originalInstruction:"Deliver a working UI",ownerId:"initiator",users:["user"],platforms:["browser"],workflows:["click button"],dataInvariants:[],interfaceContracts:[],visualRequirements:[],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"button",priority:"required",behavior:"Button changes state",applicability:{status:"applicable"},requiredEvidence:["journey"]}]};
async function fixture(){
  const cfg=baseConfig();env=makeEnv({config:{...cfg,profiles:{...cfg.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:30,max_model_requests:20}}}});
  sy=open(env,new ScriptedClient(()=>reply("{}")));
  const [task]=await sy.submitTasks([{profile:"supervise",goal:spec.originalInstruction,repositoryAliases:["core"],supervisionScope:"subtask",constraints:{acceptanceCriteria:["Button changes state"]}}]);
  return {store:new ProductDeliveries(sy.db),id:task!.taskId};
}
describe("persisted product delivery",()=>{
  it("refuses uncommitted integration edits instead of reusing clean HEAD evidence",async()=>{
    const {id}=await fixture();
    const ctx={spec:sy!.tasks.get(id)!.spec,signal:AbortSignal.timeout(10000)},repos=[{alias:"core",worktree:env!.repo}];
    expect((await currentProductCandidate(ctx,repos)).repositories.core?.head).toBeTruthy();
    writeFileSync(path.join(env!.repo,"uncommitted.txt"),"unverified runtime change");
    await expect(currentProductCandidate(ctx,repos)).rejects.toThrow(/clean committed/);
  });
  it("blocks unobserved handoff and final accept, then preserves rejection separately",async()=>{
    const {store,id}=await fixture();store.saveSpec(id,"demo",spec);store.setCandidate(id,"demo",candidate);
    expect(()=>store.saveSpec(id,"demo",{...spec,revision:2,originalInstruction:"Easier replacement goal"},deliverySpecDigest(spec))).toThrow(/original/);
    expect(()=>store.saveSpec(id,"demo",{...spec,revision:2,criteria:[{...spec.criteria[0],priority:"optional"}]},deliverySpecDigest(spec))).toThrow(/required or critical/);
    expect(()=>store.saveSpec(id,"demo",{...spec,revision:2,criteria:[{...spec.criteria[0],applicability:{status:"not_applicable",reason:"model waived",approvedBy:"initiator"}}]},deliverySpecDigest(spec))).toThrow(/authenticated FINAL/);
    expect(()=>store.saveSpec(id,"demo",{...spec,revision:2,criteria:[{...spec.criteria[0],requiredEvidence:["structural"]}]},deliverySpecDigest(spec))).toThrow(/weakened/);
    expect(()=>store.transition(id,"demo","handoff")).toThrow();
    const decision={schemaVersion:1,decision:"accept",actor:{id:"initiator",role:"initiator"},specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),reason:"reviewed",at:Date.now()};
    expect(()=>store.finalDecision(id,"demo",decision)).toThrow(/unresolved/);
    const at=Date.now();store.recordEvidence(id,"demo",{schemaVersion:1,id:"journey",criterionIds:["button"],kind:"journey",specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),actor:{id:"runtime",role:"runtime"},basis:"observed",outcome:"pass",startedAt:at,completedAt:at,expiresAt:null,artifactRefs:["artifact:journey"],observations:["Click changes state"],unknowns:[],subjectActorIds:["worker"]});
    expect(store.status(id,"demo")?.readiness?.status).toBe("ready_for_final_review");
    expect(()=>store.recordEvidence(id,"demo",{...store.status(id,"demo")!.evidence[0],id:"typo",criterionIds:["unknown-criterion"]})).toThrow(/unknown specification criterion/);
    expect(store.status(id,"demo")!.evidence).toHaveLength(1);
    expect(()=>store.finalDecision(id,"demo",{...decision,actor:{id:"worker",role:"worker"}})).toThrow();
    expect(()=>store.finalDecision(id,"demo",decision)).toThrow(/completed delivery/);
    for(const stage of ["prepare","plan","implement","integrate","validate","handoff"])store.transition(id,"demo",stage);
    sy!.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(id);
    store.finalDecision(id,"demo",decision);
    expect(store.status(id,"demo")?.accepted).toBe(true);
    store.recordEvidence(id,"demo",{...store.status(id,"demo")!.evidence[0],id:"observed-regression",outcome:"fail"});
    expect(store.status(id,"demo")).toMatchObject({accepted:false,finalDecision:{decision:"accept"},readiness:{status:"blocked"}});
    store.finalDecision(id,"demo",{...decision,decision:"reject",reason:"Actual layout unusable"});
    expect(store.status(id,"demo")).toMatchObject({stage:"validate",finalDecision:{decision:"reject"}});
    expect(store.status(id,"demo")?.readiness?.status).toBe("blocked");
    expect(()=>store.transition(id,"demo","handoff")).toThrow();
    expect(()=>store.finalDecision(id,"demo",decision)).toThrow(/unresolved/);
    expect(new ProductDeliveries(sy!.db).status(id,"demo")?.finalDecision?.reason).toBe("Actual layout unusable");
  });
  it("scopes by project and invalidates evidence/decision on CAS spec changes",async()=>{
    const {store,id}=await fixture();store.saveSpec(id,"demo",spec);store.setCandidate(id,"demo",candidate);
    expect(store.status(id,"wrong")).toBeNull();expect(()=>store.setCandidate(id,"wrong",candidate)).toThrow();
    const changed={...spec,revision:2};expect(()=>store.saveSpec(id,"demo",changed)).toThrow(/conflict/);
    store.saveSpec(id,"demo",changed,deliverySpecDigest(spec));
    expect(store.status(id,"demo")).toMatchObject({candidate:null,evidence:[],finalDecision:null,stage:"specify"});
    const history=sy!.db.prepare("SELECT spec_json,candidate_json FROM product_delivery_history WHERE task_id=? AND project_id=? ORDER BY sequence").all(id,"demo") as {spec_json:string;candidate_json:string|null}[];
    expect(history.map(row=>JSON.parse(row.spec_json).revision)).toEqual([1,1,2]);
    expect(JSON.parse(history[1]!.candidate_json!)).toEqual(candidate);
    expect(sy!.db.prepare("SELECT * FROM product_delivery_history WHERE project_id=?").all("wrong")).toEqual([]);
    expect(()=>store.transition(id,"demo","implement")).toThrow(/skip/);
  });
});
