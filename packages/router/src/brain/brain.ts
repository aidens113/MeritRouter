import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import type { BrainMode } from "../config/schema.js";
import type { Db } from "../storage/db.js";
import { git } from "../workspaces/git.js";
import { isGitSegment } from "../context/repo-reader.js";
import { blame, commitAs, type Actor, type BlameLine } from "../attribution/index.js";
import { denial, type Principal } from "./access.js";
import {
  appendToSection,
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

export class BrainError extends Error {}

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
  if (p === "readme.md") return "index";
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

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note";

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

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    const base = path.dirname(cfg.configPath);
    this.root = path.resolve(base, expandHome(cfg.brain.path));
    this.mounts = cfg.brain.mounts
      .map((m) => ({ prefix: normalizeBrainPath(m.prefix), abs: path.resolve(base, expandHome(m.path)), commit: m.commit }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
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

  private async writeFile(rel: string, content: string, actor: Actor, message: string): Promise<{ path: string; commit: string | null }> {
    await this.ensure();
    const r = this.resolve(rel);
    const doWrite = async () => {
      if (r.repo && r.commit) await this.adoptExternalEdits(r.repo);
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
      if (issues.length) throw new BrainError(`report rejected: ${issues.join("; ")}`);
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
      }
      if (issues.length) throw new BrainError(`working document rejected: ${issues.join("; ")}`);
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
    if (issues.length) throw new BrainError(`ledger entry rejected: ${issues.join("; ")}`);
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

  async writeReport(p: Principal, actor: Actor, rel: string, report: string | ReportFields): Promise<{ path: string; commit: string | null }> {
    return this.write(p, actor, rel, typeof report === "string" ? report : formatReport(report), `Report ${path.posix.basename(rel, ".md")}`);
  }

  /** Promote a lesson to global. Only supervisors and people may. */
  async promoteLesson(p: Principal, actor: Actor, title: string, body: string, sources: string[]): Promise<{ path: string; commit: string | null }> {
    if (p.kind === "agent" && p.role !== "supervisor") throw new BrainError("only supervisors promote lessons");
    const rel = `global/lessons/${slugify(title)}.md`;
    const text = `---\nkind: lesson\npromoted_by: ${actor.agent}\nsources: [${sources.map((s) => JSON.stringify(s)).join(", ")}]\n---\n\n# ${title}\n\n${body.trim()}\n`;
    return this.writeFile(rel, text, actor, `Promote lesson: ${title}`);
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
    const known = new Map((this.db.prepare("SELECT path, mtime, size FROM brain_files").all() as Array<{ path: string; mtime: number; size: number }>).map((r) => [r.path, r]));
    for (const e of this.list({ kind: "human" })) {
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

  search(p: Principal, query: string, opts: { prefix?: string; limit?: number } = {}): Array<{ path: string; title: string | null; kind: EntryKind; snippet: string }> {
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const prefix = opts.prefix ? normalizeBrainPath(opts.prefix) : "";
    const rows = this.db
      .prepare(`SELECT path, title, snippet(brain_fts, 2, '[', ']', '…', 24) AS snippet FROM brain_fts WHERE brain_fts MATCH ? ORDER BY bm25(brain_fts) LIMIT ?`)
      .all(match, (opts.limit ?? 10) * 5) as Array<{ path: string; title: string; snippet: string }>;
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

  renderIndex(entries: BrainEntry[]): string {
    const docs = entries.filter((e) => e.kind === "working_doc");
    const rows = docs.map((d) => `| [${d.path}](${d.path}) | ${d.status ?? "?"} | ${d.lines} | ${d.title ?? ""} |`);
    return `# Brain index\n\nGenerated by SwitchYard. Working documents and their status; read the one you need, then its \`Current State\` only.\n\n| Document | Status | Lines | Title |\n| --- | --- | ---: | --- |\n${rows.join("\n") || "| (none yet) | | | |"}\n`;
  }

  async regenerateIndex(actor: Actor): Promise<void> {
    await this.writeFile("README.md", this.renderIndex(this.list({ kind: "human" })), actor, "Regenerate brain index");
  }
}
