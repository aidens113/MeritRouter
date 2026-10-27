import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { git, headSha, dirtyPaths } from "../workspaces/git.js";
import { assertNotProjectMetadataPath, isProjectMetadataPath, PROJECT_METADATA_SEARCH_EXCLUDES } from "../projects/metadata-policy.js";

export const MAX_FILE_BYTES = 512 * 1024;
const MAX_PHYSICAL_CANDIDATES = 50000;
const MAX_UNSAFE_EXCLUSIONS = 128;
const MAX_SEARCH_ARGUMENT_BYTES = 20000;

export interface FileContent {
  alias: string;
  relPath: string;
  content: string;
  sha256: string;
  totalLines: number;
  /** Commit the content was read from, or null for the working tree. */
  commit: string | null;
  /** Working-tree reads: whether the file differs from HEAD. */
  dirty: boolean;
}

/** Normalize a repository-relative path and reject escapes and .git internals. */
export function normalizeRelPath(rel: string): string {
  const posix = rel.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!posix || posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) throw new Error(`path must be repository-relative: ${rel}`);
  const norm = path.posix.normalize(posix).replace(/\/+$/, "");
  if (/[\x00-\x1f:]/.test(norm) || norm.split("/").some(segment => /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error(`path uses reserved filesystem syntax: ${rel}`);
  if (norm === ".." || norm.startsWith("../")) throw new Error(`path escapes the repository: ${rel}`);
  if (norm.split("/").some(isGitSegment)) throw new Error(`paths inside or named .git are not accessible: ${rel}`);
  return norm === "." ? "" : norm;
}

/**
 * A path segment that resolves to git metadata on some filesystem: `.git` in any case, with the
 * trailing dots or spaces Windows ignores, or its 8.3 short name (`GIT~1`).
 */
export function isGitSegment(segment: string): boolean {
  const s = segment.replace(/[. ]+$/, "").toLowerCase();
  return s === ".git" || /^git~\d+$/.test(s);
}

/**
 * Read-only access to one configured repository, either at a pinned commit or in the working
 * tree. All paths are resolved inside the repository root (symlinks included).
 */
export class RepoReader {
  private rootReal: string | null = null;
  private dirty: Set<string> | null = null;
  private head: string | null = null;

  constructor(
    readonly alias: string,
    readonly root: string,
    /** Pinned commit; when set, every read comes from this commit. */
    readonly commit: string | null,
  ) {}

  invalidate(): void { this.dirty = null; this.head = null; }

  async headSha(): Promise<string> {
    this.head ??= await headSha(this.root);
    return this.head;
  }

  async dirtyPaths(signal?: AbortSignal): Promise<Set<string>> {
    this.dirty ??= new Set(await dirtyPaths(this.root,{...(signal?{signal}:{})}));
    return this.dirty;
  }

  private async resolveWorktreePath(rel: string): Promise<string> {
    this.rootReal ??= await realpath(this.root);
    const abs = path.resolve(this.rootReal, ...rel.split("/"));
    const real = await realpath(abs);
    const relToRoot = path.relative(this.rootReal, real);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) throw new Error(`path resolves outside the repository: ${rel}`);
    assertNotProjectMetadataPath(relToRoot);
    return real;
  }

  /** Inspect names/metadata only, before grep can read private bytes. Four bounded workers. */
  private async unsafeWorktreePaths(files: string[], signal?: AbortSignal): Promise<Set<string>> {
    signal?.throwIfAborted();
    if (files.length > MAX_PHYSICAL_CANDIDATES) throw new Error("Repository physical safety scan exceeds 50000 candidates; narrow the directory/glob");
    const root = await realpath(this.root);
    const parents = new Map<string, Promise<string>>();
    const unsafe = new Set<string>();
    let cursor = 0;
    const inside = (resolved: string) => {
      const relative = path.relative(root, resolved);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && !isProjectMetadataPath(relative) && !relative.split(path.sep).some(isGitSegment);
    };
    const inspect = async () => {
      while (cursor < files.length) {
        signal?.throwIfAborted();
        const file = files[cursor++]!;
        try {
          const rel = normalizeRelPath(file);
          assertNotProjectMetadataPath(rel);
          const abs = path.join(root, ...rel.split("/"));
          const parent = path.dirname(abs);
          let parentReal = parents.get(parent);
          if (!parentReal) { parentReal = realpath(parent); parents.set(parent, parentReal); }
          const resolvedParent = await parentReal;
          signal?.throwIfAborted();
          if (!inside(resolvedParent)) { unsafe.add(file); continue; }
          const info = await lstat(abs);
          signal?.throwIfAborted();
          const resolved = info.isSymbolicLink() ? await realpath(abs) : path.join(resolvedParent, path.basename(abs));
          const targetInfo = info.isSymbolicLink() ? await stat(resolved) : info;
          signal?.throwIfAborted();
          if (!inside(resolved) || !targetInfo.isFile() || targetInfo.nlink > 1) unsafe.add(file);
        } catch {
          signal?.throwIfAborted();
          unsafe.add(file); // Unreadable/missing/ambiguous paths are never search candidates.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, inspect));
    return unsafe;
  }

  async readFile(relInput: string, signal?: AbortSignal): Promise<FileContent> {
    signal?.throwIfAborted();
    const rel = normalizeRelPath(relInput);
    assertNotProjectMetadataPath(rel);
    let buf: Buffer;
    if (this.commit) {
      const out = await git(this.root, ["cat-file", "-s", `${this.commit}:${rel}`], { ...(signal ? {signal} : {}) }).catch(() => {
        throw new Error(`${this.alias}:${rel} does not exist at ${this.commit}`);
      });
      if (Number(out.trim()) > MAX_FILE_BYTES) throw new Error(`${this.alias}:${rel} exceeds ${MAX_FILE_BYTES} bytes`);
      buf = Buffer.from(await git(this.root, ["show", `${this.commit}:${rel}`], { ...(signal ? {signal} : {}) }), "utf8");
    } else {
      const abs = await this.resolveWorktreePath(rel).catch(() => {
        throw new Error(`${this.alias}:${rel} does not exist`);
      });
      const st = await stat(abs);
      if (!st.isFile()) throw new Error(`${this.alias}:${rel} is not a file`);
      if (st.nlink > 1) throw new Error(`${this.alias}:${rel} has multiple hard links; repository reads are refused`);
      if (st.size > MAX_FILE_BYTES) throw new Error(`${this.alias}:${rel} exceeds ${MAX_FILE_BYTES} bytes`);
      buf = await readFile(abs, { ...(signal ? {signal} : {}) });
    }
    if (buf.includes(0)) throw new Error(`${this.alias}:${rel} looks binary`);
    const content = buf.toString("utf8");
    return {
      alias: this.alias,
      relPath: rel,
      content,
      sha256: createHash("sha256").update(buf).digest("hex"),
      totalLines: content.length === 0 ? 0 : content.split("\n").length,
      commit: this.commit,
      dirty: this.commit ? false : (await this.dirtyPaths(signal)).has(rel),
    };
  }

  /** Tracked (and, in the working tree, untracked-but-not-ignored) files under `dir`. */
  async listFiles(dirInput = "", glob?: string, limit = 500, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
    signal?.throwIfAborted();
    const root = dirInput.replace(/\\/g, "/");
    const dir = /^(?:\.\/)*\.?\/?$/.test(root) ? "" : normalizeRelPath(dirInput);
    assertNotProjectMetadataPath(dir);
    const out = this.commit
      ? await git(this.root, ["ls-tree", "-r", "--name-only", "-z", this.commit, ...(dir ? ["--", dir] : [])], { ...(signal ? {signal} : {}) })
      : await git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(dir ? ["--", dir] : [])], { ...(signal ? {signal} : {}) });
    let files = [...new Set(out.split("\0").filter(file => !!file && !isProjectMetadataPath(file)))].sort();
    if (glob) {
      const match = picomatch(glob, { dot: true });
      files = files.filter((f) => match(f) || match(path.posix.basename(f)));
    }
    if (!this.commit) {
      const unsafe = await this.unsafeWorktreePaths(files, signal);
      files = files.filter(file => !unsafe.has(file));
    }
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }

  /** Line matches for an extended regular expression (git grep semantics). */
  async search(
    pattern: string,
    opts: { pathGlob?: string; ignoreCase?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    const limit = opts.limit ?? 100;
    opts.signal?.throwIfAborted();
    if (opts.pathGlob) assertNotProjectMetadataPath(normalizeRelPath(opts.pathGlob));
    const args = ["grep", "-n", "-I", "-E", "--no-color", "-z", ...(opts.ignoreCase ? ["-i"] : []), "-e", pattern];
    if (this.commit) args.push(this.commit);
    else args.push("--untracked");
    args.push("--", ...(opts.pathGlob ? [`:(glob)${normalizeRelPath(opts.pathGlob)}`] : []), ...PROJECT_METADATA_SEARCH_EXCLUDES);
    let unsafe = new Set<string>();
    if (!this.commit) {
      // No exclude magic here: Git's ls-files can drop positive matches when exclude pathspecs
      // are present (see workspaces/metadata-staging.ts), which would hide unsafe paths.
      const listed = await git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard",
        ...(opts.pathGlob ? ["--", `:(glob)${normalizeRelPath(opts.pathGlob)}`] : [])], { ...(opts.signal ? { signal: opts.signal } : {}) });
      const files = [...new Set(listed.split("\0").filter(file => !!file && !isProjectMetadataPath(file)))];
      unsafe = await this.unsafeWorktreePaths(files, opts.signal);
      if (unsafe.size > MAX_UNSAFE_EXCLUSIONS) throw new Error("Repository search exceeds 128 unsafe-path exclusions; narrow the glob");
      args.push(...[...unsafe].map(file => `:(exclude,literal)${file}`));
    }
    if (args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg, "utf8") + 1, 0) > MAX_SEARCH_ARGUMENT_BYTES) {
      throw new Error("Repository search exceeds the 20000-byte argument safety bound; narrow the glob");
    }
    const out = await git(this.root, args, { allowExit: [1], ...(opts.signal ? {signal:opts.signal} : {}) });
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const raw of out.split("\n")) {
      if (!raw) continue;
      // -z output: <rev>:<path>\0<line>\0<text> at a commit, <path>\0<line>\0<text> otherwise.
      const parts = raw.split("\0");
      if (parts.length < 3) continue;
      let p = parts[0]!;
      if (this.commit && p.startsWith(`${this.commit}:`)) p = p.slice(this.commit.length + 1);
      if (isProjectMetadataPath(p) || unsafe.has(p)) continue;
      matches.push({ path: p, line: Number(parts[1]), text: parts.slice(2).join("\0").slice(0, 400) });
      if (matches.length >= limit) return { matches, truncated: true };
    }
    return { matches, truncated: false };
  }
}

export function sliceLines(content: string, start?: number, end?: number): { text: string; start: number; end: number } {
  const lines = content.split("\n");
  const s = Math.max(1, start ?? 1);
  const e = Math.min(lines.length, end ?? lines.length);
  return { text: lines.slice(s - 1, e).map((l, i) => `${s + i}| ${l}`).join("\n"), start: s, end: e };
}
