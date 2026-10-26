import picomatch from "picomatch";
import { z } from "zod";
import type { RunContext } from "../runners/types.js";
import { git } from "../workspaces/git.js";
import { repoKey } from "../projects/context.js";
import { narrowedScope } from "./task-scope.js";

const paths = z.array(z.string().min(1)).min(1);
const terminal = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const patchMetadata = z.object({ id: z.string().min(1), task_id: z.string().min(1), kind: z.literal("patch") });

const integrationHead=z.object({after_head:z.string().regex(/^[a-f0-9]{40,64}$/)}).strict();
type IntegrationTarget={branch:string;worktree:string};

/** Receipt identity plus current branch ancestry proves ordinary follow-up need not replay source. */
async function alreadyIntegrated(ctx:RunContext,taskId:string,alias:string,project:string,repo:IntegrationTarget|undefined):Promise<boolean>{
  if(!repo)return false;
  const readReceipt=()=>ctx.tasks.db.prepare(`SELECT after_head FROM merge_queue
    WHERE job_id=? AND task_id=? AND kind='task' AND repo_alias=? AND branch=?
    AND integration_worktree=? AND lock_key=? AND state='integrated' ORDER BY created_at DESC,rowid DESC LIMIT 1`)
    .get(ctx.taskId,taskId,alias,repo.branch,repo.worktree,`${repoKey(project,alias)}:${repo.branch}`);
  const receipt=integrationHead.safeParse(readReceipt());
  if(!receipt.success)return false;
  const wasUndone=()=>ctx.tasks.db.prepare("SELECT 1 FROM verification_signals WHERE task_id=? AND kind='undone' AND (job_id=? OR job_id IS NULL) LIMIT 1").get(taskId,ctx.taskId);
  if(wasUndone())return false;
  try {
    const opts={signal:ctx.signal,timeoutMs:10_000,maxBuffer:65536};
    if((await git(repo.worktree,["symbolic-ref","--quiet","HEAD"],opts)).trim()!==`refs/heads/${repo.branch}`)return false;
    const currentHead=(await git(repo.worktree,["rev-parse","HEAD"],opts)).trim();
    if(!/^[a-f0-9]{40,64}$/.test(currentHead))return false;
    await git(repo.worktree,["merge-base","--is-ancestor",receipt.data.after_head,currentHead],opts);
    if((await git(repo.worktree,["symbolic-ref","--quiet","HEAD"],opts)).trim()!==`refs/heads/${repo.branch}` || wasUndone())return false;
    if((await git(repo.worktree,["rev-parse","HEAD"],opts)).trim()!==currentHead)return false;
    const latest=integrationHead.safeParse(readReceipt()),source=ctx.tasks.get(taskId);
    if(!latest.success || latest.data.after_head!==receipt.data.after_head || wasUndone() ||
        ctx.tasks.projectOf(ctx.taskId)!==project || !source || source.row.project_id!==project ||
        source.spec.parentTaskId!==ctx.taskId || source.spec.writableRepository!==alias || !terminal.has(source.row.state))return false;
    return true;
  } catch(error){if(ctx.signal.aborted)throw error;return false;}
}

/** A prose reference can require an explicit repair choice, but never grants source authority. */
export async function assertExplicitRepairReferences(ctx: RunContext, children: ReadonlyMap<string,string>, items: Array<Record<string,unknown>>, defaultRepository: string | undefined, repositories?:ReadonlyMap<string,IntegrationTarget>): Promise<void> {
  const implementations=items.filter(item=>item.profile==="implement");
  if(!implementations.length)return;
  const project=ctx.tasks.projectOf(ctx.taskId);
  const owned=new Set(children.values());
  const sources=ctx.tasks.childrenOf(ctx.taskId).filter(task=>owned.has(task.row.id) &&
    task.spec.parentTaskId===ctx.taskId && task.row.project_id===project && terminal.has(task.row.state) &&
    ctx.cfg.profiles[task.spec.profile]?.mode==="coding");
  for(const item of implementations){
    const references=new Set(z.string().parse(item.goal).match(/[A-Za-z0-9_-]+/g) ?? []);
    const target=paths.safeParse(item.allowed_paths);
    if(!target.success)continue; // Ordinary brief validation reports malformed/missing scope.
    const writable=String(item.writable_repository ?? defaultRepository ?? "");
    const targetMatches=picomatch(target.data,{dot:true});
    const referencedSources=new Set(sources.filter(source=>references.has(source.row.id)).map(source=>source.row.id));
    // A patch ID can identify an owned retained source just as its task ID does. Resolve
    // metadata only: this refusal boundary must never read bytes or grant artifact access.
    for(const ref of references){
      if(!/^a_[A-Za-z0-9_-]+$/.test(ref))continue;
      const metadata=patchMetadata.safeParse(ctx.artifacts.get(ref));
      if(metadata.success && metadata.data.id===ref && sources.some(source=>source.row.id===metadata.data.task_id))referencedSources.add(metadata.data.task_id);
    }
    const compatible=sources.filter(source=>{
      if(source.spec.writableRepository!==writable || !referencedSources.has(source.row.id))return false;
      const actual=paths.safeParse(source.result?.changedPaths);
      if(actual.success)return actual.data.every(path=>targetMatches(path));
      const original=paths.safeParse(source.spec.constraints.allowedPaths);
      if(!original.success)return false;
      try { narrowedScope(target.data,original.data); return true; } catch { return false; }
    });
    const matches=[];
    for(const source of compatible){
      if(!await alreadyIntegrated(ctx,source.row.id,writable,project!,repositories?.get(writable)))matches.push(source);
    }
    if(!matches.length)continue;
    const selected=item.repair_from_task===undefined ? undefined : z.string().min(1).parse(item.repair_from_task);
    const selectedId=selected===undefined ? undefined : children.get(selected) ?? selected;
    if(selectedId && matches.some(source=>source.row.id===selectedId))continue;
    const ids=matches.map(source=>source.row.id);
    const reason=selected ? "repair_reference_mismatch" : ids.length>1 ? "repair_reference_ambiguous" : "repair_reference_required";
    throw new Error(`${reason}: ${String(item.label)} references owned retained coding task${ids.length>1?"s":""} ${ids.join(", ")} within its writable scope. Set repair_from_task explicitly to ${ids.length>1?"ONE referenced task ID":"\""+ids[0]+"\""} (or its dispatched label) before planning or delegating this repair. Prose/task/artifact references do not hydrate or grant access; normal repair source validation still applies.`);
  }
}
