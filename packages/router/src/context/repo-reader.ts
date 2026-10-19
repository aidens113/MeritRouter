import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { git, headSha, dirtyPaths } from "../workspaces/git.js";

export const MAX_FILE_BYTES = 512 * 1024;

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

  async headSha(): Promise<string> {
    this.head ??= await headSha(this.root);
    return this.head;
  }

  async dirtyPaths(): Promise<Set<string>> {
    this.dirty ??= new Set(await dirtyPaths(this.root));
    return this.dirty;
  }

  private async resolveWorktreePath(rel: string): Promise<string> {
    this.rootReal ??= await realpath(this.root);
    const abs = path.resolve(this.rootReal, ...rel.split("/"));
    const real = await realpath(abs);
    const relToRoot = path.relative(this.rootReal, real);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) throw new Error(`path resolves outside the repository: ${rel}`);
    return real;
  }

  async readFile(relInput: string): Promise<FileContent> {
    const rel = normalizeRelPath(relInput);
    let buf: Buffer;
    if (this.commit) {
      const out = await git(this.root, ["cat-file", "-s", `${this.commit}:${rel}`]).catch(() => {
        throw new Error(`${this.alias}:${rel} does not exist at ${this.commit}`);
      });
      if (Number(out.trim()) > MAX_FILE_BYTES) throw new Error(`${this.alias}:${rel} exceeds ${MAX_FILE_BYTES} bytes`);
      buf = Buffer.from(await git(this.root, ["show", `${this.commit}:${rel}`]), "utf8");
    } else {
      const abs = await this.resolveWorktreePath(rel).catch(() => {
        throw new Error(`${this.alias}:${rel} does not exist`);
      });
      const st = await stat(abs);
      if (!st.isFile()) throw new Error(`${this.alias}:${rel} is not a file`);
      if (st.size > MAX_FILE_BYTES) throw new Error(`${this.alias}:${rel} exceeds ${MAX_FILE_BYTES} bytes`);
      buf = await readFile(abs);
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
      dirty: this.commit ? false : (await this.dirtyPaths()).has(rel),
    };
  }

  /** Tracked (and, in the working tree, untracked-but-not-ignored) files under `dir`. */
  async listFiles(dirInput = "", glob?: string, limit = 500): Promise<{ files: string[]; truncated: boolean }> {
    const dir = dirInput ? normalizeRelPath(dirInput) : "";
    const out = this.commit
      ? await git(this.root, ["ls-tree", "-r", "--name-only", "-z", this.commit, ...(dir ? ["--", dir] : [])])
      : await git(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(dir ? ["--", dir] : [])]);
    let files = [...new Set(out.split("\0").filter(Boolean))].sort();
    if (glob) {
      const match = picomatch(glob, { dot: true });
      files = files.filter((f) => match(f) || match(path.posix.basename(f)));
    }
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }

  /** Line matches for an extended regular expression (git grep semantics). */
  async search(
    pattern: string,
    opts: { pathGlob?: string; ignoreCase?: boolean; limit?: number } = {},
  ): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
    const limit = opts.limit ?? 100;
    const args = ["grep", "-n", "-I", "-E", "--no-color", "-z", ...(opts.ignoreCase ? ["-i"] : []), "-e", pattern];
    if (this.commit) args.push(this.commit);
    else args.push("--untracked");
    if (opts.pathGlob) args.push("--", `:(glob)${normalizeRelPath(opts.pathGlob)}`);
    const out = await git(this.root, args, { allowExit: [1] });
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const raw of out.split("\n")) {
      if (!raw) continue;
      // -z output: <rev>:<path>\0<line>\0<text> at a commit, <path>\0<line>\0<text> otherwise.
      const parts = raw.split("\0");
      if (parts.length < 3) continue;
      let p = parts[0]!;
      if (this.commit && p.startsWith(`${this.commit}:`)) p = p.slice(this.commit.length + 1);
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
