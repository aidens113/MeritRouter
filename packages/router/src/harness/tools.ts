import { createRepositoryEffects, type RepositoryEffects } from "../workspaces/repository-command.js";
import type { RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import { assertRunAuthority } from "./task-authority.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { ChatTool } from "../gateway/types.js";
import type { RoleName } from "../config/schema.js";
import type { RunContext } from "../runners/types.js";
import type { EvidenceUniverse } from "../core/worker-output.js";
import { normalizeRelPath, sliceLines, type RepoReader } from "../context/repo-reader.js";
import type { Brain } from "../brain/brain.js";
import { normalizeBrainPath } from "../brain/brain.js";
import type { BrainAccess, Principal } from "../brain/access.js";
import type { Actor } from "../attribution/index.js";
import type { ToolSideEffect } from "../sessions/events.js";
import { minimalEnv } from "../runners/coding/process.js";
import { channelTools } from "./channel-tools.js";
import { awaitWorkerCommand, executeSupervisorCommand, requestWorkerCommand, workerSourceIdentity } from "./worker-actions.js";
import { scopedArtifact } from "./check-evidence.js";
import { dirtyPaths } from "../workspaces/git.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";
import { assertNotProjectMetadataPath } from "../projects/metadata-policy.js";

export interface HarnessEnv {
  /** Trusted journal identity for this invocation; never taken from model arguments. */
  toolInvocationId?: string;
  repositoryEffects?: RepositoryEffects;
  repositoryMutation?: RepositoryMutationCapability;
  /** Trusted caller-derived inline output cap, clamped to the active model context. */
  inlineOutputBytes?: number;
  ctx: RunContext;
  role: RoleName;
  readers: Map<string, RepoReader>;
  universe: EvidenceUniverse;
  allowArtifacts: boolean;
  /**
   * Writable workspace (coding workers: their worktree; supervisors: the integration worktree).
   * `guard` refuses an edit with its reason (a delegating supervisor: coordination files only).
   */
  workspace?: { alias: string; root: string; allowedPaths: string[] | null; guard?: ((rel: string) => string | null) | null };
  commands?: { patterns: string[]; cwd: string; timeoutMs: number };
  /** The task's declared checks (constraints.checks), runnable exactly as declared with run_check. */
  checks?: { commands: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; maxRuns: number };
  /** Checks run in this agent loop; read-only task results use these as their execution evidence. */
  checkResults?: Array<{ command: string; exitCode: number | null; logRef: string }>;
  brain?: { brain: Brain; access: BrainAccess; principal: () => Principal; actor: Actor; workingDoc: string | null };
  /** Files edited during the current model response (for per-response commits). */
  edits: Set<string>;
  /** Host-only receipt shared with invocation environments; advanced after an actual bounded async wait. */
  observationWait?: { epoch: number };
}

export interface HarnessTool {
  def: ChatTool;
  /** What the tool does to the world; journaled with each call so resume knows how to treat it. */
  sideEffect: ToolSideEffect;
  /** For `command` tools: safe to re-run on resume. */
  idempotent?: boolean;
  /** The same call may legitimately return new state when repeated. */
  repeatBehavior?: "execute" | "observe" | ((args: Record<string, unknown>) => "execute" | "observe" | undefined);
  /**
   * Whether this run may have the tool at all (default: yes). A tool that is not available is
   * neither offered to the model nor run (the agent loop drops it), e.g. the team channel outside
   * a job.
   */
  available?(env: HarnessEnv): boolean;
  /** Structured adapters distinguish a completed invocation from a successful operation. */
  outputSucceeded?(output: string): boolean;
  /** Remove transport IDs/timing, retaining semantic state for no-progress detection. */
  observationOutput?(output: string): string;
  run(args: Record<string, unknown>, env: HarnessEnv): Promise<string>;
}

/** The tools this run may have (see `HarnessTool.available`). */
export function availableTools(tools: HarnessTool[], env: HarnessEnv): HarnessTool[] {
  return tools.filter((t) => t.available?.(env) ?? true);
}

const MAX = 16_000;
const cap = (t: string) => (t.length > MAX ? `${t.slice(0, MAX)}\n[truncated; narrow the request]` : t);
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
};

function tool(name: string, sideEffect: ToolSideEffect, description: string, properties: Record<string, unknown>, required: string[], run: HarnessTool["run"]): HarnessTool {
  return { def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, sideEffect, run };
}

// ---------- repository reading ----------

export function repoTools(aliases: string[]): HarnessTool[] {
  const alias = { type: "string", enum: aliases, description: "Repository alias" };
  const reader = (env: HarnessEnv, a: unknown) => {
    const name = typeof a === "string" ? a : env.workspace?.alias ?? (env.readers.size === 1 ? env.readers.keys().next().value : undefined);
    const r = name ? env.readers.get(name) : undefined;
    if (!r) throw new Error(`unknown alias; use one of ${[...env.readers.keys()].join(", ")}`);
    return r;
  };
  return [
    tool("list_files", "read", "List files in a repository directory (git-tracked and untracked-not-ignored).", { alias, dir: { type: "string" }, glob: { type: "string" } }, ["alias"], async (a, env) => {
      const r = await reader(env, a.alias).listFiles(String(a.dir ?? ""), typeof a.glob === "string" ? a.glob : undefined);
      if (r.files.length) return cap(`${r.files.join("\n")}${r.truncated ? "\n[more files not shown; narrow dir or glob]" : ""}`);
      // Said plainly: models otherwise read an empty listing as an error and list again and again.
      const where = String(a.dir ?? "").replace(/^\.?\/?$/, "") || "the repository root";
      const filter = typeof a.glob === "string" && a.glob && a.glob !== "*" && a.glob !== "**/*" ? ` matching ${a.glob}` : "";
      return `No files${filter} in ${where}. This is a complete answer, not an error: ${filter ? "nothing matches" : "it is empty (a task that edits creates files with write_file)"}.`;
    }),
    tool("read_file", "read", "Read a file with numbered lines. Use line ranges for large files.", { alias, path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["alias", "path"], async (a, env) => {
      const r = reader(env, a.alias);
      const f = await r.readFile(str(a.path, "path"));
      env.universe.refs.set(`${r.alias}:${f.relPath}`, f.totalLines);
      const s = sliceLines(f.content, Number(a.start_line) || undefined, Number(a.end_line) || undefined);
      return cap(`ref: ${r.alias}:${f.relPath}#L${s.start}-L${s.end} (of ${f.totalLines} lines)\n${s.text}`);
    }),
    tool("search", "read", "Search file contents with an extended regular expression. Returns path:line matches.", { alias, pattern: { type: "string" }, path_glob: { type: "string" }, ignore_case: { type: "boolean" } }, ["alias", "pattern"], async (a, env) => {
      const r = reader(env, a.alias);
      const res = await r.search(str(a.pattern, "pattern"), { ...(typeof a.path_glob === "string" ? { pathGlob: a.path_glob } : {}), ignoreCase: a.ignore_case === true });
      return cap(res.matches.map((m) => `${r.alias}:${m.path}#L${m.line}: ${m.text}`).join("\n") + (res.truncated ? "\n[more matches]" : "")) || "(no matches)";
    }),
  ];
}

export function artifactTool(): HarnessTool {
  return tool("read_artifact", "read", "Read a stored artifact (logs, traces, patches, earlier results) by its artifact:<id> reference.", { ref: { type: "string" } }, ["ref"], async (a, env) => {
    if (!env.allowArtifacts) throw new Error("artifacts are not available to this role");
    const art = scopedArtifact(env, str(a.ref, "ref"));
    const text = art.content.toString("utf8");
    env.universe.refs.set(`artifact:${art.row.id}`, text.split("\n").length);
    return cap(text);
  });
}

// ---------- workspace editing (confined in code, not by prompt) ----------

export function workspacePath(env: HarnessEnv, input: unknown): { rel: string; abs: string } {
  const ws = env.workspace;
  if (!ws) throw new Error("no writable workspace for this role");
  const rel = normalizeRelPath(str(input, "path"));
  if (!rel) throw new Error("path must name a file");
  assertNotProjectMetadataPath(rel);
  if (ws.allowedPaths && !picomatch(ws.allowedPaths, { dot: true })(rel)) {
    throw new Error(`${rel} is outside allowedPaths (${ws.allowedPaths.join(", ")}); the edit was refused`);
  }
  const refused = ws.guard?.(rel);
  if (refused) throw new Error(`${refused} The edit was refused.`);
  const abs = path.join(ws.root, ...rel.split("/"));
  if (path.resolve(abs).toLowerCase() === path.resolve(env.ctx.cfg.configPath).toLowerCase()) throw new Error("agents cannot edit the trusted MeritRouter configuration through repository tools");
  // Even an in-root directory link could redirect an allowed lexical path to a protected
  // file or another worker's scope. Never mutate through linked parent components.
  let parent = path.dirname(abs);
  while (path.resolve(parent) !== path.resolve(ws.root)) {
    if (lstatExists(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`${rel} has a linked parent; edits through directory links are refused`);
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`${rel} escapes the workspace`);
    parent = next;
  }
  const rootReal = realpathSync(ws.root);
  let probe = path.dirname(abs);
  while (!existsSync(probe)) probe = path.dirname(probe);
  const rel2 = path.relative(rootReal, realpathSync(probe));
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) throw new Error(`${rel} resolves outside the workspace`);
  // Never write through a symlink: the link itself could point anywhere.
  if (existsSync(abs) || lstatExists(abs)) {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`${rel} is a symbolic link; edits through links are refused`);
    if (lstatSync(abs).nlink > 1) throw new Error(`${rel} has multiple hard links; edits could affect files outside the workspace`);
    const rel3 = path.relative(rootReal, realpathSync(abs));
    if (rel3.startsWith("..") || path.isAbsolute(rel3)) throw new Error(`${rel} resolves outside the workspace`);
  }
  return { rel, abs };
}

/**
 * The file argument of an edit tool. Models also send it as `file_path`, `filename`, or `file`
 * (live: a 2197-token write_file without `path` was refused and lost); a call with none is refused
 * with what is needed, saying that nothing was written.
 */
function pathArg(a: Record<string, unknown>, toolName: string): string {
  const values = ["path", "file_path", "filename", "file"].map(key => a[key]).filter((value): value is string => typeof value === "string" && !!value.trim());
  if (new Set(values.map(value => value.replace(/\\/g, "/"))).size > 1) throw new Error(`${toolName} received conflicting path fields; provide exactly one path. Nothing was written.`);
  if (values.length) return values[0]!;
  throw new Error(`${toolName} needs path: the file, relative to the repository root (for example "src/posts.js"). Nothing was written; call ${toolName} again with path.`);
}

/** A file the worker edited is citable evidence, like one it read. */
function noteEdited(env: HarnessEnv, rel: string, abs: string): void {
  env.edits.add(rel);
  if (env.workspace) env.readers.get(env.workspace.alias)?.invalidate();
  if (env.workspace && existsSync(abs)) env.universe.refs.set(`${env.workspace.alias}:${rel}`, readFileSync(abs, "utf8").split(/\r?\n/).length);
}

/** Guard actual repository effects, including direct tool calls without runner injection. */
export async function withRepositoryToolWrite<T>(env: HarnessEnv, action: (guarded: HarnessEnv) => T | Promise<T>): Promise<T> {
  let effects = env.repositoryEffects;
  if (!effects && env.workspace) {
    let directory = path.resolve(env.workspace.root);
    while (true) {
      if (lstatExists(path.join(directory, ".git")) || (lstatExists(path.join(directory, "HEAD")) && lstatExists(path.join(directory, "objects")))) {
        effects = createRepositoryEffects(env.workspace.root); break;
      }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
  }
  const execute = (guarded: HarnessEnv) => { assertRunAuthority(env.ctx); return action(guarded); };
  return effects ? effects.withWrite(cap => execute({ ...env, repositoryEffects: effects, repositoryMutation: cap }), env.repositoryMutation) : execute(env);
}

export function editTools(): HarnessTool[] {
  return [
    tool("write_file", "edit", "Create or overwrite a file in your workspace with the full new content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"], async (a, env) => withRepositoryToolWrite(env, async env => {
      const { rel, abs } = workspacePath(env, pathArg(a, "write_file"));
      mkdirSync(path.dirname(abs), { recursive: true });
      // Keep an existing file's line-ending style.
      const crlf = existsSync(abs) && readFileSync(abs, "utf8").includes("\r\n");
      const content = String(a.content ?? "").replace(/\r\n/g, "\n");
      writeFileSync(abs, crlf ? content.replace(/\n/g, "\r\n") : content);
      noteEdited(env, rel, abs);
      return `wrote ${rel} (${String(a.content ?? "").split("\n").length} lines)`;
    })),
    tool(
      "replace_in_file",
      "edit",
      "Replace an exact text snippet in a file. old_text must match exactly once unless replace_all is true.",
      { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } },
      ["path", "old_text", "new_text"],
      async (a, env) => withRepositoryToolWrite(env, async env => {
        const { rel, abs } = workspacePath(env, pathArg(a, "replace_in_file"));
        if (!existsSync(abs)) throw new Error(`${rel} does not exist`);
        // Match on LF-normalised text and write back in the file's own line-ending style, so
        // CRLF checkouts work with model output that uses \n.
        const raw = readFileSync(abs, "utf8");
        const crlf = raw.includes("\r\n");
        const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
        const oldText = str(a.old_text, "old_text").replace(/\r\n/g, "\n");
        const newText = String(a.new_text ?? "").replace(/\r\n/g, "\n");
        const count = text.split(oldText).length - 1;
        if (count === 0) throw new Error("old_text not found; read the file again and copy the exact text");
        if (count > 1 && a.replace_all !== true) throw new Error(`old_text matches ${count} times; add surrounding context or set replace_all`);
        const next = a.replace_all === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
        writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next);
        noteEdited(env, rel, abs);
        return `replaced ${a.replace_all === true ? count : 1} occurrence(s) in ${rel}`;
      }),
    ),
    tool("delete_file", "edit", "Delete a file in your workspace.", { path: { type: "string" } }, ["path"], async (a, env) => withRepositoryToolWrite(env, async env => {
      const { rel, abs } = workspacePath(env, pathArg(a, "delete_file"));
      if (!existsSync(abs)) throw new Error(`${rel} does not exist`);
      rmSync(abs);
      env.edits.add(rel);
      if (env.workspace) env.readers.get(env.workspace.alias)?.invalidate();
      return `deleted ${rel}`;
    })),
  ];
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Shell syntax that could chain, redirect, or substitute commands. */
const SHELL_META = /[;&|<>`$\n\r\\%^]|\(|\)/;

/**
 * Allowed command patterns use `*` as a wildcard (e.g. `npm test*`). Commands containing shell
 * operators are refused outright, so a pattern can never be extended with `&& ...` or `; ...`.
 */
export function commandAllowed(command: string, patterns: string[]): boolean {
  if (SHELL_META.test(command)) return false;
  return patterns.some((p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(command.trim()));
}

export function commandTool(patterns: string[]): HarnessTool {
  return tool(
    "run_command",
    "command",
    `Run an allowed command in your workspace. Allowed patterns: ${patterns.join(", ")}`,
    { command: { type: "string" } },
    ["command"],
    async (a, env) => {
      const c = env.commands;
      const command = str(a.command, "command");
      if (!c || !commandAllowed(command, c.patterns)) throw new Error(`command not allowed; allowed patterns: ${c?.patterns.join(", ") || "none"}`);
      if (!env.ctx.taskLease || !currentSupervisorAuthority(env.ctx.tasks.db, env.ctx.cfg, env.ctx.taskLease, env.ctx.now())) {
        const request = await requestWorkerCommand(env.ctx, { command, cwd: c.cwd, timeoutMs: c.timeoutMs, invocationId: env.toolInvocationId, reason: "Worker command requires supervisor execution because no OS repository sandbox is available." });
        return JSON.stringify(request);
      }
      const r = await executeSupervisorCommand(env.ctx, { command, invocationId: env.toolInvocationId, cwd: c.cwd, timeoutMs: c.timeoutMs, reason: "Supervisor command tool", env: minimalEnv({ CI: "1" }) });
      return cap(`$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""}\n${r.stdout}\n${r.stderr}`);
    },
  );
}

/** Task event of one run_check run by a worker (counted against coding.max_check_runs_per_task). */
export const WORKER_CHECK_EVENT = "worker_check_run";

const tail = (t: string, n: number) => (t.length > n ? `[...]\n${t.slice(-n)}` : t);

/**
 * A coding worker's own runs of its task's declared checks (constraints.checks), with the same
 * working directory, environment, timeout, and shell as the checks run after it submits. Only a
 * declared command, exactly as declared, is accepted; runs are capped per task. Results are
 * informational: the post-submission checks still decide acceptance.
 */
export function declaredCheckTool(): HarnessTool {
  return {
    ...tool(
      "run_check",
      "command",
      "Run one of your task's declared checks in your task workspace and see its output. Pass the command exactly as declared; arbitrary commands are refused. The returned artifact is evidence you may cite with its exact artifact:<id> reference. Coding tasks run checks again after submission; read-only tasks retain this run as their check evidence.",
      { command: { type: "string", description: "one declared check, exactly as listed in your brief" } },
      ["command"],
      async (a, env) => {
        const c = env.checks;
        if (!c?.commands.length) throw new Error("this task declares no checks");
        const raw = typeof a.command === "string" ? a.command : "";
        const command = c.commands.includes(raw) ? raw : c.commands.find((x) => x === raw.trim());
        if (!command) throw new Error(`not a declared check; run exactly one of: ${c.commands.map((x) => JSON.stringify(x)).join(", ")} (there is no shell for anything else)`);
        const taskId = env.ctx.taskId;
        const runs = (env.ctx.tasks.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?").get(taskId, WORKER_CHECK_EVENT) as { n: number }).n;
        if (runs >= c.maxRuns) throw new Error(`check run limit reached (${runs} of ${c.maxRuns}, coding.max_check_runs_per_task): fix what the last output showed and submit_result; the checks run again after you submit`);
        if (!env.ctx.taskLease || !currentSupervisorAuthority(env.ctx.tasks.db, env.ctx.cfg, env.ctx.taskLease, env.ctx.now())) {
          const reader = [...env.readers.values()].find(r => path.resolve(r.root) === path.resolve(c.cwd));
          if (reader?.commit && (reader.commit !== (await reader.headSha()) || (await dirtyPaths(reader.root)).length > 0)) throw new Error("declared check source differs from the pinned read revision; no host check may run against another revision or dirty worktree");
          const request = await awaitWorkerCommand(env.ctx, { command, cwd: c.cwd, timeoutMs: c.timeoutMs, invocationId: env.toolInvocationId ?? `worker_check:${runs}`, reason: "Declared check requires exact supervisor execution; worker shell is not OS-contained." });
          if (request.status !== "completed" || request.action.operation) return JSON.stringify(request);
          const logContent = request.output ?? "supervisor command output unavailable";
          const logRef = env.ctx.artifacts.write({ taskId, kind: "check_log", label: `supervisor check: ${command}`, content: logContent, extension: ".log" });
          env.universe.refs.set(logRef, logContent.split(/\r?\n/).length);
          const record = { command, exitCode: request.action.source === await workerSourceIdentity(c.cwd) ? request.exitCode : null, logRef };
          env.checkResults?.push(record);
          env.ctx.tasks.event(taskId, WORKER_CHECK_EVENT, { ...record, actionId: request.id, source: request.action.source, sessionId: env.ctx.session?.id ?? null });
          return cap(`${logContent}\n(log ${logRef}; supervisor action ${request.id})`);
        }
        const r = await executeSupervisorCommand(env.ctx, { command, invocationId: env.toolInvocationId, cwd: c.cwd, env: c.env, timeoutMs: c.timeoutMs, reason: "Supervisor declared check" });
        const exit = r.killed ? null : r.exitCode;
        const logContent = `$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""}\n\n${r.stdout}\n${r.stderr}`;
        const logRef = env.ctx.artifacts.write({ taskId, kind: "check_log", label: `run_check: ${command}`, content: logContent, extension: ".log" });
        env.universe.refs.set(logRef, logContent.split(/\r?\n/).length);
        env.checkResults?.push({ command, exitCode: exit, logRef });
        env.ctx.tasks.event(taskId, WORKER_CHECK_EVENT, { command, exitCode: exit, logRef });
        return cap(`$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""} (log ${logRef}; run ${runs + 1} of ${c.maxRuns})\n${tail(r.stdout, 8000)}\n${tail(r.stderr, 4000)}`);
      },
    ),
    idempotent: true,
    repeatBehavior: "execute",
    available: (env) => !!env.checks?.commands.length && env.checks.maxRuns > 0,
  };
}

// ---------- brain ----------

function brainOf(env: HarnessEnv) {
  if (!env.brain) throw new Error("the brain is not available to this role");
  return env.brain;
}

/** Only canonical global preference reads may cross from a project to the trusted install. */
export function memoryReadBrain(env: HarnessEnv, input: string): Brain {
  const normalized = normalizeBrainPath(input);
  return (normalized === "global/preferences" || normalized.startsWith("global/preferences/")) && env.ctx.installBrain
    ? env.ctx.installBrain : brainOf(env).brain;
}

/**
 * Brain read tools, and the team channel (`post_channel`, `read_channel`): every role given the
 * brain (workers and supervisors) gets the channel with it, but only while its task belongs to a
 * job (the channel tools are unavailable otherwise). Reviewers get neither.
 */
export function brainReadTools(): HarnessTool[] {
  return [
    ...channelTools(),
    tool("brain_search", "read", "Search shared knowledge (working documents, decisions, lessons) you have access to.", { query: { type: "string" }, prefix: { type: "string" } }, ["query"], async (a, env) => {
      const b = brainOf(env);
      const hits = memoryReadBrain(env, typeof a.prefix === "string" ? a.prefix : "").search(b.principal(), str(a.query, "query"), { ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}), limit: 8 });
      return hits.map((h) => `brain:${h.path} (${h.kind}) ${h.title ?? ""}\n  ${h.snippet}`).join("\n") || "(no results you can read; request access if you need more)";
    }),
    tool("brain_read", "read", "Read a brain entry, optionally one section (e.g. 'Current State').", { path: { type: "string" }, section: { type: "string" } }, ["path"], async (a, env) => {
      const b = brainOf(env);
      const r = memoryReadBrain(env, str(a.path, "path")).read(b.principal(), str(a.path, "path"), typeof a.section === "string" ? { section: a.section } : {});
      env.universe.refs.set(`brain:${r.path}`, r.lines);
      return cap(`ref: brain:${r.path}\n${r.content}`);
    }),
    tool("brain_list", "read", "List brain entries under a prefix that you can read.", { prefix: { type: "string" } }, [], async (a, env) => {
      const b = brainOf(env);
      return memoryReadBrain(env, typeof a.prefix === "string" ? a.prefix : "").list(b.principal(), typeof a.prefix === "string" ? a.prefix : "").map((e) => `${e.path} (${e.kind}${e.status ? `, ${e.status}` : ""}) ${e.title ?? ""}`).join("\n") || "(nothing you can read here)";
    }),
    tool(
      "brain_request_access",
      "brain",
      "Ask for access to brain entries outside your grants. Continue with what you have; check back with brain_my_requests.",
      { pattern: { type: "string", description: "Path or glob, e.g. projects/x/decisions/**" }, mode: { type: "string", enum: ["read", "append", "write"] }, reason: { type: "string" } },
      ["pattern", "mode", "reason"],
      async (a, env) => {
        const b = brainOf(env);
        const req = b.access.request(b.principal(), str(a.pattern, "pattern"), (a.mode as "read") ?? "read", str(a.reason, "reason"));
        return `request ${req.id}: ${req.status}${req.status === "pending" ? ` (decided by the ${env.ctx.cfg.brain.access_approver})` : ""}`;
      },
    ),
    tool("brain_my_requests", "read", "Status of your brain access requests.", {}, [], async (_a, env) => {
      const p = brainOf(env).principal();
      const reqs = brainOf(env).access.list(p.kind === "agent" && p.taskId ? { taskId: p.taskId } : {});
      return reqs.map((r) => `${r.id} ${r.mode} ${r.pattern}: ${r.status}${r.decisionReason ? ` (${r.decisionReason})` : ""}`).join("\n") || "(no requests)";
    }),
  ];
}

export function brainSupervisorTools(): HarnessTool[] {
  const doc = (env: HarnessEnv, a: Record<string, unknown>) => (typeof a.path === "string" && a.path ? a.path : brainOf(env).workingDoc ?? "");
  return [
    tool("brain_set_current_state", "brain", "Rewrite the Current State of your job's working document (or another you own). Keep it under the line limit.", { body: { type: "string" }, path: { type: "string" } }, ["body"], async (a, env) => {
      const b = brainOf(env);
      await b.brain.setCurrentState(b.principal(), b.actor, doc(env, a), str(a.body, "body"));
      return "Current State updated";
    }),
    tool(
      "brain_append_ledger",
      "brain",
      "Append a Work Ledger entry. validation must be the exact command you ran and what it printed, or 'not validated' and why.",
      { title: { type: "string" }, changed: { type: "string" }, why: { type: "string" }, validation: { type: "string" }, outcome: { type: "string", enum: ["Accepted", "Partial", "Reverted", "Blocked"] }, follow_up: { type: "string" }, path: { type: "string" } },
      ["title", "changed", "why", "validation", "outcome", "follow_up"],
      async (a, env) => {
        const b = brainOf(env);
        const r = await b.brain.appendLedger(b.principal(), b.actor, doc(env, a), {
          title: str(a.title, "title"),
          agent: b.actor.agent,
          changed: str(a.changed, "changed"),
          why: str(a.why, "why"),
          validation: str(a.validation, "validation"),
          outcome: a.outcome as "Accepted",
          followUp: str(a.follow_up, "follow_up"),
        });
        return `ledger entry added${r.compactionDue ? "; the document is due for compaction (brain_compact)" : ""}`;
      },
    ),
    tool("brain_write", "brain", "Create or replace a brain note (decisions/, facts/, repos/<alias>.md) in your project.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"], async (a, env) => {
      const b = brainOf(env);
      const r = await b.brain.write(b.principal(), b.actor, str(a.path, "path"), str(a.content, "content"));
      return `wrote ${r.path}`;
    }),
    tool(
      "brain_promote_lesson",
      "brain",
      "Propose a lesson for global knowledge, which every project's agents read. Only for lessons that hold beyond this project: name nothing of this project (its name, repositories, paths, files) and cite at least one source in this project's brain (projects/<project>/...). An independent reviewer on another model judges it; a rejected lesson is kept in this project's decisions/lessons/ with the reason.",
      { title: { type: "string" }, body: { type: "string" }, sources: { type: "array", items: { type: "string" }, description: "Brain paths the lesson rests on, at least one in this project's brain" } },
      ["title", "body", "sources"],
      async (a, env) => {
        const b = brainOf(env);
        const r = await b.brain.promoteLesson(b.principal(), b.actor, str(a.title, "title"), str(a.body, "body"), Array.isArray(a.sources) ? a.sources.map(String) : []);
        if (r.status === "approved") return `promoted to ${r.path}`;
        if (r.status === "rejected") return `not promoted: ${r.reason ?? "rejected"}. Kept in the project as ${r.path}.`;
        return `promotion ${r.id} is ${r.status.replace("_", " ")}${r.reason ? `: ${r.reason}` : ""}. Nothing is needed from you; it is decided without you.`;
      },
    ),
    tool("brain_compact", "brain", "Move older ledger entries of a working document to its archive.", { path: { type: "string" } }, [], async (a, env) => {
      const b = brainOf(env);
      const r = await b.brain.compact(b.principal(), b.actor, doc(env, a));
      return r.archive ? `archived to ${r.archive}` : "nothing to compact";
    }),
    tool("brain_access_requests", "read", "List pending brain access requests from your workers.", {}, [], async (_a, env) => {
      const p = brainOf(env).principal();
      const reqs = brainOf(env).access.list({ status: "pending", ...(p.kind === "agent" && p.jobId ? { jobId: p.jobId } : {}) });
      return reqs.map((r) => `${r.id} task ${r.taskId} (${r.role}) wants ${r.mode} on ${r.pattern}: ${r.reason}`).join("\n") || "(none pending)";
    }),
    tool("brain_decide_request", "brain", "Approve or deny a worker's brain access request, with a reason.", { id: { type: "integer" }, approve: { type: "boolean" }, reason: { type: "string" } }, ["id", "approve", "reason"], async (a, env) => {
      const b = brainOf(env);
      const r = b.access.decide(Number(a.id), a.approve === true, b.actor.agent, str(a.reason, "reason"),b.principal());
      return `request ${r.id}: ${r.status}`;
    }),
  ];
}

export type { Principal };
