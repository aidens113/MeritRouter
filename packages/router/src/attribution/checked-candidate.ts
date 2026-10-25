import { z } from "zod";
import { actorIdentity, trailerArgs, type Actor } from "./index.js";
import { git } from "../workspaces/git.js";

const GitObject = z.string().regex(/^[a-f0-9]{40,64}$/);

/** Commit the already captured index, never restage files or substitute a newer tree. */
export async function sealCheckedCandidate(input: {
  worktree: string; head: string; tree: string; actor: Actor; assertAuthority: () => void;
}): Promise<string> {
  const { worktree, actor, assertAuthority } = input;
  const head = GitObject.parse(input.head), tree = GitObject.parse(input.tree);
  const read = async (args: string[]) => { assertAuthority(); const value = (await git(worktree, args)).trim(); assertAuthority(); return value; };
  if (await read(["rev-parse", "HEAD"]) !== head) throw new Error("Checked candidate HEAD changed before sealing");
  if (await read(["write-tree"]) !== tree) throw new Error("Checked candidate index differs from the verified tree");
  if (await read(["diff", "--name-only"]) || await read(["ls-files", "--others", "--exclude-standard"])) throw new Error("Checked candidate has unsealed source changes");
  if (await read(["rev-parse", "HEAD^{tree}"]) === tree) return head;
  const identity = actorIdentity(actor);
  assertAuthority();
  const trailers = trailerArgs(actor).filter((_, index) => index % 2 === 1).join("\n");
  const commit = GitObject.parse((await git(worktree, ["commit-tree", tree, "-p", head, "-m", `Seal generated files in checked worker candidate\n\n${trailers}`], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
  })).trim());
  assertAuthority();
  // The immutable object names the captured tree by construction. Publish it only
  // while HEAD is still the exact worker revision we inspected.
  await git(worktree, ["update-ref", "HEAD", commit, head]);
  assertAuthority();
  if (await read(["rev-parse", "HEAD^{tree}"]) !== tree || await read(["write-tree"]) !== tree || await read(["diff", "--name-only"]) || await read(["ls-files", "--others", "--exclude-standard"]))
    throw new Error("Checked candidate changed while sealing; refusing checked evidence");
  return read(["rev-parse", "HEAD"]);
}
