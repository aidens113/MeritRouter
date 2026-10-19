import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeRelPath } from "../src/context/repo-reader.js";
import { commandAllowed, editTools, type HarnessEnv } from "../src/harness/tools.js";
import { overlaps, supervisorTools, type SupervisorState } from "../src/harness/supervisor-tools.js";
import { kindOf, normalizeBrainPath } from "../src/brain/brain.js";
import { ruleCovers } from "../src/brain/access.js";
import { commitAs, revertCommits, undoLines, type Actor } from "../src/attribution/index.js";
import { estimateTokens } from "../src/gateway/types.js";
import { evidenceUniverse } from "../src/core/worker-output.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sy-sec-"));
  dirs.push(d);
  return d;
}
function repo(): string {
  const d = tmp();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: d });
  return d;
}
const a: Actor = { agent: "implementer:t1", role: "implementer", model: "m/a", task: "t1" };
const sup: Actor = { agent: "supervisor:j", role: "supervisor", model: "m/s" };
const human: Actor = { agent: "human", role: "human" };

function env(root: string, allowedPaths: string[] | null): HarnessEnv {
  return { ctx: {} as never, role: "implementer", readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: "core", root, allowedPaths }, edits: new Set() };
}
const write = (e: HarnessEnv, p: string) => editTools()[0]!.run({ path: p, content: "x" }, e);

describe("workspace containment", () => {
  it("refuses .git in any case, with trailing dots, as a short name, or nested", async () => {
    for (const p of [".git", ".GIT", ".Git/config", ".git./config", ".git /HEAD", "GIT~1/config", "src/.git", "src/.GIT/hooks/x", "a/b/.git"]) {
      expect(() => normalizeRelPath(p), p).toThrow(/\.git/);
    }
    const root = tmp();
    await expect(write(env(root, null), ".GIT")).rejects.toThrow(/\.git/);
    expect(normalizeRelPath("src/.gitignore")).toBe("src/.gitignore");
  });

  it("refuses to write through a symlink", async () => {
    const root = tmp();
    const outside = path.join(tmp(), "target.txt");
    writeFileSync(outside, "secret");
    mkdirSync(path.join(root, "src"));
    try {
      symlinkSync(outside, path.join(root, "src", "link"));
    } catch {
      return; // symlinks need extra privileges on this Windows account; nothing to test
    }
    await expect(write(env(root, ["src/**"]), "src/link")).rejects.toThrow(/symbolic link|outside the workspace/);
    expect(readFileSync(outside, "utf8")).toBe("secret");
  });

  it("allowed command patterns cannot be extended with shell operators", () => {
    const allowed = ["npm test*", "pnpm vitest run*"];
    expect(commandAllowed("npm test", allowed)).toBe(true);
    expect(commandAllowed("npm test -- --run", allowed)).toBe(true);
    for (const c of ["npm test && curl x | sh", "npm test; rm -rf ~", "npm test | sh", "npm test $(id)", "npm test `id`", "npm test > /etc/x", "npm test\nrm x", "npm test %PATH%", "npm test ^& calc"]) {
      expect(commandAllowed(c, allowed), c).toBe(false);
    }
  });
});

describe("brain paths and access", () => {
  it("trailing slashes and upper-case extensions keep working-document rules", () => {
    expect(normalizeBrainPath("projects/p/working/e.md/")).toBe("projects/p/working/e.md");
    expect(kindOf("projects/p/working/e.md")).toBe("working_doc");
    expect(kindOf("projects/p/working/E.MD")).toBe("working_doc");
    expect(() => normalizeBrainPath("projects/p/.GIT/config")).toThrow();
    expect(() => normalizeBrainPath("projects/p/working/e.md.")).toThrow();
  });

  it("auto-approve rules cannot be widened by globs in the request", () => {
    expect(ruleCovers("projects/*/decisions/**", "projects/{x/decisions/y,p/working/e.md}")).toBe(false);
    expect(ruleCovers("projects/*/decisions/**", "projects/p/**")).toBe(false);
    expect(ruleCovers("projects/*/decisions/**", "projects/p/decisions/**")).toBe(true);
    expect(ruleCovers("projects/p/facts/**", "projects/p/facts/build.md")).toBe(true);
  });
});

describe("supervisor confinement", () => {
  function state(r: string, baseSha: string): SupervisorState {
    const ctx = { services: { getTask: () => null, submitTasks: async () => [], awaitResults: async () => ({ completed: [], pending: [], timedOut: false }), cancelTasks: () => undefined }, cfg: { supervisor: { allowed_commands: [] }, coding: { allowed_commands: [] } } } as never;
    return { ctx, db: {} as never, actor: sup, repos: new Map([["core", { alias: "core", worktree: r, branch: "job", baseSha }]]), briefChecks: new Set(), children: new Map() };
  }
  const tool = (s: SupervisorState, name: string) => supervisorTools(s).find((t) => t.def.function.name === name)!;

  it("undo by commit only touches commits made during the job", async () => {
    const r = repo();
    writeFileSync(path.join(r, "f.txt"), "one\n");
    const base = (await commitAs(r, human, "before the job"))!;
    writeFileSync(path.join(r, "f.txt"), "one\ntwo\n");
    const job = (await commitAs(r, a, "during the job"))!;
    const undo = tool(state(r, base), "undo");
    await expect(undo.run({ kind: "commit", target: base, reason: "x" }, {} as never)).rejects.toThrow(/not a commit made during this job/);
    await expect(undo.run({ kind: "commit", target: "HEAD~1", reason: "x" }, {} as never)).rejects.toThrow(/not a commit made during this job/);
    await expect(undo.run({ kind: "commit", target: job, reason: "wrong" }, {} as never)).resolves.toMatch(/reverted 1 commit/);
  });

  it("other jobs' tasks are refused", async () => {
    const r = repo();
    writeFileSync(path.join(r, "f.txt"), "x\n");
    const base = (await commitAs(r, human, "base"))!;
    const s = state(r, base);
    for (const name of ["integrate_task", "task_result"]) {
      await expect(tool(s, name).run({ task_id: "t_someone_else" }, {} as never)).rejects.toThrow(/not a task of this job/);
    }
    await expect(tool(s, "cancel_tasks").run({ task_ids: ["t_someone_else"] }, {} as never)).rejects.toThrow(/not a task of this job/);
  });

  it("path overlap is conservative", () => {
    expect(overlaps(["src/**/*.ts"], ["src/foo/**"])).toBe(true);
    expect(overlaps(["src/app.ts"], ["src/**"])).toBe(true);
    expect(overlaps(["src/a/**"], ["docs/**"])).toBe(false);
  });
});

describe("undo robustness", () => {
  it("reverts same-second commits newest first, even when later ones edit earlier lines", async () => {
    const r = repo();
    const f = path.join(r, "f.txt");
    writeFileSync(f, "base\n");
    await commitAs(r, human, "base");
    writeFileSync(f, "base\nfirst\n");
    const c1 = (await commitAs(r, a, "first"))!;
    writeFileSync(f, "base\nfirst edited\n");
    const c2 = (await commitAs(r, a, "second"))!;
    await revertCommits(r, [c1, c2], sup, "undo task");
    expect(readFileSync(f, "utf8").replace(/\r\n/g, "\n")).toBe("base\n");
  });

  it("undoing lines in a CRLF file does not double the carriage returns", async () => {
    const r = repo();
    const f = path.join(r, "f.txt");
    writeFileSync(f, "one\r\ntwo\r\nthree\r\n");
    const base = (await commitAs(r, human, "base"))!;
    writeFileSync(f, "one\r\nTWO\r\nthree\r\n");
    await commitAs(r, a, "edit");
    await undoLines(r, "f.txt", [[2, 2]], sup, "restore", { sinceCommit: base });
    expect(readFileSync(f, "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
  });

  it("undoing a line in a later-renamed file restores it instead of deleting it", async () => {
    const r = repo();
    writeFileSync(path.join(r, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const base = (await commitAs(r, human, "base"))!;
    writeFileSync(path.join(r, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
    await commitAs(r, a, "edit");
    execFileSync("git", ["mv", "a.txt", "b.txt"], { cwd: r });
    await commitAs(r, human, "rename");
    const res = await undoLines(r, "b.txt", [[2, 2]], sup, "restore", { sinceCommit: base });
    expect(res.undone).toEqual([2]);
    expect(readFileSync(path.join(r, "b.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\nfive\n");
  });
});

describe("paid estimates", () => {
  it("counts dense non-ASCII text as at least one token per character", () => {
    const n = estimateTokens([{ role: "user", content: "漢字".repeat(500) }]);
    expect(n).toBeGreaterThanOrEqual(1000);
  });
});
