import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ActorSchema, type Actor } from "../attribution/actor.js";
import { verifyRecoveredEditAttestation } from "../attribution/recovered-edit-provenance.js";
import { RepairSourceSchema, type RepairSource } from "../core/task.js";
import type { RunContext } from "../runners/types.js";
import { canonicalJson } from "../storage/tasks.js";
import { git } from "./git.js";
import { projectRuntimeActivationRoots } from "./worktree.js";

const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digestValue=z.string().regex(/^[a-f0-9]{64}$/),taskIdValue=z.string().min(1).max(200);
export const RepairCopyCreatedSchema=z.object({version:z.literal(1),sourceDigest:digestValue,sourceTaskId:taskIdValue,sourceCommit:objectId,targetParent:objectId,targetCommit:objectId,targetTree:objectId,originTaskId:taskIdValue,originCommit:objectId,originProofDigest:digestValue,actor:ActorSchema}).strict();
export const RepairHydrationReceiptSchema = z.object({ status: z.enum(["started", "completed", "failed"]), digest: z.string().regex(/^[a-f0-9]{64}$/), worktree: z.string(), base: objectId, head: objectId.optional(), tree: objectId.optional() }).strict().superRefine((v,c)=>{if(v.status==="completed"&&(!v.head||!v.tree))c.addIssue({code:"custom",message:"completed hydration requires head/tree"});});
export const repairSourceDigest = (source: RepairSource) => createHash("sha256").update(JSON.stringify(source)).digest("hex");
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function refuse(reason: string): never { throw new Error(`repair_copy_provenance_refused: ${reason}`); }
export interface RepairLineageState { active: Set<string>; visits: number }
export const newRepairLineageState = (): RepairLineageState => ({ active: new Set(), visits: 0 });
export interface RepairCopyOrigin { actor: Actor; originalTaskId: string; originalCommit: string; proofDigest: string }
interface CopyProofState { active: Set<string>; deltaBytes: number }

function singleOrigin(proof: Awaited<ReturnType<typeof verifyRecoveredEditAttestation>>): RepairCopyOrigin {
  const first = proof.files[0]?.origin;
  if (!first || proof.files.some(file => [file.origin.agent,file.origin.role,file.origin.endpointId,file.origin.requestId,file.origin.job,file.origin.tier].some((value,index)=>value!==[first.agent,first.role,first.endpointId,first.requestId,first.job,first.tier][index]))) refuse("recovered commit has mixed original actors or requests");
  return { actor: { agent: first.agent, role: first.role, model: first.endpointId, request: first.requestId, task: proof.taskId, job: first.job, tier: first.tier }, originalTaskId: proof.taskId, originalCommit: proof.commit, proofDigest: hash(proof) };
}

function assertCopiedActor(message: string, actor: Actor) {
  for (const [key, expected] of [["Agent",actor.agent],["Role",actor.role],["Task",actor.task],["Job",actor.job],["Tier",actor.tier],["Model",actor.model],["Request",actor.request]] as const) {
    const values=message.split(/\r?\n/).filter(line=>line.startsWith(`${key}: `)).map(line=>line.slice(key.length+2));
    if ((key==="Model"||key==="Request")&&!values.length) continue;
    if (expected ? values.length!==1||values[0]!==expected : values.length!==0) refuse("copied actor differs from the verified original");
  }
}

/** Called only after the owning source passes resolveRepairSource's full eligibility checks. */
export async function verifyRepairCommitOrigin(ctx: RunContext, input: { taskId: string; alias: string; commit: string; worktree: string; base: string; head: string }, resolveAncestor: (id: string) => Promise<RepairSource>, proofState:CopyProofState={active:new Set(),deltaBytes:0}): Promise<RepairCopyOrigin> {
 const key=`${input.taskId}:${input.commit}`;
 if(proofState.active.has(key)||proofState.active.size>=16)refuse("copy lineage is cyclic or exceeds its depth bound");
 proofState.active.add(key);
 try{return await verifyRepairCommitOriginInternal(ctx,input,resolveAncestor,proofState);}finally{proofState.active.delete(key);}
}

async function verifyRepairCommitOriginInternal(ctx:RunContext,input:{taskId:string;alias:string;commit:string;worktree:string;base:string;head:string},resolveAncestor:(id:string)=>Promise<RepairSource>,proofState:CopyProofState):Promise<RepairCopyOrigin>{
  const task=ctx.tasks.get(input.taskId);
  if(!task || task.row.project_id!==ctx.tasks.projectOf(ctx.taskId))refuse("foreign source task");
  const descriptor=task.spec.context.repairSource;
  if(!descriptor) return singleOrigin(await verifyRecoveredEditAttestation({tasks:ctx.tasks,cfg:ctx.cfg,now:ctx.now},{project:task.row.project_id,taskId:input.taskId,alias:input.alias,commit:input.commit}));
  const source=RepairSourceSchema.parse(descriptor);
  if(source.project!==task.row.project_id||source.alias!==input.alias)refuse("foreign inherited descriptor");
  const root=await realpath(projectRuntimeActivationRoots(ctx.cfg).worktrees),physical=await realpath(input.worktree),relative=path.relative(root,physical);
  if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))refuse("copy worktree is outside its owning runtime");
  const common=async(cwd:string)=>realpath(path.resolve(cwd,(await git(cwd,["rev-parse","--git-common-dir"])).trim()));
  const configured=ctx.cfg.repositoryPaths[input.alias]?.path;
  const ownerKey=(value:string)=>process.platform==="win32"?value.toLowerCase():value;
  if(!configured||ownerKey(await common(input.worktree))!==ownerKey(await common(configured)))refuse("copy Git owner differs from configured repository");
  const rows=ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type='repair_hydration' ORDER BY id").all(input.taskId) as {data_json:string}[];
  const receipts=rows.map(row=>RepairHydrationReceiptSchema.parse(JSON.parse(row.data_json)));
  if(receipts.length!==2||receipts[0]!.status!=="started"||receipts[1]!.status!=="completed")refuse("copy has no unique completed hydration prefix");
  const receipt=receipts[1]!;
  if(receipts.some(value=>value.digest!==repairSourceDigest(source)||value.worktree!==input.worktree||value.base!==input.base))refuse("copy receipt or inherited descriptor changed");
  const opts={signal:ctx.signal,timeoutMs:30000,maxBuffer:8*1024*1024};
  await git(input.worktree,["merge-base","--is-ancestor",receipt.head!,input.head],opts);
  if((await git(input.worktree,["rev-parse",`${receipt.head}^{tree}`],opts)).trim()!==receipt.tree)refuse("copy hydration tree changed");
  const range=(await git(input.worktree,["rev-list","--parents","--reverse",`${receipt.base}..${receipt.head}`],opts)).trim().split(/\r?\n/).filter(Boolean).map(line=>line.split(" "));
  if(range.length!==source.commits.length)refuse("copy count differs from the original descriptor");
  let previous=receipt.base;
  for(const entry of range){if(entry.length!==2||entry[1]!==previous)refuse("copy prefix is not exactly linear");previous=entry[0]!;}
  if(previous!==receipt.head)refuse("copy prefix head differs");
  const index=range.findIndex(entry=>entry[0]===input.commit);
  if(index<0) return singleOrigin(await verifyRecoveredEditAttestation({tasks:ctx.tasks,cfg:ctx.cfg,now:ctx.now},{project:task.row.project_id,taskId:input.taskId,alias:input.alias,commit:input.commit}));
  const resolved=await resolveAncestor(source.taskId);
  if(JSON.stringify(resolved)!==JSON.stringify(source))refuse("original source descriptor changed");
  const sourceCommit=source.commits[index]!, message=await git(input.worktree,["show","-s","--format=%B",input.commit],opts);
  const footers=[...message.matchAll(/^\(cherry picked from commit ([a-f0-9]{40,64})\)\r?$/gm)].map(match=>match[1]);
  if(footers.at(-1)!==sourceCommit||footers.filter(value=>value===sourceCommit).length!==1)refuse("copy has no unambiguous immediate source footer");
  const sourceDelta=await git(input.worktree,["diff-tree","--no-commit-id","--raw","--no-abbrev","--no-renames","-r","-z",sourceCommit],opts);
  const targetDelta=await git(input.worktree,["diff-tree","--no-commit-id","--raw","--no-abbrev","--no-renames","-r","-z",input.commit],opts);
  proofState.deltaBytes+=Buffer.byteLength(sourceDelta)+Buffer.byteLength(targetDelta);
  if(proofState.deltaBytes>8*1024*1024)refuse("copy lineage exceeds its cumulative delta byte bound");
  if(sourceDelta!==targetDelta)refuse("copy delta bytes, modes or paths differ from its original");
  const ancestorTask=ctx.tasks.get(source.taskId)!,ws=z.object({worktree_path:z.string(),base_sha:objectId}).parse(ctx.tasks.db.prepare("SELECT worktree_path,base_sha FROM workspaces WHERE task_id=?").get(source.taskId));
  const origin=await verifyRepairCommitOrigin(ctx,{taskId:source.taskId,alias:source.alias,commit:sourceCommit,worktree:ws.worktree_path,base:ws.base_sha,head:source.head},resolveAncestor,proofState);
  if(ancestorTask.row.project_id!==task.row.project_id)refuse("copy ancestor belongs to another project");
  assertCopiedActor(message,origin.actor);
  return {...origin,proofDigest:hash({version:1,taskId:input.taskId,commit:input.commit,source,receipt,sourceCommit,delta:hash(sourceDelta),origin:origin.proofDigest})};
}
