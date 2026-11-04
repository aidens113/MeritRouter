import { lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { commitAs } from "../attribution/index.js";
import { git } from "../workspaces/git.js";
import { exactRepositoryRoot } from "../workspaces/repository-root.js";
import { withRepositoryMutation } from "../workspaces/repository-mutation.js";
import { BrainConflictError, BrainError, brainContentDigest, expandHome, kindOf, normalizeBrainPath, type BrainEntry, type SharedBrainKnowledgePort } from "./brain.js";
import { parseDoc } from "./protocol.js";

interface Options {
  assertCurrent(): void;
  privateRoots(): string[];
  operation<T>(work: () => Promise<T>): Promise<T>;
}
interface Target { rel: string; abs: string; root: string; repo: string; repoRel: string; commit: boolean }
export interface GlobalHistoryScope { prefix: string; repo: string; repoRel: string }
const same = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const inside = (root: string, target: string) => { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Installation-owned public files. No project database, bootstrap, indexing or publication authority. */
export class GlobalKnowledge {
  readonly shared: SharedBrainKnowledgePort;
  constructor(private readonly cfg: ResolvedConfig, private readonly options: Options) {
    // Project runtimes receive this closed read-only object, never the admin removal capability.
    this.shared = Object.freeze({ read: (rel: string) => this.read(rel), list: (prefix: string) => this.list(prefix), search: (query: string, opts: { prefix?: string; limit: number; offset: number }) => this.search(query, opts) });
  }

  runOperation<T>(work: () => Promise<T>): Promise<T> { return this.options.operation(work); }

  private globalPath(input: string): string {
    const rel = normalizeBrainPath(z.string().min(1).max(4096).parse(input));
    if (rel !== "global" && !rel.startsWith("global/")) throw new BrainError("Global knowledge capability accepts only global paths");
    return rel;
  }

  private configuration() {
    const base = path.dirname(this.cfg.configPath), root = path.resolve(base, expandHome(this.cfg.brain.path));
    const mounts = this.cfg.brain.mounts.map(mount => ({ prefix: normalizeBrainPath(mount.prefix), root: path.resolve(base, expandHome(mount.path)), commit: mount.commit }))
      .filter(mount => mount.prefix === "global" || mount.prefix.startsWith("global/"))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    return { root, mounts, commit: this.cfg.brain.commit };
  }

  /** Refuse links on the entire path; only actual missing files/directories are empty data. */
  private physical(target: string) {
    const absolute = path.resolve(target), root = path.parse(absolute).root;
    let current = root, result: Stats | null = null;
    for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try { result = lstatSync(current); } catch (error) { if (missing(error)) return null; throw error; }
      if (result.isSymbolicLink()) throw new BrainError("Global knowledge path contains a redirected link");
    }
    return result;
  }

  resolve(input: string): Target {
    this.options.assertCurrent();
    const rel = this.globalPath(input), cfg = this.configuration();
    const mount = cfg.mounts.find(value => rel === value.prefix || rel.startsWith(`${value.prefix}/`));
    const root = mount?.root ?? path.join(cfg.root, "global"), sub = mount ? rel.slice(mount.prefix.length).replace(/^\//, "") : rel.slice("global".length).replace(/^\//, "");
    const abs = path.join(root, ...sub.split("/").filter(Boolean));
    const privateRoots = [path.join(cfg.root, "projects"), ...this.options.privateRoots()].flatMap(value => {
      try { return [value, realpathSync(value)]; } catch (error) { if (missing(error)) return [value]; throw error; }
    });
    if (!inside(root, abs) || privateRoots.some(privateRoot => inside(privateRoot, root) || inside(root, privateRoot))) throw new BrainError("Global knowledge overlaps private project storage");
    const rootStat = this.physical(root);
    if (rootStat && !rootStat.isDirectory()) throw new BrainError("Configured global knowledge root is not a directory");
    this.physical(abs);
    return { rel, abs, root, repo: mount?.root ?? cfg.root, repoRel: mount ? sub : rel, commit: mount?.commit ?? cfg.commit };
  }

  read(input: string): { content: string } | null {
    const target = this.resolve(input), stat = this.physical(target.abs);
    if (!stat || stat.isDirectory()) return null;
    if (!stat.isFile() || stat.size > 2_000_000) throw new BrainError("Global knowledge entry is not a bounded regular file");
    return { content: z.string().max(2_000_000).parse(readFileSync(target.abs, "utf8")) };
  }

  list(input = "global"): BrainEntry[] {
    const prefix = this.globalPath(input), entries = new Map<string, BrainEntry>(), seen = new Set<string>();
    let visited = 0;
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      if (++visited > 20_000) throw new BrainError("Global knowledge catalogue exceeds its bounded scan");
      const target = this.resolve(rel), stat = this.physical(target.abs);
      if (!stat) return;
      if (stat.isDirectory()) {
        for (const name of readdirSync(target.abs)) if (!name.startsWith(".")) walk(`${rel}/${name}`);
      } else if (rel.endsWith(".md")) {
        const content = this.read(rel)!.content, doc = parseDoc(content);
        entries.set(rel, { path: rel, kind: kindOf(rel), title: doc.title, status: doc.header.Status ?? null, lines: doc.lines.length, mtime: stat.mtimeMs });
        if (entries.size > 10_000) throw new BrainError("Global knowledge catalogue exceeds its entry bound");
      }
    };
    walk(prefix);
    for (const mount of this.configuration().mounts) if (mount.prefix === prefix || mount.prefix.startsWith(`${prefix}/`)) walk(mount.prefix);
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  search(query: string, raw: { prefix?: string; limit: number; offset: number }) {
    const opts = z.object({ prefix: z.string().optional(), limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(10000) }).strict().parse(raw);
    const terms = z.string().max(10000).parse(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!terms.length) return [];
    return this.list(opts.prefix ?? "global").flatMap(entry => {
      const content = this.read(entry.path)!.content, lower = content.toLowerCase(), index = terms.reduce((first, term) => { const at = lower.indexOf(term); return at < 0 ? first : Math.min(first, at); }, Infinity);
      return Number.isFinite(index) ? [{ path: entry.path, title: entry.title, kind: entry.kind, snippet: content.slice(Math.max(0, index - 80), index + 220) }] : [];
    }).slice(opts.offset, opts.offset + opts.limit);
  }

  /** Only configured repositories themselves may own effects/history; never discover an enclosing checkout. */
  async historyScopes(): Promise<GlobalHistoryScope[]> {
    return this.runOperation(async () => {
      const prefixes = ["global", ...this.configuration().mounts.map(mount => mount.prefix)], scopes: GlobalHistoryScope[] = [];
      for (const prefix of [...new Set(prefixes)]) {
        const target = this.resolve(prefix);
        if (!target.commit || !this.physical(target.repo) || !this.physical(path.join(target.repo, ".git"))) continue;
        await exactRepositoryRoot(target.repo);
        this.resolve(prefix);
        const head = (await git(target.repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowExit: [1] })).trim();
        if (head) scopes.push({ prefix, repo: target.repo, repoRel: target.repoRel });
      }
      return scopes;
    });
  }

  /** Explicit human administration only; does not bootstrap repositories or publish knowledge. */
  async remove(input: string, who: string, reason: string, expectedContent: string, trailers: (text: string) => Record<string, string>): Promise<{ path: string; commit: string | null; text: string }> {
    return this.runOperation(async () => {
      const target = this.resolve(input);
      z.string().trim().min(1).max(200).parse(who);
      z.string().trim().min(1).parse(reason);
      if (!target.rel.endsWith(".md") || target.rel === "global/glossary.md") throw new BrainError("Only individual global Markdown entries may be reverted");
      if (!target.commit || !this.physical(path.join(target.repo, ".git"))) throw new BrainError("Global entry has no configured committing Git repository");
      const owner = await exactRepositoryRoot(target.repo), common = realpathSync(owner.commonDirectory), configuration = JSON.stringify(this.configuration());
      const assertTarget = () => {
        if (configuration !== JSON.stringify(this.configuration()) || JSON.stringify(this.resolve(input)) !== JSON.stringify(target)) throw new BrainError("Global knowledge configuration changed during removal");
        const text = this.read(input)?.content;
        if (text === undefined) throw new BrainError(`${target.rel} does not exist`);
        if (brainContentDigest(text) !== brainContentDigest(expectedContent)) throw new BrainConflictError();
        return text;
      };
      assertTarget();
      return withRepositoryMutation([target.repo], async mutation => {
        const text = assertTarget(), paths = [`:(literal)${target.repoRel}`];
        const status = await git(target.repo, ["status", "--porcelain=v1", "--", ...paths]);
        assertTarget();
        if (status.trim()) await commitAs(target.repo, { agent: "human", role: "human" }, "Record edits made outside MeritRouter", { paths }, { mutation });
        assertTarget();
        const extraTrailers = trailers(text);
        unlinkSync(target.abs);
        const commit = await commitAs(target.repo, { agent: "human", role: "human" }, `Revert global entry ${target.rel}`.slice(0, 200), { paths, extraTrailers }, { mutation });
        return { path: target.rel, commit, text };
      }, { expectedCommonDirectories: [common] });
    });
  }
}
