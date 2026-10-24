import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Worktrees } from "../src/workspaces/worktree.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env:Env|undefined,sy:MeritRouter|undefined;
afterEach(async()=>{await sy?.close();env?.cleanup();});
it("retains the protected deleted source and scope violation when an evaluator is renamed",async()=>{
  env=makeEnv();sy=open(env,new ScriptedClient(()=>reply("{}")));
  mkdirSync(path.join(env.repo,"tests"),{recursive:true});
  writeFileSync(path.join(env.repo,"tests","acceptance.test.ts"),"// immutable acceptance fixture\n");
  execFileSync("git",["add","-A"],{cwd:env.repo});
  execFileSync("git",["commit","-m","acceptance fixture"],{cwd:env.repo});
  const baseSha=execFileSync("git",["rev-parse","HEAD"],{cwd:env.repo}).toString().trim();
  renameSync(path.join(env.repo,"tests","acceptance.test.ts"),path.join(env.repo,"src","renamed.ts"));
  const changes=await new Worktrees(sy.db,path.join(env.dir,"worktrees")).collect({taskId:"fixture",repoAlias:"core",sourcePath:env.repo,worktreePath:env.repo,baseSha,sourceDirty:false,dirtyPaths:[]},["src/**"],["tests/**"]);
  expect(changes.protectedChanged).toContain("tests/acceptance.test.ts");
  expect(changes.outOfScope).toContain("tests/acceptance.test.ts");
  expect(changes.changed).toContainEqual({status:"D",path:"tests/acceptance.test.ts"});
  expect(changes.changed).toContainEqual({status:"A",path:"src/renamed.ts"});
});
