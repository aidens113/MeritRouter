import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { sealCheckedCandidate } from "../src/attribution/checked-candidate.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, goodOutput, makeEnv, openWithTestSupervisor, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const raw = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const actor = { agent: "implementer:fixture", role: "implementer", model: "fake/model", task: "fixture-task", job: "fixture-job" };
function candidate() {
  env = makeEnv();
  const head = raw(env.repo, "rev-parse", "HEAD");
  writeFileSync(path.join(env.repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  raw(env.repo, "add", "package-lock.json");
  return { worktree: env.repo, head, tree: raw(env.repo, "write-tree"), actor, assertAuthority: () => {} };
}

it("commits exactly the captured staged generated file with worker attribution", async () => {
  const input = candidate();
  const head = await sealCheckedCandidate(input);
  expect(raw(input.worktree, "rev-parse", "HEAD^{tree}")).toBe(input.tree);
  expect(raw(input.worktree, "rev-parse", `${head}^`)).toBe(input.head);
  expect(raw(input.worktree, "status", "--porcelain")).toBe("");
  expect(raw(input.worktree, "show", "-s", "--format=%B")).toContain("Task: fixture-task");
  expect(raw(input.worktree, "show", "-s", "--format=%B")).toContain("Model: fake/model");
  expect(await sealCheckedCandidate({ ...input, head })).toBe(head);
});

it.each(["head", "index", "worktree", "untracked", "cancelled"])("refuses a changed %s before sealing", async condition => {
  const input = candidate();
  if (condition === "head") input.head = "0".repeat(40);
  if (condition === "index") input.tree = raw(input.worktree, "rev-parse", "HEAD^{tree}");
  if (condition === "worktree") writeFileSync(path.join(input.worktree, "package-lock.json"), "changed\n");
  if (condition === "untracked") writeFileSync(path.join(input.worktree, "extra.txt"), "unsealed\n");
  if (condition === "cancelled") input.assertAuthority = () => { throw new Error("cancelled"); };
  const before = raw(input.worktree, "rev-parse", "HEAD");
  await expect(sealCheckedCandidate(input)).rejects.toThrow();
  expect(raw(input.worktree, "rev-parse", "HEAD")).toBe(before);
});

it("publishes only the captured immutable tree even if the live index changes during sealing", async () => {
  const input = candidate(); let locked = false;
  await expect(sealCheckedCandidate({ ...input,
    publication: { sealed: async () => {
      expect(() => raw(input.worktree, "add", "package-lock.json")).toThrow(/index\.lock/);
      locked = true;
    } },
    afterPublication: async () => {
      writeFileSync(path.join(input.worktree, "extra.txt"), "new concurrent source\n");
      raw(input.worktree, "add", "extra.txt");
    },
  })).rejects.toThrow(/changed while sealing/);
  expect(locked).toBe(true);
  expect(raw(input.worktree, "rev-parse", "HEAD^{tree}")).toBe(input.tree);
  expect(raw(input.worktree, "diff", "--cached", "--name-only")).toBe("extra.txt");
});

it("uses expected-old HEAD CAS and preserves a concurrent commit", async () => {
  const input = candidate(); let newer = "", locked = false;
  await expect(sealCheckedCandidate({ ...input, publication: { beforePrepare: async () => {
    expect(() => raw(input.worktree, "commit", "-qm", "blocked concurrent owner commit")).toThrow(/index\.lock/);
    locked = true;
    // A legitimate ref-only Git writer does not take index.lock; expected-old CAS still applies.
    newer = raw(input.worktree, "commit-tree", input.tree, "-p", input.head, "-m", "concurrent owner commit");
    raw(input.worktree, "update-ref", "HEAD", newer, input.head);
  } } })).rejects.toThrow();
  expect(locked).toBe(true);
  expect(newer).not.toBe(""); expect(raw(input.worktree, "rev-parse", "HEAD")).toBe(newer);
});

it("seals a declared-check generated lockfile before final checks in the real native fake-provider runner", async () => {
  env = makeEnv({ config: baseConfig({ coding: { runner: "native" } }) });
  const command = `node -e "const f=require('fs');if(!f.existsSync('package-lock.json'))f.writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3}))"`;
  const client = new ScriptedClient(req => {
    const turn = req.messages.filter(message => message.role === "assistant").length;
    const tool = turn === 0 ? { name: "replace_in_file", arguments: JSON.stringify({ path: "src/app.ts", old_text: "return a + b;", new_text: "return a + b; // checked fixture" }) }
      : turn === 1 ? { name: "run_check", arguments: JSON.stringify({ command }) }
        : { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "core:src/app.ts#L1-L3")) };
    return reply(null, { ...servedFor(sy!, req), toolCalls: [{ id: `call-${turn}`, type: "function", function: tool }] });
  });
  sy = openWithTestSupervisor(env, client, { worker: true, coding: createCodingRunner(env.cfg) }, [command]);
  const [sub] = await sy.submitTasks([{ profile: "implement", goal: "Generate and seal a dependency lockfile", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["lockfile retained"], allowedPaths: ["src/**", "package-lock.json"], checks: [command] } }]);
  const result = (await sy.awaitResults([sub!.taskId], { timeoutSeconds: 60 })).completed[0]!;
  expect(result.acceptanceStatus, JSON.stringify(result)).toBe("met");
  const wt = (sy.db.prepare("SELECT worktree_path FROM workspaces WHERE task_id=?").get(sub!.taskId) as { worktree_path: string }).worktree_path;
  expect(raw(wt, "show", "HEAD:package-lock.json")).toContain("lockfileVersion");
  expect(raw(wt, "rev-parse", "HEAD^{tree}")).toBe(result.checks[0]!.revision);
  expect(raw(wt, "status", "--porcelain")).toBe("");
  expect(sy.sessions.forTask(sub!.taskId).at(-1)!.workspace!.repos[0]!.head).toBe(raw(wt, "rev-parse", "HEAD"));
}, 90_000);
