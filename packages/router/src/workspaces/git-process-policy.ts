import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { devNull } from "node:os";
import { authorizedGitIndex, type GitIndexCapability } from "./git-index-transaction.js";

const GIT_NULL = process.platform === "win32" ? "NUL" : devNull;
const IDENTITY_ENV = /^(GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))$/i;
const INTERNAL_COMMANDS = new Set(["init", "add", "commit", "commit-tree", "diff", "diff-tree", "show", "show-ref", "log", "blame", "grep", "rev-parse", "rev-list", "status", "ls-files", "worktree", "switch", "symbolic-ref", "merge-base", "merge", "cherry-pick", "rebase", "revert", "reset", "update-ref", "for-each-ref", "branch", "check-ref-format", "config", "ls-tree", "cat-file", "write-tree", "read-tree", "apply", "check-ignore"]);
const EXECUTABLE_CONFIG = /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver|trailer\..*\.(command|cmd)|diff\..*\.(command|textconv)|core\.alternaterefscommand|include\.path|includeif\..*\.path)$/i;
const SAFE_CONFIG = [
  "core.fsmonitor=false", `core.hooksPath=${GIT_NULL}`, "commit.gpgsign=false", "tag.gpgsign=false", "merge.gpgsign=false",
  "core.pager=", "core.editor=false", "sequence.editor=false", "core.sshCommand=false", "core.gitProxy=",
  "credential.helper=", "protocol.allow=never", "gc.auto=0", "maintenance.auto=false", "submodule.recurse=false",
];

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
  const env = gitProcessEnvironment(overrides);
  if (index !== undefined) env.GIT_INDEX_FILE = authorizedGitIndex(index, cwd, args);
  let policy = SAFE_CONFIG.flatMap(value => ["-c", value]);
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
  const newlineDefaults = trustedNewlineConfiguration().filter(value => !localKeys.has(value.slice(0, value.indexOf("="))));
  policy = [...policy, ...newlineDefaults.flatMap(value => ["-c", value])];
  // Services hand this helper an authorized repository/worktree root. A local core.worktree
  // (or redirected gitdir) must not silently move content reads/staging outside that root.
  // Preserve the exact metadata probe used to diagnose an enclosing repository before init.
  const enclosingProbe = args.join("\0") === ["ls-files", "-z", "--", "."].join("\0") &&
    !config.split("\0").some(entry => /^core\.worktree\n/i.test(entry));
  if (!["init", "config", "rev-parse", "check-ref-format"].includes(command) && !enclosingProbe) {
    const top = execFileSync("git", ["--no-pager", ...policy, "rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 65536 }).trim();
    const canonical = (value: string) => {
      const resolved = path.resolve(realpathSync(value));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (canonical(top) !== canonical(cwd)) throw new Error("Git working tree escapes the authorized repository root; automatic content operations denied");
  }
  // External diff and text conversion are opt-in for several Git readers; force them off even if callers add flags.
  if (["diff", "show", "log", "blame"].includes(command)) args.splice(1, 0, "--no-ext-diff", "--no-textconv");
  return { args: ["--no-pager", ...identity, ...policy, ...args], env };
}
