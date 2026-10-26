import { z } from "zod";
import { ActorSchema, type Actor } from "./actor.js";
import { git } from "../workspaces/git.js";
import { withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import { commitCapturedApplication, unpackSelectedCommitOutcome, type SelectedCommitControl } from "./selected-commit.js";

const GitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

/** Commit the already captured index, never restage files or substitute a newer tree. */
export async function sealCheckedCandidate(input: {
  worktree: string; head: string; tree: string; actor: Actor; assertAuthority: () => void; mutation?: RepositoryMutationCapability;
  /** Trusted host verification hooks, never parsed from model/tool input. */
  publication?: Pick<SelectedCommitControl, "sealed" | "beforePrepare" | "prepared" | "refPublished">;
  afterPublication?: () => Promise<void>;
}): Promise<string> {
  const { worktree, actor, assertAuthority } = input;
  const head = GitObject.parse(input.head), tree = GitObject.parse(input.tree);
  ActorSchema.parse(actor); assertAuthority();
  return withRepositoryMutation([worktree], async mutation => {
    assertAuthority();
    const result = await commitCapturedApplication(worktree, { actor, head, tree, message: "Seal generated files in checked worker candidate" }, { ...input.publication, mutation, assertAuthority });
    const commit = unpackSelectedCommitOutcome(result) ?? head;
    if (input.afterPublication) await input.afterPublication();
    const read = async (args: string[]) => { assertAuthority(); const value = await git(worktree, args); assertAuthority(); return value; };
    if ((await read(["rev-parse", "HEAD"])).trim() !== commit || (await read(["rev-parse", "HEAD^{tree}"])).trim() !== tree || (await read(["write-tree"])).trim() !== tree ||
      (await read(["diff", "--name-only", "-z"])).length || (await read(["ls-files", "--others", "--exclude-standard", "-z"])).length)
      throw new Error("Checked candidate changed while sealing; refusing checked evidence");
    return commit;
  }, input.mutation === undefined ? {} : { capability: input.mutation });
}
