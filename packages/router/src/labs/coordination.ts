import type { LabManager } from "./lab.js";
import { git } from "../workspaces/git.js";
export interface LabOverlap {
  otherLab: string;
  repository: string;
  paths: string[];
}
export interface LabCoordination {
  repositories: Array<{
    alias: string;
    branch: string;
    target: string;
    head: string | null;
    targetHead: string;
    ahead: number;
    behind: number;
    changedPaths: string[];
  }>;
  overlaps: LabOverlap[];
}
export async function labCoordination(manager: LabManager, project: string, name: string): Promise<LabCoordination> {
  const status = manager.status(project, name);
  const repositories: LabCoordination["repositories"] = [];
  const overlaps: LabOverlap[] = [];
  for (const repo of status.lab.repositories) {
    const targetHead = (await git(repo.source, ["rev-parse", "--verify", "--end-of-options", `${repo.target}^{commit}`])).trim();
    const counts = (await git(repo.source, ["rev-list", "--left-right", "--count", `${repo.branch}...${targetHead}`, "--"])).trim().split(/\s+/).map(Number);
    const changedPaths = (await git(repo.source, ["diff", "--name-only", "-z", `${targetHead}...${repo.branch}`, "--"])).split("\0").filter(Boolean);
    repositories.push({ alias: repo.alias, branch: repo.branch, target: repo.target, head: status.heads[repo.alias] ?? null, targetHead, ahead: counts[0] ?? 0, behind: counts[1] ?? 0, changedPaths });
    for (const other of manager.list(project)) {
      if (other.id === status.lab.id)
        continue;
      const peer = other.repositories.find(r => r.source === repo.source && r.target === repo.target);
      if (!peer)
        continue;
      const paths = new Set((await git(peer.source, ["diff", "--name-only", "-z", `${targetHead}...${peer.branch}`, "--"])).split("\0").filter(Boolean));
      const intersection = changedPaths.filter(p => paths.has(p));
      if (intersection.length)
        overlaps.push({ otherLab: other.name, repository: repo.alias, paths: intersection });
    }
  }
  return { repositories, overlaps };
}
