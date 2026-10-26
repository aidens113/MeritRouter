import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { git } from "./git.js";
import { RepositoryMutationError } from "./repository-mutation.js";

/** Call under common-owner authority immediately before removal; never erase native recovery evidence. */
export async function assertNoNativeWorktreeOperation(worktree:string):Promise<void>{
 const directories=z.tuple([z.string().min(1),z.string().min(1)]).parse(
  (await git(worktree,["rev-parse","--path-format=absolute","--git-dir","--git-common-dir"])).trim().split(/\r?\n/));
 for(const directory of new Set(directories)){
  if(!path.isAbsolute(directory))throw new RepositoryMutationError("ownership_changed","Worktree metadata owner is unavailable");
  for(const marker of ["index.lock","HEAD.lock","packed-refs.lock","locked","MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge","rebase-apply","sequencer","BISECT_LOG"]){
   try{await lstat(path.join(directory,marker));}
   catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
   throw new RepositoryMutationError("ownership_changed",`Worktree removal requires native operation recovery first (${marker}); metadata was retained`);
  }
 }
}
