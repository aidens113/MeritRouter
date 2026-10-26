import { randomUUID } from "node:crypto";
import { z } from "zod";
import { immediate } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import { LeaseRefSchema,type LeaseRef } from "../storage/task-leases.js";
import { assertStoreRole } from "../storage/store-role.js";
import { readStoreIdentity,ProjectStoreIdentitySchema,type ProjectStoreIdentity } from "../projects/store-identity.js";
import { WebUsageInputSchema,WebUsageReceiptSchema,WebUsageOutcomeSchema,webUsageDigest,type WebUsageReservations,type WebUsageInput,type WebUsageOutcome } from "./usage-reservations.js";
import type { Db } from "../storage/db.js";
import { nextUtcMidnight } from "../providers/limits.js";

/**
 * The record of agents' web requests (`web_requests`): one row per attempt on a backend, grouped
 * by `call_id` (one web_search or web_fetch tool call; a call that fails over to the next backend
 * has several attempts). The first attempt of a call is reserved inside one write transaction that
 * checks the per-task and per-day budgets, which count tool calls, so they hold across processes
 * sharing the store. Per-backend caps count attempts. A refused call is never recorded (nothing
 * was sent).
 */

export type WebRequestKind = "search" | "fetch";
export type WebRequestStatus = "pending" | "ok" | "error";

export interface WebRequestRow {
  id: number;
  callId: string;
  taskId: string | null;
  projectId: string;
  sessionId: string | null;
  kind: WebRequestKind;
  /** The backend this attempt went to (`builtin` for MeritRouter's own fetch). */
  backend: string;
  /** The backend key used (`vault:3`, `env:TAVILY_API_KEY`, ...); null when keyless. */
  keyRef: string | null;
  /** The query or the URL. */
  target: string;
  status: WebRequestStatus;
  /** How a failed attempt failed (rate_limited, auth_invalid, out_of_credits, server, ...). */
  errorKind: string | null;
  results: number | null;
  bytes: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: number;
  call_id: string;
  task_id: string | null;
  project_id: string;
  session_id: string | null;
  kind: WebRequestKind;
  backend: string;
  key_ref: string | null;
  target: string;
  status: WebRequestStatus;
  error_kind: string | null;
  results: number | null;
  bytes: number | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const toRow = (r: Row): WebRequestRow => ({
  id: r.id,
  callId: r.call_id,
  taskId: r.task_id,
  projectId: r.project_id,
  sessionId: r.session_id,
  kind: r.kind,
  backend: r.backend,
  keyRef: r.key_ref,
  target: r.target,
  status: r.status,
  errorKind: r.error_kind,
  results: r.results,
  bytes: r.bytes,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface WebBudget {
  perTask: number;
  perDay: number;
}

export interface AttemptInput {
  callId: string;
  taskId: string | null;
  sessionId: string | null;
  kind: WebRequestKind;
  backend: string;
  keyRef: string | null;
  target: string;
  lease?:LeaseRef;
}

export type ReserveOutcome = { ok: true; id: number } | { ok: false; reason: string };

/** Start of the current UTC day. */
export function utcDayStart(now: number): number {
  return nextUtcMidnight(now) - 86_400_000;
}

/** Start of the current UTC month, and of the next one. */
export function utcMonth(now: number): { start: number; next: number } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), next: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

export interface ProjectWebLedgerOptions {identity:ProjectStoreIdentity;usage:WebUsageReservations;assertRuntime():void}
const PrivateOutcomeSchema=z.discriminatedUnion("ok",[z.object({ok:z.literal(true),results:z.number().int().nonnegative().optional(),bytes:z.number().int().nonnegative().optional()}).strict(),z.object({ok:z.literal(false),error:z.string().max(20000),errorKind:z.string().min(1).max(200)}).strict()]);
const InputSchema=z.object({callId:z.string().min(1).max(300),taskId:z.string().min(1).nullable(),sessionId:z.string().min(1).nullable(),kind:z.enum(["search","fetch"]),backend:z.string().min(1).max(300),keyRef:z.string().min(1).max(300).nullable(),target:z.string().min(1).max(2000),lease:LeaseRefSchema.optional()}).strict();
const ProtocolSchema=z.object({id:z.number().int(),project_id:z.string(),binding_json:z.string().max(20000),phase:z.enum(["prepared","bound","dispatch_intent","settled","uncertain"]),global_id:z.string(),global_receipt_json:z.string().nullable(),dispatch_id:z.string().nullable(),outcome_json:z.string().nullable(),outcome_digest:z.string().nullable(),created_at:z.number(),updated_at:z.number()}).strict();

export class WebLedger {
  private readonly issued=new Map<number,string>();
  private readonly live=new Map<number,{input:AttemptInput;global:WebUsageInput}>();
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly project?:ProjectWebLedgerOptions,
  ) {this.project=project?{...project,identity:Object.freeze(ProjectStoreIdentitySchema.parse(project.identity))}:undefined;const identity=readStoreIdentity(db);if(identity?.role==="coordination")throw new Error("Private web ledger cannot use coordination store");if(identity?.role==="project"&&!project)throw new Error("Project web ledger requires explicit coordination quota port");if(project){ProjectStoreIdentitySchema.parse(project.identity);this.owner();}}
  private owner():void{if(this.project){this.project.assertRuntime();assertStoreRole(this.db,this.project.identity);}}
  private authority(input:AttemptInput):void{
    this.owner();if(!this.project)return;const lease=LeaseRefSchema.parse(input.lease);
    if(input.taskId===null||input.taskId!==lease.taskId||lease.project!==this.project.identity.slug)throw new Error("Split web requires exact task lease and project");
    const row=this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=? AND lease_owner=? AND run_count=? AND lease_incarnation=? AND state='running' AND cancel_requested=0 AND lease_expires_at>? AND (deadline_at IS NULL OR deadline_at>?)").get(lease.taskId,lease.project,lease.owner,lease.runCount,lease.incarnation,this.now(),this.now());if(!row)throw new Error("Web caller lost original task authority");
    if(input.sessionId!==null&&!this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND task_id=? AND status='running'").get(input.sessionId,input.taskId))throw new Error("Web session does not belong to current local caller");
  }
  private protocol(id:number){this.owner();const raw=this.db.prepare("SELECT * FROM web_usage_protocol WHERE id=?").get(id);if(!raw)throw new Error("Unknown local web protocol");const row=ProtocolSchema.parse(raw),input=InputSchema.parse(JSON.parse(row.binding_json));if(!this.project||row.project_id!==this.project.identity.slug)throw new Error("Local web owner changed");const physical=z.object({call_id:z.string(),task_id:z.string().nullable(),session_id:z.string().nullable(),kind:z.string(),backend:z.string(),key_ref:z.string().nullable(),target:z.string(),project_id:z.string()}).strict().parse(this.db.prepare("SELECT call_id,task_id,session_id,kind,backend,key_ref,target,project_id FROM web_requests WHERE id=?").get(id));
    if(physical.call_id!==input.callId||physical.task_id!==input.taskId||physical.session_id!==input.sessionId||physical.kind!==input.kind||physical.backend!==input.backend||physical.key_ref!==input.keyRef||physical.target!==input.target||physical.project_id!==this.project.identity.slug)throw new Error("Private web evidence binding changed");
    const global=WebUsageInputSchema.parse({id:row.global_id,callId:input.callId,owner:{installationId:this.project.identity.installationId,projectId:this.project.identity.projectId,storeId:this.project.identity.storeId,generation:this.project.identity.generation},bindingDigest:webUsageDigest(input),backend:input.backend,keyRef:input.keyRef,kind:input.kind});if(row.global_receipt_json){const receipt=WebUsageReceiptSchema.parse(JSON.parse(row.global_receipt_json));if(canonicalJson(receipt.input)!==canonicalJson(global))throw new Error("Local/global web binding changed");}return {row,input,global};}
  private prepare(value:AttemptInput,budget?:WebBudget):number{
    const input=InputSchema.parse(value),options=this.project!;
    const id=immediate(this.db,()=>{this.authority(input);
      const old=this.db.prepare("SELECT p.id,p.binding_json FROM web_usage_protocol p JOIN web_requests w ON w.id=p.id WHERE w.call_id=? AND w.backend=? AND w.key_ref IS ?").get(input.callId,input.backend,input.keyRef) as {id:number;binding_json:string}|undefined;
      if(old){if(old.binding_json!==canonicalJson(input))throw new Error("Web call binding conflict");return old.id;}
      const siblings=this.db.prepare("SELECT p.binding_json FROM web_usage_protocol p JOIN web_requests w ON w.id=p.id WHERE w.call_id=?").all(input.callId) as Array<{binding_json:string}>;
      if(!budget&&!siblings.length)throw new Error("Further web attempt requires original local call admission");
      for(const sibling of siblings){const bound=InputSchema.parse(JSON.parse(sibling.binding_json));if(bound.taskId!==input.taskId||bound.sessionId!==input.sessionId||bound.target!==input.target||bound.kind!==input.kind||canonicalJson(bound.lease)!==canonicalJson(input.lease))throw new Error("Web fallback cannot change private caller binding");}
      if(budget&&!siblings.length&&this.taskCount(input.taskId!)>=budget.perTask)throw new Error("Task web request budget exhausted");
      const id=this.insert(input),now=this.now();this.db.prepare("INSERT INTO web_usage_protocol(id,project_id,binding_json,phase,global_id,created_at,updated_at) VALUES(?,?,?,'prepared',?,?,?)").run(id,options.identity.slug,canonicalJson(input),randomUUID(),now,now);return id;});
    const prepared=this.protocol(id);if(prepared.row.phase!=="prepared"&&prepared.row.phase!=="uncertain")return id;
    try{const result=options.usage.reserve(prepared.global);immediate(this.db,()=>{this.authority(input);const latest=this.protocol(id);if(latest.row.dispatch_id!==null)throw new Error("Web reservation already dispatched");this.db.prepare("UPDATE web_usage_protocol SET phase='bound',global_receipt_json=?,updated_at=? WHERE id=?").run(canonicalJson(result.receipt),this.now(),id);});return id;}
    catch(error){const global=options.usage.read(prepared.global.id);immediate(this.db,()=>{if(!global){this.db.prepare("DELETE FROM web_usage_protocol WHERE id=?").run(id);this.db.prepare("DELETE FROM web_requests WHERE id=?").run(id);}else this.db.prepare("UPDATE web_usage_protocol SET phase='uncertain',global_receipt_json=?,updated_at=? WHERE id=?").run(canonicalJson(global),this.now(),id);});throw error;}
  }
  beginDispatch(id:number,dispatchId:string):boolean{
    if(!this.project)return true;const record=this.protocol(id);let fresh=false;
    immediate(this.db,()=>{const current=this.protocol(id);this.authority(current.input);if(current.row.dispatch_id!==null)return;if(current.row.phase!=="bound")throw new Error("Web request is not durably bound");const global=this.project!.usage.begin(current.global,dispatchId);if(global.disposition!=="fresh")throw new Error("Replayed web intent cannot authorize transport");this.db.prepare("UPDATE web_usage_protocol SET phase='dispatch_intent',dispatch_id=?,global_receipt_json=?,updated_at=? WHERE id=?").run(dispatchId,canonicalJson(global.receipt),this.now(),id);fresh=true;});
    if(fresh){this.authority(record.input);this.issued.set(id,dispatchId);}return fresh;
  }
  assertDispatch(id:number,dispatchId:string):void{
    if(!this.project)return;const proof=this.issued.get(id);this.issued.delete(id);if(proof!==dispatchId)throw new Error("No fresh process-owned web transport authority");
    const record=this.protocol(id);this.authority(record.input);const receipt=this.project.usage.read(record.global.id);if(record.row.phase!=="dispatch_intent"||record.row.dispatch_id!==dispatchId||!receipt||receipt.state!=="dispatch_intent"||receipt.dispatchId!==dispatchId)throw new Error("Web dispatch ownership changed");this.live.set(id,{input:record.input,global:record.global});
  }
  private minimal(value:z.infer<typeof PrivateOutcomeSchema>):WebUsageOutcome{const errorCode=value.ok?"none":value.errorKind;const parsed=WebUsageOutcomeSchema.safeParse({ok:value.ok,errorCode,results:value.ok?value.results??null:null,bytes:value.ok?value.bytes??null:null});return parsed.success?parsed.data:{ok:false,errorCode:"error",results:null,bytes:null};}


  /** Web tool calls a task made (each counts once, however many backends it tried). */
  taskCount(taskId: string): number {
    this.owner();return (this.db.prepare("SELECT COUNT(DISTINCT call_id) AS n FROM web_requests WHERE task_id = ?").get(taskId) as { n: number }).n;
  }

  /** Web tool calls made install-wide since the start of the current UTC day. */
  dayCount(): number {
    this.owner();if(this.project)return this.project.usage.dayCount();return (this.db.prepare("SELECT COUNT(DISTINCT call_id) AS n FROM web_requests WHERE started_at >= ?").get(utcDayStart(this.now())) as { n: number }).n;
  }

  /** Attempts sent to one backend since `since` (every kind and outcome). */
  backendCount(backend: string, since: number): number {
    this.owner();if(this.project)return this.project.usage.backendCount(backend,since);return (this.db.prepare("SELECT COUNT(*) AS n FROM web_requests WHERE backend = ? AND started_at >= ?").get(backend, since) as { n: number }).n;
  }

  private insert(a: AttemptInput): number {
    return Number(
      this.db
        .prepare("INSERT INTO web_requests (call_id, task_id, session_id, kind, backend, key_ref, target, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(a.callId, a.taskId, a.sessionId, a.kind, a.backend, a.keyRef, a.target.slice(0, 2000), this.now()).lastInsertRowid,
    );
  }

  /**
   * The first attempt of a tool call: check both budgets and record it as pending, in one write
   * transaction so two processes cannot both take the last slot.
   */
  reserve(a: AttemptInput, budget: WebBudget): ReserveOutcome {
    if(this.project)return {ok:true,id:this.prepare(a,budget)};
    return this.db.transaction((): ReserveOutcome => {
      if (a.taskId !== null) {
        const used = this.taskCount(a.taskId);
        if (used >= budget.perTask) return { ok: false, reason: `this task's web request budget is used up (${used} of web.max_requests_per_task ${budget.perTask}); continue with what you have` };
      }
      const today = this.dayCount();
      if (today >= budget.perDay) return { ok: false, reason: `the install's daily web request budget is used up (${today} of web.max_requests_per_day ${budget.perDay}; resets at 00:00 UTC); continue with what you have` };
      return { ok: true, id: this.insert(a) };
    }).immediate();
  }

  /** A further attempt of a call already reserved (the next backend after a failure). */
  attempt(a: AttemptInput): number {
    if(this.project)return this.prepare(a);
    return this.insert(a);
  }

  settle(id: number, outcome: { ok: true; results?: number; bytes?: number } | { ok: false; error: string; errorKind: string }): void {
    if(this.project){
      const validated=PrivateOutcomeSchema.parse(outcome),live=this.live.get(id);
      // A live response must preserve minimal global usage even if the project volume closed.
      if(live)this.project.usage.settle(live.global,this.minimal(validated));
      let record=this.protocol(id);if(!live&&record.row.outcome_json===null)throw new Error("Web outcome lacks live transport or durable captured evidence");
      immediate(this.db,()=>{record=this.protocol(id);const digest=webUsageDigest(validated);if(record.row.outcome_digest!==null&&record.row.outcome_digest!==digest)throw new Error("Conflicting private web outcome");this.db.prepare("UPDATE web_usage_protocol SET outcome_json=?,outcome_digest=?,updated_at=? WHERE id=?").run(canonicalJson(validated),digest,this.now(),id);});
      const receipt=this.project.usage.settle(record.global,this.minimal(validated));
      immediate(this.db,()=>{if(validated.ok)this.db.prepare("UPDATE web_requests SET status='ok',results=?,bytes=?,finished_at=? WHERE id=?").run(validated.results??null,validated.bytes??null,this.now(),id);else this.db.prepare("UPDATE web_requests SET status='error',error=?,error_kind=?,finished_at=? WHERE id=?").run(validated.error.slice(0,500),validated.errorKind,this.now(),id);this.db.prepare("UPDATE web_usage_protocol SET phase='settled',global_receipt_json=?,updated_at=? WHERE id=?").run(canonicalJson(receipt),this.now(),id);});this.live.delete(id);return;
    }
    if (outcome.ok) this.db.prepare("UPDATE web_requests SET status = 'ok', results = ?, bytes = ?, finished_at = ? WHERE id = ?").run(outcome.results ?? null, outcome.bytes ?? null, this.now(), id);
    else this.db.prepare("UPDATE web_requests SET status = 'error', error = ?, error_kind = ?, finished_at = ? WHERE id = ?").run(outcome.error.slice(0, 500), outcome.errorKind, this.now(), id);
  }

  recover(id:number):void{
    if(!this.project)return;const record=this.protocol(id);
    if(record.row.outcome_json!==null){this.settle(id,PrivateOutcomeSchema.parse(JSON.parse(record.row.outcome_json)));return;}
    const receipt=this.project.usage.read(record.global.id);if(!receipt)return;
    if(canonicalJson(receipt.input)!==canonicalJson(record.global))throw new Error("Recovered global web binding changed");
    if(receipt.state==="settled"&&receipt.outcome){const value=receipt.outcome;immediate(this.db,()=>{this.protocol(id);this.db.prepare("UPDATE web_requests SET status=?,results=?,bytes=?,error_kind=?,error=?,finished_at=? WHERE id=?").run(value.ok?"ok":"error",value.results,value.bytes,value.ok?null:value.errorCode,value.ok?null:"Private response unavailable; recovered accounting code only",this.now(),id);this.db.prepare("UPDATE web_usage_protocol SET phase='settled',global_receipt_json=?,updated_at=? WHERE id=?").run(canonicalJson(receipt),this.now(),id);});return;}
    if(receipt.state==="dispatch_intent")immediate(this.db,()=>this.db.prepare("UPDATE web_usage_protocol SET phase='uncertain',global_receipt_json=?,updated_at=? WHERE id=?").run(canonicalJson(receipt),this.now(),id));
  }

  /** A task's attempts, oldest first. */
  forTask(taskId: string): WebRequestRow[] {
    this.owner();return (this.db.prepare("SELECT * FROM web_requests WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(toRow);
  }

  /** The latest attempts install-wide (optionally one project's), newest first. */
  recent(limit = 50, project?: string): WebRequestRow[] {
    this.owner();if(this.project&&project!==undefined&&project!==this.project.identity.slug)throw new Error("Web evidence project scope mismatch");
    const rows = project === undefined ? this.db.prepare("SELECT * FROM web_requests ORDER BY id DESC LIMIT ?").all(limit) : this.db.prepare("SELECT * FROM web_requests WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(project, limit);
    return (rows as Row[]).map(toRow);
  }
}
