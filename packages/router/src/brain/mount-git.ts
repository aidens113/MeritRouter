import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { git } from "../workspaces/git.js";

export interface BrainGitDocument {
  repo: string; repoRel: string; mountRoot: string; mountPrefix: string; virtualPrefix: string;
}
interface ResolvedDocument { rel: string; repo: string | null; repoRel: string; commit: boolean }
const canonical = (value: string) => {
  const absolute = realpathSync(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const contained = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** The configured mount keeps its own visibility boundary even when Git's root is its parent. */
export async function resolveBrainGitDocument(resolved: ResolvedDocument): Promise<BrainGitDocument | null> {
  if (!resolved.repo || !resolved.repoRel || !resolved.commit) return null;
  const root = realpathSync((await git(resolved.repo, ["rev-parse", "--show-toplevel"])).trim());
  const mount = realpathSync(resolved.repo);
  if (!contained(root, mount)) throw new Error("brain mount escapes its Git repository");
  const [mountCommon, rootCommon] = await Promise.all([
    git(mount, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (canonical(mountCommon.trim()) !== canonical(rootCommon.trim())) throw new Error("brain mount Git repository identity changed");
  const relative = path.relative(root, mount);
  const mountPrefix = relative ? `${relative.split(path.sep).join("/")}/` : "";
  return { repo: root, repoRel: `${mountPrefix}${resolved.repoRel}`, mountRoot: mount, mountPrefix, virtualPrefix: resolved.rel.slice(0, resolved.rel.length - resolved.repoRel.length) };
}

/** Check existing file/nearest parent before a write or deletion, including symlink ancestors. */
export function assertBrainGitPath(binding: BrainGitDocument, target: string): void {
  let existing = target;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("brain document has no authorized parent");
    existing = parent;
  }
  if (!contained(canonical(binding.mountRoot), canonical(existing))) throw new Error("brain document escapes its configured mount");
}

/** Adopt only this mount, never a parent's unrelated files or the active mount lock. */
export function brainMountPathspecs(binding: BrainGitDocument): string[] {
  return binding.mountPrefix ? [`:(literal)${binding.mountPrefix}`, `:(exclude,literal)${binding.mountPrefix}.switchyard-brain.lock`] : [".", ":(exclude).switchyard-brain.lock"];
}

/** Follow renames only while paths stay inside the original mount; subjects need whole-commit scope. */
export async function brainMountHistory(binding: BrainGitDocument, limit: number) {
  const raw = await git(binding.repo, ["log", `-${Math.max(1, Math.min(1000, Math.floor(limit)))}`, "--follow", "--no-relative", "--format=%x1e%H%x00%aI%x00%(trailers:key=Agent,valueonly)%x00%(trailers:key=Model,valueonly)%x00%s%x00", "--name-status", "-z", "HEAD", "--", `:(literal)${binding.repoRel}`]);
  const entries: Array<{ commit: string; date: string; agent: string | null; model: string | null; subject: string }> = [];
  let historical = binding.repoRel;
  for (const record of raw.split("\x1e")) {
    const fields = record.split("\0");
    const commit = fields.shift()?.trim();
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) continue;
    const date = fields.shift()?.trim() ?? "", agent = fields.shift()?.trim() || null, model = fields.shift()?.trim() || null, subject = fields.shift() ?? "";
    if (!historical.startsWith(binding.mountPrefix)) break;
    let touched = false, previous = historical;
    for (let i = 0; i < fields.length; i++) {
      const status = fields[i]!.trim();
      if (/^[RC]\d+$/.test(status)) {
        const oldPath = fields[++i], newPath = fields[++i];
        if (newPath === historical && oldPath) { touched = true; previous = oldPath; }
      } else if (/^[ADMTUXB]\d*$/.test(status) && fields[++i] === historical) touched = true;
    }
    if (touched) entries.push({ commit, date, agent, model, subject });
    historical = previous;
  }
  if (!binding.mountPrefix || !entries.length) return entries;
  const inventory = await git(binding.repo, ["log", "--no-walk=unsorted", "--root", "-m", "--raw", "--no-renames", "--no-relative", "--abbrev=40", "--format=%H%x00", "-z", ...entries.map(entry => entry.commit), "--"], { maxBuffer: 4 * 1024 * 1024 });
  const fields = inventory.split("\0"), visible = new Map<string, { safe: boolean; files: number }>();
  let current: { safe: boolean; files: number } | undefined;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!.trim();
    if (/^[a-f0-9]{40}$/.test(field)) { current = visible.get(field) ?? { safe: true, files: 0 }; visible.set(field, current); }
    else if (/^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [ACDMRTUXB]\d*$/.test(field)) {
      const file = fields[++i] ?? "";
      if (current) { current.files++; current.safe &&= file.startsWith(binding.mountPrefix); }
    } else if (field && current) current.safe = false;
  }
  return entries.map(entry => ({ ...entry, subject: visible.get(entry.commit)?.safe && visible.get(entry.commit)!.files ? entry.subject : "Document changed" }));
}
