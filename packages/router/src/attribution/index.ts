import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { git, GitError } from "../workspaces/git.js";

/** Who made a change. Every SwitchYard commit records this as git identity plus trailers. */
export interface Actor {
  /** Stable agent identity, e.g. `implementer:t_abc`, `supervisor:t_job`, `human`. */
  agent: string;
  role: string;
  model?: string | null;
  task?: string | null;
  job?: string | null;
  tier?: string | null;
  request?: string | null;
}

export const TRAILER_KEYS = ["Agent", "Role", "Model", "Task", "Job", "Tier", "Request"] as const;

export function actorIdentity(a: Actor): { name: string; email: string } {
  const slug = a.agent.replace(/[^A-Za-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || "agent";
  const model = a.model ? ` (${a.model})` : "";
  return { name: `${a.agent.replace(":", " ")}${model}`.slice(0, 120), email: `${slug}@switchyard.local` };
}

export function trailerArgs(a: Actor, extra: Record<string, string> = {}): string[] {
  const t: Record<string, string | null | undefined> = { Agent: a.agent, Role: a.role, Model: a.model, Task: a.task, Job: a.job, Tier: a.tier, Request: a.request, ...extra };
  return Object.entries(t)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .flatMap(([k, v]) => ["--trailer", `${k}: ${String(v).replace(/[\r\n]+/g, " ")}`]);
}

/**
 * Stage changes (all, or the given paths) and commit them as the actor. Returns the new commit
 * id, or null when there was nothing to commit.
 */
export async function commitAs(repo: string, actor: Actor, message: string, opts: { paths?: string[]; extraTrailers?: Record<string, string>; allowEmpty?: boolean } = {}): Promise<string | null> {
  await git(repo, ["add", "-A", ...(opts.paths?.length ? ["--", ...opts.paths] : [])]);
  const paths = opts.paths?.length ? opts.paths : undefined;
  const staged = await git(repo, ["diff", "--cached", "--name-only", ...(paths ? ["--", ...paths] : [])]);
  if (!staged.trim() && !opts.allowEmpty) return null;
  const id = actorIdentity(actor);
  const env = { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
  await git(repo, ["commit", "-q", "--no-verify", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", message, ...trailerArgs(actor, opts.extraTrailers), ...(paths ? ["--only", "--", ...paths] : [])], { env });
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

export function parseTrailers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export interface CommitInfo {
  commit: string;
  subject: string;
  authorName: string;
  date: string;
  trailers: Record<string, string>;
}

export async function commitInfo(repo: string, commits: string[]): Promise<Map<string, CommitInfo>> {
  const out = new Map<string, CommitInfo>();
  const unique = [...new Set(commits)].filter((c) => !/^0+$/.test(c));
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const raw = await git(repo, ["log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%(trailers:unfold)%x1e", ...chunk]);
    for (const rec of raw.split("\x1e")) {
      const [commit, subject, authorName, date, trailers] = rec.replace(/^\s+/, "").split("\x1f");
      if (!commit) continue;
      out.set(commit, { commit, subject: subject ?? "", authorName: authorName ?? "", date: date ?? "", trailers: parseTrailers(trailers ?? "") });
    }
  }
  return out;
}

export interface BlameLine {
  line: number;
  text: string;
  commit: string;
  origLine: number;
  /** The file's path in the commit that last changed this line (differs after a rename). */
  origPath: string;
  agent: string | null;
  role: string | null;
  model: string | null;
  task: string | null;
  job: string | null;
  authorName: string;
  date: string;
  uncommitted: boolean;
}

/** Per-line attribution: git blame, then each commit's agent/model trailers. */
export async function blame(repo: string, file: string, rev = "HEAD"): Promise<BlameLine[]> {
  const raw = await git(repo, ["blame", "--line-porcelain", rev, "--", file]);
  const lines: Array<{ commit: string; origLine: number; finalLine: number; text: string; origPath: string }> = [];
  let cur: { commit: string; origLine: number; finalLine: number; origPath: string } | null = null;
  for (const l of raw.split("\n")) {
    const h = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (h) cur = { commit: h[1]!, origLine: Number(h[2]), finalLine: Number(h[3]), origPath: file };
    else if (cur && l.startsWith("filename ")) cur.origPath = l.slice("filename ".length).replace(/\r$/, "");
    else if (l.startsWith("\t") && cur) {
      lines.push({ ...cur, text: l.slice(1) });
      cur = null;
    }
  }
  const info = await commitInfo(repo, lines.map((l) => l.commit));
  return lines.map((l) => {
    const c = info.get(l.commit);
    const t = c?.trailers ?? {};
    return {
      line: l.finalLine,
      text: l.text,
      commit: l.commit,
      origLine: l.origLine,
      origPath: l.origPath,
      agent: t.Agent ?? null,
      role: t.Role ?? (c ? "human" : null),
      model: t.Model ?? null,
      task: t.Task ?? null,
      job: t.Job ?? null,
      authorName: c?.authorName ?? "not committed",
      date: c?.date ?? "",
      uncommitted: /^0+$/.test(l.commit),
    };
  });
}

/** Commits in `range` (e.g. `<base>..HEAD`) whose trailers match every given filter. */
export async function commitsMatching(repo: string, range: string, filter: Partial<Record<"Agent" | "Model" | "Task" | "Job" | "Role", string>>): Promise<CommitInfo[]> {
  return (await commitsIn(repo, range)).filter((c) => Object.entries(filter).every(([k, v]) => c.trailers[k] === v));
}

/** Commits in `range` whose `Task` trailer names any of `tasks` (a sub-job and every task under it). */
export async function commitsOfTasks(repo: string, range: string, tasks: ReadonlySet<string>): Promise<CommitInfo[]> {
  return (await commitsIn(repo, range)).filter((c) => c.trailers.Task !== undefined && tasks.has(c.trailers.Task));
}

/** Every commit in `range`, oldest first, with its attribution. */
async function commitsIn(repo: string, range: string): Promise<CommitInfo[]> {
  const ids = (await git(repo, ["rev-list", "--reverse", range])).split("\n").filter(Boolean);
  const info = await commitInfo(repo, ids);
  return ids.map((id) => info.get(id)).filter((c): c is CommitInfo => c !== undefined);
}

/** A commit an undo took back (in whole or in part), with its attribution. */
export interface UndoneCommit {
  commit: string;
  task: string | null;
  job: string | null;
  agent: string | null;
  model: string | null;
}

/** What an undo did, as the undo hook is told (verification calibration counts it as an escaped defect). */
export interface UndoneChange {
  kind: "commits" | "lines";
  repo: string;
  /** The undo commit (null when nothing needed committing). */
  commit: string | null;
  undone: UndoneCommit[];
  reason: string;
  actor: Actor;
  /** lines: the file and the lines put back. */
  file?: string;
  lines?: number[];
}

/** Told after an undo commits. It never affects the undo: a throwing hook is ignored. */
export type UndoHook = (change: UndoneChange) => void;

function notifyUndone(hook: UndoHook | undefined, change: UndoneChange): void {
  if (!hook || !change.commit) return;
  try {
    hook(change);
  } catch {
    /* the undo is done; recording it is best effort */
  }
}

/**
 * Revert whole commits (newest first) in one undo commit. History is kept; the undo commit
 * names what it reverts and why. `onUndone` is told which commits (and tasks) were undone.
 */
export async function revertCommits(repo: string, commits: string[], actor: Actor, reason: string, opts: { onUndone?: UndoHook } = {}): Promise<string | null> {
  if (!commits.length) return null;
  // Newest first in history order (commit dates tie after a cherry-pick, so dates are not enough).
  const wanted = new Set(await Promise.all(commits.map(async (c) => (await git(repo, ["rev-parse", c])).trim())));
  const ordered = (await git(repo, ["rev-list", "--topo-order", "HEAD"])).split("\n").filter((c) => wanted.has(c));
  if (ordered.length !== wanted.size) throw new GitError("some commits to undo are not on the current branch", null, "");
  try {
    await git(repo, ["revert", "--no-commit", ...ordered]);
  } catch (err) {
    await git(repo, ["revert", "--abort"]).catch(() => undefined);
    throw new GitError(`undo would conflict with later changes: ${(err as Error).message}; undo specific lines instead`, (err as GitError).exitCode ?? null, (err as GitError).stderr ?? "");
  }
  const commit = await commitAs(repo, actor, `Undo ${ordered.length} commit(s): ${reason}`.slice(0, 200), {
    extraTrailers: { Reverts: ordered.map((c) => c.slice(0, 12)).join(" "), Reason: reason.slice(0, 300) },
  });
  if (opts.onUndone && commit) {
    const info = await commitInfo(repo, ordered);
    notifyUndone(opts.onUndone, { kind: "commits", repo, commit, reason, actor, undone: ordered.map((c) => undoneCommit(c, info.get(c)?.trailers ?? {})) });
  }
  return commit;
}

function undoneCommit(commit: string, t: Record<string, string>): UndoneCommit {
  return { commit, task: t.Task ?? null, job: t.Job ?? null, agent: t.Agent ?? null, model: t.Model ?? null };
}

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newCount: number;
}

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let h: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      h = { oldStart: Number(m[1]), oldLines: [], newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) };
      hunks.push(h);
    } else if (h && line.startsWith("-") && !line.startsWith("---")) h.oldLines.push(line.slice(1).replace(/\r$/, ""));
  }
  return hunks;
}

/**
 * Undo specific lines: each selected line goes back to what it was before the commit that last
 * changed it (or is removed if that commit added it). Lines that predate `sinceCommit` are left
 * alone. Exact for whole hunks; for partial selections inside a modified hunk, lines are paired by
 * position.
 */
export async function undoLines(
  repo: string,
  file: string,
  ranges: Array<[number, number]>,
  actor: Actor,
  reason: string,
  opts: { sinceCommit?: string; onUndone?: UndoHook } = {},
): Promise<{ commit: string | null; undone: number[]; skipped: Array<{ line: number; why: string }> }> {
  const abs = path.join(repo, file);
  if (!existsSync(abs)) throw new Error(`${file} does not exist`);
  const status = await git(repo, ["status", "--porcelain", "--", file]);
  if (status.trim()) throw new Error(`${file} has uncommitted changes; commit them before undoing lines`);
  const lines = await blame(repo, file);
  const selected = new Set<number>();
  for (const [a, b] of ranges) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(i);
  const allowed = opts.sinceCommit ? new Set((await git(repo, ["rev-list", `${opts.sinceCommit}..HEAD`])).split("\n").filter(Boolean)) : null;

  const skipped: Array<{ line: number; why: string }> = [];
  const byCommit = new Map<string, BlameLine[]>();
  for (const l of lines) {
    if (!selected.has(l.line)) continue;
    if (allowed && !allowed.has(l.commit)) {
      skipped.push({ line: l.line, why: "predates this job" });
      continue;
    }
    byCommit.set(l.commit, [...(byCommit.get(l.commit) ?? []), l]);
  }

  // Edits against current line numbers: replace or delete; extra old lines inserted after a fully selected hunk.
  const replace = new Map<number, string | null>();
  const insertAfter = new Map<number, string[]>();
  // Commits that had at least one of their lines put back, with the attribution blame gave them.
  const touched = new Map<string, BlameLine>();
  for (const [commit, picked] of byCommit) {
    const parent = (await git(repo, ["rev-list", "--parents", "-n", "1", commit])).trim().split(" ")[1];
    let hunks: Hunk[] | null = null; // null: the commit has no parent, so every line was added by it
    if (parent) {
      // Diff under the file's name in that commit (it may have been renamed since).
      hunks = parseHunks(await git(repo, ["diff", "-U0", parent, commit, "--", picked[0]!.origPath]));
    }
    const pickedOrig = new Set(picked.map((p) => p.origLine));
    for (const p of picked) {
      const h = hunks?.find((x) => p.origLine >= x.newStart && p.origLine < x.newStart + x.newCount);
      if (!hunks) {
        replace.set(p.line, null); // file created by this commit: the line was added
        touched.set(commit, p);
        continue;
      }
      if (!h) {
        skipped.push({ line: p.line, why: `no change found in ${commit.slice(0, 12)}` });
        continue;
      }
      const offset = p.origLine - h.newStart;
      replace.set(p.line, offset < h.oldLines.length ? h.oldLines[offset]! : null);
      touched.set(commit, p);
      const wholeHunk = Array.from({ length: h.newCount }, (_, i) => h.newStart + i).every((o) => pickedOrig.has(o));
      if (wholeHunk && offset === h.newCount - 1 && h.oldLines.length > h.newCount) insertAfter.set(p.line, h.oldLines.slice(h.newCount));
    }
  }
  if (!replace.size) return { commit: null, undone: [], skipped };

  const original = readFileSync(abs, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = original.endsWith("\n");
  const cur = original.split(/\r?\n/);
  if (endsWithNewline) cur.pop();
  const out: string[] = [];
  cur.forEach((text, i) => {
    const n = i + 1;
    if (replace.has(n)) {
      const r = replace.get(n);
      if (r !== null && r !== undefined) out.push(r);
    } else out.push(text);
    for (const extra of insertAfter.get(n) ?? []) out.push(extra);
  });
  writeFileSync(abs, out.join(eol) + (endsWithNewline ? eol : ""));
  const undone = [...replace.keys()].sort((a, b) => a - b);
  const commit = await commitAs(repo, actor, `Undo ${undone.length} line(s) in ${file}: ${reason}`.slice(0, 200), {
    paths: [file],
    extraTrailers: { Undoes: [...byCommit.keys()].map((c) => c.slice(0, 12)).join(" "), Lines: `${file}:${undone.join(",")}`.slice(0, 300), Reason: reason.slice(0, 300) },
  });
  notifyUndone(opts.onUndone, {
    kind: "lines",
    repo,
    commit,
    reason,
    actor,
    file,
    lines: undone,
    undone: [...touched].map(([c, l]) => ({ commit: c, task: l.task, job: l.job, agent: l.agent, model: l.model })),
  });
  return { commit, undone, skipped };
}
