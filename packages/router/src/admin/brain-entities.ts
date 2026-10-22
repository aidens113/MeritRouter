import { z } from "zod";
import type { Switchyard } from "../core/service.js";
import { normalizeBrainPath } from "../brain/brain.js";
import { git } from "../workspaces/git.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120);
const pathSchema = z.string().min(1).max(2000);
const hashSchema = z.string().regex(/^[a-f0-9]{7,40}$/i);

/** Project brain views expose only its documents, shared global knowledge and the root index. */
export function brainDocumentVisible(project: string, input: string): boolean {
  if (!slugSchema.safeParse(project).success || !pathSchema.safeParse(input).success) return false;
  try {
    const path = normalizeBrainPath(input);
    return path === input && (path.startsWith(`projects/${project}/`) || path.startsWith("global/") || path === "README.md");
  } catch {
    return false;
  }
}

export interface BrainCommitDetail {
  commit: string;
  date: string;
  path: string;
  diff: string;
  truncated: boolean;
}

/** Stored task/job links named by this document's line attribution, filtered by project. */
export async function brainDocumentRelated(sy: Switchyard, project: string, path: string): Promise<{ tasks: string[]; jobs: string[] }> {
  const empty = { tasks: [] as string[], jobs: [] as string[] };
  if (!brainDocumentVisible(project, path) || !sy.projects.get(project)) return empty;
  const lines = await brainDocumentBlame(sy, project, path);
  const belongs = sy.db.prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?");
  return {
    tasks: [...new Set(lines.map(line => line.task).filter((id): id is string => !!id && !!belongs.get(id, project)))],
    jobs: [...new Set(lines.map(line => line.job).filter((id): id is string => !!id && !!belongs.get(id, project)))],
  };
}

export interface BrainHistoryEntry {
  commit: string;
  date: string;
  agent: string | null;
  model: string | null;
  subject: string;
}

/** Read history once, tracking historical paths without exposing private rename ancestors. */
async function documentHistory(sy: Switchyard, project: string, path: string) {
  if (!brainDocumentVisible(project, path) || !sy.projects.get(project)) return null;
  const resolved = sy.brainFor(project).resolve(path);
  if (!resolved.repo || !resolved.repoRel) return null;
  const raw = await git(resolved.repo, ["log", "--follow", "--relative", "--format=%x1e%H%x00%aI%x00%(trailers:key=Agent,valueonly)%x00%(trailers:key=Model,valueonly)%x00", "--name-status", "-z", "HEAD", "--", `:(literal)${resolved.repoRel}`]);
  let historicalPath = resolved.repoRel;
  const prefix = path.slice(0, path.length - resolved.repoRel.length);
  const entries: Array<BrainHistoryEntry & { repoPath: string }> = [];
  for (const record of raw.split("\x1e")) {
    const fields = record.split("\0");
    const commit = fields.shift()?.trim();
    if (!commit) continue;
    const date = fields.shift()?.trim() ?? "";
    const agent = fields.shift()?.trim() || null;
    const model = fields.shift()?.trim() || null;
    // Stop permanently at the first visibility boundary. A document that moved back and
    // forth cannot reveal older content just because its earlier path becomes visible again.
    if (!brainDocumentVisible(project, `${prefix}${historicalPath}`)) break;
    if (!hashSchema.safeParse(commit).success) continue;
    entries.push({ commit, date, agent, model, subject: "Document changed", repoPath: historicalPath });
    for (let i = 0; i < fields.length; i++) {
      const status = fields[i]!.trim();
      if (/^R\d+$/.test(status)) {
        const oldPath = fields[++i];
        const newPath = fields[++i];
        if (newPath === historicalPath && oldPath) historicalPath = oldPath;
      } else if (/^[ACDMRTUXB]\d*$/.test(status)) i++;
    }
  }
  return { repo: resolved.repo, entries };
}

/**
 * Commit subjects and bodies can describe unrelated private changes in a mixed commit. Never
 * read or return them. Agent/model trailers describe attribution of this visible document.
 */
export async function brainDocumentHistory(sy: Switchyard, project: string, path: string): Promise<BrainHistoryEntry[]> {
  try {
    const history = await documentHistory(sy, project, path);
    return (history?.entries ?? []).slice(0, 50).map(({ repoPath: _repoPath, ...entry }) => entry);
  } catch { return []; }
}

/** Keep visible document text while masking attribution inherited from private history. */
export async function brainDocumentBlame(sy: Switchyard, project: string, path: string) {
  if (!brainDocumentVisible(project, path) || !sy.projects.get(project)) return [];
  try {
    const history = await documentHistory(sy, project, path);
    const visible = new Set(history?.entries.map(entry => entry.commit) ?? []);
    const lines = await sy.brainFor(project).blame(path);
    return lines.map(line => visible.has(line.commit) || line.uncommitted ? line : {
      ...line, commit: "", origPath: path, agent: null, role: null, model: null,
      task: null, job: null, authorName: "Earlier history unavailable", date: "",
    });
  } catch { return []; }
}

/** Return a document-only diff, never whole-commit metadata or private rename sources. */
export async function brainCommitDetail(sy: Switchyard, project: string, path: string, hash: string): Promise<BrainCommitDetail | null> {
  if (!hashSchema.safeParse(hash).success) return null;
  try {
    const history = await documentHistory(sy, project, path);
    if (!history) return null;
    const commit = (await git(history.repo, ["rev-parse", "--verify", `${hash}^{commit}`])).trim();
    const selected = history.entries.find(entry => entry.commit === commit);
    if (!selected) return null;
    const diff = await git(history.repo, ["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--patch", commit, "--", `:(literal)${selected.repoPath}`]);
    if (!diff.trim()) return null;
    return { commit, date: selected.date, path, diff: diff.slice(0, 200_000), truncated: diff.length > 200_000 };
  } catch { return null; }
}
