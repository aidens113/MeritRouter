import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { ChatTool } from "../gateway/types.js";
import type { RoleName } from "../config/schema.js";
import type { RunContext } from "../runners/types.js";
import type { EvidenceUniverse } from "../core/worker-output.js";
import { normalizeRelPath, sliceLines, type RepoReader } from "../context/repo-reader.js";
import type { Brain } from "../brain/brain.js";
import type { BrainAccess, Principal } from "../brain/access.js";
import type { Actor } from "../attribution/index.js";
import type { ToolSideEffect } from "../sessions/events.js";
import { minimalEnv, runProcess } from "../runners/coding/process.js";

export interface HarnessEnv {
  ctx: RunContext;
  role: RoleName;
  readers: Map<string, RepoReader>;
  universe: EvidenceUniverse;
  allowArtifacts: boolean;
  /** Writable workspace (coding workers: their worktree; supervisors: the integration worktree). */
  workspace?: { alias: string; root: string; allowedPaths: string[] | null };
  commands?: { patterns: string[]; cwd: string; timeoutMs: number };
  brain?: { brain: Brain; access: BrainAccess; principal: () => Principal; actor: Actor; workingDoc: string | null };
  /** Files edited during the current model response (for per-response commits). */
  edits: Set<string>;
}

export interface HarnessTool {
  def: ChatTool;
  /** What the tool does to the world; journaled with each call so resume knows how to treat it. */
  sideEffect: ToolSideEffect;
  /** For `command` tools: safe to re-run on resume. */
  idempotent?: boolean;
  run(args: Record<string, unknown>, env: HarnessEnv): Promise<string>;
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
    const r = typeof a === "string" ? env.readers.get(a) : undefined;
    if (!r) throw new Error(`unknown alias; use one of ${[...env.readers.keys()].join(", ")}`);
    return r;
  };
  return [
    tool("list_files", "read", "List files in a repository directory (git-tracked and untracked-not-ignored).", { alias, dir: { type: "string" }, glob: { type: "string" } }, ["alias"], async (a, env) => {
      const r = await reader(env, a.alias).listFiles(String(a.dir ?? ""), typeof a.glob === "string" ? a.glob : undefined);
      return cap(`${r.files.join("\n")}${r.truncated ? "\n[more files not shown; narrow dir or glob]" : ""}`) || "(no files)";
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
    const art = env.ctx.artifacts.read(str(a.ref, "ref"));
    if (!art) throw new Error("unknown artifact");
    const text = art.content.toString("utf8");
    env.universe.refs.set(`artifact:${art.row.id}`, text.split("\n").length);
    return cap(text);
  });
}

// ---------- workspace editing (confined in code, not by prompt) ----------

function workspacePath(env: HarnessEnv, input: unknown): { rel: string; abs: string } {
  const ws = env.workspace;
  if (!ws) throw new Error("no writable workspace for this role");
  const rel = normalizeRelPath(str(input, "path"));
  if (!rel) throw new Error("path must name a file");
  if (ws.allowedPaths && !picomatch(ws.allowedPaths, { dot: true })(rel)) {
    throw new Error(`${rel} is outside allowedPaths (${ws.allowedPaths.join(", ")}); the edit was refused`);
  }
  const abs = path.join(ws.root, ...rel.split("/"));
  const rootReal = realpathSync(ws.root);
  let probe = path.dirname(abs);
  while (!existsSync(probe)) probe = path.dirname(probe);
  const rel2 = path.relative(rootReal, realpathSync(probe));
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) throw new Error(`${rel} resolves outside the workspace`);
  // Never write through a symlink: the link itself could point anywhere.
  if (existsSync(abs) || lstatExists(abs)) {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`${rel} is a symbolic link; edits through links are refused`);
    const rel3 = path.relative(rootReal, realpathSync(abs));
    if (rel3.startsWith("..") || path.isAbsolute(rel3)) throw new Error(`${rel} resolves outside the workspace`);
  }
  return { rel, abs };
}

/** A file the worker edited is citable evidence, like one it read. */
function noteEdited(env: HarnessEnv, rel: string, abs: string): void {
  env.edits.add(rel);
  if (env.workspace && existsSync(abs)) env.universe.refs.set(`${env.workspace.alias}:${rel}`, readFileSync(abs, "utf8").split(/\r?\n/).length);
}

export function editTools(): HarnessTool[] {
  return [
    tool("write_file", "edit", "Create or overwrite a file in your workspace with the full new content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"], async (a, env) => {
      const { rel, abs } = workspacePath(env, a.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      // Keep an existing file's line-ending style.
      const crlf = existsSync(abs) && readFileSync(abs, "utf8").includes("\r\n");
      const content = String(a.content ?? "").replace(/\r\n/g, "\n");
      writeFileSync(abs, crlf ? content.replace(/\n/g, "\r\n") : content);
      noteEdited(env, rel, abs);
      return `wrote ${rel} (${String(a.content ?? "").split("\n").length} lines)`;
    }),
    tool(
      "replace_in_file",
      "edit",
      "Replace an exact text snippet in a file. old_text must match exactly once unless replace_all is true.",
      { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } },
      ["path", "old_text", "new_text"],
      async (a, env) => {
        const { rel, abs } = workspacePath(env, a.path);
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
      },
    ),
    tool("delete_file", "edit", "Delete a file in your workspace.", { path: { type: "string" } }, ["path"], async (a, env) => {
      const { rel, abs } = workspacePath(env, a.path);
      if (!existsSync(abs)) throw new Error(`${rel} does not exist`);
      rmSync(abs);
      env.edits.add(rel);
      return `deleted ${rel}`;
    }),
  ];
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
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
      const r = await runProcess(command, [], { cwd: c.cwd, env: minimalEnv({ CI: "1" }), timeoutMs: c.timeoutMs, signal: env.ctx.signal, shell: true });
      return cap(`$ ${command}\nexit ${r.exitCode}${r.killed ? ` (killed: ${r.killed})` : ""}\n${r.stdout}\n${r.stderr}`);
    },
  );
}

// ---------- brain ----------

function brainOf(env: HarnessEnv) {
  if (!env.brain) throw new Error("the brain is not available to this role");
  return env.brain;
}

export function brainReadTools(): HarnessTool[] {
  return [
    tool("brain_search", "read", "Search shared knowledge (working documents, decisions, lessons) you have access to.", { query: { type: "string" }, prefix: { type: "string" } }, ["query"], async (a, env) => {
      const b = brainOf(env);
      const hits = b.brain.search(b.principal(), str(a.query, "query"), { ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}), limit: 8 });
      return hits.map((h) => `brain:${h.path} (${h.kind}) ${h.title ?? ""}\n  ${h.snippet}`).join("\n") || "(no results you can read; request access if you need more)";
    }),
    tool("brain_read", "read", "Read a brain entry, optionally one section (e.g. 'Current State').", { path: { type: "string" }, section: { type: "string" } }, ["path"], async (a, env) => {
      const b = brainOf(env);
      const r = b.brain.read(b.principal(), str(a.path, "path"), typeof a.section === "string" ? { section: a.section } : {});
      env.universe.refs.set(`brain:${r.path}`, r.lines);
      return cap(`ref: brain:${r.path}\n${r.content}`);
    }),
    tool("brain_list", "read", "List brain entries under a prefix that you can read.", { prefix: { type: "string" } }, [], async (a, env) => {
      const b = brainOf(env);
      return b.brain.list(b.principal(), typeof a.prefix === "string" ? a.prefix : "").map((e) => `${e.path} (${e.kind}${e.status ? `, ${e.status}` : ""}) ${e.title ?? ""}`).join("\n") || "(nothing you can read here)";
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
    tool("brain_promote_lesson", "brain", "Promote a reusable lesson to global knowledge, citing its sources.", { title: { type: "string" }, body: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, ["title", "body"], async (a, env) => {
      const b = brainOf(env);
      const r = await b.brain.promoteLesson(b.principal(), b.actor, str(a.title, "title"), str(a.body, "body"), Array.isArray(a.sources) ? a.sources.map(String) : []);
      return `promoted to ${r.path}`;
    }),
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
      const r = b.access.decide(Number(a.id), a.approve === true, b.actor.agent, str(a.reason, "reason"));
      return `request ${r.id}: ${r.status}`;
    }),
  ];
}

export type { Principal };
