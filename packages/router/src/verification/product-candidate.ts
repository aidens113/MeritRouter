import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { platform, arch } from "node:os";
import type { RunContext } from "../runners/types.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { productDigest } from "./product-spec.js";
import { ProductCandidateSchema, type ProductCandidate } from "./product-evidence.js";
import { resolveCurrentJourneyCandidate } from "../labs/browser-journey-current.js";
import type { LabManager } from "../labs/lab.js";
import type { LabRecord } from "../labs/store.js";

/** Resolve runtime identity from retained service evidence, never from a model's receipt. */
export async function currentDeliveryCandidate(ctx:Pick<RunContext,"spec"|"signal">,repos:Iterable<{alias:string;worktree:string}>,runtime?:{manager:LabManager;lab:LabRecord;specDigest:string}) {
  if(runtime){
    const journey=await resolveCurrentJourneyCandidate(runtime.manager,runtime.lab,runtime.specDigest,ctx.signal);
    if(journey)return journey;
  }
  return {candidate:await currentProductCandidate(ctx,repos),check:null};
}

/** Actual integration tree identities; unspecified fixtures are explicit, never a passed journey. */
export async function currentProductCandidate(ctx:Pick<RunContext,"spec"|"signal">,repos:Iterable<{alias:string;worktree:string}>):Promise<ProductCandidate> {
  const repositories:Record<string,{head:string;tree:string}>={},dependencies:Record<string,string>={};
  for(const repo of repos){
    if((await dirtyPaths(repo.worktree,{signal:ctx.signal,timeoutMs:30000})).length)throw new Error("Product candidate requires clean committed integration sources");
    repositories[repo.alias]={head:(await git(repo.worktree,["rev-parse","HEAD"],{signal:ctx.signal,timeoutMs:30000})).trim(),tree:(await git(repo.worktree,["rev-parse","HEAD^{tree}"],{signal:ctx.signal,timeoutMs:30000})).trim()};
    for(const name of ["package-lock.json","pnpm-lock.yaml","yarn.lock","package.json"]){
      const target=path.join(repo.worktree,name);
      try {if(lstatSync(target).isFile())dependencies[`${repo.alias}/${name}`]=productDigest(readFileSync(target,"utf8"));}catch{ /* Missing manifests are represented by absence, never a successful setup check. */ }
    }
  }
  return ProductCandidateSchema.parse({repositories,testDigest:productDigest(ctx.spec.constraints.checks??[]),recipeDigest:productDigest({checks:ctx.spec.constraints.checks??[],labChecks:ctx.spec.constraints.labChecks??[]}),environmentDigest:productDigest({platform:platform(),arch:arch(),node:process.version}),dependencyDigest:productDigest(dependencies),fixtureDigest:productDigest({status:"unspecified_external_fixture"}),browserGeneration:null});
}
