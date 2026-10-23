import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
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
export async function brainDocumentRelated(sy: MeritRouter, project: string, path: string): Promise<{ tasks: string[]; jobs: string[] }> {
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
async function documentHistory(sy: MeritRouter, project: string, path: string) {
  if (!brainDocumentVisible(project, path) || !sy.projects.get(project)) return null;
  const resolved = await sy.brainFor(project).resolveGitDocument(path);
  if (!resolved) return null;
  const raw = await git(resolved.repo, ["log", "--follow", "--relative", "--format=%x1e%H%x00%aI%x00%(trailers:key=Agent,valueonly)%x00%(trailers:key=Model,valueonly)%x00", "--name-status", "-z", "HEAD", "--", `:(literal)${resolved.repoRel}`]);
  let historicalPath = resolved.repoRel;
  const visiblePath = (repoPath: string) => repoPath.startsWith(resolved.mountPrefix) && brainDocumentVisible(project, `${resolved.virtualPrefix}${repoPath.slice(resolved.mountPrefix.length)}`);
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
    if (!visiblePath(historicalPath)) break;
    if (!hashSchema.safeParse(commit).success) continue;
    let touched = false;
    let previousPath = historicalPath;
    for (let i = 0; i < fields.length; i++) {
      const status = fields[i]!.trim();
      if (/^[RC]\d+$/.test(status)) {
        const oldPath = fields[++i];
        const newPath = fields[++i];
        if (newPath === historicalPath && oldPath) {
          touched = true;
          previousPath = oldPath;
        }
      } else if (/^[ADMTUXB]\d*$/.test(status)) {
        if (fields[++i] === historicalPath) touched = true;
      }
    }
    if (touched) entries.push({ commit, date, agent, model, subject: "Document changed", repoPath: historicalPath });
    historicalPath = previousPath;
  }
  return { repo: resolved.repo, mountPrefix: resolved.mountPrefix, virtualPrefix: resolved.virtualPrefix, entries };
}

/**
 * A subject is shown only when a whole-commit path inventory proves all changed paths are
 * visible. Bodies are never returned. One bounded batch covers the 50 displayed commits.
 */
export async function brainDocumentHistory(sy: MeritRouter, project: string, path: string): Promise<BrainHistoryEntry[]> {
  try {
    const history = await documentHistory(sy, project, path);
    const entries = (history?.entries ?? []).slice(0, 50).map(({ repoPath: _repoPath, ...entry }) => entry);
    if (!history || !entries.length) return entries;
    try {
      const inventory = await git(history.repo, ["log", "--no-walk=unsorted", "--root", "-m", "--raw", "--no-renames", "--no-relative", "--abbrev=40", "--format=%H%x00%s%x00", "-z", ...entries.map(entry => entry.commit), "--"], { maxBuffer: 4 * 1024 * 1024 });
      const rootPrefix = history.mountPrefix;
      const virtualPrefix = history.virtualPrefix;
      const fields = inventory.split("\0");
      const subjects = new Map<string, { subject: string; visible: boolean; files: number }>();
      let current: { subject: string; visible: boolean; files: number } | undefined;
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!.trim();
        if (/^[a-f0-9]{40}$/.test(field)) {
          const subject = fields[++i] ?? "";
          current = subjects.get(field) ?? { subject, visible: true, files: 0 };
          subjects.set(field, current);
        } else if (/^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [ACDMRTUXB]\d*$/.test(field)) {
          const file = fields[++i] ?? "";
          if (!current) continue;
          current.files++;
          current.visible &&= file.startsWith(rootPrefix) && brainDocumentVisible(project, `${virtualPrefix}${file.slice(rootPrefix.length)}`);
        } else if (field && current) current.visible = false;
      }
      for (const entry of entries) {
        const found = subjects.get(entry.commit);
        if (found?.visible && found.files) entry.subject = found.subject;
      }
    } catch {
      // Missing or oversized inventories cannot establish scope; retain generic labels.
    }
    return entries;
  } catch { return []; }
}

/** Keep visible document text while masking attribution inherited from private history. */
export async function brainDocumentBlame(sy: MeritRouter, project: string, path: string) {
  if (!brainDocumentVisible(project, path) || !sy.projects.get(project)) return [];
  try {
    const history = await documentHistory(sy, project, path);
    const visible = new Set(history?.entries.map(entry => entry.commit) ?? []);
    const lines = await sy.brainFor(project).blame(path);
    const belongs = sy.db.prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?");
    return lines.map(line => {
      if (!visible.has(line.commit) && !line.uncommitted) return {
        ...line, commit: "", origPath: path, agent: null, role: null, model: null,
        task: null, job: null, authorName: "Earlier history unavailable", date: "",
      };
      return { ...line,
        task: line.task && belongs.get(line.task, project) ? line.task : null,
        job: line.job && belongs.get(line.job, project) ? line.job : null,
      };
    });
  } catch { return []; }
}

/** Return a document-only diff, never whole-commit metadata or private rename sources. */
export async function brainCommitDetail(sy: MeritRouter, project: string, path: string, hash: string): Promise<BrainCommitDetail | null> {
  if (!hashSchema.safeParse(hash).success) return null;
  try {
    const history = await documentHistory(sy, project, path);
    if (!history) return null;
    const commit = (await git(history.repo, ["rev-parse", "--verify", `${hash}^{commit}`])).trim();
    const selected = history.entries.find(entry => entry.commit === commit);
    if (!selected) return null;
    const diff = await git(history.repo, ["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ...(history.mountPrefix ? [`--relative=${history.mountPrefix}`] : ["--relative"]), "--patch", commit, "--", `:(literal)${selected.repoPath}`]);
    if (!diff.trim()) return null;
    return { commit, date: selected.date, path, diff: diff.slice(0, 200_000), truncated: diff.length > 200_000 };
  } catch { return null; }
}
