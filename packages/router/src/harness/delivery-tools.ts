import { z } from "zod";
import { createHash } from "node:crypto";
import type { HarnessTool } from "./tools.js";
import { ProductDeliveries, DeliveryStageSchema } from "../verification/product-delivery.js";
import { DeliverySpecSchema, deliverySpecDigest } from "../verification/product-spec.js";
import { productCandidateDigest } from "../verification/product-evidence.js";
import { executeSupervisorCommand } from "./worker-actions.js";
import { minimalEnv } from "../runners/coding/process.js";
import { dirtyPaths } from "../workspaces/git.js";
import { synchronizeDeliveryCandidate } from "../verification/product-runtime.js";

/** Coordination tools accept specifications and stages, never model-authored observed receipts. */
export function deliveryTools(repositories:Iterable<{alias:string;worktree:string}>):HarnessTool[] {
  const repos=[...repositories];
  const make=(name:string,description:string,schema:z.ZodType,run:HarnessTool["run"],sideEffect:HarnessTool["sideEffect"]):HarnessTool=>({
    def:{type:"function",function:{name,description,parameters:z.toJSONSchema(schema) as Record<string,unknown>}},sideEffect,run,
  });
  // The runtime owns the authoritative task goal; models need not echo or hash it.
  // Only tool input is optional. The stored specification remains fully strict.
  const specInput=z.object({...DeliverySpecSchema.shape,
    source:DeliverySpecSchema.shape.source.optional().describe("Optional authored source reference and SHA256 digest. Omit to bind the task goal automatically; do not invent a hash."),
    originalInstruction:DeliverySpecSchema.shape.originalInstruction.optional().describe("Optional exact original task goal. Omit to use the authoritative task goal; supplied replacements are rejected."),
  }).strict();
  const args=z.object({spec:specInput,expectedDigest:z.string().optional()}).strict();
  return [
    make("set_delivery_spec","Write a versioned observable delivery specification before implementation. Omit originalInstruction and source: runtime binds the exact task goal and its SHA256 source automatically. Supplied fields retain strict validation and cannot replace the original goal. Existing specs require expectedDigest and next revision; changes invalidate candidate evidence.",args,async(raw,env)=>{
      const a=args.parse(raw),store=new ProductDeliveries(env.ctx.tasks.db),project=(env.ctx.tasks.projectOf(env.ctx.taskId) ?? env.ctx.cfg.brain.project);
      const bound=DeliverySpecSchema.parse({...a.spec,originalInstruction:a.spec.originalInstruction??env.ctx.spec.goal,source:a.spec.source??{ref:`task:${env.ctx.taskId}:goal`,digest:createHash("sha256").update(env.ctx.spec.goal,"utf8").digest("hex")}});
      const spec=store.saveSpec(env.ctx.taskId,project,bound,a.expectedDigest);
      env.ctx.tasks.event(env.ctx.taskId,"delivery_spec_written",{digest:deliverySpecDigest(spec),revision:spec.revision});
      return JSON.stringify({specDigest:deliverySpecDigest(spec),stage:"specify"});
    },"edit"),
    make("delivery_status","Read current specification, stage, candidate and evidence blockers. Readiness is not FINAL acceptance.",z.object({}).strict(),async(_,env)=>JSON.stringify(new ProductDeliveries(env.ctx.tasks.db).status(env.ctx.taskId,(env.ctx.tasks.projectOf(env.ctx.taskId) ?? env.ctx.cfg.brain.project))),"read"),
    make("validate_delivery","Run the declared integrated job checks and record actual structural evidence for the current clean candidate. Does not manufacture runtime/journey/visual review.",z.object({}).strict(),async(_,env)=>{
      const ctx=env.ctx,store=new ProductDeliveries(ctx.tasks.db),project=(ctx.tasks.projectOf(ctx.taskId) ?? ctx.cfg.brain.project);
      const before=store.status(ctx.taskId,project);
      if(!before||!["integrate","validate"].includes(before.stage))throw new Error("Set specification and complete prepare/plan/implement/integrate stages before integrated validation");
      if(!repos.length)throw new Error("Integration repositories are missing");
      const resolved=await synchronizeDeliveryCandidate(ctx,repos);
      if(!ctx.spec.constraints.checks?.length){
        if(!ctx.lab)throw new Error("Integrated check recipes are missing");
        return JSON.stringify(resolved);
      }
      const startedAt=Date.now(),logs:string[]=[],observations:string[]=[];let passed=true;
      const candidate=resolved!.candidate!;
      for(const [index,command] of ctx.spec.constraints.checks.entries()){
        const result=await executeSupervisorCommand(ctx,{command,cwd:repos[0]!.worktree,invocationId:`delivery_validation:${env.toolInvocationId??startedAt}:${index}`,env:minimalEnv({CI:"1"}),timeoutMs:ctx.cfg.execution.check_timeout_seconds*1000,reason:"Integrated delivery structural validation"});
        passed=passed&&!result.killed&&result.exitCode===0;
        logs.push(ctx.artifacts.write({taskId:ctx.taskId,kind:"check_log",label:command,content:`$ ${command}\nexit ${result.exitCode}\n${result.stdout}\n${result.stderr}`,extension:".log"}));
        observations.push(`${command}: ${result.killed?"terminated":`exit ${result.exitCode}`}`);
      }
      const current=(await synchronizeDeliveryCandidate(ctx,repos))!.candidate!;
      if(productCandidateDigest(current)!==productCandidateDigest(candidate)||(await Promise.all(repos.map(repo=>dirtyPaths(repo.worktree)))).some(paths=>paths.length))throw new Error("Candidate changed during checks; commit/repair and validate the exact candidate again");
      const ids=before.spec.criteria.filter(c=>c.requiredEvidence.includes("structural")).map(c=>c.id);
      if(ids.length)store.recordEvidence(ctx.taskId,project,{schemaVersion:1,id:`validation-${env.toolInvocationId??startedAt}`,criterionIds:ids,kind:"structural",specDigest:deliverySpecDigest(before.spec),candidateDigest:productCandidateDigest(candidate),actor:{id:`runtime:${ctx.taskId}`,role:"runtime"},basis:"observed",outcome:passed?"pass":"fail",startedAt,completedAt:Date.now(),expiresAt:null,artifactRefs:logs,observations,unknowns:[],subjectActorIds:[`supervisor:${ctx.spec.label??ctx.taskId}`]});
      return JSON.stringify(store.status(ctx.taskId,project));
    },"command"),
    make("advance_delivery_stage","Advance one stage after its work is complete, or return to an earlier stage for repair. Handoff requires current observed evidence.",z.object({stage:DeliveryStageSchema}).strict(),async(raw,env)=>{
      const {stage}=z.object({stage:DeliveryStageSchema}).strict().parse(raw);
      new ProductDeliveries(env.ctx.tasks.db).transition(env.ctx.taskId,(env.ctx.tasks.projectOf(env.ctx.taskId) ?? env.ctx.cfg.brain.project),stage);
      env.ctx.tasks.event(env.ctx.taskId,"delivery_stage_changed",{stage});return JSON.stringify({stage});
    },"edit"),
  ];
}
