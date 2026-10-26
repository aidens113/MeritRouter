import { z } from "zod";
import { immediate } from "../storage/db.js";
import { canonicalJson } from "../storage/tasks.js";
import { LeaseRefSchema,LeaseReceiptSchema,type LeaseRef,type LeaseReceipt } from "../storage/task-leases.js";
import { assertStoreRole } from "../storage/store-role.js";
import { readStoreIdentity,ProjectStoreIdentitySchema,type ProjectStoreIdentity } from "../projects/store-identity.js";
import { loadConfig } from "../config/load.js";
import { ProjectRegistry } from "../projects/registry.js";
import { roleForProfile } from "../roles/index.js";
import { WorkerTaskSchema,TASK_STATES } from "../core/task.js";
import { RoleNameSchema,ProfileNameSchema } from "../config/schema.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";
import picomatch from "picomatch";
import type { ResolvedConfig } from "../config/load.js";
import type { BrainMode, RoleName, TierName } from "../config/schema.js";
import { TIER_NAMES } from "../config/schema.js";
import type { Db } from "../storage/db.js";

export interface Grant {
  pattern: string;
  mode: BrainMode;
}

export type Principal =
  | { kind: "human"; name?: string }
  | { kind: "agent"; role: RoleName; taskId: string | null; jobId: string | null; tier: TierName | null; grants: Grant[] };

const RANK: Record<BrainMode, number> = { read: 1, append: 2, write: 3, admin: 4 };

export interface GrantContext {
  project: string;
  effort: string;
  task: string | null;
  repos: string[];
}

/**
 * Built-in defaults, overridable per role in config (roles.<role>.brain_grants). A project's
 * agents see their own project and `global/` only (decision D4); another project's entries need
 * an access request. Nothing here, in config, or in an approved request lets an agent write
 * `global/`: that happens only through the gated promotion (`Brain.promoteLesson`).
 */
const DEFAULTS: Record<RoleName, Grant[]> = {
  supervisor: [
    { pattern: "global/**", mode: "read" },
    { pattern: "projects/{project}/**", mode: "write" },
  ],
  summarizer: [],
  inspector: [],
  analyst: [],
  implementer: [],
  reviewer: [{ pattern: "projects/{project}/working/{effort}/reports/**", mode: "read" }],
  classifier: [],
};

/** Every worker role reads the shared context its brief needs and writes only its own report. */
const WORKER_BASE: Grant[] = [
  { pattern: "global/preferences/**", mode: "read" },
  { pattern: "projects/{project}/memory/**", mode: "read" },
  { pattern: "projects/{project}/working/{effort}.md", mode: "read" },
  { pattern: "projects/{project}/repos/{repo}.md", mode: "read" },
  { pattern: "projects/{project}/decisions/**", mode: "read" },
  { pattern: "global/lessons/**", mode: "read" },
  { pattern: "global/glossary.md", mode: "read" },
  { pattern: "projects/{project}/working/{effort}/reports/{task}.md", mode: "write" },
];

export function reportPath(ctx: GrantContext): string {
  return `projects/${ctx.project}/working/${ctx.effort}/reports/${ctx.task}.md`;
}

function substitute(g: Grant, ctx: GrantContext): Grant[] {
  const base = g.pattern.replaceAll("{project}", ctx.project).replaceAll("{effort}", ctx.effort).replaceAll("{task}", ctx.task ?? "_none_");
  if (!base.includes("{repo}")) return [{ pattern: base, mode: g.mode }];
  return ctx.repos.map((r) => ({ pattern: base.replaceAll("{repo}", r), mode: g.mode }));
}

export function defaultGrants(cfg: ResolvedConfig, role: RoleName, ctx: GrantContext): Grant[] {
  const configured = cfg.roles[role]?.brain_grants;
  const templates = configured ?? (role === "supervisor" || role === "classifier" ? DEFAULTS[role] : [...WORKER_BASE, ...DEFAULTS[role]]);
  return templates.flatMap((g) => substitute(g, ctx));
}

/**
 * Paths agents may never change, whatever their grants: global knowledge (written only by the
 * gated promotion) and each project's promotion records (written only by MeritRouter).
 */
export function systemManaged(path: string): boolean {
  const p = path.toLowerCase();
  return p === "global" || p.startsWith("global/") || /^projects\/[^/]+\/(promotions|memory)(\/|$)/.test(p);
}

/** The generated indexes: the root `README.md` and each project's `projects/<p>/README.md`. */
export function isBrainIndex(path: string): boolean {
  return /^(projects\/[^/]+\/)?readme\.md$/i.test(path);
}

export function allows(principal: Principal, path: string, mode: BrainMode): boolean {
  if (principal.kind === "human") return true;
  if (mode !== "read" && (systemManaged(path) || isBrainIndex(path))) return false;
  return principal.grants.some((g) => RANK[g.mode] >= RANK[mode] && picomatch(g.pattern, { dot: false, nocase: true })(path));
}

export function denial(principal: Principal, path: string, mode: BrainMode): string | null {
  if (allows(principal, path, mode)) return null;
  const who = principal.kind === "agent" ? `${principal.role}${principal.taskId ? ` ${principal.taskId}` : ""}` : "user";
  if (mode !== "read" && systemManaged(path)) {
    if (/^projects\/[^/]+\/memory(\/|$)/i.test(path)) return `${who} cannot directly ${mode} typed memory: use the scoped memory service with expected digest; user preferences require a trusted initiating instruction.`;
    return `${who} cannot ${mode} ${path}: global knowledge is added only through brain_promote_lesson (supervisors), and promotion records only by MeritRouter.`;
  }
  if (mode !== "read" && isBrainIndex(path)) return `${who} cannot ${mode} ${path}: brain indexes are generated by MeritRouter (creating a working document updates them).`;
  return `${who} has no ${mode} access to ${path}. Use brain_request_access(pattern, mode, reason) to ask for it.`;
}

export interface AccessRequest {
  id: number;
  taskId: string | null;
  jobId: string | null;
  role: string;
  pattern: string;
  mode: BrainMode;
  reason: string;
  status: "pending" | "approved" | "denied";
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

type Row = { id: number; task_id: string | null; job_id: string | null; role: string; pattern: string; mode: BrainMode; reason: string; status: AccessRequest["status"]; decided_by: string | null; decision_reason: string | null; created_at: number; decided_at: number | null };
const toRequest = (r: Row): AccessRequest => ({ id: r.id, taskId: r.task_id, jobId: r.job_id, role: r.role, pattern: r.pattern, mode: r.mode, reason: r.reason, status: r.status, decidedBy: r.decided_by, decisionReason: r.decision_reason, createdAt: r.created_at, decidedAt: r.decided_at });

/**
 * Does an auto-approve rule cover everything a request could match? Only literal paths and
 * literal-prefix `/**` requests qualify (a glob in the request could widen what it grants); the
 * rule must match the path itself or, for `/**`, shallow and deep paths under the prefix.
 */
export function ruleCovers(rule: string, requested: string): boolean {
  const m = /^([^*?{}[\]!()+@]+?)(\/\*\*)?$/.exec(requested);
  if (!m) return false;
  const match = picomatch(rule, { nocase: true });
  const prefix = m[1]!.replace(/\/+$/, "");
  if (!m[2]) return match(prefix);
  return match(`${prefix}/x.md`) && match(`${prefix}/a/b/c.md`);
}

export interface ProjectBrainAccessOptions {identity:ProjectStoreIdentity;assertRuntime():void;authorizeHarnessRole?(proof:{lease:LeaseRef;role:RoleName;sessionId:string}):boolean}
const TaskAuthoritySchema=z.object({state:z.enum(TASK_STATES),lease_owner:z.string().nullable(),lease_expires_at:z.number().int().nullable(),deadline_at:z.number().int().nullable(),cancel_requested:z.union([z.literal(0),z.literal(1)]),lease_incarnation:z.string().regex(/^[a-f0-9]{32}$/),run_count:z.number().int().nonnegative(),project_id:z.string()}).strict();
const AccessRowSchema=z.object({id:z.number().int().positive(),task_id:z.string().nullable(),job_id:z.string().nullable(),role:RoleNameSchema,pattern:z.string(),mode:z.enum(["read","append","write","admin"]),reason:z.string(),status:z.enum(["pending","approved","denied"]),decided_by:z.string().nullable(),decision_reason:z.string().nullable(),created_at:z.number().int(),decided_at:z.number().int().nullable(),project_id:z.string(),lease_json:z.string().nullable()}).strict();
const GrantSchema=z.object({pattern:z.string().min(1).max(2000),mode:z.enum(["read","append","write","admin"])}).strict();
const principalBindings=new WeakMap<object,{db:Db;lease:LeaseRef;fingerprint:string;reportPath:string|null;now:()=>number;phaseSession:string|null}>();
export function assertProjectBrainPrincipal(db:Db,p:Principal,rel?:string):void {
 if(readStoreIdentity(db)?.role!=="project"||p.kind==="human")return;
 const bound=principalBindings.get(p);if(!bound||bound.db!==db||bound.fingerprint!==canonicalJson(p))throw new Error("Brain principal is not bound to original project authority");
 const row=db.prepare("SELECT state,lease_owner,lease_expires_at,deadline_at,cancel_requested,lease_incarnation,run_count,project_id FROM tasks WHERE id=?").get(bound.lease.taskId) as {state:string;lease_owner:string|null;lease_expires_at:number|null;deadline_at:number|null;cancel_requested:number;lease_incarnation:string;run_count:number;project_id:string}|undefined;
 if(!row||row.project_id!==bound.lease.project||row.lease_incarnation!==bound.lease.incarnation||row.run_count!==bound.lease.runCount)throw new Error("Brain principal task generation changed");
 if(bound.phaseSession!==null&&!db.prepare("SELECT 1 FROM sessions WHERE id=? AND task_id=? AND role=? AND status='running'").get(bound.phaseSession,bound.lease.taskId,p.role))throw new Error("Captured Brain harness phase/session ended");
 if(bound.reportPath!==null){if(rel!==bound.reportPath)throw new Error("Terminal report authority permits only its original report path");return;}
 if(row.state!=="running"||row.cancel_requested||row.lease_owner!==bound.lease.owner||!(row.lease_expires_at!>bound.now())||row.deadline_at!==null&&row.deadline_at<=bound.now())throw new Error("Brain principal original task authority ended");
}

/** Grants beyond the defaults, and the request workflow for obtaining them. */
export class BrainAccess {
  constructor(
    private readonly db: Db,
    private readonly cfg: ResolvedConfig,
    private readonly now: () => number = Date.now,
    private readonly project?:ProjectBrainAccessOptions,
  ) {this.project=project?{...project,identity:Object.freeze(ProjectStoreIdentitySchema.parse(project.identity))}:undefined;const role=readStoreIdentity(db);if(role?.role==="coordination")throw new Error("Private Brain access cannot use coordination store");if(role?.role==="project"&&!project)throw new Error("Project Brain access requires explicit pinned identity");this.owner();}
  private owner():void{if(this.project){this.project.assertRuntime();assertStoreRole(this.db,ProjectStoreIdentitySchema.parse(this.project.identity));if(this.cfg.brain.project!==this.project.identity.slug)throw new Error("Brain access configuration changed project scope");}}
  private task(taskId:string):void{this.owner();if(this.project&&!this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId,this.project.identity.slug))throw new Error("Brain task does not belong to pinned project");}
  private pattern(pattern:string,mode:BrainMode):void{if(!this.project)return;const own=`projects/${this.project.identity.slug}/`;if(!(pattern.startsWith(own)||mode==="read"&&pattern.startsWith("global/")))throw new Error("Brain grant cannot escape pinned project/global read scope");}


  private trusted():ResolvedConfig {if(!this.project)return this.cfg;const current=new ProjectRegistry(loadConfig(this.cfg.configPath)).context(this.project.identity.slug);if(!current)throw new Error("Brain project is no longer configured");return current;}
  extraGrants(taskId: string): Grant[] {
    this.task(taskId);if(this.project)return z.array(z.object({pattern:z.string(),mode:z.enum(["read","append","write","admin"])}).strict()).parse(this.db.prepare("SELECT g.pattern,g.mode FROM brain_grants g JOIN tasks t ON t.id=g.task_id WHERE g.task_id=? AND g.lease_incarnation=t.lease_incarnation").all(taskId));return z.array(z.object({pattern:z.string(),mode:z.enum(["read","append","write","admin"])}).strict()).parse(this.db.prepare("SELECT pattern, mode FROM brain_grants WHERE task_id = ?").all(taskId));
  }

  principalFor(role: RoleName, ctx: GrantContext & { jobId: string | null; tier: TierName | null; briefGrants?: Grant[];lease?:LeaseRef;reportOnly?:boolean;terminalReceipt?:LeaseReceipt;sessionId?:string }): Principal {
    this.owner();RoleNameSchema.parse(role);let taskId=ctx.task,report:string|null=null,phaseSession:string|null=null,tier=ctx.tier;let lease:LeaseRef|undefined;const trusted=this.trusted();
    if(this.project){lease=LeaseRefSchema.parse(ctx.lease);this.task(lease.taskId);if(ctx.project!==this.project.identity.slug||lease.project!==ctx.project)throw new Error("Brain principal project scope mismatch");
      const task=z.object({spec_json:z.string(),profile:ProfileNameSchema,lease_incarnation:z.string().regex(/^[a-f0-9]{32}$/),run_count:z.number().int().nonnegative(),state:z.enum(TASK_STATES),tier:z.string().nullable()}).strict().parse(this.db.prepare("SELECT spec_json,profile,lease_incarnation,run_count,state,tier FROM tasks WHERE id=?").get(lease.taskId));
      tier=task.tier!==null&&TIER_NAMES.includes(task.tier as TierName)?task.tier as TierName:null;
      const spec=WorkerTaskSchema.parse(JSON.parse(task.spec_json));if(spec.profile!==task.profile)throw new Error("Stored Brain task profile disagrees with specification");
      if(role!==roleForProfile(task.profile)){const id=z.string().min(1).parse(ctx.sessionId);const session=z.object({task_id:z.string().nullable(),role:RoleNameSchema,status:z.string()}).strict().optional().parse(this.db.prepare("SELECT task_id,role,status FROM sessions WHERE id=?").get(id));if(!session||session.task_id!==lease.taskId||session.role!==role||session.status!=="running"||this.project.authorizeHarnessRole?.({lease,role,sessionId:id})!==true)throw new Error("Brain role differs from persisted task and captured harness phase");phaseSession=id;}
      const expectedEffort=spec.brain?.effort??(task.profile==="supervise"?`job-${lease.taskId}`:spec.parentTaskId?`job-${spec.parentTaskId}`:"adhoc");if(ctx.effort!==expectedEffort||role!=="supervisor"&&ctx.task!==(spec.label??lease.taskId)||ctx.repos.some(alias=>!spec.repositoryAliases.includes(alias)))throw new Error("Brain grants cannot change actual task/report/repository context");
      if(task.lease_incarnation!==lease.incarnation||task.run_count!==lease.runCount||ctx.jobId!==(trusted.profiles[task.profile]?.mode==="supervisor"?lease.taskId:spec.parentTaskId??null))throw new Error("Brain principal run or parent scope mismatch");
      if(role==="supervisor"&&!currentSupervisorAuthority(this.db,this.cfg,lease,this.now()))throw new Error("Brain supervisor role is not persisted live authority");taskId=lease.taskId;
      if(ctx.reportOnly){const proof=LeaseReceiptSchema.parse(ctx.terminalReceipt),raw=z.object({response_json:z.string()}).strict().optional().parse(this.db.prepare("SELECT response_json FROM task_lease_operations WHERE id=?").get(proof.operationId));const stored=raw?LeaseReceiptSchema.parse(JSON.parse(raw.response_json)):null;
        if(!stored||stored.kind!=="finish"||stored.original!=="applied"||!stored.lease||canonicalJson(stored.lease)!==canonicalJson(lease)||stored.operationId!==proof.operationId||stored.state!==task.state||["running","queued","cancel_requested"].includes(task.state))throw new Error("Terminal report requires original durable finish receipt");
        if(ctx.task!==(spec.label??lease.taskId)||ctx.effort!==(spec.brain?.effort??(spec.parentTaskId?`job-${spec.parentTaskId}`:"adhoc")))throw new Error("Terminal report cannot choose another report destination");report=reportPath(ctx);
      }
    }
    const principal:Principal={kind:"agent",role,taskId,jobId:ctx.jobId,tier,grants:z.array(GrantSchema).max(1000).parse(report?[{pattern:report,mode:"write"}]:[...defaultGrants(trusted,role,ctx),...(ctx.briefGrants??[]),...(taskId?this.extraGrants(taskId):[])])};
    if(this.project&&lease){for(const grant of principal.grants)this.pattern(grant.pattern,grant.mode);principalBindings.set(principal,{db:this.db,lease,fingerprint:canonicalJson(principal),reportPath:report,now:this.now,phaseSession});if(!report)assertProjectBrainPrincipal(this.db,principal);}
    return principal;
  }

  grant(taskId: string, g: Grant, grantedBy: string, requestId: number | null = null,actor?:Principal): void {
    GrantSchema.parse(g);this.task(taskId);this.pattern(g.pattern,g.mode);if(this.project)this.decisionActor(actor,taskId);
    const incarnation=this.project?z.object({lease_incarnation:z.string().regex(/^[a-f0-9]{32}$/)}).strict().parse(this.db.prepare("SELECT lease_incarnation FROM tasks WHERE id=?").get(taskId)).lease_incarnation:null;
    this.db.prepare("INSERT INTO brain_grants (task_id, pattern, mode, granted_by, request_id, created_at,lease_incarnation) VALUES (?, ?, ?, ?, ?, ?,?)").run(taskId, g.pattern, g.mode, grantedBy, requestId, this.now(),incarnation);
  }

  /** File a request. Auto-approval rules apply immediately; otherwise it waits for the approver. */
  request(p: Principal, pattern: string, mode: BrainMode, reason: string): AccessRequest {return immediate(this.db,()=>this.requestBound(p,pattern,mode,reason));}
  private requestBound(p: Principal, pattern: string, mode: BrainMode, reason: string): AccessRequest {
    GrantSchema.parse({pattern,mode});z.string().min(1).max(20000).parse(reason);
    this.owner();if(this.project){assertProjectBrainPrincipal(this.db,p);if(p.kind==="agent"&&principalBindings.get(p)?.reportPath!==null)throw new Error("Terminal report cannot request Brain access");this.pattern(pattern,mode);}
    if (p.kind !== "agent") throw new Error("only agents request access");
    if (mode !== "read" && systemManaged(pattern.replace(/\\/g, "/").replace(/^\.?\/+/, ""))) throw new Error(`${mode} access to ${pattern} is never granted: supervisors add global knowledge with brain_promote_lesson`);
    const id = Number(
      this.db
        .prepare("INSERT INTO brain_access_requests (task_id, job_id, role, pattern, mode, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(p.taskId, p.jobId, p.role, pattern, mode, reason.slice(0, 1000), this.now()).lastInsertRowid,
    );
    if(this.project)this.db.prepare("UPDATE brain_access_requests SET lease_json=? WHERE id=?").run(canonicalJson(principalBindings.get(p)!.lease),id);
    const policy=this.trusted().brain;
    const auto = policy.access_approver === "auto" ? true : policy.auto_approve.some((r) => RANK[r.mode] >= RANK[mode] && ruleCovers(r.pattern, pattern) && (p.tier === null ? !this.project : TIER_NAMES.indexOf(p.tier) >= TIER_NAMES.indexOf(r.min_tier)));
    if (auto) return this.decideRecord(id,true,"auto","matched an auto-approve rule");
    return this.get(id)!;
  }

  get(id: number): AccessRequest | null {
    this.owner();const r = this.db.prepare("SELECT * FROM brain_access_requests WHERE id = ?").get(id) as Row | undefined;
    return r ? toRequest(AccessRowSchema.parse(r)) : null;
  }

  list(opts: { status?: AccessRequest["status"]; jobId?: string; taskId?: string } = {}): AccessRequest[] {
    this.owner();if(opts.jobId)this.task(opts.jobId);if(opts.taskId)this.task(opts.taskId);
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) (where.push("status = ?"), args.push(opts.status));
    if (opts.jobId) (where.push("job_id = ?"), args.push(opts.jobId));
    if (opts.taskId) (where.push("task_id = ?"), args.push(opts.taskId));
    return z.array(AccessRowSchema).parse(this.db.prepare(`SELECT * FROM brain_access_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 200`).all(...args)).map(toRequest);
  }

  private decisionActor(actor:Principal|undefined,taskId:string):void{
    if(!actor)throw new Error("Pinned Brain decision requires explicit actor");if(actor.kind==="human")return;assertProjectBrainPrincipal(this.db,actor);const bound=principalBindings.get(actor);
    if(!bound||bound.reportPath!==null||actor.role!=="supervisor"||!currentSupervisorAuthority(this.db,this.cfg,bound.lease,this.now()))throw new Error("Only an owning live supervisor may decide Brain access");
    const target=z.object({spec_json:z.string()}).strict().optional().parse(this.db.prepare("SELECT spec_json FROM tasks WHERE id=?").get(taskId));if(!target||WorkerTaskSchema.parse(JSON.parse(target.spec_json)).parentTaskId!==bound.lease.taskId)throw new Error("Brain access request is outside supervisor children");
  }
  decide(id: number, approve: boolean, decidedBy: string, reason: string,actor?:Principal): AccessRequest {
    this.owner();return immediate(this.db,()=>{const req=this.get(id);if(!req)throw new Error(`unknown access request ${id}`);if(this.project){if(!req.taskId)throw new Error("Taskless project access request is not owned");this.decisionActor(actor,req.taskId);}return this.decideRecord(id,approve,decidedBy,reason);});
  }
  private decideRecord(id:number,approve:boolean,decidedBy:string,reason:string):AccessRequest{
    const req=this.get(id);if(!req)throw new Error(`unknown access request ${id}`);if(req.status!=="pending")return req;
    let incarnation:string|null=null;
    if(this.project){const raw=z.object({lease_json:z.string().nullable()}).strict().parse(this.db.prepare("SELECT lease_json FROM brain_access_requests WHERE id=?").get(id));if(raw.lease_json===null)throw new Error("Legacy Brain request needs explicit identity migration");const lease=LeaseRefSchema.parse(JSON.parse(raw.lease_json));const task=z.object({lease_incarnation:z.string().regex(/^[a-f0-9]{32}$/),run_count:z.number().int().nonnegative(),project_id:z.string()}).strict().optional().parse(this.db.prepare("SELECT lease_incarnation,run_count,project_id FROM tasks WHERE id=?").get(req.taskId));if(!task||task.lease_incarnation!==lease.incarnation||task.run_count<lease.runCount||task.project_id!==lease.project||lease.project!==this.project.identity.slug)throw new Error("Original Brain access request task incarnation changed");incarnation=lease.incarnation;}
    this.db.prepare("UPDATE brain_access_requests SET status=?,decided_by=?,decision_reason=?,decided_at=? WHERE id=?").run(approve?"approved":"denied",decidedBy,reason.slice(0,1000),this.now(),id);
    if(approve&&req.taskId){this.task(req.taskId);this.pattern(req.pattern,req.mode);this.db.prepare("INSERT INTO brain_grants(task_id,pattern,mode,granted_by,request_id,created_at,lease_incarnation) VALUES(?,?,?,?,?,?,?)").run(req.taskId,req.pattern,req.mode,decidedBy,id,this.now(),incarnation);}return this.get(id)!;
  }
}
