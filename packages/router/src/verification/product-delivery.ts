import { z } from "zod";
import type { Db } from "../storage/db.js";
import { DeliverySpecSchema, deliverySpecDigest, type DeliverySpec } from "./product-spec.js";
import { EvidenceReceiptSchema, ProductCandidateSchema, ProductFinalDecisionSchema, productCandidateDigest, type EvidenceReceipt, type ProductCandidate, type ProductFinalDecision } from "./product-evidence.js";
import { evaluateProductReadiness } from "./product-readiness.js";

export const DELIVERY_STAGES = ["discover","specify","prepare","plan","implement","integrate","validate","handoff"] as const;
export const DeliveryStageSchema = z.enum(DELIVERY_STAGES);
export type DeliveryStage = z.infer<typeof DeliveryStageSchema>;
interface Row {task_id:string;project_id:string;stage:string;spec_json:string;candidate_json:string|null;evidence_json:string;final_decision_json:string|null;updated_at:number}

/** Service-owned store. Model output is never a trusted evidence receipt. */
export class ProductDeliveries {
  constructor(private readonly db: Db, private readonly now:()=>number=Date.now) {}
  private row(taskId:string,project:string):Row|null {
    return this.db.prepare("SELECT * FROM product_deliveries WHERE task_id=? AND project_id=?").get(taskId,project) as Row|undefined ?? null;
  }
  private require(taskId:string,project:string):Row {
    const row=this.row(taskId,project); if(!row) throw new Error(`No delivery specification for ${taskId} in project ${project}`); return row;
  }
  saveSpec(taskId:string,project:string,input:unknown,expectedDigest?:string):DeliverySpec {
    const spec=DeliverySpecSchema.parse(input);
    const task=this.db.prepare("SELECT project_id,profile FROM tasks WHERE id=?").get(taskId) as {project_id:string;profile:string}|undefined;
    if(!task||task.project_id!==project||task.profile!=="supervise") throw new Error("Delivery specification requires an owned supervisor task");
    this.db.transaction(()=>{
      const old=this.row(taskId,project);
      if(old){
        const previous=DeliverySpecSchema.parse(JSON.parse(old.spec_json));
        if(expectedDigest!==deliverySpecDigest(previous)) throw new Error("delivery_spec_conflict: read the current specification and provide its digest");
        if(spec.id!==previous.id||spec.revision!==previous.revision+1) throw new Error("Spec changes retain ID and increment revision by one");
      }
      this.db.prepare("INSERT INTO product_deliveries(task_id,project_id,stage,spec_json,updated_at) VALUES(?,?,'specify',?,?) ON CONFLICT(task_id) DO UPDATE SET stage='specify',spec_json=excluded.spec_json,candidate_json=NULL,evidence_json='[]',final_decision_json=NULL,updated_at=excluded.updated_at").run(taskId,project,JSON.stringify(spec),this.now());
    }).immediate();
    return spec;
  }
  transition(taskId:string,project:string,input:unknown):void {
    const stage=DeliveryStageSchema.parse(input),row=this.require(taskId,project);
    const from=DELIVERY_STAGES.indexOf(DeliveryStageSchema.parse(row.stage)),to=DELIVERY_STAGES.indexOf(stage);
    if(to>from+1) throw new Error(`Cannot skip delivery stage ${DELIVERY_STAGES[from+1]}`);
    if(stage==="handoff" && this.status(taskId,project)?.readiness?.status!=="ready_for_final_review") throw new Error("Delivery handoff requires complete current observed criterion evidence");
    this.db.prepare("UPDATE product_deliveries SET stage=?,updated_at=? WHERE task_id=? AND project_id=?").run(stage,this.now(),taskId,project);
  }
  /** Called by the runtime only after resolving actual integration heads and environment. */
  setCandidate(taskId:string,project:string,input:unknown):void {
    const candidate=ProductCandidateSchema.parse(input),old=this.require(taskId,project);
    const changed=old.candidate_json===null||productCandidateDigest(JSON.parse(old.candidate_json))!==productCandidateDigest(candidate);
    this.db.prepare("UPDATE product_deliveries SET candidate_json=?, final_decision_json=CASE WHEN ? THEN NULL ELSE final_decision_json END,updated_at=? WHERE task_id=? AND project_id=?").run(JSON.stringify(candidate),changed?1:0,this.now(),taskId,project);
  }
  /** Callers supply authenticated runtime/reviewer receipts, never raw model claims. */
  recordEvidence(taskId:string,project:string,input:unknown):void {
    const receipt=EvidenceReceiptSchema.parse(input);
    this.db.transaction(()=>{
      const row=this.require(taskId,project),spec=DeliverySpecSchema.parse(JSON.parse(row.spec_json));
      if(!row.candidate_json||receipt.specDigest!==deliverySpecDigest(spec)||receipt.candidateDigest!==productCandidateDigest(JSON.parse(row.candidate_json))) throw new Error("Evidence does not match current delivery specification/candidate");
      const receipts=z.array(EvidenceReceiptSchema).max(9999).parse(JSON.parse(row.evidence_json));
      if(receipts.some(r=>r.id===receipt.id)) throw new Error("Duplicate delivery evidence ID");
      this.db.prepare("UPDATE product_deliveries SET evidence_json=?,updated_at=? WHERE task_id=? AND project_id=?").run(JSON.stringify([...receipts,receipt]),this.now(),taskId,project);
    }).immediate();
  }
  finalDecision(taskId:string,project:string,input:unknown):void {
    const decision=ProductFinalDecisionSchema.parse(input),status=this.status(taskId,project);
    if(!status?.candidate||decision.specDigest!==deliverySpecDigest(status.spec)||decision.candidateDigest!==productCandidateDigest(status.candidate)) throw new Error("FINAL decision does not match current delivery");
    if(decision.decision==="accept"&&status.readiness?.status!=="ready_for_final_review") throw new Error("Cannot accept delivery with unresolved evidence");
    this.db.prepare("UPDATE product_deliveries SET final_decision_json=?,stage=CASE WHEN ?='reject' THEN 'validate' ELSE stage END,updated_at=? WHERE task_id=? AND project_id=?").run(JSON.stringify(decision),decision.decision,this.now(),taskId,project);
  }
  status(taskId:string,project:string):{spec:DeliverySpec;stage:DeliveryStage;candidate:ProductCandidate|null;evidence:EvidenceReceipt[];finalDecision:ProductFinalDecision|null;readiness:ReturnType<typeof evaluateProductReadiness>|null}|null {
    const row=this.row(taskId,project);if(!row)return null;
    const spec=DeliverySpecSchema.parse(JSON.parse(row.spec_json));
    const candidate=row.candidate_json?ProductCandidateSchema.parse(JSON.parse(row.candidate_json)):null;
    const evidence=z.array(EvidenceReceiptSchema).max(10000).parse(JSON.parse(row.evidence_json));
    return {spec,stage:DeliveryStageSchema.parse(row.stage),candidate,evidence,finalDecision:row.final_decision_json?ProductFinalDecisionSchema.parse(JSON.parse(row.final_decision_json)):null,readiness:candidate?evaluateProductReadiness({spec,candidate,evidence,now:this.now()}):null};
  }
}
