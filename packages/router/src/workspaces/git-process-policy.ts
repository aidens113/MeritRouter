import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { devNull } from "node:os";
import { authorizedGitIndex, type GitIndexCapability } from "./git-index-transaction.js";

const GIT_NULL = process.platform === "win32" ? "NUL" : devNull;
const IDENTITY_ENV = /^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))$/i;
const INTERNAL_COMMANDS = new Set(["init", "add", "commit", "commit-tree", "diff", "diff-tree", "show", "show-ref", "log", "blame", "grep", "rev-parse", "rev-list", "status", "ls-files", "worktree", "switch", "symbolic-ref", "merge-base", "merge", "cherry-pick", "rebase", "revert", "reset", "update-ref", "for-each-ref", "branch", "check-ref-format", "config", "ls-tree", "cat-file", "write-tree", "read-tree", "apply", "check-ignore", "stripspace", "interpret-trailers"]);
const EXECUTABLE_CONFIG = /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver|trailer\..*\.(command|cmd)|diff\..*\.(command|textconv)|core\.alternaterefscommand|include\.path|includeif\..*\.path)$/i;
const SAFE_CONFIG = [
  ...(process.platform === "win32" ? ["core.longpaths=true"] : []),
  "core.fsmonitor=false", `core.hooksPath=${GIT_NULL}`, "commit.gpgsign=false", "tag.gpgsign=false", "merge.gpgsign=false",
  "core.pager=", "core.editor=false", "sequence.editor=false", "core.sshCommand=false", "core.gitProxy=",
  "credential.helper=", "protocol.allow=never", "gc.auto=0", "maintenance.auto=false", "submodule.recurse=false",
];

/** Closed formatting-only argv: never accepts a filename, in-place write or extra option. */
export function isCommitMessageStdinCommand(args: readonly string[]): boolean {
  if (args.join("\0") === "stripspace" || args.join("\0") === "stripspace\0--strip-comments") return true;
  return args[0] === "interpret-trailers" && args[1] === "--no-divider" && args.length >= 4 && args.length <= 82 && args.length % 2 === 0
    && args.slice(2).every((arg, offset) => offset % 2 === 0 ? arg === "--trailer" : arg.length > 0 && arg.length <= 4096 && !/[\0\r\n]/.test(arg))
    && args.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) <= 32768;
}

/** No inherited Git config, directory redirection, external-command or trace-file injection. */
export function gitProcessEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key) || IDENTITY_ENV.test(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!IDENTITY_ENV.test(key)) throw new Error(`internal Git environment override denied: ${key}`);
    env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: GIT_NULL, GIT_CONFIG_GLOBAL: GIT_NULL,
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false", GIT_SSH_COMMAND: "false", GIT_ASKPASS: "false", SSH_ASKPASS: "false" };
}

// Snapshot only non-executable newline semantics from standard trusted installation/user config.
// Never honor inherited GIT_CONFIG_* paths or config includes. Local repository values still win.
let trustedNewlines: string[] | undefined;
function trustedNewlineConfiguration(): string[] {
  if (trustedNewlines) return trustedNewlines;
  const env = gitProcessEnvironment();
  delete env.GIT_CONFIG_SYSTEM; delete env.GIT_CONFIG_GLOBAL; delete env.GIT_CONFIG_NOSYSTEM;
  const values = new Map<string, string>();
  for (const scope of ["--system", "--global"]) {
    let raw: string;
    try {
      raw = execFileSync("git", ["--no-pager", "config", scope, "--no-includes", "--null", "--get-regexp", "^core\\.(autocrlf|eol|safecrlf)$"], { env, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    } catch (error) {
      if ((error as { status?: number }).status === 1) continue;
      throw error;
    }
    for (const entry of raw.split("\0")) {
      const split = entry.indexOf("\n");
      if (split < 0) continue;
      const key = entry.slice(0, split).toLowerCase();
      let value = entry.slice(split + 1).toLowerCase();
      if (key !== "core.eol") {
        if (["", "yes", "on", "1"].includes(value)) value = "true";
        else if (["no", "off", "0"].includes(value)) value = "false";
      }
      const allowed = key === "core.eol" ? ["lf", "crlf", "native"] : key === "core.autocrlf" ? ["true", "false", "input"] : key === "core.safecrlf" ? ["true", "false", "warn"] : [];
      if (!allowed.includes(value)) throw new Error(`invalid trusted Git newline configuration: ${key}`);
      values.set(key, value);
    }
  }
  trustedNewlines = [...values].map(([key, value]) => `${key}=${value}`);
  return trustedNewlines;
}

/**
 * Per-repository policy verdicts (config safety, trusted newline defaults, worktree-root
 * containment). Each verdict is reused only while the repository's discovery and config
 * fingerprint is identical; otherwise both probes run again exactly as before.
 */
interface PolicyVerdict { fingerprint: string; newlineDefaults: string[]; hasCoreWorktree: boolean; rootVerified: boolean }
const verdicts = new Map<string, PolicyVerdict>();
const MAX_VERDICTS = 256;
const MAX_POINTER_BYTES = 4096;
function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
/** Content stamp for files Git reads: identity, size, nanosecond times; "-" when absent. */
function fileStamp(file: string): string {
  try {
    const stat = lstatSync(file, { bigint: true });
    return `${stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "o"}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) { if (missing(error)) return "-"; throw error; }
}
/** Identity stamp for directories whose entries change on every write (.git, objects, refs). */
function directoryStamp(directory: string): string {
  try {
    const stat = lstatSync(directory, { bigint: true });
    return `${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "o"}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}`;
  } catch (error) { if (missing(error)) return "-"; throw error; }
}
function pointer(file: string): string | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch (error) { if (missing(error)) return null; throw error; }
}
/**
 * Everything the cached verdicts depend on, read without starting Git: the physical root, its
 * own `.git` entry (directory, or gitfile and its target), the commondir pointer, HEAD, the
 * repository and worktree config files (includes are refused by the config check itself), and
 * the objects/refs directories that make the gitdir valid for discovery. Returns null, so the
 * probes always run, when discovery would leave the root (no `.git` entry here) or is unusual.
 */
function repositoryFingerprint(cwd: string): { key: string; value: string } | null {
  try {
    // Windows paths compare case-insensitively; callers reach one root with differing case.
    const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const root = realpathSync(path.resolve(cwd)), dotGit = path.join(root, ".git");
    const entry = lstatSync(dotGit);
    const parts = [fold(root), entry.isDirectory() ? directoryStamp(dotGit) : fileStamp(dotGit)];
    let gitDir: string;
    if (entry.isDirectory()) gitDir = dotGit;
    else if (entry.isFile()) {
      const text = pointer(dotGit);
      const match = text === null ? null : /^gitdir: (.+?)[ \t]*\r?\n?$/.exec(text);
      if (!text || !match) return null;
      parts.push(text); gitDir = path.resolve(root, match[1]!);
    } else return null;
    const commondirFile = path.join(gitDir, "commondir"), commondir = pointer(commondirFile);
    const common = commondir === null ? gitDir : path.resolve(gitDir, commondir.trim());
    parts.push(fold(gitDir), directoryStamp(gitDir), fileStamp(path.join(gitDir, "HEAD")), fileStamp(commondirFile), commondir ?? "",
      fold(common), directoryStamp(common), fileStamp(path.join(common, "config")), fileStamp(path.join(gitDir, "config.worktree")),
      directoryStamp(path.join(common, "objects")), directoryStamp(path.join(common, "refs")));
    return { key: process.platform === "win32" ? root.toLowerCase() : root, value: parts.join("\0") };
  } catch { return null; }
}

/** Shared by async Git and the few fixed synchronous metadata reads. This is not a worker shell API. */
export function prepareGitProcess(cwd: string, input: readonly string[], overrides: Record<string, string> = {}, index?: GitIndexCapability): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = [...input];
  const identity: string[] = [];
  while (args[0] === "-c") {
    args.shift();
    const value = args.shift();
    if (!value || !/^(user\.(name|email)=|commit\.gpgsign=false$)/i.test(value)) throw new Error("internal Git config override denied");
    identity.push("-c", value);
  }
  const command = args[0];
  if (!command || !INTERNAL_COMMANDS.has(command)) throw new Error(`unsupported internal Git command: ${command ?? "empty"}`);
  if (["stripspace", "interpret-trailers"].includes(command) && !isCommitMessageStdinCommand(args)) throw new Error("Git commit-message stdin command requires exact formatting-only arguments");
  const env = gitProcessEnvironment(overrides);
  if (index !== undefined) env.GIT_INDEX_FILE = authorizedGitIndex(index, cwd, args);
  let policy = SAFE_CONFIG.flatMap(value => ["-c", value]);
  // The verdicts below depend only on files the fingerprint covers; reuse them while it holds.
  const fingerprint = repositoryFingerprint(cwd);
  const cached = fingerprint ? verdicts.get(fingerprint.key) : undefined;
  const verdict = cached && cached.fingerprint === fingerprint?.value ? cached : undefined;
  let newlineDefaults: string[], hasCoreWorktree: boolean;
  if (verdict) ({ newlineDefaults, hasCoreWorktree } = verdict);
  else {
    // Reading configuration is a built-in metadata operation; it does not run filters/hooks.
    // Reject configured conversion/merge/trailer programs rather than silently changing file semantics.
    const config = execFileSync("git", ["--no-pager", ...policy, "config", "--no-includes", "--null", "--list"], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    for (const entry of config.split("\0")) {
      const split = entry.indexOf("\n");
      const key = split < 0 ? entry : entry.slice(0, split);
      const value = split < 0 ? "" : entry.slice(split + 1);
      if (EXECUTABLE_CONFIG.test(key) && value.trim()) throw new Error(`unsafe repository Git configuration: ${key}; automatic Git operations cannot execute repository programs`);
    }
    const localKeys = new Set(config.split("\0").map(entry => entry.slice(0, entry.indexOf("\n") < 0 ? entry.length : entry.indexOf("\n")).toLowerCase()));
    newlineDefaults = trustedNewlineConfiguration().filter(value => !localKeys.has(value.slice(0, value.indexOf("="))));
    hasCoreWorktree = config.split("\0").some(entry => /^core\.worktree\n/i.test(entry));
  }
  policy = [...policy, ...newlineDefaults.flatMap(value => ["-c", value])];
  // Services hand this helper an authorized repository/worktree root. A local core.worktree
  // (or redirected gitdir) must not silently move content reads/staging outside that root.
  // Preserve the exact metadata probe used to diagnose an enclosing repository before init.
  const enclosingProbe = args.join("\0") === ["ls-files", "-z", "--", "."].join("\0") && !hasCoreWorktree;
  let rootVerified = verdict?.rootVerified ?? false;
  if (!["init", "config", "rev-parse", "check-ref-format"].includes(command) && !enclosingProbe && !rootVerified) {
    const top = execFileSync("git", ["--no-pager", ...policy, "rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 }).trim();
    const canonical = (value: string) => {
      const resolved = path.resolve(realpathSync(value));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (canonical(top) !== canonical(cwd)) throw new Error("Git working tree escapes the authorized repository root; automatic content operations denied");
    rootVerified = true;
  }
  // Re-fingerprint after the probes: a change while they ran must not be cached as verified.
  if (fingerprint && (!verdict || rootVerified !== verdict.rootVerified) && repositoryFingerprint(cwd)?.value === fingerprint.value) {
    verdicts.delete(fingerprint.key);
    if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!);
    verdicts.set(fingerprint.key, { fingerprint: fingerprint.value, newlineDefaults, hasCoreWorktree, rootVerified });
  }
  // External diff and text conversion are opt-in for several Git readers; force them off even if callers add flags.
  if (["diff", "show", "log", "blame"].includes(command)) args.splice(1, 0, "--no-ext-diff", "--no-textconv");
  return { args: ["--no-pager", ...identity, ...policy, ...args], env };
}
