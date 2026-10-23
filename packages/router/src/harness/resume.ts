import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatToolCall } from "../gateway/types.js";
import type { ResumePlan } from "../sessions/resume.js";
import { editRecoveryMessage, RESUME_TEXT, notAppliedToolProof, validNotAppliedToolProof } from "../sessions/resume.js";
import type { ResumeAction, ResumeToolRef, WorkspaceRepo } from "../sessions/events.js";
import type { WorkspacePointer } from "../runners/session-workspace.js";
import { commitAs, type Actor } from "../attribution/index.js";
import { git } from "../workspaces/git.js";
import { normalizeRelPath } from "../context/repo-reader.js";
import type { HarnessEnv, HarnessTool } from "./tools.js";
import type { TerminalTool } from "./loop.js";
import { journaled, parseArgs } from "./journal.js";
import { assertRunAuthority } from "./task-authority.js";
import { scopedArtifact } from "./check-evidence.js";

/**
 * What a runner hands the agent loop to continue an interrupted session (S2). The loop's
 * `messages` must be `plan.messages`; the session in `env.ctx.session` must be the reopened one.
 */
export interface ResumeInput {
  plan: ResumePlan;
  /** Identity for commits of recovered edits (the session's agent). */
  actor: Actor;
  /** Records each repository's new head after edit reconciliation. */
  pointer: WorkspacePointer | null;
  /** Text for an interrupted `external` call (ask_user): its stored question and answer state. */
  external?: (ref: ResumeToolRef) => string;
  /** Runner-specific text appended to the resume notice (answers received meanwhile, ...). */
  notice?: string;
}

export type ResumeOutcome<T> = { kind: "finished"; value: T } | {
  kind: "continue";
  /** Pending edits proven absent by successful workspace reconciliation, never inferred from tool prose. */
  notAppliedToolIndexes: ReadonlySet<number>;
};

/** A tool message slot in the plan's transcript. */
function setTool(messages: ChatMessage[], index: number | null, content: string): void {
  if (index === null) return;
  const m = messages[index];
  if (m && m.role === "tool") m.content = content;
}

function argsOf(ref: ResumeToolRef): unknown {
  return typeof ref.args === "string" ? parseArgs(ref.args) : ref.args;
}

/**
 * Re-establish the evidence a worker may cite: files, brain entries, and artifacts it read (or
 * edited) before the interruption, taken from the tool outputs in the transcript.
 */
export function restoreEvidence(env: HarnessEnv, messages: ChatMessage[]): void {
  const calls = new Map<string, ChatToolCall>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.set(c.id, c);
  for (const m of messages) {
    if (m.role !== "tool" || m.content.startsWith("error:")) continue;
    const call = calls.get(m.tool_call_id);
    if (!call) continue;
    // An interrupted read has no output to cite; an interrupted edit was reconciled, so its file is checked on disk below.
    if (m.content.startsWith("interrupted") && call.function.name !== "write_file" && call.function.name !== "replace_in_file") continue;
    const args = (parseArgs(call.function.arguments) ?? {}) as Record<string, unknown>;
    switch (call.function.name) {
      case "read_file": {
        const r = /^ref: (\S+?)#L\d+-L\d+ \(of (\d+) lines\)/.exec(m.content);
        if (r) env.universe.refs.set(r[1]!, Number(r[2]));
        break;
      }
      case "brain_read": {
        const r = /^ref: (brain:\S+)/.exec(m.content);
        if (r && !env.universe.refs.has(r[1]!)) env.universe.refs.set(r[1]!, null);
        break;
      }
      case "read_artifact": {
        if (typeof args.ref !== "string" || !args.ref) break;
        const ref = args.ref.startsWith("artifact:") ? args.ref : `artifact:${args.ref}`;
        try { const artifact = scopedArtifact(env, ref); env.universe.refs.set(ref, artifact.content.toString("utf8").split(/\r?\n/).length); } catch { /* unavailable or foreign artifact is not evidence */ }
        break;
      }
      case "write_file":
      case "replace_in_file": {
        const ws = env.workspace;
        if (!ws || typeof args.path !== "string") break;
        try {
          const rel = normalizeRelPath(args.path);
          const abs = path.join(ws.root, ...rel.split("/"));
          if (existsSync(abs)) env.universe.refs.set(`${ws.alias}:${rel}`, readFileSync(abs, "utf8").split(/\r?\n/).length);
        } catch {
          // not a repository-relative path: it was refused, nothing to cite
        }
        break;
      }
      default:
        break;
    }
  }
}

/** An interrupted cherry-pick or revert (integration, undo) is aborted before reconciling. */
async function abortSequencer(worktree: string): Promise<string | null> {
  for (const [marker, cmd] of [
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ] as const) {
    const p = (await git(worktree, ["rev-parse", "--git-path", marker]).catch(() => "")).trim();
    if (p && existsSync(path.isAbsolute(p) ? p : path.join(worktree, p))) {
      await git(worktree, [cmd, "--abort"]).catch(() => undefined);
      return cmd;
    }
  }
  return null;
}

/**
 * Compare one worktree with its last recorded head and apply the policy: `commit` commits the
 * uncommitted difference as "recovered" (attributed to the session's agent); `reset` discards
 * it. Commits made after the recorded head (a per-response commit whose workspace event was
 * lost) are kept either way. Returns the files the reconciliation concerned.
 */
async function reconcileRepo(repo: WorkspaceRepo, policy: "commit" | "reset", actor: Actor, pointer: WorkspacePointer | null): Promise<{ files: string[]; note: string | null; unchanged: boolean }> {
  if (!existsSync(repo.worktree)) return { files: [], note: `${repo.alias}: worktree ${repo.worktree} is gone; nothing to reconcile`, unchanged: false };
  const aborted = await abortSequencer(repo.worktree);
  const note = aborted ? `${repo.alias}: an interrupted ${aborted} was aborted` : null;
  await git(repo.worktree, ["add", "-A"]);
  const dirty = (await git(repo.worktree, ["diff", "--cached", "--name-only", "HEAD"])).split(/\r?\n/).filter(Boolean);
  const actual = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
  const unchanged = dirty.length === 0 && !!repo.head && actual === repo.head && !aborted;
  if (policy === "reset") {
    if (dirty.length) await git(repo.worktree, ["reset", "-q", "--hard", "HEAD"]);
    pointer?.setHead(repo.alias, actual);
    return { files: dirty, note, unchanged };
  }
  const head = dirty.length ? ((await commitAs(repo.worktree, actor, `${actor.role ?? "agent"}: recovered edits after interruption`)) ?? actual) : actual;
  pointer?.setHead(repo.alias, head);
  const since = repo.head && repo.head !== head ? (await git(repo.worktree, ["diff", "--name-only", repo.head, head]).catch(() => "")).split(/\r?\n/).filter(Boolean) : [];
  return { files: [...new Set([...since, ...dirty])].sort(), note, unchanged };
}

async function reconcileEdits(action: Extract<ResumeAction, { kind: "reconcile_edits" }>, messages: ChatMessage[], r: ResumeInput): Promise<{ text: string; unchanged: boolean }> {
  const files: string[] = [];
  const notes: string[] = [];
  let unchanged = action.repos.length > 0;
  for (const repo of action.repos) {
    try {
      const out = await reconcileRepo(repo, action.policy, r.actor, r.pointer);
      files.push(...(action.repos.length > 1 ? out.files.map((f) => `${repo.alias}:${f}`) : out.files));
      unchanged &&= out.unchanged;
      if (out.note) notes.push(out.note);
    } catch (err) {
      unchanged = false;
      notes.push(`${repo.alias}: reconciliation failed (${(err as Error).message.slice(0, 200)}); re-read the files before editing`);
    }
  }
  let text = editRecoveryMessage(action.policy, files);
  if (action.policy === "reset" && action.completedCallIds.length && files.length) text += ` This also reverted the edits of call(s) ${action.completedCallIds.join(", ")}, which had finished but were not committed.`;
  if (notes.length) text += ` (${notes.join("; ")})`;
  for (const c of action.calls) setTool(messages, c.messageIndex, text);
  return { text, unchanged };
}

/** The terminal call of the last assistant turn, with the index of its tool message. */
function tailTerminal(messages: ChatMessage[], terminalName: string): { call: ChatToolCall; index: number } | null {
  let tail = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      tail = i;
      break;
    }
  }
  const m = messages[tail];
  if (!m || m.role !== "assistant" || !m.tool_calls?.length) return null;
  const call = m.tool_calls.find((c) => c.function.name === terminalName);
  if (!call) return null;
  for (let i = tail + 1; i < messages.length; i++) {
    const t = messages[i]!;
    if (t.role === "tool" && t.tool_call_id === call.id) return { call, index: i };
  }
  return null;
}

/**
 * Apply a resume plan before the loop's next request: restore citable evidence, perform the
 * plan's actions (re-run delegations and idempotent commands under their original call ids,
 * reconcile interrupted edits, report interrupted questions), record the `resumed` event, and
 * either finish with a terminal submission made before the interruption (accepted, or never
 * validated) or append the resume notice for the model.
 */
export async function applyResume<T>(o: { env: HarnessEnv; messages: ChatMessage[]; tools: HarnessTool[]; terminal: TerminalTool<T> }, r: ResumeInput): Promise<ResumeOutcome<T>> {
  const { env, messages, plan } = { ...o, plan: r.plan };
  const session = env.ctx.session;
  restoreEvidence(env, messages);

  const byName = new Map(o.tools.map((t) => [t.def.function.name, t]));
  const done: ResumeAction[] = [];
  const notAppliedToolIndexes = new Set((plan.notAppliedTools ?? []).filter(proof => validNotAppliedToolProof(messages, proof)).map(proof => proof.messageIndex));
  for (const action of plan.actions) {
    assertRunAuthority(env.ctx);
    if (action.kind === "rerun_tool") {
      const tool = byName.get(action.name);
      const args = argsOf(action);
      const res = await journaled(session, { id: action.callId, function: { name: action.name, arguments: typeof action.args === "string" ? action.args : JSON.stringify(action.args ?? {}) } }, args, tool ? { sideEffect: tool.sideEffect, idempotent: tool.idempotent } : { sideEffect: action.sideEffect }, async () => {
        if (!tool) return { ok: false, output: `error: unknown tool ${action.name}` };
        try {
          if (args === undefined || args === null || typeof args !== "object") throw new Error(`${action.name} arguments are not valid JSON`);
          const previousInvocation = env.toolInvocationId;
          env.toolInvocationId = `${session?.id ?? env.ctx.taskId}:${action.callId}`;
          try { return { ok: true, output: await tool.run(args as Record<string, unknown>, env) }; }
          finally { env.toolInvocationId = previousInvocation; }
        } catch (err) {
          return { ok: false, output: `error: ${(err as Error).message}` };
        }
      });
      setTool(messages, action.messageIndex, res.output);
      done.push({ ...action, result: res.output });
    } else if (action.kind === "reconcile_edits") {
      const reconciled = await reconcileEdits(action, messages, r);
      if (reconciled.unchanged) for (const call of action.calls) {
        if (!plan.notAppliedCandidateIntents?.includes(call.intentSeq)) continue;
        if (call.messageIndex !== null && messages[call.messageIndex]?.role === "tool" && (messages[call.messageIndex] as Extract<ChatMessage, { role: "tool" }>).tool_call_id === call.callId) notAppliedToolIndexes.add(call.messageIndex);
      }
      done.push({ ...action, result: reconciled.text });
    } else {
      const text = r.external?.(action) ?? "interrupted; outcome unknown; ask again if you still need the answer";
      setTool(messages, action.messageIndex, text);
      done.push({ ...action, result: text });
    }
  }
  const notAppliedTools = [...notAppliedToolIndexes].map(index => notAppliedToolProof(messages, index)).filter(proof => proof !== null);
  // Persist the exact reconciled transcript before its proof, so another interruption
  // immediately after this resume can verify the same occurrence without reading prose.
  session?.syncMessages(messages);
  session?.resumed(plan.summary, done, { ...plan, notAppliedTools });

  // A submission made before the interruption: finish with it rather than asking the model again.
  const terminalName = o.terminal.def.function.name;
  const tail = tailTerminal(messages, terminalName);
  if (tail) {
    const slot = messages[tail.index] as Extract<ChatMessage, { role: "tool" }>;
    const args = parseArgs(tail.call.function.arguments);
    if (slot.content === "accepted") {
      const v = args === undefined ? null : await o.terminal.accept(args, env);
      if (v?.ok) return { kind: "finished", value: v.value };
      messages.push({ role: "user", content: `${plan.summary}\nYour ${terminalName} submission was accepted before the interruption but no longer validates:\n- ${v ? v.errors.join("\n- ") : "arguments are not valid JSON"}\nFix and call ${terminalName} again.${r.notice ? `\n${r.notice}` : ""}` });
      return { kind: "continue", notAppliedToolIndexes };
    }
    if (slot.content === RESUME_TEXT.retry || slot.content === RESUME_TEXT.notRun) {
      let value: T | undefined;
      const res = await journaled(session, tail.call, args, { sideEffect: "none" }, async () => {
        const v = args === undefined ? { ok: false as const, errors: [`${terminalName} arguments are not valid JSON`] } : await o.terminal.accept(args, env);
        if (v.ok) {
          value = v.value;
          return { ok: true, output: "accepted" };
        }
        return { ok: false, output: `rejected:\n- ${v.errors.join("\n- ")}\nFix and call ${terminalName} again.` };
      });
      slot.content = res.output;
      if (value !== undefined) return { kind: "finished", value };
    }
  }
  messages.push({ role: "user", content: `${plan.summary}${r.notice ? `\n${r.notice}` : ""}` });
  return { kind: "continue", notAppliedToolIndexes };
}
