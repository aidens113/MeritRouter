import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../src/workspaces/git.js";
import { prepareGitProcess } from "../src/workspaces/git-process-policy.js";
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const root=mkdtempSync(path.join(tmpdir(),"sy-git-policy-"));roots.push(root);
  const repo=path.join(root,"repo");mkdirSync(repo);
  const raw=(args:string[])=>execFileSync("git",args,{cwd:repo,encoding:"utf8",windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:"0"}});
  raw(["init","-q"]);raw(["config","user.name","Fixture"]);raw(["config","user.email","fixture@example.invalid"]);
  const sentinel=path.join(root,"outside");
  const program=path.join(root,"touch.cjs");writeFileSync(program,`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'EXECUTED')`);
  const evil=`node "${program.replace(/\\/g,"/")}"`;
  return {root,repo,raw,sentinel,evil};
}
describe("fixed internal Git process policy",()=>{
  it("preserves trusted global CRLF semantics across raw reset and protected cherry-pick",async()=>{
    const f=fixture();const probe=vi.mocked(childProcess.execFileSync);const actual=probe.getMockImplementation()!;
    probe.mockImplementation(((file: string, args: string[], opts: unknown) => {
      if(file === "git" && args.includes("--get-regexp") && (args.includes("--system") || args.includes("--global"))) {
        expect(args).toContain("--no-includes");expect((opts as {env:NodeJS.ProcessEnv}).env.GIT_CONFIG_GLOBAL).toBeUndefined();
        return args.includes("--system") ? "core.autocrlf\nyes\0" : "core.safecrlf\noff\0";
      }
      return actual(file,args,opts as never);
    }) as typeof childProcess.execFileSync);
    try {
      writeFileSync(path.join(f.repo,"file"),"base\n");await git(f.repo,["add","-A"]);await git(f.repo,["commit","-q","-m","base"]);
      const base=(await git(f.repo,["rev-parse","HEAD"])).trim();
      const source=path.join(f.root,"source"), target=path.join(f.root,"target");
      f.raw(["-c","core.autocrlf=true","worktree","add","-q","-b","source",source,base]);
      writeFileSync(path.join(source,"file"),"worker\n");await git(source,["add","-A"]);await git(source,["commit","-q","-m","worker"]);const commit=(await git(source,["rev-parse","HEAD"])).trim();
      f.raw(["-c","core.autocrlf=true","worktree","add","-q","-b","target",target,base]);
      execFileSync("git",["-c","core.autocrlf=true","reset","--hard",base],{cwd:target,stdio:"pipe"});
      expect(readFileSync(path.join(target,"file"),"utf8")).toBe("base\r\n");
      expect(await git(target,["status","--porcelain"])).toBe("");
      await git(target,["cherry-pick","-x",commit],{env:{GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
      expect(await git(target,["show","HEAD:file"])).toBe("worker\n");
      f.raw(["config","core.autocrlf","false"]);
      expect(prepareGitProcess(f.repo,["status"]).args).not.toContain("core.autocrlf=true");
    } finally {probe.mockImplementation(actual);}
  });

  it("stages, commits with attribution, reads blame and creates a worktree without repository hooks/fsmonitor",async()=>{
    const f=fixture();const hooks=path.join(f.root,"hooks");mkdirSync(hooks);
    for(const name of ["pre-commit","prepare-commit-msg","commit-msg","post-commit","post-checkout"]){writeFileSync(path.join(hooks,name),`#!/bin/sh\n${f.evil}\n`,{mode:0o755});}
    f.raw(["config","core.hooksPath",hooks]);f.raw(["config","core.fsmonitor",f.evil]);f.raw(["config","commit.gpgsign","true"]);f.raw(["config","gpg.program",f.evil]);
    writeFileSync(path.join(f.repo,"hello.txt"),"hello\n");
    await git(f.repo,["status","--porcelain"]);await git(f.repo,["add","-A"]);
    await git(f.repo,["commit","-q","-m","safe","--trailer","Agent: inspector:fixture"]);
    expect(await git(f.repo,["log","-1","--format=%B"])).toContain("Agent: inspector:fixture");
    expect(await git(f.repo,["blame","--line-porcelain","HEAD","--","hello.txt"])).toContain("hello");
    await git(f.repo,["worktree","add","--detach",path.join(f.root,"worktree"),"HEAD"]);
    expect(existsSync(path.join(f.root,"worktree","hello.txt"))).toBe(true);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it.each(["filter.evil.clean","filter.evil.smudge","filter.evil.process","merge.evil.driver","trailer.Agent.command","trailer.Agent.cmd","diff.evil.textconv","diff.evil.command","core.alternateRefsCommand"])("fails closed for executable config %s",async key=>{
    const f=fixture();f.raw(["config",key,f.evil]);writeFileSync(path.join(f.repo,".gitattributes"),"* filter=evil diff=evil merge=evil\n");writeFileSync(path.join(f.repo,"file"),"test");
    await expect(git(f.repo,["add","-A"])).rejects.toThrow(/unsafe repository Git configuration/);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("disables external diff and ignores inherited config/directory injection",async()=>{
    const f=fixture();writeFileSync(path.join(f.repo,"file"),"old");await git(f.repo,["add","-A"]);await git(f.repo,["commit","-q","-m","initial"]);
    f.raw(["config","diff.external",f.evil]);writeFileSync(path.join(f.repo,"file"),"changed");
    expect(await git(f.repo,["diff"])).toContain("changed");
    const keys=["GIT_CONFIG_COUNT","GIT_CONFIG_KEY_0","GIT_CONFIG_VALUE_0","GIT_DIR","GIT_WORK_TREE","GIT_EXTERNAL_DIFF"];
    const prior=keys.map(k=>process.env[k]);
    try {process.env.GIT_CONFIG_COUNT="1";process.env.GIT_CONFIG_KEY_0="filter.injected.clean";process.env.GIT_CONFIG_VALUE_0=f.evil;process.env.GIT_DIR=path.join(f.root,"missing");process.env.GIT_WORK_TREE=f.root;process.env.GIT_EXTERNAL_DIFF=f.evil;
      expect(await git(f.repo,["status","--porcelain"])).toContain("file");
      const policy=prepareGitProcess(f.repo,["rev-parse","HEAD"]);expect(policy.env.GIT_CONFIG_COUNT).toBeUndefined();expect(policy.env.GIT_DIR).toBeUndefined();
    } finally {keys.forEach((k,i)=>prior[i]===undefined?delete process.env[k]:process.env[k]=prior[i]);}
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("rejects repository includes that could change between preflight and execution",async()=>{
    const f=fixture();const include=path.join(f.repo,"included.cfg");writeFileSync(include,"[user]\n name = included\n");
    f.raw(["config","include.path",include]);
    await expect(git(f.repo,["status","--porcelain"])).rejects.toThrow(/unsafe repository Git configuration: include.path/);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("rejects core.worktree redirection before content reads or staging",async()=>{
    const f=fixture();const outside=path.join(f.root,"outside-tree");mkdirSync(outside);const secret=path.join(outside,"secret");writeFileSync(secret,"outside unchanged");
    writeFileSync(path.join(f.repo,"file"),"inside");await git(f.repo,["add","-A"]);await git(f.repo,["commit","-q","-m","base"]);
    const before=f.raw(["ls-files","--stage"]);f.raw(["config","core.worktree",outside]);
    expect((await git(f.repo,["rev-parse","--show-toplevel"])).trim().replace(/\\/g,"/")).toBe(outside.replace(/\\/g,"/"));
    for(const args of [["add","-A"],["diff"],["show","HEAD:file"],["ls-files","-z","--","."],["status","--porcelain"]]) await expect(git(f.repo,args)).rejects.toThrow(/escapes the authorized repository root/);
    expect(readFileSync(secret,"utf8")).toBe("outside unchanged");expect(f.raw(["ls-files","--stage"])).toBe(before);
  });
  it("accepts content operations in legitimate managed worktrees and diagnostic nested probes",async()=>{
    const f=fixture();writeFileSync(path.join(f.repo,"file"),"root");await git(f.repo,["add","-A"]);await git(f.repo,["commit","-q","-m","base"]);
    const worktree=path.join(f.root,"managed");await git(f.repo,["worktree","add","--detach",worktree,"HEAD"]);
    expect(await git(worktree,["grep","-n","-I","-E","-e","root","HEAD"])).toContain("HEAD:file:1:root");
    expect(await git(worktree,["show","HEAD:file"])).toBe("root");writeFileSync(path.join(worktree,"file"),"managed update");await git(worktree,["add","-A"]);expect(await git(worktree,["diff","--cached"])).toContain("managed update");
    const nested=path.join(f.repo,"nested");mkdirSync(nested);writeFileSync(path.join(nested,"child"),"tracked");await git(f.repo,["add","-A"]);
    expect(await git(nested,["rev-parse","--is-inside-work-tree"])).toContain("true");expect(await git(nested,["ls-files","-z","--","."])).toContain("child");
  });
  it("rejects alias commands and executable command/env overrides",()=>{
    const f=fixture();expect(()=>prepareGitProcess(f.repo,["evil"])).toThrow(/unsupported/);
    expect(()=>prepareGitProcess(f.repo,["-c","core.hooksPath=evil","status"])).toThrow(/override denied/);
    expect(()=>prepareGitProcess(f.repo,["status"],{GIT_CONFIG_PARAMETERS:"evil"})).toThrow(/override denied/);
  });
  describe("cached policy verdicts",()=>{
    const probes=()=>vi.mocked(childProcess.execFileSync).mock.calls.filter(([,args])=>Array.isArray(args)&&(args.includes("--list")||args.includes("--show-toplevel"))).length;
    it("reuses config and root verdicts for an unchanged repository, in any path case",()=>{
      const f=fixture();prepareGitProcess(f.repo,["status"]);
      const before=probes();
      for(let i=0;i<5;i++) prepareGitProcess(f.repo,["status"]);
      if(process.platform==="win32") prepareGitProcess(f.repo.toUpperCase(),["status"]);
      expect(probes()).toBe(before);
    });
    it("re-probes when config is replaced or edited in place, and still fails closed",async()=>{
      const f=fixture();await git(f.repo,["status","--porcelain"]);
      f.raw(["config","filter.evil.clean",f.evil]);
      await expect(git(f.repo,["status","--porcelain"])).rejects.toThrow(/unsafe repository Git configuration: filter.evil.clean/);
      f.raw(["config","--unset","filter.evil.clean"]);await git(f.repo,["status","--porcelain"]);
      // Same inode, new content: an in-place edit must invalidate the verdict too.
      appendFileSync(path.join(f.repo,".git","config"),`[diff "evil"]\n\ttextconv = ${f.evil.replace(/\\/g,"/")}\n`);
      await expect(git(f.repo,["diff"])).rejects.toThrow(/unsafe repository Git configuration: diff.evil.textconv/);
      expect(existsSync(f.sentinel)).toBe(false);
    });
    it("re-probes the root when the gitdir is redirected after a verified call",async()=>{
      const f=fixture();writeFileSync(path.join(f.repo,"file"),"inside");await git(f.repo,["add","-A"]);
      const outside=path.join(f.root,"outside-tree");mkdirSync(outside);
      f.raw(["config","core.worktree",outside]);
      await expect(git(f.repo,["status","--porcelain"])).rejects.toThrow(/escapes the authorized repository root/);
      const linked=path.join(f.root,"linked");mkdirSync(linked);
      writeFileSync(path.join(linked,".git"),`gitdir: ${path.join(f.repo,".git").replace(/\\/g,"/")}\n`);
      await expect(git(linked,["status","--porcelain"])).rejects.toThrow(/escapes the authorized repository root/);
    });
  });
});
