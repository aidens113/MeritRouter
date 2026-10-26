import { z } from "zod";
import picomatch from "picomatch";
import { createHash } from "node:crypto";
import { RepairSourceSchema, type RepairSource } from "../core/task.js";
import type { RunContext } from "../runners/types.js";
import type { Workspace } from "./worktree.js";
import { git } from "./git.js";
import { assertRunAuthority } from "../harness/task-authority.js";
import { SessionStore } from "../sessions/store.js";
import { authorSessions } from "../sessions/run-sessions.js";
import { WorkerActionRequests } from "../harness/worker-actions.js";

const EVENT = "repair_hydration";
const Receipt = z.object({ status: z.enum(["started", "completed", "failed"]), digest: z.string().regex(/^[0-9a-f]{64}$/),
  worktree: z.string(), base: z.string(), head: z.string().regex(/^[0-9a-f]{40,64}$/).optional(), tree: z.string().regex(/^[0-9a-f]{40,64}$/).optional() }).strict().superRefine((v,c)=>{if(v.status==="completed"&&(!v.head||!v.tree))c.addIssue({code:"custom",message:"completed hydration requires head/tree"});});
function refuse(why: string): never { throw new Error(`repair_hydration_refused: ${why}`); }
const options = (ctx: RunContext) => ({ signal: ctx.signal, timeoutMs: 30_000 });
const digest = (source: RepairSource) => createHash("sha256").update(JSON.stringify(source)).digest("hex");

/** Resolve only a terminal sibling's immutable, attributed, fully scoped retained commit chain. */
export async function resolveRepairSource(ctx: RunContext, id: string, alias: string, constraints: {allowedPaths?: string[]}, parent: string): Promise<RepairSource> {
  assertRunAuthority(ctx);
  const task = ctx.tasks.get(id);
  if (!task || task.spec.parentTaskId !== parent || task.row.project_id !== ctx.tasks.projectOf(ctx.taskId) ||
      !["completed", "failed", "cancelled", "budget_exhausted"].includes(task.row.state) ||
      task.spec.writableRepository !== alias || ctx.cfg.profiles[task.spec.profile]?.mode !== "coding" ||
      task.spec.lab || task.spec.constraints.labChecks?.length || task.result?.scopeViolation?.length) refuse("source ownership, terminal state or scope");
  if (ctx.tasks.db.prepare("SELECT 1 FROM merge_queue WHERE task_id=? AND state IN ('queued','integrating','picked') LIMIT 1").get(id)) refuse("source merge is active");
  const ws = z.object({worktree_path:z.string(),base_sha:z.string(),repo_alias:z.string()}).parse(
    ctx.tasks.db.prepare("SELECT worktree_path,base_sha,repo_alias FROM workspaces WHERE task_id=?").get(id));
  if (ws.repo_alias !== alias) refuse("source repository");
  const actions = new WorkerActionRequests(ctx.tasks.db, ctx.now);
  const scope = { project: task.row.project_id, taskId:id };
  const uncertain = actions.list({...scope,status:"uncertain"});
  if (actions.list({...scope,status:"pending"}).length || actions.list({...scope,status:"running"}).length ||
      uncertain.length >= 500 || uncertain.some(a=>!a.quiescedAt)) refuse("source actions are not quiescent");
  const sessions = new SessionStore(ctx.tasks.db,ctx.cfg.storageDir,ctx.now);
  const author = authorSessions(sessions,id).at(-1);
  const page = author ? sessions.events(author.id, {limit:10000}) : null;
  if (!page || page.corrupt.length || page.hasMore || sessions.forTask(id).some(a=>a.status==="running")) refuse("source session history is incomplete or active");
  const pending = new Set<string>();
  for (const e of page.events) {
    if (e.type==="tool_intent" && e.data.sideEffect!=="none") pending.add(e.data.callId);
    if (e.type==="tool_outcome") pending.delete(e.data.callId);
  }
  if (pending.size) refuse("source has unfinished effects");
  const recorded = author?.workspace?.repos.find(r=>r.alias===alias);
  if (!author || author.role!=="implementer" || author.profile!==task.spec.profile || !["completed","failed","cancelled","budget_exhausted"].includes(author.status) || !recorded ||
      recorded.worktree !== ws.worktree_path || recorded.baseCommit !== ws.base_sha) refuse("source author workspace proof");
  const cwd = ws.worktree_path, opts=options(ctx);
  if ((await git(cwd,["status","--porcelain=v1","--untracked-files=all"],opts)).trim()) refuse("source is dirty");
  const head=(await git(cwd,["rev-parse","HEAD"],opts)).trim();
  if (recorded.head !== head) refuse("source head differs from author receipt");
  const commits=(await git(cwd,["rev-list","--reverse","--max-count=101",`${ws.base_sha}..${head}`],opts)).trim().split("\n").filter(Boolean);
  if (!commits.length || commits.length>100) refuse("source commit bound");
  const allowed=picomatch(constraints.allowedPaths ?? [],{dot:true});
  const original=picomatch(task.spec.constraints.allowedPaths ?? [],{dot:true});
  let previous=ws.base_sha;
  let remainingPatchBytes=8*1024*1024;
  for (const commit of commits) {
    const parents=(await git(cwd,["rev-list","--parents","-n","1",commit],opts)).trim().split(" ");
    if (parents.length!==2 || parents[1]!==previous) refuse("source is not a linear bounded chain");
    const message=await git(cwd,["show","-s","--format=%B",commit],opts);
    if (!["Agent","Model","Task"].every(k=>new RegExp(`^${k}: .+`,"m").test(message))) refuse("source attribution missing");
    const raw=await git(cwd,["diff-tree","--no-commit-id","--no-renames","--name-only","-r","-z",commit],opts);
    for (const name of raw.split("\0").filter(Boolean)) if (!allowed(name)||!original(name)) refuse(`inherited path outside scope: ${name}`);
    const tree=await git(cwd,["ls-tree","-r",commit],{...opts,maxBuffer:4*1024*1024});
    if (tree.split("\n").some(line=>/^(120000|160000) /.test(line))) refuse("symlink or submodule source");
    const patch=await git(cwd,["diff","--binary",previous,commit],{...opts,maxBuffer:Math.max(1,remainingPatchBytes)});
    remainingPatchBytes-=Buffer.byteLength(patch,"utf8");
    if(remainingPatchBytes<0)refuse("source cumulative patch byte bound");
    previous=commit;
    assertRunAuthority(ctx);
  }
  const result=RepairSourceSchema.parse({taskId:id,project:task.row.project_id,alias,base:ws.base_sha,head,
    tree:(await git(cwd,["rev-parse",`${head}^{tree}`],opts)).trim(),commits});
  assertRunAuthority(ctx);
  return result;
}

/** Read unpaged task-local receipts: a partial/crashed hydration must never enter a model loop. */
export async function verifyRepairHydration(ctx:RunContext,ws:Workspace):Promise<void> {
  const source=ctx.spec.context.repairSource;
  if (!source) return;
  RepairSourceSchema.parse(source);
  const rows=ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? ORDER BY id").all(ctx.taskId,EVENT) as {data_json:string}[];
  const receipt=rows.length ? Receipt.parse(JSON.parse(rows.at(-1)!.data_json)) : null;
  if (!receipt || receipt.status!=="completed" || receipt.digest!==digest(source) || receipt.worktree!==ws.worktreePath || receipt.base!==ws.baseSha) refuse("missing or incomplete hydration receipt");
  // Later worker commits are valid; the immutable hydrated head must remain an ancestor.
  await git(ws.worktreePath,["merge-base","--is-ancestor",receipt.head!,"HEAD"],options(ctx));
  if ((await git(ws.worktreePath,["rev-parse",`${receipt.head}^{tree}`],options(ctx))).trim()!==receipt.tree) refuse("hydrated tree mismatch");
  assertRunAuthority(ctx);
}

/** Git rename following can relocate source edits; inspect actual target changes, not source names. */
async function validateTargetDelta(ctx:RunContext,ws:Workspace,from:string,to:string):Promise<void> {
  const allowed=picomatch(ctx.spec.constraints.allowedPaths ?? [],{dot:true});
  const raw=await git(ws.worktreePath,["diff","--raw","--no-renames","-z",from,to],{...options(ctx),maxBuffer:4*1024*1024});
  const fields=raw.split("\0").filter(Boolean);
  for(let i=0;i<fields.length;i+=2){
    const metadata=fields[i]!,name=fields[i+1];
    if(!name || !/^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [A-Z]$/.test(metadata))refuse("unrecognized target delta");
    if(!allowed(name))refuse(`hydrated target path outside scope: ${name}`);
    const modes=metadata.slice(1).split(" ").slice(0,2);
    if(modes.some(mode=>mode!=="000000" && mode!=="100644" && mode!=="100755"))refuse("hydrated target mode is not a regular file");
  }
  assertRunAuthority(ctx);
}

export async function hydrateRepairWorkspace(ctx:RunContext,ws:Workspace):Promise<void> {
  const source=ctx.spec.context.repairSource;
  if (!source) return;
  if (ctx.spec.lab || ctx.spec.constraints.labChecks?.length || ctx.retry?.startFrom) refuse("unsupported Lab or quality-retry hydration");
  const existing=ctx.tasks.db.prepare("SELECT 1 FROM events WHERE task_id=? AND type=? LIMIT 1").get(ctx.taskId,EVENT);
  if (existing) { await verifyRepairHydration(ctx,ws); return; }
  const resolved=await resolveRepairSource(ctx,source.taskId,ws.repoAlias,ctx.spec.constraints,ctx.spec.parentTaskId ?? "");
  if (JSON.stringify(resolved)!==JSON.stringify(RepairSourceSchema.parse(source))) refuse("source provenance changed");
  if ((await git(ws.worktreePath,["rev-parse","HEAD"],options(ctx))).trim()!==ws.baseSha ||
      (await git(ws.worktreePath,["status","--porcelain=v1","--untracked-files=all"],options(ctx))).trim()) refuse("target is not a clean integration base");
  const sourceWorkspace=z.object({worktree_path:z.string()}).parse(ctx.tasks.db.prepare("SELECT worktree_path FROM workspaces WHERE task_id=?").get(source.taskId));
  const receipt={digest:digest(source),worktree:ws.worktreePath,base:ws.baseSha};
  assertRunAuthority(ctx);ctx.tasks.event(ctx.taskId,EVENT,{...receipt,status:"started"});
  try {
    const assertSourceCurrent=async()=>{
      // The source may have been explicitly resumed after descriptor resolution.
      const latest=ctx.tasks.get(source.taskId);
      if (!latest || !["completed","failed","cancelled","budget_exhausted"].includes(latest.row.state)) refuse("source became active during replay");
      if ((await git(sourceWorkspace.worktree_path,["rev-parse","HEAD"],options(ctx))).trim()!==source.head) refuse("source head changed during replay");
      assertRunAuthority(ctx);
      const actions=new WorkerActionRequests(ctx.tasks.db,ctx.now);
      const scope={project:source.project,taskId:source.taskId};
      if(actions.list({...scope,status:"running"}).length || actions.list({...scope,status:"pending"}).length || actions.list({...scope,status:"uncertain"}).length>=500 || actions.list({...scope,status:"uncertain"}).some(a=>!a.quiescedAt))refuse("source effects became active during replay");
      const latestAfterRead=ctx.tasks.get(source.taskId);
      if(!latestAfterRead || !["completed","failed","cancelled","budget_exhausted"].includes(latestAfterRead.row.state))refuse("source became active during replay");
      if(ctx.tasks.db.prepare("SELECT 1 FROM merge_queue WHERE task_id=? AND state IN ('queued','integrating','picked') LIMIT 1").get(source.taskId))refuse("source merge became active during replay");
      assertRunAuthority(ctx);
    };
    for (const commit of source.commits) {
      await assertSourceCurrent();
      const previousHead=(await git(ws.worktreePath,["rev-parse","HEAD"],options(ctx))).trim();
      assertRunAuthority(ctx);
      await git(ws.worktreePath,["cherry-pick","-x","--allow-empty",commit],{...options(ctx),env:{GIT_COMMITTER_NAME:"MeritRouter repair hydration",GIT_COMMITTER_EMAIL:"repair@meritrouter.local"}});
      assertRunAuthority(ctx);
      await validateTargetDelta(ctx,ws,previousHead,"HEAD");
    }
    const head=(await git(ws.worktreePath,["rev-parse","HEAD"],options(ctx))).trim();
    const tree=(await git(ws.worktreePath,["rev-parse",`${head}^{tree}`],options(ctx))).trim();
    await validateTargetDelta(ctx,ws,ws.baseSha,head);
    await assertSourceCurrent();
    assertRunAuthority(ctx);ctx.tasks.event(ctx.taskId,EVENT,{...receipt,status:"completed",head,tree});
  } catch (error) {
    // Preserve partial target and typed start receipt on authority loss. Never expose it to a model.
    assertRunAuthority(ctx);ctx.tasks.event(ctx.taskId,EVENT,{...receipt,status:"failed"});
    throw error;
  }
}
