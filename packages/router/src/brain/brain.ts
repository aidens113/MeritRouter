import { loadConfig } from "../config/load.js";
import { z } from "zod";
import YAML from "yaml";
import { assertStoreRole } from "../storage/store-role.js";
import { readStoreIdentity,ProjectStoreIdentitySchema,type ProjectStoreIdentity } from "../projects/store-identity.js";
import { projectRuntimePaths } from "../projects/runtime-paths.js";
import { assertProjectBrainPrincipal } from "./access.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, lstatSync, realpathSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import type { BrainMode } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import { assertBrainGitPath, brainMountHistory, brainMountPathspecs, resolveBrainGitDocument, type BrainGitDocument } from "./mount-git.js";
import { git } from "../workspaces/git.js";
import { withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import { isGitSegment } from "../context/repo-reader.js";
import { blame, commitAs, type Actor, type BlameLine } from "../attribution/index.js";
import { denial, isBrainIndex, type Grant, type Principal } from "./access.js";
import { GlobalPromotions, type ProjectScope, type PromotionOutcome, type PromotionReviewPort } from "./promotion.js";
import {
  appendToSection,
  channelEntryIds,
  formatChannelEntry,
  formatLedgerEntry,
  formatReport,
  ledgerEntryCount,
  parseDoc,
  replaceSection,
  section,
  setHeaderField,
  validateCurrentState,
  validateHeader,
  validateLedgerEntry,
  validateReport,
  workingDocTemplate,
  TEAM_CHANNEL_SECTION,
  type ChannelEntryFields,
  type LedgerFields,
  type ReportFields,
} from "./protocol.js";

export type EntryKind = "working_doc" | "report" | "archive" | "lesson" | "glossary" | "decision" | "fact" | "repo_notes" | "index" | "note";

export interface BrainEntry {
  path: string;
  kind: EntryKind;
  title: string | null;
  status: string | null;
  lines: number;
  mtime: number;
}

export class BrainError extends Error {
  readonly code = "brain_rejected";
  constructor(
    message: string,
    /** Individual protocol or access problems, for showing next to the input. */
    readonly issues: string[] = [message],
  ) {
    super(message);
  }
}

export const brainContentDigest = (content: string) => createHash("sha256").update(content).digest("hex");
export class BrainConflictError extends Error {
  readonly code = "brain_conflict";
  constructor() { super("This document changed since it was opened. Reload the current version before saving; your draft has been preserved."); }
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(homedir(), p.slice(2)) : p;
}

/** Normalize a brain-relative path; refuses escapes, absolute paths, and git internals. */
export function normalizeBrainPath(p: string): string {
  if (/^[A-Za-z]:/.test(p)) throw new BrainError(`brain paths are relative: ${p}`);
  const posix = p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const norm = path.posix.normalize(posix || ".");
  if (norm === ".." || norm.startsWith("../")) throw new BrainError(`path escapes the brain: ${p}`);
  if (norm !== "." && norm.split("/").some((seg) => isGitSegment(seg) || /[. ]$/.test(seg))) throw new BrainError(`invalid brain path: ${p}`);
  return norm === "." ? "" : norm;
}

/** Kind from the path, case-insensitively (so `E.MD` cannot dodge working-document rules). */
export function kindOf(input: string): EntryKind {
  const p = input.toLowerCase();
  if (isBrainIndex(p)) return "index";
  if (/\/working\/[^/]+\/reports\/[^/]+\.md$/.test(p)) return "report";
  if (/\/working\/[^/]+\/archive\//.test(p)) return "archive";
  if (/\/working\/[^/]+\.md$/.test(p)) return "working_doc";
  if (/^projects\/[a-z0-9][a-z0-9._-]*\/labs\/[a-z0-9][a-z0-9-]{0,40}\.md$/.test(p)) return "working_doc";
  if (/^global\/lessons\//.test(p)) return "lesson";
  if (/glossary\.md$/.test(p)) return "glossary";
  if (/\/decisions\//.test(p)) return "decision";
  if (/\/facts\//.test(p)) return "fact";
  if (/\/repos\/[^/]+\.md$/.test(p)) return "repo_notes";
  return "note";
}

/** A project's generated index of its working documents. */
export const projectIndexPath = (project: string) => `projects/${project}/README.md`;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note";

export interface BrainMutationControl {
  /** Host-only opaque authority; never supplied by a model operation. */
  mutation?: RepositoryMutationCapability;
  /** Deletion holds the common lease; remote I/O must be drained after releasing it. */
  deferPush?: boolean;
}

export interface SharedBrainKnowledgePort {
  /** Global public knowledge only; implementations never persist private search queries. */
  read(path:string):{content:string}|null;
  list(prefix:string):BrainEntry[];
  search(query:string,opts:{prefix?:string;limit:number;offset:number}):Array<{path:string;title:string|null;kind:EntryKind;snippet:string}>;
  /** Durable expected-digest CAS/idempotent publication of an already reviewed/approved sanitized lesson. */
  publishApprovedLesson?(input:{path:string;content:string;publicationDigest:string;expectedDigest:string|null}):Promise<{path:string;commit:string|null;digest:string}>;
}
export interface ProjectBrainOptions {identity:ProjectStoreIdentity;assertRuntime():void;sharedKnowledge?:SharedBrainKnowledgePort}
const BrainEntrySchema=z.object({path:z.string(),kind:z.enum(["working_doc","report","archive","lesson","glossary","decision","fact","repo_notes","index","note"]),title:z.string().nullable(),status:z.string().nullable(),lines:z.number().int().nonnegative(),mtime:z.number().finite()}).strict();

export interface BrainOptions {
  project?:ProjectBrainOptions;
  /** The independent reviewer of global promotions (a function: the service builds it after its brains). */
  reviewer?: PromotionReviewPort | (() => PromotionReviewPort | null | undefined) | null;
}

/** The literal directory prefix a grant pattern can match under ('' when it can match anything). */
function grantPrefix(pattern: string): string {
  const cut = pattern.search(/[*?{}[\]!()+@]/);
  if (cut < 0) return pattern;
  const lit = pattern.slice(0, cut);
  return lit.slice(0, lit.lastIndexOf("/") + 1);
}

const brainMutationQueues = new Map<string, Promise<unknown>>();

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Shared knowledge stored as markdown in a git repository. Agents reach it only through these
 * methods, which enforce scoped access and the working-document protocol, and commit every
 * write under the writing agent's identity.
 */
export class Brain {
  readonly root: string;
  private readonly projectMode:ProjectBrainOptions|undefined;
  private readonly mounts: Array<{ prefix: string; abs: string; commit: boolean }>;
  private chains = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | null = null;
  private readonly queueOwners = new Map<string, string>();
  private readonly pendingPushes = new Set<string>();
  private indexRefresh: Promise<number> | null = null;
  private indexRefreshedAt = 0;
  /** Gated promotion of lessons to `global/` (decision D9): records, review, approval. */
  readonly promotions: GlobalPromotions;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    opts: BrainOptions = {},
  ) {
    this.projectMode=opts.project?{...opts.project,identity:Object.freeze(ProjectStoreIdentitySchema.parse(opts.project.identity))}:undefined;
    const role=readStoreIdentity(db);if(role?.role==="coordination")throw new BrainError("Private Brain cannot use coordination store");if(role?.role==="project"&&!opts.project)throw new BrainError("Project Brain requires explicit pinned local options");
    const base = path.dirname(cfg.configPath);
    this.root = path.resolve(base, expandHome(cfg.brain.path));
    this.mounts = cfg.brain.mounts
      .map((m) => ({ prefix: normalizeBrainPath(m.prefix), abs: path.resolve(base, expandHome(m.path)), commit: m.commit }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    if(this.projectMode){const identity=ProjectStoreIdentitySchema.parse(this.projectMode.identity),directory=(cfg as {projectDirectory?:unknown}).projectDirectory;if(typeof directory!=="string"||path.resolve(projectRuntimePaths(directory).brain).toLowerCase()!==this.root.toLowerCase()||cfg.brain.project!==identity.slug)throw new BrainError("Project Brain root/configuration differs from pinned project runtime");for(const mount of this.mounts){if(!mount.prefix.startsWith(`projects/${identity.slug}/`))throw new BrainError("Project Brain mounts must remain in its own namespace");if(!this.localTarget(mount.abs))throw new BrainError("Project Brain mount must stay beneath its own canonical .MeritRouter runtime");}this.owner();}
    const reviewer = opts.reviewer;
    this.promotions = new GlobalPromotions({
      scope: () => this.scope(),
      exists: (rel) => this.exists(rel),
      readText: (rel) => {
        if(this.projectMode&&rel.startsWith("global/"))return this.readShared(rel);
        const r = this.resolve(rel);
        return existsSync(r.abs) && statSync(r.abs).isFile() ? readFileSync(r.abs, "utf8") : null;
      },
      listDir: (rel) => {
        if(this.projectMode&&(rel==="global"||rel.startsWith("global/")))return this.sharedEntries(rel).filter(entry=>path.posix.dirname(entry.path)===rel).map(entry=>path.posix.basename(entry.path));
        const r = this.resolve(rel);
        return existsSync(r.abs) && statSync(r.abs).isDirectory() ? readdirSync(r.abs).filter((n) => n.endsWith(".md") && !n.startsWith(".")) : [];
      },
      repoHas: (root, rel) => existsSync(path.join(root, ...rel.split("/"))),
      write: (rel, content, actor, message) => this.projectMode&&rel.startsWith("global/")?this.publishShared(rel,content):this.writeFile(normalizeBrainPath(rel), content, actor, message),
      ...(this.projectMode?{publicProjection:({promotionId,title,body}:{promotionId:string|null;title:string;body:string})=>({publicationDigest:brainContentDigest(JSON.stringify({promotionId,title,body}))})}:{}),
      requiresApproval: () => this.projectMode?loadConfig(this.cfg.configPath).brain.global_requires_approval:this.cfg.brain.global_requires_approval,
      reviewer: () => (typeof reviewer === "function" ? (reviewer() ?? null) : (reviewer ?? null)),
      error: (message, issues) => new BrainError(message, issues),
      now: this.now,
    });
  }

  private localTarget(target:string):boolean{
    const directory=(this.cfg as {projectDirectory?:string}).projectDirectory;
    const roots=directory?[projectRuntimePaths(directory).root]:[];
    const inside=(root:string,file:string)=>{const rel=path.relative(path.resolve(root),path.resolve(file));return rel===""||!path.isAbsolute(rel)&&rel!==".."&&!rel.startsWith(`..${path.sep}`);};
    if(!roots.some(root=>inside(root,target)))return false;
    let existing=path.resolve(target);while(!existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)return false;existing=parent;}
    const real=realpathSync(existing);return roots.some(root=>{let actualRoot=path.resolve(root);if(existsSync(actualRoot)){const canonical=realpathSync(actualRoot);if((process.platform==="win32"?canonical.toLowerCase():canonical)!==(process.platform==="win32"?actualRoot.toLowerCase():actualRoot))return false;actualRoot=canonical;}return inside(actualRoot,real);});
  }
  private owner():void{
    if(!this.projectMode)return;this.projectMode.assertRuntime();assertStoreRole(this.db,this.projectMode.identity);
    if(this.cfg.brain.project!==this.projectMode.identity.slug)throw new BrainError("Brain project configuration changed");
    const paths=z.array(z.object({path:z.string()}).strict()).parse(this.db.prepare("SELECT path FROM brain_files UNION SELECT path FROM brain_fts").all());if(paths.some(row=>!this.owns(row.path)))throw new BrainError("Project Brain index contains foreign or global rows; explicit migration required");
  }
  private shared():SharedBrainKnowledgePort{this.owner();const port=this.projectMode?.sharedKnowledge;if(!port)throw new BrainError("Shared global knowledge requires an explicit port");return port;}
  private readShared(rel:string):string|null{const value=z.object({content:z.string().max(2000000)}).strict().nullable().parse(this.shared().read(rel));return value?.content??null;}
  private globalPath(rel:string):boolean{return rel==="global"||rel.startsWith("global/");}
  private sharedEntries(prefix:string):BrainEntry[]{return z.array(BrainEntrySchema).max(10000).parse(this.shared().list(prefix)).map(entry=>{if(!entry.path.startsWith("global/")||normalizeBrainPath(entry.path)!==entry.path)throw new BrainError("Shared knowledge port returned a private path");return entry;});}
  private async publishShared(rel:string,content:string|((current:string|null)=>string|null)):Promise<{path:string;commit:string|null;digest:string}>{
    const port=this.shared();if(!port.publishApprovedLesson||!/^global\/lessons\/[^/]+\.md$/.test(rel))throw new BrainError("Shared approved lesson publication port is unavailable");
    const current=this.readShared(rel),next=typeof content==="function"?content(current):content;if(next===null)return {path:rel,commit:null,digest:brainContentDigest(current??"")};
    z.string().max(2000000).parse(next);
    const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(next);if(!match)throw new BrainError("Shared lesson has no sanitized publication metadata");
    const metadata=z.object({kind:z.literal("lesson"),publication_digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(YAML.parse(match[1]!));
    const result=z.object({path:z.string(),commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await port.publishApprovedLesson({path:rel,content:next,publicationDigest:metadata.publication_digest,expectedDigest:current===null?null:brainContentDigest(current)}));
    if(result.path!==rel||result.digest!==brainContentDigest(next))throw new BrainError("Shared publication receipt does not match approved content");return result;
  }

  /** The project this brain serves: its slug, name, and repositories (what a global lesson must not name). */
  scope(): ProjectScope {
    this.owner();const info = (this.cfg as { project?: { slug: string; name: string } }).project;
    return {
      slug: this.project,
      name: info?.name ?? this.project,
      repositories: Object.entries(this.cfg.repositoryPaths).map(([alias, r]) => ({ alias, path: r.path })),
    };
  }

  /** Paths this brain's project maintains in the shared index: everything except other projects' folders. */
  private owns(rel: string): boolean {
    const p = rel.toLowerCase();
    if(this.projectMode)return p==="readme.md"||p===`projects/${this.project.toLowerCase()}`||p.startsWith(`projects/${this.project.toLowerCase()}/`);
    return !p.startsWith("projects/") || p.startsWith(`projects/${this.project.toLowerCase()}/`);
  }

  get project(): string {
    return this.cfg.brain.project;
  }

  workingDocPath(effort: string): string {
    return `projects/${this.project}/working/${effort}.md`;
  }

  /** Create the brain repository and its skeleton on first use. */
  ensure(control: BrainMutationControl = {}): Promise<void> {
    this.owner();
    // A host already holding the common lease must not wait for an initializer queued
    // behind that same lease. Bootstrap is idempotent and revalidates its supplied scope.
    if (control.mutation !== undefined) return this.initialize(control);
    return this.ready ??= this.initialize(control);
  }

  private async initialize(control: BrainMutationControl): Promise<void> {
    if (control.mutation !== undefined) await withRepositoryMutation([this.root], async () => {}, { capability: control.mutation });
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(path.join(this.root, ".git"))) {
      await this.locked(this.root, async () => {
        if (!existsSync(path.join(this.root, ".git"))) {
          await git(this.root, ["init", "-q", "-b", "main"]);
          await git(this.root, ["config", "core.autocrlf", "false"]);
        }
      });
    }
    const own = this.resolve(projectIndexPath(this.project));
    const ownBinding = own.repo && own.repo !== this.root && own.commit ? await this.resolveGitDocument(own.rel) : null;
    const ownOwner = ownBinding?.repo ?? (own.repo !== this.root ? await this.effectRepository(own.abs) : null);
    await this.mutate([this.root, ...(ownOwner ? [ownOwner] : [])], mutation => this.locked(this.root, async () => {
      if (ownBinding) assertBrainGitPath(ownBinding, own.abs);
      const created: string[] = [];
      for (const dir of [...(this.projectMode?[]:["global/lessons"]), `projects/${this.project}/working`, `projects/${this.project}/decisions`, `projects/${this.project}/repos`]) {
        mkdirSync(path.join(this.root, dir), { recursive: true });
      }
      const glossary = path.join(this.root, "global/glossary.md");
      if (!this.projectMode&&!existsSync(glossary)) { writeFileSync(glossary, "# Glossary\n\nShared terms. Supervisors maintain this file.\n"); created.push("global/glossary.md"); }
      if (!existsSync(path.join(this.root, "README.md"))) { writeFileSync(path.join(this.root, "README.md"), this.renderIndex([])); created.push("README.md"); }
      if (!existsSync(own.abs)) {
        mkdirSync(path.dirname(own.abs), { recursive: true });
        writeFileSync(own.abs, this.renderProjectIndex([]));
        if (own.repo === this.root) created.push(own.repoRel);
      }
      // Reopening a Brain must not scan/adopt every user file or stage unrelated changes.
      if (this.cfg.brain.commit && created.length) await commitAs(this.root, { agent: "meritrouter", role: "tool" }, "Initialise brain", { paths: created.map(rel => `:(literal)${rel}`) }, { mutation });
    }), control);
  }

  /** A non-committing mount can still be Git-backed and must honor its owner's fence. */
  private async effectRepository(target: string): Promise<string | null> {
    let directory = path.resolve(target);
    while (true) {
      try { lstatSync(path.join(directory, ".git")); return (await git(directory, ["rev-parse", "--show-toplevel"])).trim(); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
    }
  }

  private async pushAfterMutation(repo: string, commit: string | null, control: BrainMutationControl): Promise<void> {
    if (!this.cfg.brain.push || !commit) return;
    if (control.mutation !== undefined || control.deferPush) { this.pendingPushes.add(repo); return; }
    await git(repo, ["push", "-q"]).catch(() => undefined);
  }

  /** Host calls only after releasing its outer repository lease. */
  async pushPending(): Promise<void> {
    for (const repo of [...this.pendingPushes]) {
      this.pendingPushes.delete(repo);
      await git(repo, ["push", "-q"]).catch(() => undefined);
    }
  }

  /** Map a brain path to a file, honouring mounts (e.g. a repository's docs/working). */
  resolve(relInput: string): { rel: string; abs: string; repo: string | null; repoRel: string; commit: boolean } {
    this.owner();const rel = normalizeBrainPath(relInput);
    if(this.projectMode&&rel!==""&&rel!=="projects"&&!this.owns(rel))throw new BrainError("Brain path is outside pinned local project namespace");
    for (const m of this.mounts) {
      if (rel === m.prefix || rel.startsWith(`${m.prefix}/`)) {
        const sub = rel.slice(m.prefix.length).replace(/^\//, "");
        const abs=path.join(m.abs,...sub.split("/").filter(Boolean));if(this.projectMode&&!this.localTarget(abs))throw new BrainError("Project Brain path is redirected outside allowed roots");
        return { rel, abs, repo: m.commit ? m.abs : null, repoRel: sub, commit: m.commit };
      }
    }
    const abs=path.join(this.root,...rel.split("/").filter(Boolean));if(this.projectMode&&!this.localTarget(abs))throw new BrainError("Project Brain path is redirected outside allowed roots");
    return { rel, abs, repo: this.root, repoRel: rel, commit: this.cfg.brain.commit };
  }

  /** Resolve a configured document mount to its verified Git root without broadening mount visibility. */
  async resolveGitDocument(relInput: string): Promise<BrainGitDocument | null> {
    return resolveBrainGitDocument(this.resolve(relInput));
  }

  private check(p: Principal, rel: string, mode: BrainMode): void {
    if(this.projectMode){this.owner();assertProjectBrainPrincipal(this.db,p,rel);}
    const d = denial(p, rel, mode);
    if (d) throw new BrainError(d);
  }

  /** Queue cooperating Brain effects before acquiring common authority, never while holding it. */
  private async mutate<T>(repos: string[], action: (mutation: RepositoryMutationCapability) => Promise<T>, control: BrainMutationControl = {}): Promise<T> {
    const execute = () => withRepositoryMutation(repos, mutation=>{this.owner();return action(mutation);}, { capability: control.mutation });
    // A nested host already owns its sorted scopes. Waiting for a normal operation
    // queued behind that same host would deadlock; the original capability is revalidated.
    if (control.mutation !== undefined) return execute();
    // Queue keys only order this process's cooperating Brain effects; the repository mutation
    // fence re-resolves and locks the real owners. Cache the lookup instead of a Git process per write.
    const owners = [...new Set(await Promise.all(repos.map(async repo => {
      const cached = this.queueOwners.get(repo);
      if (cached) return cached;
      const common = realpathSync((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
      const owner = process.platform === "win32" ? common.toLowerCase() : common;
      this.queueOwners.set(repo, owner);
      return owner;
    })))];
    const previous = owners.map(owner => brainMutationQueues.get(owner) ?? Promise.resolve());
    const run = Promise.all(previous.map(pending => pending.catch(() => undefined))).then(execute);
    for (const owner of owners) brainMutationQueues.set(owner, run);
    const release = () => { for (const owner of owners) if (brainMutationQueues.get(owner) === run) brainMutationQueues.delete(owner); };
    void run.then(release, release);
    return run;
  }

  /** Serialize writes per repository (in-process chain plus a cross-process lock file). */
  private async locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repo) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      // Stable cross-version synchronization protocol; renaming this could permit concurrent writes.
      const lock = path.join(repo, ".switchyard-brain.lock");
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          closeSync(openSync(lock, "wx"));
          break;
        } catch {
          try {
            if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
          } catch {
            // lock disappeared meanwhile
          }
          if (Date.now() > deadline) throw new BrainError("brain is locked by another process");
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      try {
        return await fn();
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          // already removed
        }
      }
    });
    this.chains.set(repo, run);
    return run as Promise<T>;
  }

  /** Commit edits made outside MeritRouter (editor, scripts) as the user, before MeritRouter writes. */
  private async adoptExternalEdits(repo: string, binding: BrainGitDocument | undefined, mutation: RepositoryMutationCapability): Promise<void> {
    const paths = binding ? brainMountPathspecs(binding) : [".", ":(exclude).switchyard-brain.lock"];
    const status = await git(repo, ["status", "--porcelain", "--", ...paths]);
    const changed = status.split("\n").filter((l) => l.trim() && !l.endsWith(".switchyard-brain.lock"));
    if (changed.length) await commitAs(repo, { agent: "human", role: "human" }, "Record edits made outside MeritRouter", { paths }, { mutation });
  }

  /**
   * Write a file and commit it. `content` may be a function of the file's current text (null
   * when absent), evaluated under the repository lock; returning null skips the write.
   */
  private async writeFile(rel: string, contentOrFn: string | ((current: string | null) => string | null), actor: Actor, message: string, opts: { expectedDigest?: string | null } = {}, control: BrainMutationControl = {}): Promise<{ path: string; commit: string | null; digest: string }> {
    await this.ensure(control);
    const r = this.resolve(rel);
    const binding = r.repo && r.commit ? await this.resolveGitDocument(rel) : null;
    const effectRepo = binding?.repo ?? r.repo ?? await this.effectRepository(r.abs);
    const doWrite = async (mutation?: RepositoryMutationCapability) => {
      this.owner();
      if (opts.expectedDigest !== undefined) {
        const current = existsSync(r.abs) ? brainContentDigest(readFileSync(r.abs, "utf8")) : null;
        if (current !== opts.expectedDigest) throw new BrainConflictError();
      }
      if (binding) { assertBrainGitPath(binding, r.abs); await this.adoptExternalEdits(binding.repo, binding, mutation!); }
      const content = typeof contentOrFn === "string" ? contentOrFn : contentOrFn(existsSync(r.abs) ? readFileSync(r.abs, "utf8") : null);
      if (content === null) return { path: rel, commit: null, digest: existsSync(r.abs) ? brainContentDigest(readFileSync(r.abs, "utf8")) : "" };
      const next = content.endsWith("\n") ? content : `${content}\n`;
      // Admission, revision/path checks and outside-edit adoption have already run.
      // An identical generated index does not need another native publication.
      if (existsSync(r.abs) && readFileSync(r.abs).equals(Buffer.from(next, "utf8"))) {
        this.indexFile(rel);
        return { path: rel, commit: null, digest: brainContentDigest(next) };
      }
      mkdirSync(path.dirname(r.abs), { recursive: true });
      const tmp = `${r.abs}.${process.pid}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, r.abs);
      let commit: string | null = null;
      if (binding) {
        commit = await commitAs(binding.repo, actor, message.slice(0, 200), { paths: [`:(literal)${binding.repoRel}`] }, { mutation });
      }
      this.indexFile(rel);
      return { path: rel, commit, digest: brainContentDigest(content.endsWith("\n") ? content : `${content}\n`) };
    };
    const result = effectRepo ? await this.mutate([effectRepo], mutation => this.locked(r.repo ?? effectRepo, () => doWrite(mutation)), control) : await doWrite();
    if (binding) await this.pushAfterMutation(binding.repo, result.commit, control);
    return result;
  }

  exists(rel: string): boolean {
    const normalized=normalizeBrainPath(rel);if(this.projectMode&&this.globalPath(normalized))return this.readShared(normalized)!==null;
    return existsSync(this.resolve(rel).abs);
  }

  read(p: Principal, rel: string, opts: { section?: string } = {}): { path: string; kind: EntryKind; content: string; lines: number; digest: string } {
    const normalized=normalizeBrainPath(rel);if(this.projectMode&&this.globalPath(normalized)){this.check(p,normalized,"read");const record=this.readShared(normalized);if(record===null)throw new BrainError(`${normalized} does not exist`);let content=z.string().max(2000000).parse(record),digest=brainContentDigest(content);if(opts.section){const found=section(parseDoc(content),opts.section);if(!found)throw new BrainError("Shared section does not exist");content=found.body;}return {path:normalized,kind:kindOf(normalized),content,lines:content.split("\n").length,digest};}
    const r = this.resolve(rel);
    this.check(p, r.rel, "read");
    if (!existsSync(r.abs)) throw new BrainError(`${r.rel} does not exist`);
    let content = readFileSync(r.abs, "utf8");
    const digest = brainContentDigest(content);
    if (opts.section) {
      const s = section(parseDoc(content), opts.section);
      if (!s) throw new BrainError(`${r.rel} has no '${opts.section}' section`);
      content = s.body;
    }
    return { path: r.rel, kind: kindOf(r.rel), content, lines: content.split("\n").length, digest };
  }

  /** Files under a prefix that the principal may read. */
  list(p: Principal, prefix = ""): BrainEntry[] {
    this.owner();if(this.projectMode)assertProjectBrainPrincipal(this.db,p);
    const start = normalizeBrainPath(prefix);
    if(this.projectMode&&this.globalPath(start))return this.sharedEntries(start).filter(entry=>denial(p,entry.path,"read")===null);
    const out: BrainEntry[] = [];
    const walk = (rel: string) => {
      if(this.projectMode&&rel!==""&&rel!=="projects"&&!this.owns(rel))return;
      const r = this.resolve(rel);
      if (!existsSync(r.abs)) return;
      const st = statSync(r.abs);
      if (st.isDirectory()) {
        for (const name of readdirSync(r.abs)) {
          if (name.startsWith(".")) continue;
          walk(rel ? `${rel}/${name}` : name);
        }
        // Mounts below this directory are walked even when the folder does not exist in the brain.
        for (const m of this.mounts) if (path.posix.dirname(m.prefix) === (rel || ".") && !existsSync(path.join(r.abs, path.posix.basename(m.prefix)))) walk(m.prefix);
      } else if (rel.endsWith(".md") && denial(p, rel, "read") === null) {
        const text = readFileSync(r.abs, "utf8");
        const doc = parseDoc(text);
        out.push({ path: rel, kind: kindOf(rel), title: doc.title, status: doc.header.Status ?? null, lines: doc.lines.length, mtime: st.mtimeMs });
      }
    };
    walk(start);
    if(this.projectMode&&this.projectMode.sharedKnowledge&&start==="")out.push(...this.sharedEntries("global/").filter(entry=>denial(p,entry.path,"read")===null));
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---------- writes with protocol rules ----------

  /** Create or replace a file. Working documents keep their ledger append-only. */
  async write(p: Principal, actor: Actor, rel: string, content: string, message?: string, opts: { expectedDigest?: string | null } = {}): Promise<{ path: string; commit: string | null; digest: string }> {
    const r = this.resolve(rel);
    if (!r.rel.toLowerCase().endsWith(".md")) throw new BrainError(`brain entries are markdown files ending in .md: ${r.rel}`);
    this.check(p, r.rel, "write");
    const kind = kindOf(r.rel);
    if (kind === "report") {
      const issues = validateReport(content);
      if (issues.length) throw new BrainError(`report rejected: ${issues.join("; ")}`, issues);
    }
    if (kind === "working_doc") {
      const doc = parseDoc(content);
      const issues = validateHeader(doc);
      const cs = section(doc, "Current State");
      if (!cs) issues.push("working documents need a '## Current State' section");
      else issues.push(...validateCurrentState(cs.body, this.cfg.brain.current_state_max_lines));
      if (existsSync(r.abs)) {
        const oldLedger = section(parseDoc(readFileSync(r.abs, "utf8")), "Work Ledger")?.body.trim() ?? "";
        const newLedger = section(doc, "Work Ledger")?.body.trim() ?? "";
        if (oldLedger && !newLedger.startsWith(oldLedger)) issues.push("the Work Ledger is append-only: existing entries must stay unchanged (use compaction to archive history)");
        const oldChannel = section(parseDoc(readFileSync(r.abs, "utf8")), TEAM_CHANNEL_SECTION)?.body.trim() ?? "";
        const newChannel = section(doc, TEAM_CHANNEL_SECTION)?.body.trim() ?? "";
        if (oldChannel && !newChannel.startsWith(oldChannel)) issues.push(`the ${TEAM_CHANNEL_SECTION} is append-only: it mirrors the job's channel and must stay unchanged`);
      }
      if (issues.length) throw new BrainError(`working document rejected: ${issues.join("; ")}`, issues);
      content = setHeaderField(content, "Last updated", new Date(this.now()).toISOString().slice(0, 10));
    }
    return this.writeFile(r.rel, content, actor, message ?? `${existsSync(r.abs) ? "Update" : "Add"} ${r.rel}`, opts);
  }

  async createWorkingDoc(p: Principal, actor: Actor, effort: string, f: { title: string; statusDetail: string; owner: string; scope: string; related?: string; currentState: string }): Promise<{ path: string; commit: string | null }> {
    const rel = this.workingDocPath(slugify(effort));
    if (this.exists(rel)) throw new BrainError(`${rel} already exists`);
    const r = await this.write(p, actor, rel, workingDocTemplate(f, new Date(this.now()).toISOString().slice(0, 10)), `Start working document ${rel}`);
    await this.regenerateIndex(actor);
    return r;
  }

  /** Rewrite `Current State` (the authoritative section). Workers never may. */
  async setCurrentState(p: Principal, actor: Actor, rel: string, body: string): Promise<{ path: string; commit: string | null }> {
    const r = this.resolve(rel);
    this.check(p, r.rel, "write");
    if (kindOf(r.rel) !== "working_doc") throw new BrainError(`${r.rel} is not a working document`);
    const issues = validateCurrentState(body, this.cfg.brain.current_state_max_lines);
    if (issues.length) throw new BrainError(issues.join("; "));
    const text = readFileSync(r.abs, "utf8");
    const next = setHeaderField(replaceSection(text, "Current State", body), "Last updated", new Date(this.now()).toISOString().slice(0, 10));
    return this.writeFile(r.rel, next, actor, `Update Current State of ${r.rel}`);
  }

  /** Append one ledger entry. Requires a real validation record. */
  async appendLedger(p: Principal, actor: Actor, rel: string, entry: string | LedgerFields): Promise<{ path: string; commit: string | null; compactionDue: boolean }> {
    const r = this.resolve(rel);
    this.check(p, r.rel, "append");
    if (kindOf(r.rel) !== "working_doc") throw new BrainError(`${r.rel} is not a working document`);
    const text = typeof entry === "string" ? entry.trim() : formatLedgerEntry(entry, new Date(this.now()).toISOString().slice(0, 10));
    const issues = validateLedgerEntry(text);
    if (issues.length) throw new BrainError(`ledger entry rejected: ${issues.join("; ")}`, issues);
    const current = readFileSync(r.abs, "utf8");
    const next = setHeaderField(appendToSection(current, "Work Ledger", text, "Open Questions"), "Last updated", new Date(this.now()).toISOString().slice(0, 10));
    const res = await this.writeFile(r.rel, next, actor, `Ledger: ${text.split("\n")[0]!.replace(/^### /, "")}`);
    const doc = parseDoc(next);
    return { ...res, compactionDue: doc.lines.length > this.cfg.brain.compact_at_lines || ledgerEntryCount(doc) > this.cfg.brain.compact_at_ledger_entries };
  }

  /** Record a worker brief in the working document before dispatch. */
  async addBrief(p: Principal, actor: Actor, rel: string, brief: string): Promise<{ path: string; commit: string | null }> {
    const r = this.resolve(rel);
    this.check(p, r.rel, "write");
    const next = appendToSection(readFileSync(r.abs, "utf8"), "Worker Briefs", brief, "Work Ledger");
    return this.writeFile(r.rel, next, actor, `Brief: ${brief.split("\n")[0]!.replace(/^### Brief: /, "")}`);
  }

  /**
   * Mirror team channel posts into a working document's append-only Team Channel section
   * (created before the Work Ledger). A system write on behalf of the posts' authors: the posts
   * were already validated and stored, so no principal is checked. Entries the section already
   * holds (by post id) are skipped, under the repository lock. Returns the ids now mirrored.
   */
  async appendChannel(actor: Actor, rel: string, entries: ChannelEntryFields[]): Promise<{ path: string; commit: string | null; mirrored: number[] }> {
    const r = this.resolve(rel);
    if (kindOf(r.rel) !== "working_doc") throw new BrainError(`${r.rel} is not a working document`);
    if (!existsSync(r.abs)) throw new BrainError(`${r.rel} does not exist`);
    let mirrored: number[] = [];
    const res = await this.writeFile(
      r.rel,
      (current) => {
        if (current === null) return null;
        const present = channelEntryIds(section(parseDoc(current), TEAM_CHANNEL_SECTION)?.body ?? "");
        const fresh = entries.filter((e) => !present.has(e.id));
        mirrored = entries.map((e) => e.id);
        if (!fresh.length) return null;
        let next = current;
        for (const e of fresh) next = appendToSection(next, TEAM_CHANNEL_SECTION, formatChannelEntry(e), "Work Ledger");
        return next;
      },
      actor,
      `Team channel: ${entries.map((e) => `#${e.id}`).join(", ")}`,
    );
    return { ...res, mirrored };
  }

  async writeReport(p: Principal, actor: Actor, rel: string, report: string | ReportFields): Promise<{ path: string; commit: string | null }> {
    return this.write(p, actor, rel, typeof report === "string" ? report : formatReport(report), `Report ${path.posix.basename(rel, ".md")}`);
  }

  /**
   * Promote a lesson to global knowledge. Only supervisors and people may. A person's lesson is
   * written at once; a supervisor's goes through the gates of decision D9 (see `GlobalPromotions`)
   * and usually comes back pending review, or rejected and kept in the project with the reason.
   */
  async promoteLesson(p: Principal, actor: Actor, title: string, body: string, sources: string[]): Promise<PromotionOutcome> {
    if(this.projectMode)assertProjectBrainPrincipal(this.db,p);
    if (p.kind === "agent" && p.role !== "supervisor") throw new BrainError("only supervisors promote lessons");
    await this.ensure();
    return this.promotions.promote(p, actor, { title, body, sources });
  }

  /** Move ledger history to the archive, leaving a pointer (compaction). */
  async compact(p: Principal, actor: Actor, rel: string, keepLastEntries = 5): Promise<{ archive: string }> {
    const r = this.resolve(rel);
    this.check(p, r.rel, "write");
    const text = readFileSync(r.abs, "utf8");
    const doc = parseDoc(text);
    const ledger = section(doc, "Work Ledger")?.body ?? "";
    const entries = ledger.split(/\n(?=### )/).filter((e) => e.trim());
    if (entries.length <= keepLastEntries) return { archive: "" };
    const moved = entries.slice(0, entries.length - keepLastEntries);
    const effort = path.posix.basename(r.rel, ".md");
    const archive = `${path.posix.dirname(r.rel)}/${effort}/archive/${new Date(this.now()).toISOString().slice(0, 10)}-ledger.md`;
    await this.writeFile(archive, `# ${doc.title ?? effort}: archived ledger\n\n${moved.join("\n\n")}\n`, actor, `Archive ${moved.length} ledger entries of ${r.rel}`);
    const pointer = `Earlier entries archived in [${path.posix.basename(archive)}](./${effort}/archive/${path.posix.basename(archive)}).`;
    // Compaction is the one sanctioned rewrite of the ledger.
    await this.writeFile(r.rel, replaceSection(text, "Work Ledger", [pointer, ...entries.slice(-keepLastEntries)].join("\n\n")), actor, `Compact ${r.rel}`);
    return { archive };
  }

  /**
   * Remove an entry with a recorded reason: one commit, made under the repository lock (the same
   * lock and adoption of outside edits as every write), that deletes the file. Only people remove
   * `global/**` (global knowledge is otherwise written only by the gated promotion); anyone else
   * needs write access to the path, and the generated indexes cannot be removed. The commit's
   * trailers are `Removed-By` and `Remove-Reason` unless `opts.trailers` gives them, as a map or
   * as a function of the removed text (evaluated under the lock). Returns the removed text.
   */
  async remove(
    p: Principal,
    actor: Actor,
    relInput: string,
    reason: string,
    opts: { message?: string; trailers?: Record<string, string> | ((removedText: string) => Record<string, string>) } = {},
  ): Promise<{ path: string; commit: string | null; text: string }> {
    const r = this.resolve(relInput);
    const lower = r.rel.toLowerCase();
    if (!lower.endsWith(".md")) throw new BrainError(`brain entries are markdown files ending in .md: ${r.rel}`);
    if ((lower === "global" || lower.startsWith("global/")) && p.kind !== "human") throw new BrainError(`only a person removes global knowledge: ${r.rel}`);
    if (isBrainIndex(r.rel)) throw new BrainError(`${r.rel} is generated by MeritRouter and cannot be removed`);
    this.check(p, r.rel, "write");
    const why = reason.trim().replace(/\s+/g, " ");
    if (!why) throw new BrainError("say why the entry is removed; the reason is recorded in the brain's history");
    await this.ensure();
    const binding = r.repo && r.commit ? await this.resolveGitDocument(r.rel) : null;
    const effectRepo = binding?.repo ?? r.repo ?? await this.effectRepository(r.abs);
    const doRemove = async (mutation?: RepositoryMutationCapability) => {
      this.owner();
      if (binding) assertBrainGitPath(binding, r.abs);
      if (!existsSync(r.abs) || !statSync(r.abs).isFile()) throw new BrainError(`${r.rel} does not exist`);
      // A file written outside MeritRouter and never committed is recorded first, so its text stays in the history.
      if (binding) await this.adoptExternalEdits(binding.repo, binding, mutation!);
      const text = readFileSync(r.abs, "utf8");
      const who = p.kind === "human" ? (p.name ?? actor.agent) : actor.agent;
      const trailers = typeof opts.trailers === "function" ? opts.trailers(text) : (opts.trailers ?? { "Removed-By": who.slice(0, 200), "Remove-Reason": why.slice(0, 1000) });
      unlinkSync(r.abs);
      let commit: string | null = null;
      if (binding) {
        commit = await commitAs(binding.repo, actor, (opts.message ?? `Remove ${r.rel}`).slice(0, 200), { paths: [`:(literal)${binding.repoRel}`], extraTrailers: trailers }, { mutation });
      }
      this.indexFile(r.rel);
      return { path: r.rel, commit, text };
    };
    const result = effectRepo ? await this.mutate([effectRepo], mutation => this.locked(r.repo ?? effectRepo, () => doRemove(mutation))) : await doRemove();
    if (binding && this.cfg.brain.push && result.commit) await git(binding.repo, ["push", "-q"]).catch(() => undefined);
    return result;
  }

  /** Files under another project's folder (`projects/<slug>/`) in the shared brain repository, for a deletion preview. */
  projectFolderFiles(slug: string): number {
    const dir = this.projectFolder(slug);
    if (!existsSync(dir)) return 0;
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else n++;
      }
    };
    walk(dir);
    return n;
  }

  private projectFolder(slug: string): string {
    this.owner();if(this.projectMode&&slug!==this.projectMode.identity.slug)throw new BrainError("Project Brain cannot inspect another project folder");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug) || slug.includes("..")) throw new BrainError(`not a project slug: ${JSON.stringify(slug)}`);
    return path.join(this.root, "projects", slug);
  }

  /**
   * Remove a deleted project's folder (`projects/<slug>/`) from the shared brain repository: one
   * commit under the repository lock, after adopting outside edits (so the removed text stays in
   * the history), then drop its rows from the search index and regenerate the root index (which
   * no longer names it once the config has dropped the project). Called on a remaining project's
   * brain; never on the folder's own project. Mounts outside the brain repository are not touched.
   */
  async removeProjectFolder(slug: string, actor: Actor, reason: string, control: BrainMutationControl = {}): Promise<{ files: number; commit: string | null }> {
    if (slug.toLowerCase() === this.project.toLowerCase()) throw new BrainError(`a project's brain cannot remove its own folder (${slug})`);
    const dir = this.projectFolder(slug);
    await this.ensure(control);
    const rel = `projects/${slug}`;
    const out = await this.mutate([this.root], async mutation => {
      const nested = { ...control, mutation };
      const removed = await this.locked(this.root, async () => {
        const files = this.projectFolderFiles(slug);
        if (!existsSync(dir)) return { files: 0, commit: null };
        const commits = this.cfg.brain.commit && existsSync(path.join(this.root, ".git"));
        if (commits) await this.adoptExternalEdits(this.root, undefined, mutation);
        rmSync(dir, { recursive: true, force: true });
        let commit: string | null = null;
        if (commits && (await git(this.root, ["ls-files", "--", `:(literal)${rel}`])).trim()) {
          commit = await commitAs(this.root, actor, `Remove project ${slug}`.slice(0, 200), { paths: [`:(literal)${rel}`], extraTrailers: { "Removed-By": actor.agent.slice(0, 200), "Remove-Reason": reason.trim().replace(/\s+/g, " ").slice(0, 1000) } }, { mutation });
        }
        return { files, commit };
      });
      // Both publications precede SQL/config deletion. The configured project still exists
      // here, so explicitly omit its link rather than publishing again after task purge.
      await this.writeFile("README.md", this.renderIndex(this.list({ kind: "human" }), [slug]), actor, "Regenerate brain index", {}, nested);
      const like = `${likeEscape(`${rel}/`)}%`;
      this.db.prepare("DELETE FROM brain_fts WHERE path LIKE ? ESCAPE '\\'").run(like);
      this.db.prepare("DELETE FROM brain_files WHERE path LIKE ? ESCAPE '\\'").run(like);
      return removed;
    }, control);
    await this.pushAfterMutation(this.root, out.commit, control);
    if (!control.mutation && !control.deferPush) await this.pushPending();
    return out;
  }

  // ---------- index and search ----------

  private bumpIndexGeneration(rel: string): void {
    const projectScope = /^projects\/([^/]+)\//.exec(rel)?.[1];
    const scope = this.projectMode?`project:${this.project}`:projectScope ? `project:${projectScope}` : "global";
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`brain:index-generation:${scope}`, randomUUID());
  }

  private removeFromIndex(rel: string): void {
    this.bumpIndexGeneration(rel);
    this.db.prepare("DELETE FROM brain_fts WHERE path = ?").run(rel);
    this.db.prepare("DELETE FROM brain_files WHERE path = ?").run(rel);
  }

  private indexFile(rel: string): void {
    const r = this.resolve(rel);
    if (!rel.endsWith(".md")) return;
    if (!existsSync(r.abs)) {
      this.removeFromIndex(rel);
      return;
    }
    this.bumpIndexGeneration(rel);
    this.db.prepare("DELETE FROM brain_fts WHERE path = ?").run(rel);
    const st = statSync(r.abs);
    const text = readFileSync(r.abs, "utf8");
    const doc = parseDoc(text);
    this.db
      .prepare("INSERT INTO brain_files (path, mtime, size, title, kind, status, lines) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, title = excluded.title, kind = excluded.kind, status = excluded.status, lines = excluded.lines")
      .run(rel, st.mtimeMs, st.size, doc.title, kindOf(rel), doc.header.Status ?? null, doc.lines.length);
    this.db.prepare("INSERT INTO brain_fts (path, title, body) VALUES (?, ?, ?)").run(rel, doc.title ?? "", text);
  }

  /** Bring the index up to date with the files (cheap when nothing changed). */
  async refreshIndex(opts: { maxAgeMs?: number } = {}): Promise<number> {
    this.owner();if (this.indexRefresh) return this.indexRefresh;
    if (this.indexRefreshedAt && this.now() - this.indexRefreshedAt < (opts.maxAgeMs ?? 0)) return 0;
    this.indexRefresh = this.reconcileIndex().then(changed => {
      this.indexRefreshedAt = this.now();
      return changed;
    }).finally(() => { this.indexRefresh = null; });
    return this.indexRefresh;
  }

  private async reconcileIndex(): Promise<number> {
    await this.ensure();
    const seen = new Set<string>();
    const pending: string[] = [];
    const removed = new Set<string>();
    let changed = 0;
    // The index is shared by every project's brain; each maintains its own folder, global/, and
    // the root (another project's mounts are invisible here, so its rows are left alone).
    const known = new Map((this.db.prepare("SELECT path, mtime, size FROM brain_files").all() as Array<{ path: string; mtime: number; size: number }>).filter((r) => this.owns(r.path)).map((r) => [r.path, r]));
    // Inspect metadata only; unchanged documents must never be read or parsed during reconciliation.
    const visit = (rel: string) => {
      if (!this.owns(rel) && rel !== "projects" && rel !== `projects/${this.project}`) return;
      const resolved = this.resolve(rel);
      if (!existsSync(resolved.abs)) return;
      const st = statSync(resolved.abs);
      if (st.isDirectory()) {
        for (const entry of readdirSync(resolved.abs, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          visit(rel ? `${rel}/${entry.name}` : entry.name);
        }
        return;
      }
      if (!rel.endsWith(".md")) return;
      if (seen.has(rel)) return;
      seen.add(rel);
      const k = known.get(rel);
      if (!k || k.mtime !== st.mtimeMs || k.size !== st.size) {
        pending.push(rel);
      }
    };
    visit("");
    for (const mount of this.mounts) if (this.owns(mount.prefix)) visit(mount.prefix);
    for (const p of known.keys()) if (!seen.has(p)) { pending.push(p); removed.add(p); }
    // Bound synchronous parsing/FTS work so cold indexing does not freeze the panel event loop.
    for (let at = 0; at < pending.length; at += 100) {
      this.db.transaction(() => { for (const rel of pending.slice(at, at + 100)) { if (removed.has(rel)) this.removeFromIndex(rel); else this.indexFile(rel); changed++; } })();
      if (at + 100 < pending.length) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return changed;
  }

  /** Indexed metadata, scoped before ordering and pagination. No document bodies are loaded. */
  async catalog(p: Principal, opts: { prefix?: string; scope?: "project" | "all"; after?: string; limit?: number } = {}): Promise<{ entries: BrainEntry[]; next: string | null; refreshedAt: number; generation: string }> {
    await this.refreshIndex({ maxAgeMs: 5000 });
    const prefix = normalizeBrainPath(opts.prefix ?? "");
    if(this.projectMode){assertProjectBrainPrincipal(this.db,p);const local=z.array(BrainEntrySchema).parse(this.db.prepare("SELECT path,title,kind,status,lines,mtime FROM brain_files").all());const shared=this.projectMode.sharedKnowledge&&(!prefix||this.globalPath(prefix))?this.sharedEntries(prefix||"global/"):[];const entries=[...local,...shared].filter(entry=>entry.path.startsWith(prefix)&&entry.path>(opts.after??"")&&denial(p,entry.path,"read")===null).sort((a,b)=>a.path.localeCompare(b.path));const limit=Math.min(100,Math.max(1,Math.trunc(opts.limit??50)));const generations=z.array(z.object({key:z.string(),value:z.string()}).strict()).parse(this.db.prepare("SELECT key,value FROM meta WHERE key=?").all(`brain:index-generation:project:${this.project}`));return {entries:entries.slice(0,limit),next:entries.length>limit?entries[limit-1]!.path:null,refreshedAt:this.indexRefreshedAt,generation:brainContentDigest(JSON.stringify({generations,shared:shared.map(entry=>[entry.path,entry.mtime])}))};}
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 50)));
    const scoped = opts.scope !== "all";
    const generations = (scoped
      ? this.db.prepare("SELECT key, value FROM meta WHERE key IN (?, ?) ORDER BY key").all("brain:index-generation:global", `brain:index-generation:project:${this.project}`)
      : this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'brain:index-generation:%' ORDER BY key").all()) as Array<{ key: string; value: string }>;
    const generation = brainContentDigest(JSON.stringify(generations));
    const sql = `SELECT path, title, kind, status, lines, mtime FROM brain_files WHERE path > ? AND path LIKE ? ESCAPE '\\'${scoped ? " AND (path LIKE ? ESCAPE '\\' OR path LIKE 'global/%' OR path = 'README.md')" : ""} ORDER BY path LIMIT ?`;
    // Scan bounded chunks through ACLs so denied rows cannot crowd out visible metadata.
    const entries: BrainEntry[] = [];
    let cursor = opts.after ?? "";
    for (;;) {
      const rows = this.db.prepare(sql).all(cursor, `${likeEscape(prefix)}%`, ...(scoped ? [`${likeEscape(`projects/${this.project}/`)}%`] : []), 100) as BrainEntry[];
      for (const row of rows) if (denial(p, row.path, "read") === null) {
        entries.push(row);
        if (entries.length > limit) return { entries: entries.slice(0, limit), next: entries[limit - 1]!.path, refreshedAt: this.indexRefreshedAt, generation };
      }
      if (rows.length < 100) return { entries, next: null, refreshedAt: this.indexRefreshedAt, generation };
      cursor = rows[rows.length - 1]!.path;
    }
  }

  /**
   * Full-text search over what the caller may read. The query itself is restricted to the
   * folders the caller's read grants can reach (an agent: its project and `global/`, plus granted
   * paths), so other projects' entries never crowd out its results; every hit is then checked
   * against the grants. A person sees everything, or with `scope: "project"` this brain's project,
   * `global/`, and the root.
   */
  search(p: Principal, query: string, opts: { prefix?: string; limit?: number; offset?: number; scope?: "project" | "all" } = {}): Array<{ path: string; title: string | null; kind: EntryKind; snippet: string }> {
    this.owner();if(this.projectMode){assertProjectBrainPrincipal(this.db,p);if(opts.prefix&&!(this.globalPath(normalizeBrainPath(opts.prefix))||this.owns(normalizeBrainPath(opts.prefix))))throw new BrainError("Brain search prefix is outside pinned scope");}
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const prefix = opts.prefix ? normalizeBrainPath(opts.prefix) : "";
    let prefixes: string[] | null = null;
    if (p.kind === "agent") {
      const reach = p.grants.map((g: Grant) => grantPrefix(g.pattern.replace(/\\/g, "/")));
      prefixes = reach.includes("") ? null : [...new Set(reach)];
      if (prefixes && !prefixes.length) return [];
    } else if (opts.scope === "project") prefixes = [`projects/${this.project}/`, "global/"];
    const scopeSql = (prefixes ? ` AND (${prefixes.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ")}${p.kind === "human" ? " OR path = 'README.md'" : ""})` : "") + (prefix ? " AND path LIKE ? ESCAPE '\\'" : "");
    const rows = this.db
      .prepare(`SELECT path, title, snippet(brain_fts, 2, '[', ']', '…', 24) AS snippet FROM brain_fts WHERE brain_fts MATCH ?${scopeSql} ORDER BY bm25(brain_fts), path LIMIT ? OFFSET ?`)
      .all(match, ...(prefixes ?? []).map((x) => `${likeEscape(x)}%`), ...(prefix ? [`${likeEscape(prefix)}%`] : []), (opts.limit ?? 10) * 5, opts.offset ?? 0) as Array<{ path: string; title: string; snippet: string }>;
    const local=rows
      .filter((r) => (!prefix || r.path.startsWith(prefix)) && denial(p, r.path, "read") === null)
      .slice(0, opts.limit ?? 10)
      .map((r) => ({ path: r.path, title: r.title || null, kind: kindOf(r.path), snippet: r.snippet }));
    if(this.projectMode?.sharedKnowledge&&(!prefix||this.globalPath(prefix))){const hits=z.array(z.object({path:z.string(),title:z.string().nullable(),kind:BrainEntrySchema.shape.kind,snippet:z.string()}).strict()).max(1000).parse(this.shared().search(query,{...(prefix?{prefix}:{}),limit:opts.limit??10,offset:opts.offset??0}));for(const hit of hits)if(!hit.path.startsWith("global/")||normalizeBrainPath(hit.path)!==hit.path)throw new BrainError("Shared search returned a private path");return [...local,...hits.filter(hit=>denial(p,hit.path,"read")===null)].slice(0,opts.limit??10);}return local;
  }

  // ---------- history ----------

  async history(rel: string, limit = 50): Promise<Array<{ commit: string; date: string; agent: string | null; model: string | null; subject: string }>> {
    try {
      const binding = await this.resolveGitDocument(rel);
      return binding ? await brainMountHistory(binding, limit) : [];
    } catch { return []; }
  }

  async blame(rel: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number } = {}): Promise<BlameLine[]> {
    const r = await this.resolveGitDocument(rel);
    if (!r) throw new BrainError(`${rel} is not tracked by MeritRouter`);
    const lines = await blame(r.repo, r.repoRel, "HEAD", opts);
    return lines.map(line => ({ ...line, origPath: line.origPath.startsWith(r.mountPrefix) ? line.origPath.slice(r.mountPrefix.length) : line.origPath }));
  }

  // ---------- index document ----------

  /**
   * The root index: global knowledge (`global/`) and the projects by name, each linking to its
   * own index. It names no project's documents (supervisors read only their own project).
   */
  renderIndex(entries: BrainEntry[], excludedProjects: string[] = []): string {
    const global = entries.filter((e) => e.path.toLowerCase().startsWith("global/"));
    const rows = global.map((e) => `| [${e.path}](${e.path}) | ${e.kind} | ${e.title ?? ""} |`);
    const list = this.indexProjects().filter(p => !excludedProjects.some(slug => slug.toLowerCase() === p.slug.toLowerCase())).map((p) => `- [${p.name}](${projectIndexPath(p.slug)})${p.name === p.slug ? "" : ` (\`${p.slug}\`)`}`);
    return `# Brain index\n\nGenerated by MeritRouter. Global knowledge, and the projects; each project's own index lists its working documents.\n\n## Global knowledge\n\n| Entry | Kind | Title |\n| --- | --- | --- |\n${rows.join("\n") || "| (none yet) | | |"}\n\n## Projects\n\n${list.join("\n") || "(none yet)"}\n`;
  }

  /** This project's index (`projects/<p>/README.md`): its working documents and their status. */
  renderProjectIndex(entries: BrainEntry[]): string {
    const prefix = `projects/${this.project}/`.toLowerCase();
    const docs = entries.filter((e) => e.kind === "working_doc" && e.path.toLowerCase().startsWith(prefix));
    // Links are relative to this index's own folder (projects/<p>/): a full brain path here would
    // resolve to projects/<p>/projects/<p>/... in the panel and any markdown viewer.
    const rows = docs.map((d) => `| [${d.path}](${d.path.slice(prefix.length)}) | ${d.status ?? "?"} | ${d.lines} | ${d.title ?? ""} |`);
    return `# Brain index: ${this.scope().name}\n\nGenerated by MeritRouter. This project's working documents and their status; read the one you need, then its \`Current State\` only. Global knowledge is under \`global/\`.\n\n| Document | Status | Lines | Title |\n| --- | --- | ---: | --- |\n${rows.join("\n") || "| (none yet) | | | |"}\n`;
  }

  /** Projects the root index names: the configured ones, this brain's, and any other folder under `projects/`. */
  private indexProjects(): Array<{ slug: string; name: string }> {
    const out = new Map<string, string>();
    if(this.projectMode)return [{slug:this.project,name:this.scope().name}];
    for (const p of this.cfg.projectResolution?.projects ?? []) out.set(p.slug, p.name);
    if (!out.has(this.project)) out.set(this.project, this.scope().name);
    const dir = path.join(this.root, "projects");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) if (!name.startsWith(".") && !out.has(name) && statSync(path.join(dir, name)).isDirectory()) out.set(name, name);
    }
    return [...out.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** Regenerate the root index and this project's index. */
  async regenerateIndex(actor: Actor, control: BrainMutationControl = {}): Promise<void> {
    const entries = this.list({ kind: "human" });
    await this.writeFile("README.md", this.renderIndex(entries), actor, "Regenerate brain index", {}, control);
    await this.writeFile(projectIndexPath(this.project), this.renderProjectIndex(entries), actor, `Regenerate the ${this.project} index`, {}, control);
  }
}
