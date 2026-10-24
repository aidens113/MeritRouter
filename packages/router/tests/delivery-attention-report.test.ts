import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { projectDeliveryReport } from "../src/admin/deliveries.js";
import { projectAttention } from "../src/admin/projects.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { deliverySpecDigest, type DeliverySpec } from "../src/verification/product-spec.js";
import { productCandidateDigest, type ProductCandidate } from "../src/verification/product-evidence.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env: Env | undefined, sy: MeritRouter | undefined, client: Client | undefined;
afterEach(async () => { await client?.close(); await sy?.close(); env?.cleanup(); client=undefined; sy=undefined; env=undefined; });
const digest="a".repeat(64);
const candidate:ProductCandidate={repositories:{core:{head:"a".repeat(40),tree:"b".repeat(40)}},testDigest:digest,recipeDigest:digest,environmentDigest:digest,dependencyDigest:digest,fixtureDigest:digest,browserGeneration:null};
const spec:DeliverySpec={schemaVersion:1,id:"report",revision:1,source:{ref:"brain:private-spec",digest},originalInstruction:"Private product goal",ownerId:"final",users:["user"],platforms:["browser"],workflows:["click"],dataInvariants:[],interfaceContracts:[],visualRequirements:[],failureStates:[],securityRequirements:[],exclusions:[],setupRecipeRefs:[],criteria:[{id:"click",priority:"required",behavior:"Private behavior",applicability:{status:"applicable"},requiredEvidence:["journey"]}]};
function setup(){
  const cfg=baseConfig({repositories:{},projects:{alpha:{repositories:{core:{path:"repo"}}},beta:{repositories:{core:{path:"repo"}}}}});
  env=makeEnv({config:{...cfg,profiles:{...cfg.profiles,supervise:{mode:"supervisor",tools:"supervisor",min_total_parameters_b:30,max_model_requests:20}}}});
  sy=open(env,new ScriptedClient(()=>reply("{}")));
}
async function delivery(project="alpha"){
  const [task]=await sy!.submitTasks([{profile:"supervise",goal:spec.originalInstruction,repositoryAliases:["core"],supervisionScope:"subtask",constraints:{acceptanceCriteria:["Click works"]}}],{project});
  const id=task!.taskId,store=new ProductDeliveries(sy!.db);
  store.saveSpec(id,project,spec);
  sy!.db.prepare("UPDATE tasks SET state='completed',result_json=? WHERE id=?").run(JSON.stringify({acceptanceStatus:"met"}),id);
  return {id,store,project};
}
function accepted(f:Awaited<ReturnType<typeof delivery>>){
  const {id,store,project}=f,at=Date.now();store.setCandidate(id,project,candidate);
  store.recordEvidence(id,project,{schemaVersion:1,id:"journey",criterionIds:["click"],kind:"journey",specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),actor:{id:"runtime",role:"runtime"},basis:"observed",outcome:"pass",startedAt:at,completedAt:at,expiresAt:null,artifactRefs:["artifact:private"],observations:["Private observation"],unknowns:[],subjectActorIds:["worker"]});
  for(const stage of ["prepare","plan","implement","integrate","validate","handoff"])store.transition(id,project,stage);
  store.finalDecision(id,project,{schemaVersion:1,decision:"accept",actor:{id:"final",role:"initiator"},specDigest:deliverySpecDigest(spec),candidateDigest:productCandidateDigest(candidate),reason:"Private final reason",at});
}
describe("compact project delivery attention and report",()=>{
  it("flags legacy-met unready/rejected and clears only current accepted evidence",async()=>{
    setup();const f=await delivery();
    expect(projectAttention(sy!,"alpha").join(" ")).toContain("candidate_missing");
    accepted(f);expect(projectAttention(sy!,"alpha")).toEqual([]);
    const status=f.store.status(f.id,"alpha")!;
    f.store.finalDecision(f.id,"alpha",{...status.finalDecision!,decision:"reject"});
    expect(projectAttention(sy!,"alpha").join(" ")).toContain("final_rejected");
    expect(projectDeliveryReport(sy!,{project:"alpha"}).deliveries[0]).toMatchObject({historicalFinalDecision:"reject",effectiveAccepted:false,needsAttention:true});
  });
  it("exposes stale historical acceptance as ineffective without private bodies",async()=>{
    setup();const f=await delivery();accepted(f);
    f.store.recordEvidence(f.id,"alpha",{...f.store.status(f.id,"alpha")!.evidence[0]!,id:"regression",outcome:"fail"});
    const report=projectDeliveryReport(sy!,{project:"alpha"});
    expect(report).toMatchObject({sourceRevalidated:false,freshness:"stored_candidate_and_evidence",deliveries:[{historicalFinalDecision:"accept",effectiveAccepted:false,reasons:["failed_evidence","historical_acceptance_invalid"]}]});
    expect(JSON.stringify(report)).not.toContain("Private");
    expect(projectAttention(sy!,"alpha").join(" ")).toContain("historical_acceptance_invalid");
  });
  it("scopes before keyset limits and rejects invalid inputs",async()=>{
    setup();await delivery("beta");await delivery();await delivery();await delivery();
    const first=projectDeliveryReport(sy!,{project:"alpha",limit:2});
    const second=projectDeliveryReport(sy!,{project:"alpha",limit:2,after:first.nextAfter!});
    expect(first.deliveries).toHaveLength(2);expect(second.deliveries).toHaveLength(1);expect(second.nextAfter).toBeNull();
    expect(new Set([...first.deliveries,...second.deliveries].map(x=>x.taskId)).size).toBe(3);
    for(const input of [{project:"alpha",limit:101},{project:"alpha",limit:0},{project:"alpha",after:""},{project:"alpha",spoof:true},{project:"missing"}])expect(()=>projectDeliveryReport(sy!,input)).toThrow();
  });
  it("MCP returns the same scoped compact report with strict bounds",async()=>{
    setup();await delivery("beta");await delivery();
    const server=buildMcpServer({sy:sy!,cfg:env!.cfg,project:"alpha"});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);client=new Client({name:"report-test",version:"1"});await client.connect(ct);
    const result=await client.callTool({name:"project_delivery_report",arguments:{limit:1}});
    expect(JSON.parse((result.content as {text:string}[])[0]!.text)).toEqual(projectDeliveryReport(sy!,{project:"alpha",limit:1}));
    expect((await client.callTool({name:"project_delivery_report",arguments:{limit:101}})).isError).toBe(true);
    expect((await client.callTool({name:"project_delivery_report",arguments:{spoof:true}})).isError).toBe(true);
    expect((await client.callTool({name:"project_delivery_report",arguments:{project:"missing"}})).isError).toBe(true);
  });
});
