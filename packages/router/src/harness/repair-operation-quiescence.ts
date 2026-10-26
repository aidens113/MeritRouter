import { z } from "zod";
import { createHash } from "node:crypto";
import type { RunContext } from "../runners/types.js";
import type { StoredTask } from "../storage/tasks.js";
import type { SessionRecord } from "../sessions/store.js";
import type { SessionEvent } from "../sessions/events.js";
import { OperationResultSchema } from "./operation-contract.js";
import { LeaseRefSchema } from "../storage/task-leases.js";

const recipeArgs=z.object({id:z.string().regex(/^check:[1-9]\d*$/),timeout_ms:z.number().int().min(1).max(300000).optional()}).strict();
const groupArgs=z.object({ids:z.array(z.string().regex(/^check:[1-9]\d*$/)).min(1).max(64).optional(),stop_on_failure:z.boolean().optional(),timeout_ms:z.number().int().min(1).max(300000).optional()}).strict();
const operationNote=z.object({kind:z.literal("harness_v2_operation"),taskId:z.string(),operationId:z.string(),sideEffect:z.literal("command"),result:OperationResultSchema.optional()}).strict();
const broker=z.object({id:z.string(),project:z.string(),taskId:z.string(),status:z.enum(["completed","uncertain"]),createdAt:z.number().int(),executionStartedAt:z.number().int(),executionTimeoutMs:z.number().int().positive(),quiescedAt:z.number().int(),action:z.object({command:z.string(),cwd:z.string(),invocationId:z.string(),timeoutMs:z.number().int().positive(),source:z.string().regex(/^[a-f0-9]{64}$/),lease:LeaseRefSchema,jobId:z.string(),operation:z.unknown().optional()}).passthrough()}).passthrough();

/** Eligibility only: reconcile one missing nested recipe outcome from exact host quiescence proof.
 * The unknown command result remains unknown; this neither repairs the journal nor permits replay.
 */
export function quiescentRecipeSource(ctx:RunContext,source:StoredTask,author:SessionRecord,events:SessionEvent[],pending:Extract<SessionEvent,{type:"tool_intent"}>,workspace:{path:string;alias:string},sourceHash:string):boolean{
 try {
  if(source.row.state!=="completed" || author.status!=="completed" || author.taskId!==source.row.id || author.endedAt===null || pending.data.name!=="run_recipe" || pending.data.sideEffect!=="command")return false;
  const session=z.object({task_id:z.string(),project_id:z.string(),status:z.literal("completed")}).parse(ctx.tasks.db.prepare("SELECT task_id,project_id,status FROM sessions WHERE id=?").get(author.id));
  if(session.task_id!==source.row.id || session.project_id!==source.row.project_id)return false;
  if(events.filter(e=>e.type==="tool_intent"&&e.data.callId===pending.data.callId).length!==1||events.some(e=>e.type==="tool_outcome"&&e.data.callId===pending.data.callId))return false;
  const child=recipeArgs.parse(pending.data.args),prefix=`${author.id}:`,separator=pending.data.callId.lastIndexOf(":recipe:");
  if(!pending.data.callId.startsWith(prefix)||separator<=prefix.length)return false;
  const indexText=pending.data.callId.slice(separator+8);
  if(!/^(0|[1-9]\d*)$/.test(indexText))return false;
  const index=Number(indexText),operationId=pending.data.callId.slice(0,separator),outerId=operationId.slice(prefix.length);
  const parents=events.filter((e):e is Extract<SessionEvent,{type:"tool_intent"}>=>e.type==="tool_intent"&&e.data.callId===outerId);
  if(parents.length!==1)return false;
  const parent=parents[0]!;
  if(parent.seq>=pending.seq||parent.data.name!=="run_checks"||parent.data.sideEffect!=="command")return false;
  const args=groupArgs.parse(parent.data.args),checks=source.spec.constraints.checks ?? [],ids=args.ids ?? checks.map((_,i)=>`check:${i+1}`);
  if(index>=ids.length||ids[index]!==child.id||child.timeout_ms!==args.timeout_ms)return false;
  const command=checks[Number(child.id.slice(6))-1];if(!command)return false;
  const notes:Array<{event:Extract<SessionEvent,{type:"note"}>;value:z.infer<typeof operationNote>}>=[];
  for(const event of events){
    if(event.type!=="note")continue;
    const raw=z.object({operationId:z.string()}).passthrough().safeParse(event.data.data);
    if(!raw.success||raw.data.operationId!==operationId)continue;
    const value=operationNote.safeParse(event.data.data);
    if(!value.success||value.data.taskId!==source.row.id)return false;
    notes.push({event,value:value.data});
  }
  const starts=notes.filter(n=>n.value.result===undefined),settled=notes.filter(n=>n.value.result!==undefined);
  if(starts.length!==1||settled.length!==1)return false;
  const start=starts[0]!.event,end=settled[0]!.event,result=settled[0]!.value.result!;
  if(start.seq<=parent.seq||start.seq>=pending.seq||end.seq<=pending.seq||result.status!=="unknown_effect"||result.operationId!==operationId||
      result.workspace?.alias!==workspace.alias||result.workspace.mode!=="worktree"||result.workspace.revision!==null)return false;
  const outcomes=events.filter((e):e is Extract<SessionEvent,{type:"tool_outcome"}>=>e.type==="tool_outcome"&&e.data.callId===outerId);
  if(outcomes.length!==1)return false;
  const outcome=outcomes[0]!;
  if(outcome.seq<=end.seq||outcome.data.intentSeq!==parent.seq||outcome.data.name!=="run_checks"||outcome.data.ok||outcome.data.truncated)return false;
  const outer=OperationResultSchema.parse(JSON.parse(outcome.data.output));
  if(JSON.stringify(outer)!==JSON.stringify(result))return false;
  const ended=events.filter(e=>e.type==="ended");
  if(ended.length!==1||ended[0]!.seq<=outcome.seq||ended[0]!.data.status!=="completed")return false;
  const rows=ctx.tasks.db.prepare("SELECT id,project_id,task_id,request_key,value_json FROM worker_action_requests WHERE task_id=? AND json_extract(value_json,'$.action.invocationId')=? LIMIT 2").all(source.row.id,pending.data.callId) as Array<{id:string;project_id:string;task_id:string;request_key:string;value_json:string}>;
  if(rows.length!==1)return false;
  const row=rows[0]!,raw=JSON.parse(row.value_json),action=broker.parse(raw),lease=action.action.lease;
  if(row.id!==action.id||row.task_id!==action.taskId||row.project_id!==action.project||action.taskId!==source.row.id||action.project!==source.row.project_id||
      action.action.invocationId!==pending.data.callId||action.action.cwd!==workspace.path||action.action.command!==command||action.action.operation!==undefined||action.action.jobId!==source.spec.parentTaskId||
      lease.taskId!==source.row.id||lease.project!==source.row.project_id||lease.runCount!==source.row.run_count||lease.incarnation!==source.row.lease_incarnation||action.action.source!==sourceHash)return false;
  if(createHash("sha256").update(JSON.stringify({...raw.action,reason:undefined})).digest("hex")!==row.request_key)return false;
  if(action.action.timeoutMs!==Math.min(child.timeout_ms??30000,ctx.cfg.execution.check_timeout_seconds*1000)||action.executionTimeoutMs>action.action.timeoutMs||
      action.createdAt<pending.at||action.executionStartedAt<action.createdAt||action.quiescedAt<action.executionStartedAt||action.quiescedAt>end.at||end.at>author.endedAt)return false;
  return true;
 } catch { return false; }
}
