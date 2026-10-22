import path from "node:path";
import { readFileSync, statSync } from "node:fs";
/** Read a worktree HEAD without launching Git on each panel status request. */
export function worktreeHead(worktree: string): string | null {
  try {
    const metadata = path.join(worktree, ".git");
    const gitdir = statSync(metadata).isDirectory() ? metadata : path.resolve(worktree, readFileSync(metadata, "utf8").trim().replace(/^gitdir:\s*/, ""));
    const head = readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    if (/^[a-f0-9]{40,64}$/.test(head))
      return head;
    if (!head.startsWith("ref: refs/heads/"))
      return null;
    const ref = head.slice(5);
    let common = gitdir;
    try {
      common = path.resolve(gitdir, readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
    }
    catch { }
    try {
      const sha = readFileSync(path.join(common, ref), "utf8").trim();
      if (/^[a-f0-9]{40,64}$/.test(sha))
        return sha;
    }
    catch { }
    for (const line of readFileSync(path.join(common, "packed-refs"), "utf8").split(/\r?\n/)) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && /^[a-f0-9]{40,64}$/.test(sha))
        return sha;
    }
  }
  catch { }
  return null;
}
