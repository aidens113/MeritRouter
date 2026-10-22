import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import type { BrainMode } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import { git } from "../workspaces/git.js";
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

export interface BrainOptions {
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

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Shared knowledge stored as markdown in a git repository. Agents reach it only through these
 * methods, which enforce scoped access and the working-document protocol, and commit every
 * write under the writing agent's identity.
 */
export class Brain {
  readonly root: string;
  private readonly mounts: Array<{ prefix: string; abs: string; commit: boolean }>;
  private chains = new Map<string, Promise<unknown>>();
  private ready: Promise<void> | null = null;
  /** Gated promotion of lessons to `global/` (decision D9): records, review, approval. */
  readonly promotions: GlobalPromotions;

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    opts: BrainOptions = {},
  ) {
    const base = path.dirname(cfg.configPath);
    this.root = path.resolve(base, expandHome(cfg.brain.path));
    this.mounts = cfg.brain.mounts
      .map((m) => ({ prefix: normalizeBrainPath(m.prefix), abs: path.resolve(base, expandHome(m.path)), commit: m.commit }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    const reviewer = opts.reviewer;
    this.promotions = new GlobalPromotions({
      scope: () => this.scope(),
      exists: (rel) => this.exists(rel),
      readText: (rel) => {
        const r = this.resolve(rel);
        return existsSync(r.abs) && statSync(r.abs).isFile() ? readFileSync(r.abs, "utf8") : null;
      },
      listDir: (rel) => {
        const r = this.resolve(rel);
        return existsSync(r.abs) && statSync(r.abs).isDirectory() ? readdirSync(r.abs).filter((n) => n.endsWith(".md") && !n.startsWith(".")) : [];
      },
      repoHas: (root, rel) => existsSync(path.join(root, ...rel.split("/"))),
      write: (rel, content, actor, message) => this.writeFile(normalizeBrainPath(rel), content, actor, message),
      requiresApproval: () => this.cfg.brain.global_requires_approval,
      reviewer: () => (typeof reviewer === "function" ? (reviewer() ?? null) : (reviewer ?? null)),
      error: (message, issues) => new BrainError(message, issues),
      now: this.now,
    });
  }

  /** The project this brain serves: its slug, name, and repositories (what a global lesson must not name). */
  scope(): ProjectScope {
    const info = (this.cfg as { project?: { slug: string; name: string } }).project;
    return {
      slug: this.project,
      name: info?.name ?? this.project,
      repositories: Object.entries(this.cfg.repositoryPaths).map(([alias, r]) => ({ alias, path: r.path })),
    };
  }

  /** Paths this brain's project maintains in the shared index: everything except other projects' folders. */
  private owns(rel: string): boolean {
    const p = rel.toLowerCase();
    return !p.startsWith("projects/") || p.startsWith(`projects/${this.project.toLowerCase()}/`);
  }

  get project(): string {
    return this.cfg.brain.project;
  }

  workingDocPath(effort: string): string {
    return `projects/${this.project}/working/${effort}.md`;
  }

  /** Create the brain repository and its skeleton on first use. */
  ensure(): Promise<void> {
    this.ready ??= (async () => {
      mkdirSync(this.root, { recursive: true });
      if (!existsSync(path.join(this.root, ".git"))) {
        await git(this.root, ["init", "-q", "-b", "main"]);
        await git(this.root, ["config", "core.autocrlf", "false"]);
      }
      for (const dir of ["global/lessons", `projects/${this.project}/working`, `projects/${this.project}/decisions`, `projects/${this.project}/repos`]) {
        mkdirSync(path.join(this.root, dir), { recursive: true });
      }
      const glossary = path.join(this.root, "global/glossary.md");
      if (!existsSync(glossary)) writeFileSync(glossary, "# Glossary\n\nShared terms. Supervisors maintain this file.\n");
      if (!existsSync(path.join(this.root, "README.md"))) writeFileSync(path.join(this.root, "README.md"), this.renderIndex([]));
      const own = this.resolve(projectIndexPath(this.project));
      if (!existsSync(own.abs)) {
        mkdirSync(path.dirname(own.abs), { recursive: true });
        writeFileSync(own.abs, this.renderProjectIndex([]));
      }
      if (this.cfg.brain.commit) await commitAs(this.root, { agent: "switchyard", role: "tool" }, "Initialise brain").catch(() => null);
    })();
    return this.ready;
  }

  /** Map a brain path to a file, honouring mounts (e.g. a repository's docs/working). */
  resolve(relInput: string): { rel: string; abs: string; repo: string | null; repoRel: string; commit: boolean } {
    const rel = normalizeBrainPath(relInput);
    for (const m of this.mounts) {
      if (rel === m.prefix || rel.startsWith(`${m.prefix}/`)) {
        const sub = rel.slice(m.prefix.length).replace(/^\//, "");
        return { rel, abs: path.join(m.abs, ...sub.split("/").filter(Boolean)), repo: m.commit ? m.abs : null, repoRel: sub, commit: m.commit };
      }
    }
    return { rel, abs: path.join(this.root, ...rel.split("/").filter(Boolean)), repo: this.root, repoRel: rel, commit: this.cfg.brain.commit };
  }

  private check(p: Principal, rel: string, mode: BrainMode): void {
    const d = denial(p, rel, mode);
    if (d) throw new BrainError(d);
  }

  /** Serialize writes per repository (in-process chain plus a cross-process lock file). */
  private async locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repo) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
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

  /** Commit edits made outside SwitchYard (editor, scripts) as the user, before SwitchYard writes. */
  private async adoptExternalEdits(repo: string): Promise<void> {
    const status = await git(repo, ["status", "--porcelain", "--", "."]);
    const changed = status.split("\n").filter((l) => l.trim() && !l.endsWith(".switchyard-brain.lock"));
    if (changed.length) await commitAs(repo, { agent: "human", role: "human" }, "Record edits made outside SwitchYard");
  }

  /**
   * Write a file and commit it. `content` may be a function of the file's current text (null
   * when absent), evaluated under the repository lock; returning null skips the write.
   */
  private async writeFile(rel: string, contentOrFn: string | ((current: string | null) => string | null), actor: Actor, message: string): Promise<{ path: string; commit: string | null }> {
    await this.ensure();
    const r = this.resolve(rel);
    const doWrite = async () => {
      if (r.repo && r.commit) await this.adoptExternalEdits(r.repo);
      const content = typeof contentOrFn === "string" ? contentOrFn : contentOrFn(existsSync(r.abs) ? readFileSync(r.abs, "utf8") : null);
      if (content === null) return { path: rel, commit: null };
      mkdirSync(path.dirname(r.abs), { recursive: true });
      const tmp = `${r.abs}.${process.pid}.tmp`;
      writeFileSync(tmp, content.endsWith("\n") ? content : `${content}\n`);
      renameSync(tmp, r.abs);
      let commit: string | null = null;
      if (r.repo && r.commit) {
        commit = await commitAs(r.repo, actor, message.slice(0, 200), { paths: [r.repoRel || "."] });
        if (this.cfg.brain.push && commit) await git(r.repo, ["push", "-q"]).catch(() => undefined);
      }
      this.indexFile(rel);
      return { path: rel, commit };
    };
    return r.repo ? this.locked(r.repo, doWrite) : doWrite();
  }

  exists(rel: string): boolean {
    return existsSync(this.resolve(rel).abs);
  }

  read(p: Principal, rel: string, opts: { section?: string } = {}): { path: string; kind: EntryKind; content: string; lines: number } {
    const r = this.resolve(rel);
    this.check(p, r.rel, "read");
    if (!existsSync(r.abs)) throw new BrainError(`${r.rel} does not exist`);
    let content = readFileSync(r.abs, "utf8");
    if (opts.section) {
      const s = section(parseDoc(content), opts.section);
      if (!s) throw new BrainError(`${r.rel} has no '${opts.section}' section`);
      content = s.body;
    }
    return { path: r.rel, kind: kindOf(r.rel), content, lines: content.split("\n").length };
  }

  /** Files under a prefix that the principal may read. */
  list(p: Principal, prefix = ""): BrainEntry[] {
    const start = normalizeBrainPath(prefix);
    const out: BrainEntry[] = [];
    const walk = (rel: string) => {
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
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---------- writes with protocol rules ----------

  /** Create or replace a file. Working documents keep their ledger append-only. */
  async write(p: Principal, actor: Actor, rel: string, content: string, message?: string): Promise<{ path: string; commit: string | null }> {
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
    return this.writeFile(r.rel, content, actor, message ?? `${existsSync(r.abs) ? "Update" : "Add"} ${r.rel}`);
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
    if (isBrainIndex(r.rel)) throw new BrainError(`${r.rel} is generated by SwitchYard and cannot be removed`);
    this.check(p, r.rel, "write");
    const why = reason.trim().replace(/\s+/g, " ");
    if (!why) throw new BrainError("say why the entry is removed; the reason is recorded in the brain's history");
    await this.ensure();
    const doRemove = async () => {
      if (!existsSync(r.abs) || !statSync(r.abs).isFile()) throw new BrainError(`${r.rel} does not exist`);
      // A file written outside SwitchYard and never committed is recorded first, so its text stays in the history.
      if (r.repo && r.commit) await this.adoptExternalEdits(r.repo);
      const text = readFileSync(r.abs, "utf8");
      const who = p.kind === "human" ? (p.name ?? actor.agent) : actor.agent;
      const trailers = typeof opts.trailers === "function" ? opts.trailers(text) : (opts.trailers ?? { "Removed-By": who.slice(0, 200), "Remove-Reason": why.slice(0, 1000) });
      unlinkSync(r.abs);
      let commit: string | null = null;
      if (r.repo && r.commit) {
        commit = await commitAs(r.repo, actor, (opts.message ?? `Remove ${r.rel}`).slice(0, 200), { paths: [r.repoRel], extraTrailers: trailers });
        if (this.cfg.brain.push && commit) await git(r.repo, ["push", "-q"]).catch(() => undefined);
      }
      this.indexFile(r.rel);
      return { path: r.rel, commit, text };
    };
    return r.repo ? this.locked(r.repo, doRemove) : doRemove();
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
  async removeProjectFolder(slug: string, actor: Actor, reason: string): Promise<{ files: number; commit: string | null }> {
    if (slug.toLowerCase() === this.project.toLowerCase()) throw new BrainError(`a project's brain cannot remove its own folder (${slug})`);
    const dir = this.projectFolder(slug);
    await this.ensure();
    const rel = `projects/${slug}`;
    const out = await this.locked(this.root, async () => {
      const files = this.projectFolderFiles(slug);
      if (!existsSync(dir)) return { files: 0, commit: null };
      const commits = this.cfg.brain.commit && existsSync(path.join(this.root, ".git"));
      if (commits) await this.adoptExternalEdits(this.root);
      rmSync(dir, { recursive: true, force: true });
      let commit: string | null = null;
      if (commits) {
        const tracked = (await git(this.root, ["ls-files", "--", rel])).trim().length > 0;
        if (tracked) {
          commit = await commitAs(this.root, actor, `Remove project ${slug}`.slice(0, 200), { paths: [rel], extraTrailers: { "Removed-By": actor.agent.slice(0, 200), "Remove-Reason": reason.trim().replace(/\s+/g, " ").slice(0, 1000) } });
          if (this.cfg.brain.push && commit) await git(this.root, ["push", "-q"]).catch(() => undefined);
        }
      }
      return { files, commit };
    });
    const like = `${likeEscape(`${rel}/`)}%`;
    this.db.prepare("DELETE FROM brain_fts WHERE path LIKE ? ESCAPE '\\'").run(like);
    this.db.prepare("DELETE FROM brain_files WHERE path LIKE ? ESCAPE '\\'").run(like);
    await this.writeFile("README.md", this.renderIndex(this.list({ kind: "human" })), actor, "Regenerate brain index");
    return out;
  }

  // ---------- index and search ----------

  private indexFile(rel: string): void {
    const r = this.resolve(rel);
    if (!rel.endsWith(".md")) return;
    this.db.prepare("DELETE FROM brain_fts WHERE path = ?").run(rel);
    if (!existsSync(r.abs)) {
      this.db.prepare("DELETE FROM brain_files WHERE path = ?").run(rel);
      return;
    }
    const st = statSync(r.abs);
    const text = readFileSync(r.abs, "utf8");
    const doc = parseDoc(text);
    this.db
      .prepare("INSERT INTO brain_files (path, mtime, size, title, kind, status, lines) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, title = excluded.title, kind = excluded.kind, status = excluded.status, lines = excluded.lines")
      .run(rel, st.mtimeMs, st.size, doc.title, kindOf(rel), doc.header.Status ?? null, doc.lines.length);
    this.db.prepare("INSERT INTO brain_fts (path, title, body) VALUES (?, ?, ?)").run(rel, doc.title ?? "", text);
  }

  /** Bring the index up to date with the files (cheap when nothing changed). */
  async refreshIndex(): Promise<number> {
    await this.ensure();
    const seen = new Set<string>();
    let changed = 0;
    // The index is shared by every project's brain; each maintains its own folder, global/, and
    // the root (another project's mounts are invisible here, so its rows are left alone).
    const known = new Map((this.db.prepare("SELECT path, mtime, size FROM brain_files").all() as Array<{ path: string; mtime: number; size: number }>).filter((r) => this.owns(r.path)).map((r) => [r.path, r]));
    for (const e of this.list({ kind: "human" })) {
      if (!this.owns(e.path)) continue;
      seen.add(e.path);
      const st = statSync(this.resolve(e.path).abs);
      const k = known.get(e.path);
      if (!k || k.mtime !== st.mtimeMs || k.size !== st.size) {
        this.indexFile(e.path);
        changed++;
      }
    }
    for (const p of known.keys()) if (!seen.has(p)) (this.indexFile(p), changed++);
    return changed;
  }

  /**
   * Full-text search over what the caller may read. The query itself is restricted to the
   * folders the caller's read grants can reach (an agent: its project and `global/`, plus granted
   * paths), so other projects' entries never crowd out its results; every hit is then checked
   * against the grants. A person sees everything, or with `scope: "project"` this brain's project,
   * `global/`, and the root.
   */
  search(p: Principal, query: string, opts: { prefix?: string; limit?: number; scope?: "project" | "all" } = {}): Array<{ path: string; title: string | null; kind: EntryKind; snippet: string }> {
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
    const scopeSql = prefixes ? ` AND (${prefixes.map(() => "path LIKE ? ESCAPE '\\'").join(" OR ")}${p.kind === "human" ? " OR path NOT LIKE '%/%'" : ""})` : "";
    const rows = this.db
      .prepare(`SELECT path, title, snippet(brain_fts, 2, '[', ']', '…', 24) AS snippet FROM brain_fts WHERE brain_fts MATCH ?${scopeSql} ORDER BY bm25(brain_fts) LIMIT ?`)
      .all(match, ...(prefixes ?? []).map((x) => `${likeEscape(x)}%`), (opts.limit ?? 10) * 5) as Array<{ path: string; title: string; snippet: string }>;
    return rows
      .filter((r) => (!prefix || r.path.startsWith(prefix)) && denial(p, r.path, "read") === null)
      .slice(0, opts.limit ?? 10)
      .map((r) => ({ path: r.path, title: r.title || null, kind: kindOf(r.path), snippet: r.snippet }));
  }

  // ---------- history ----------

  async history(rel: string, limit = 50): Promise<Array<{ commit: string; date: string; agent: string | null; model: string | null; subject: string }>> {
    const r = this.resolve(rel);
    if (!r.repo || !r.commit) return [];
    const raw = await git(r.repo, ["log", `-${limit}`, "--follow", "--format=%H%x1f%aI%x1f%s%x1f%(trailers:key=Agent,valueonly)%x1f%(trailers:key=Model,valueonly)%x1e", "--", r.repoRel]).catch(() => "");
    return raw
      .split("\x1e")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [commit, date, subject, agent, model] = x.split("\x1f");
        return { commit: commit!, date: date!, subject: subject!, agent: agent?.trim() || null, model: model?.trim() || null };
      });
  }

  async blame(rel: string): Promise<BlameLine[]> {
    const r = this.resolve(rel);
    if (!r.repo || !r.commit) throw new BrainError(`${r.rel} is not tracked by SwitchYard`);
    return blame(r.repo, r.repoRel);
  }

  // ---------- index document ----------

  /**
   * The root index: global knowledge (`global/`) and the projects by name, each linking to its
   * own index. It names no project's documents (supervisors read only their own project).
   */
  renderIndex(entries: BrainEntry[]): string {
    const global = entries.filter((e) => e.path.toLowerCase().startsWith("global/"));
    const rows = global.map((e) => `| [${e.path}](${e.path}) | ${e.kind} | ${e.title ?? ""} |`);
    const list = this.indexProjects().map((p) => `- [${p.name}](${projectIndexPath(p.slug)})${p.name === p.slug ? "" : ` (\`${p.slug}\`)`}`);
    return `# Brain index\n\nGenerated by SwitchYard. Global knowledge, and the projects; each project's own index lists its working documents.\n\n## Global knowledge\n\n| Entry | Kind | Title |\n| --- | --- | --- |\n${rows.join("\n") || "| (none yet) | | |"}\n\n## Projects\n\n${list.join("\n") || "(none yet)"}\n`;
  }

  /** This project's index (`projects/<p>/README.md`): its working documents and their status. */
  renderProjectIndex(entries: BrainEntry[]): string {
    const prefix = `projects/${this.project}/`.toLowerCase();
    const docs = entries.filter((e) => e.kind === "working_doc" && e.path.toLowerCase().startsWith(prefix));
    const rows = docs.map((d) => `| [${d.path}](${d.path}) | ${d.status ?? "?"} | ${d.lines} | ${d.title ?? ""} |`);
    return `# Brain index: ${this.scope().name}\n\nGenerated by SwitchYard. This project's working documents and their status; read the one you need, then its \`Current State\` only. Global knowledge is under \`global/\`.\n\n| Document | Status | Lines | Title |\n| --- | --- | ---: | --- |\n${rows.join("\n") || "| (none yet) | | | |"}\n`;
  }

  /** Projects the root index names: the configured ones, this brain's, and any other folder under `projects/`. */
  private indexProjects(): Array<{ slug: string; name: string }> {
    const out = new Map<string, string>();
    for (const p of this.cfg.projectResolution?.projects ?? []) out.set(p.slug, p.name);
    if (!out.has(this.project)) out.set(this.project, this.scope().name);
    const dir = path.join(this.root, "projects");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) if (!name.startsWith(".") && !out.has(name) && statSync(path.join(dir, name)).isDirectory()) out.set(name, name);
    }
    return [...out.entries()].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** Regenerate the root index and this project's index. */
  async regenerateIndex(actor: Actor): Promise<void> {
    const entries = this.list({ kind: "human" });
    await this.writeFile("README.md", this.renderIndex(entries), actor, "Regenerate brain index");
    await this.writeFile(projectIndexPath(this.project), this.renderProjectIndex(entries), actor, `Regenerate the ${this.project} index`);
  }
}
