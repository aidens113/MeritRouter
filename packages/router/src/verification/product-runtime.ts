import type { RunContext } from "../runners/types.js";
import { currentDeliveryCandidate } from "./product-candidate.js";
import { ProductDeliveries } from "./product-delivery.js";
import { deliverySpecDigest } from "./product-spec.js";
import { productCandidateDigest } from "./product-evidence.js";

/** Runtime-only conversion of persisted, independently revalidated Lab observations. */
export async function synchronizeDeliveryCandidate(ctx:RunContext,repos:Iterable<{alias:string;worktree:string}>) {
  const project=ctx.tasks.projectOf(ctx.taskId)??ctx.cfg.brain.project;
  const store=new ProductDeliveries(ctx.tasks.db),before=store.status(ctx.taskId,project);
  if(!before)return null;
  const specDigest=deliverySpecDigest(before.spec);
  const runtime=ctx.lab?{manager:ctx.lab.manager,lab:ctx.lab.manager.status(ctx.lab.project,ctx.lab.name).lab,specDigest}:undefined;
  const resolved=await currentDeliveryCandidate(ctx,repos,runtime);
  store.setCandidate(ctx.taskId,project,resolved.candidate);
  const evidence=resolved.check?.journey;
  if(evidence){
    const asserted=new Set(evidence.steps.filter(step=>step.passed&&(step.action==="assert"||step.action==="wait_for")).flatMap(step=>step.criterionIds));
    const persisted=new Set(evidence.steps.flatMap((step,index)=>step.passed&&step.action==="restart_service"?step.criterionIds.filter(id=>evidence.steps.slice(index+1).some(later=>later.passed&&(later.action==="assert"||later.action==="wait_for")&&later.criterionIds.includes(id))):[]));
    let artifact:string|undefined;
    for(const kind of ["journey","runtime","persistence"] as const){
      const id=`${kind}-${resolved.check?.id}-${specDigest}`;
      if(store.status(ctx.taskId,project)!.evidence.some(receipt=>receipt.id===id))continue;
      const observed=kind==="persistence"?persisted:asserted;
      const criterionIds=before.spec.criteria.filter(criterion=>criterion.requiredEvidence.includes(kind)&&observed.has(criterion.id)).map(criterion=>criterion.id);
      if(!criterionIds.length)continue;
      artifact??=ctx.artifacts.writeJson({taskId:ctx.taskId,kind:"check_log",label:"Revalidated isolated browser journey",value:resolved.check});
      store.recordEvidence(ctx.taskId,project,{schemaVersion:1,id,criterionIds,kind,specDigest,candidateDigest:productCandidateDigest(resolved.candidate),actor:{id:`runtime:${ctx.taskId}`,role:"runtime"},basis:"observed",outcome:"pass",startedAt:Math.max(0,resolved.check!.createdAt-Math.ceil(resolved.check!.durationMs)),completedAt:resolved.check!.createdAt,expiresAt:null,artifactRefs:[artifact],observations:evidence.steps.filter(step=>step.action==="assert"||step.action==="wait_for"||step.action==="restart_service").map(step=>`${step.id}: ${step.detail}`),unknowns:evidence.unknowns,subjectActorIds:[`supervisor:${ctx.spec.label??ctx.taskId}`]});
    }
  }
  return store.status(ctx.taskId,project);
}
