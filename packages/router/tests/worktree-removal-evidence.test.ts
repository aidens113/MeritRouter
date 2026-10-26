import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { makeEnv, type Env } from "./helpers.js";
import { removeProjectWorktrees } from "../src/projects/deletion.js";
let env:Env|undefined;
afterEach(()=>{env?.cleanup();env=undefined;});
const native=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8"}).trim();
it("preserves native lock and clean sequencer evidence before confirmed worktree removal",async()=>{
 env=makeEnv();const worktree=path.join(env.dir,"retained"),source=env.repo;
 native(source,"worktree","add","--detach",worktree,"HEAD");const admin=native(worktree,"rev-parse","--absolute-git-dir"),head=readFileSync(path.join(admin,"HEAD"));
 for(const marker of ["index.lock","HEAD.lock","locked","MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge","rebase-apply","sequencer","BISECT_LOG"]){
  const file=path.join(admin,marker),directory=["sequencer","rebase-merge","rebase-apply"].includes(marker);
  if(directory)mkdirSync(file);else writeFileSync(file,"foreign recovery evidence");
  await expect(removeProjectWorktrees([{repo:source,path:worktree}])).rejects.toThrow(/native operation recovery/);
  expect(existsSync(worktree)).toBe(true);expect(readFileSync(path.join(admin,"HEAD"))).toEqual(head);
  if(directory)rmSync(file,{recursive:true});else{expect(readFileSync(file,"utf8")).toBe("foreign recovery evidence");unlinkSync(file);}
 }
 const sharedLock=path.join(native(source,"rev-parse","--absolute-git-dir"),"packed-refs.lock");writeFileSync(sharedLock,"shared recovery");
 await expect(removeProjectWorktrees([{repo:source,path:worktree}])).rejects.toThrow(/native operation recovery/);
 expect(readFileSync(sharedLock,"utf8")).toBe("shared recovery");expect(existsSync(worktree)).toBe(true);unlinkSync(sharedLock);
 expect(await removeProjectWorktrees([{repo:source,path:worktree}])).toEqual({removed:1,problems:[]});expect(existsSync(worktree)).toBe(false);
},90_000);
