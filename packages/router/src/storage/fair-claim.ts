import { z } from "zod";
import { immediate } from "./db.js";
import type { ProjectExecutionGrants, ExecutionGrantInput } from "./project-execution-grants.js";
import { ProjectStoreIdentitySchema, readProjectStoreRegistration, assertCriticalStoreDurability } from "../projects/store-identity.js";
import { readStoreIdentity } from "../projects/store-identity.js";
import type { Db } from "./db.js";
import type { TaskRow } from "./tasks.js";

/** A project's fair-share weight and its worker-task cap at claim (decision D5 of docs/working/projects.md). */
export interface ProjectClaimLimits {
  priority: number;
  /** Most worker tasks of the project running at once; undefined: no per-project cap. */
  maxConcurrent?: number | undefined;
}

/** `meta` keys holding the stride state: one pass per project, and the pass of the last claim. */
const PASS_PREFIX = "claim_pass:";
const VIRTUAL_TIME = "claim_pass";

/**
 * The order in which `TaskStore.claim` offers candidates: weighted round-robin across projects
 * with ready tasks, oldest first within a project (stride scheduling).
 *
 * Each project has a pass; the next candidate is the oldest ready task of the project with the
 * lowest pass, and a claim advances that project's pass by `1 / priority`. While two projects both
 * have ready tasks, they are therefore claimed in the ratio of their priorities, however long
 * either backlog is. A project that was idle (or whose tasks were blocked) is lifted to the pass
 * of the last claim, so it rejoins at the front of the rotation without having banked credit
 * for the time it had nothing to run. Ties go to the older task, so a single project (or equal
 * passes) is plain FIFO.
 *
 * The passes live in `meta` and are read and written inside the claim's IMMEDIATE transaction,
 * so the rotation carries across ticks, restarts, and processes sharing one store.
 */
export class FairClaimOrder {
  private readonly queues = new Map<string, { rows: TaskRow[]; next: number }>();
  private readonly pass = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private virtualTime: number;

  constructor(
    private readonly db: Db,
    candidates: TaskRow[],
    private readonly limitsOf: (projectId: string) => ProjectClaimLimits,
  ) {
    if (readStoreIdentity(db)?.role === "project") throw new Error("Project queues require explicit coordination fairness; local claim_pass metadata is forbidden");
    for (const row of candidates) {
      let q = this.queues.get(row.project_id);
      if (!q) this.queues.set(row.project_id, (q = { rows: [], next: 0 }));
      q.rows.push(row);
    }
    this.virtualTime = this.read(VIRTUAL_TIME) ?? 0;
    for (const p of this.queues.keys()) {
      const stored = this.read(PASS_PREFIX + p);
      if (stored !== null) this.pass.set(p, stored);
    }
  }

  private read(key: string): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private effective(project: string): number {
    return Math.max(this.pass.get(project) ?? this.virtualTime, this.virtualTime);
  }

  /** The next candidate to try, removed from its queue; null when every queue is empty. */
  next(): TaskRow | null {
    let best: { project: string; pass: number; head: TaskRow } | null = null;
    for (const [project, q] of this.queues) {
      const head = q.rows[q.next];
      if (!head) continue;
      const pass = this.effective(project);
      if (
        !best ||
        pass < best.pass ||
        (pass === best.pass && (head.created_at < best.head.created_at || (head.created_at === best.head.created_at && project < best.project)))
      ) {
        best = { project, pass, head };
      }
    }
    if (!best) return null;
    this.queues.get(best.project)!.next++;
    return best.head;
  }

  /** The row `next()` returned was claimed: its project moves back by one stride. */
  claimed(row: TaskRow): void {
    const p = row.project_id;
    const at = this.effective(p);
    this.virtualTime = at;
    this.pass.set(p, at + 1 / (this.limitsOf(p).priority || 1));
    this.dirty.add(p);
  }

  /** Persist the passes that moved (inside the caller's transaction). */
  save(): void {
    if (!this.dirty.size) return;
    const put = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    put.run(VIRTUAL_TIME, String(this.virtualTime));
    for (const p of this.dirty) put.run(PASS_PREFIX + p, String(this.pass.get(p)));
    this.dirty.clear();
  }
}

/** Minimal host-published readiness only; task IDs, goals and file globs never enter coordination fairness. */
export const ProjectFairCandidateSchema = z.object({project:ProjectStoreIdentitySchema,oldestReadyAt:z.number().int().nonnegative(),priority:z.number().positive().max(1000000)}).strict();
export type ProjectFairCandidate=z.infer<typeof ProjectFairCandidateSchema>;
export class ProjectFairnessDeferred extends Error { constructor(){super("Another ready project owns the next fair claim turn");this.name="ProjectFairnessDeferred";} }

/** Explicit coordination authority; never opens or queries a project database. */
export class CoordinatedFairClaims {
  constructor(readonly db:Db,private readonly grants:ProjectExecutionGrants){
    if(grants.db!==db||readStoreIdentity(db)?.role!=="coordination")throw new Error("Shared claim fairness requires matching coordination services");
    assertCriticalStoreDurability(db);
  }
  private ready(raw:readonly ProjectFairCandidate[]):ProjectFairCandidate[]{
    const candidates=z.array(ProjectFairCandidateSchema).max(1000).parse(raw);
    if(new Set(candidates.map(c=>c.project.projectId)).size!==candidates.length)throw new Error("Duplicate coordination fair candidate");
    return candidates.filter(candidate=>{const p=candidate.project,r=readProjectStoreRegistration(this.db,p.projectId);return r?.state==="registered"&&r.installationId===p.installationId&&r.storeId===p.storeId&&r.generation===p.generation&&r.slug===p.slug;});
  }
  private value(key:string):number|null{const row=z.object({value:z.string()}).optional().parse(this.db.prepare("SELECT value FROM meta WHERE key=?").get(key));if(!row)return null;const value=Number(row.value);if(!Number.isFinite(value)||value<0)throw new Error("Coordination fair pass is invalid");return value;}
  private key(candidate:ProjectFairCandidate):string{const p=candidate.project;return `claim_pass:${p.projectId}:${p.storeId}:${p.generation}`;}
  private ordered(raw:readonly ProjectFairCandidate[]):ProjectFairCandidate[]{
    const virtual=this.value("claim_pass")??0;
    return this.ready(raw).map(candidate=>({candidate,pass:Math.max(this.value(this.key(candidate))??virtual,virtual)})).sort((a,b)=>a.pass-b.pass||a.candidate.oldestReadyAt-b.candidate.oldestReadyAt||a.candidate.project.projectId.localeCompare(b.candidate.project.projectId)).map(row=>row.candidate);
  }
  /** Publish bounded minimal hints before selecting a local task or entering a global claim transaction. */
  publish(raw:readonly ProjectFairCandidate[]):void{
    const candidates=this.ready(raw),json=JSON.stringify(candidates);
    if(Buffer.byteLength(json)>1024*1024)throw new Error("Coordination ready hints exceed bounded size");
    immediate(this.db,()=>this.db.prepare("INSERT INTO meta(key,value) VALUES('claim_ready',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json));
  }
  private published():ProjectFairCandidate[]{const row=z.object({value:z.string().max(1024*1024)}).optional().parse(this.db.prepare("SELECT value FROM meta WHERE key='claim_ready'").get());return row?z.array(ProjectFairCandidateSchema).max(1000).parse(JSON.parse(row.value)):[];}
  choose(raw:readonly ProjectFairCandidate[]):ProjectFairCandidate|null{this.publish(raw);return this.ordered(this.published())[0]??null;}
  reserve(input:ExecutionGrantInput,raw:readonly ProjectFairCandidate[]):ReturnType<ProjectExecutionGrants["reserve"]>{
    // The caller already holds its local IMMEDIATE. Only minimal snapshots and global
    // registration/fairness/grants are consulted while this coordination transaction is held.
    return immediate(this.db,()=>{
      z.array(ProjectFairCandidateSchema).max(1000).parse(raw);
      const selected=this.ordered(this.published())[0];
      if(!selected||selected.project.projectId!==input.project.projectId||selected.project.storeId!==input.project.storeId||selected.project.generation!==input.project.generation)throw new ProjectFairnessDeferred();
      const receipt=this.grants.reserve(input);
      if(receipt.disposition==="fresh"){
        const virtual=this.value("claim_pass")??0,at=Math.max(this.value(this.key(selected))??virtual,virtual),put=this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        put.run("claim_pass",String(at));put.run(this.key(selected),String(at+1/selected.priority));
      }
      return receipt;
    });
  }
}
