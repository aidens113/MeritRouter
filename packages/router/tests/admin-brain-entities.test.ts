import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { brainCommitDetail, brainDocumentBlame, brainDocumentHistory, brainDocumentRelated, brainDocumentVisible } from "../src/admin/brain-entities.js";
import { git } from "../src/workspaces/git.js";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

function setup(mount = false, nested = false, mountPath?: string) {
  const base = baseConfig();
  env = makeEnv({ config: {
    ...base, repositories: {},
    brain: { path: "brain", project: "alpha", ...(mount ? { mounts: [{ prefix: "projects/alpha/notes", path: mountPath ?? (nested ? "repo/docs" : "repo"), commit: true }] } : {}) },
    projects: { alpha: { repositories: {} }, beta: { repositories: {} } },
  } });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  return { e: env, s: sy };
}

function put(root: string, file: string, text: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

describe("project-scoped brain commit details", () => {
  it("links only existing tasks and jobs attributed to the same project", async () => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    const insert = s.db.prepare("INSERT INTO tasks (id, spec_hash, profile, spec_json, state, created_at, updated_at, project_id) VALUES (?, 'test', 'summarize', '{}', 'completed', 1, 1, ?)");
    insert.run("alpha-task", "alpha");
    insert.run("alpha-job", "alpha");
    insert.run("beta-task", "beta");
    insert.run("beta-job", "beta");
    put(brain.root, "projects/alpha/note.md", "alpha line\n");
    commitAll(brain.root, "alpha attribution\n\nTask: alpha-task\nJob: alpha-job");
    put(brain.root, "projects/alpha/note.md", "alpha line\nbeta attributed line\n");
    commitAll(brain.root, "cross project attribution\n\nTask: beta-task\nJob: beta-job");
    expect(await brainDocumentRelated(s, "alpha", "projects/alpha/note.md")).toEqual({ tasks: ["alpha-task"], jobs: ["alpha-job"] });
    expect(await brainDocumentRelated(s, "beta", "projects/alpha/note.md")).toEqual({ tasks: [], jobs: [] });
    const lines = await brainDocumentBlame(s, "alpha", "projects/alpha/note.md");
    expect(lines[1]?.task).toBeNull();
    expect(lines[1]?.job).toBeNull();
  });

  it("validates paths and hashes and denies cross-project-only commits", async () => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    put(brain.root, "projects/beta/private.md", "beta secret\n");
    commitAll(brain.root, "private beta change");
    const hash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    expect(await brainCommitDetail(s, "alpha", "projects/beta/private.md", hash)).toBeNull();
    expect(await brainCommitDetail(s, "alpha", "global/missing.md", hash)).toBeNull();
    expect(await brainCommitDetail(s, "missing", "README.md", hash)).toBeNull();
    expect(await brainCommitDetail(s, "alpha", "README.md", "HEAD")).toBeNull();
    for (const file of ["projects/alpha/../beta/private.md", "projects/alpha/../../projects/beta/private.md", "global/../projects/beta/private.md", "global/.git/config", ":(glob)**", "private.md", "global\\secret.md"]) {
      expect(brainDocumentVisible("alpha", file), file).toBe(false);
      expect(await brainCommitDetail(s, "alpha", file, hash)).toBeNull();
    }
  });

  it("returns only the selected visible document from mixed and global commits", async () => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    put(brain.root, "projects/alpha/public.md", "alpha document\n");
    put(brain.root, "projects/beta/private.md", "beta secret\n");
    put(brain.root, "global/lesson.md", "global lesson\n");
    commitAll(brain.root, "beta secret in commit subject");
    const hash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    const alpha = await brainCommitDetail(s, "alpha", "projects/alpha/public.md", hash);
    expect(alpha?.diff).toContain("+alpha document");
    expect(JSON.stringify(alpha)).not.toContain("beta");
    expect(alpha?.diff).not.toContain("global lesson");
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/public.md");
    expect(history.map(row => row.commit)).toContain(hash);
    expect(history[0]?.subject).toBe("Document changed");
    expect(JSON.stringify(history)).not.toContain("beta");
    for (const project of ["alpha", "beta"]) {
      const global = await brainCommitDetail(s, project, "global/lesson.md", hash);
      expect(global?.diff).toContain("+global lesson");
      expect(JSON.stringify(global)).not.toContain("beta secret");
    }
  });

  it("does not reveal a private rename source or its content", async () => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    put(brain.root, "projects/beta/private.md", "moved document\n");
    commitAll(brain.root);
    const privateHash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    mkdirSync(path.join(brain.root, "projects/alpha"), { recursive: true });
    renameSync(path.join(brain.root, "projects/beta/private.md"), path.join(brain.root, "projects/alpha/public.md"));
    commitAll(brain.root, "move private beta record");
    const hash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    const detail = await brainCommitDetail(s, "alpha", "projects/alpha/public.md", hash);
    expect(detail?.diff).toContain("+moved document");
    expect(JSON.stringify(detail)).not.toContain("beta");
    expect(await brainCommitDetail(s, "alpha", "projects/alpha/public.md", privateHash)).toBeNull();
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/public.md");
    expect(history.map(row => row.commit)).toEqual([hash]);
    expect(JSON.stringify(history)).not.toContain("beta");
    expect(await brainDocumentHistory(s, "beta", "projects/alpha/public.md")).toEqual([]);
    const lines = await brainDocumentBlame(s, "alpha", "projects/alpha/public.md");
    expect(lines[0]?.text).toBe("moved document");
    expect(lines[0]?.commit).toBe("");
    expect(lines[0]?.authorName).toBe("Earlier history unavailable");
    expect(JSON.stringify(lines)).not.toContain("beta");
  });

  it("opens historical commits from before a rename within the visible project", async () => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    put(brain.root, "projects/alpha/old.md", "historical content\n");
    commitAll(brain.root, "A safe project-only subject");
    const oldHash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    renameSync(path.join(brain.root, "projects/alpha/old.md"), path.join(brain.root, "projects/alpha/current.md"));
    commitAll(brain.root);
    const detail = await brainCommitDetail(s, "alpha", "projects/alpha/current.md", oldHash);
    expect(detail?.diff).toContain("+historical content");
    expect(detail?.path).toBe("projects/alpha/current.md");
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/current.md");
    expect(history.find(entry => entry.commit === oldHash)?.subject).toBe("A safe project-only subject");
  });

  it("resolves mounted documents without exposing other repository files", async () => {
    const { e, s } = setup(true);
    put(e.repo, "note.md", "mounted note\n");
    put(e.repo, "unrelated.md", "unrelated repository secret\n");
    commitAll(e.repo, "mixed mounted commit");
    const hash = (await git(e.repo, ["rev-parse", "HEAD"])).trim();
    const detail = await brainCommitDetail(s, "alpha", "projects/alpha/notes/note.md", hash);
    expect(detail?.diff).toContain("+mounted note");
    expect(JSON.stringify(detail)).not.toContain("unrelated");
    expect(await brainCommitDetail(s, "beta", "projects/alpha/notes/note.md", hash)).toBeNull();
  });

  it("checks paths outside a nested mount before exposing a commit subject", async () => {
    const { e, s } = setup(true, true);
    put(e.repo, "docs/note.md", "mounted note\n");
    put(e.repo, "private.md", "outside mount\n");
    commitAll(e.repo, "private subject outside nested mount");
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md");
    expect(history[0]?.subject).toBe("Document changed");
    expect(JSON.stringify(history)).not.toContain("private subject");
  });

  it("keeps nested mount-only history, document diffs and blame usable", async () => {
    const { e, s } = setup(true, true);
    put(e.repo, "docs/note.md", "public note\n");
    commitAll(e.repo, "Safe nested note subject");
    const hash = (await git(e.repo, ["rev-parse", "HEAD"])).trim();
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md");
    expect(history[0]?.subject).toBe("Safe nested note subject");
    const detail = await brainCommitDetail(s, "alpha", "projects/alpha/notes/note.md", hash);
    expect(detail?.diff).toContain("+public note");
    expect(detail?.diff).not.toContain("docs/note.md");
    const lines = await brainDocumentBlame(s, "alpha", "projects/alpha/notes/note.md");
    expect(lines[0]?.text).toBe("public note");
    expect(lines[0]?.commit).toBe(hash);
  });

  it("stops nested mount ancestry at an outside rename and hides its attribution", async () => {
    const { e, s } = setup(true, true);
    put(e.repo, "private.md", "now public document\n");commitAll(e.repo, "private ancestor subject");
    const privateHash = (await git(e.repo, ["rev-parse", "HEAD"])).trim();
    mkdirSync(path.join(e.repo, "docs"), { recursive: true });
    renameSync(path.join(e.repo, "private.md"), path.join(e.repo, "docs/note.md"));commitAll(e.repo, "move private path into mount");
    const movedHash = (await git(e.repo, ["rev-parse", "HEAD"])).trim();
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md");
    expect(history.map(entry => entry.commit)).toEqual([movedHash]);
    expect(history[0]?.subject).toBe("Document changed");
    const mountedHistory = await s.brainFor("alpha").history("projects/alpha/notes/note.md");
    expect(mountedHistory.map(entry => entry.commit)).toEqual([movedHash]);
    expect(mountedHistory[0]?.subject).toBe("Document changed");
    expect(await brainCommitDetail(s, "alpha", "projects/alpha/notes/note.md", privateHash)).toBeNull();
    expect(JSON.stringify(await brainCommitDetail(s, "alpha", "projects/alpha/notes/note.md", movedHash))).not.toContain("private.md");
    const lines = await brainDocumentBlame(s, "alpha", "projects/alpha/notes/note.md");
    expect(lines[0]?.commit).toBe("");expect(lines[0]?.authorName).toBe("Earlier history unavailable");
    expect(JSON.stringify(lines)).not.toContain("private.md");
  });

  it("rejects core.worktree redirection to an unrelated repository", async () => {
    const { e, s } = setup(true, true);
    put(e.repo, "docs/note.md", "safe note\n");commitAll(e.repo, "safe subject");
    const outside = path.join(e.dir, "unrelated");mkdirSync(outside);
    await git(outside, ["init", "-q"]);put(outside, "docs/note.md", "unrelated secret\n");commitAll(outside, "unrelated secret subject");
    await git(e.repo, ["config", "core.worktree", outside]);
    expect(await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md")).toEqual([]);
    expect(await brainDocumentBlame(s, "alpha", "projects/alpha/notes/note.md")).toEqual([]);
    const actor = { agent: "supervisor:mount", role: "supervisor" };
    await expect(s.brainFor("alpha").write({ kind: "human" }, actor, "projects/alpha/notes/note.md", "must not write")).rejects.toThrow(/escapes its Git repository/);
    await expect(s.brainFor("alpha").remove({ kind: "human" }, actor, "projects/alpha/notes/note.md", "must not delete")).rejects.toThrow(/escapes its Git repository/);
    expect(readFileSync(path.join(e.repo, "docs/note.md"), "utf8")).toBe("safe note\n");
    expect(readFileSync(path.join(outside, "docs/note.md"), "utf8")).toBe("unrelated secret\n");
  });

  it("rejects a redirected enclosing root with a different Git common directory", async () => {
    const { e, s } = setup(true, true);
    put(e.repo, "docs/note.md", "safe mounted note\n");commitAll(e.repo, "fixture note");
    await git(e.dir, ["init", "-q"]);put(e.dir, "marker.txt", "enclosing repository\n");await git(e.dir, ["add", "--", "marker.txt"]);
    await git(e.dir, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "enclosing repository"]);
    await git(e.repo, ["config", "core.worktree", e.dir]);
    await expect(s.brainFor("alpha").write({ kind: "human" }, { agent: "supervisor:mount", role: "supervisor" }, "projects/alpha/notes/note.md", "must not write")).rejects.toThrow(/identity changed/);
    expect(await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md")).toEqual([]);
    expect(readFileSync(path.join(e.repo, "docs/note.md"), "utf8")).toBe("safe mounted note\n");
  });

  it("writes, adopts and removes inside a nested mount without committing unrelated staged changes", async () => {
    const { e, s } = setup(true, true);
    await git(e.repo, ["config", "core.autocrlf", "false"]);
    put(e.repo, "docs/note.md", "old mounted note\n");put(e.repo, "private.md", "private base\n");commitAll(e.repo, "fixture base");
    put(e.repo, "private.md", "private staged\n");await git(e.repo, ["add", "--", "private.md"]);
    put(e.repo, "private.md", "private staged plus unstaged\n");put(e.repo, "untracked.md", "outside untracked\n");
    const cached = await git(e.repo, ["diff", "--cached", "--binary", "--", "private.md"]);
    const unstaged = await git(e.repo, ["diff", "--binary", "--", "private.md"]);
    put(e.repo, "docs/hand.md", "human mounted edit\n");
    const brain = s.brainFor("alpha"), actor = { agent: "supervisor:mount", role: "supervisor" };
    const result = await brain.write({ kind: "human" }, actor, "projects/alpha/notes/note.md", "updated mounted note");
    expect(result.commit).toBeTruthy();
    expect(await git(e.repo, ["diff", "--cached", "--binary", "--", "private.md"])).toBe(cached);
    expect(await git(e.repo, ["diff", "--binary", "--", "private.md"])).toBe(unstaged);
    expect(await git(e.repo, ["show", "--format=", "--name-only", result.commit!])).toContain("docs/note.md");
    const recent = await git(e.repo, ["log", "-2", "--format=%(trailers:key=Agent,valueonly)%x09%s", "--name-only"]);
    expect(recent).toContain("human");expect(recent).not.toContain("private.md");expect(recent).not.toContain(".switchyard-brain.lock");
    expect((await brain.history("projects/alpha/notes/note.md"))[0]?.subject).toContain("note.md");
    await brain.write({ kind: "human" }, actor, "projects/alpha/notes/new.md", "new mounted document");
    const removed = await brain.remove({ kind: "human" }, actor, "projects/alpha/notes/new.md", "remove fixture document");
    expect(removed.commit).toBeTruthy();expect(removed.text).toContain("new mounted document");
    expect(await git(e.repo, ["diff", "--cached", "--binary", "--", "private.md"])).toBe(cached);
    expect(readFileSync(path.join(e.repo, "untracked.md"), "utf8")).toBe("outside untracked\n");
  });

  it("reads a nested mount in a legitimate managed worktree", async () => {
    const { e, s } = setup(true, true, "managed/docs");
    const managed = path.join(e.dir, "managed");await git(e.repo, ["worktree", "add", "--detach", managed, "HEAD"]);
    put(managed, "docs/note.md", "managed note\n");commitAll(managed, "Managed mount subject");
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/notes/note.md");
    expect(history[0]?.subject).toBe("Managed mount subject");
    expect((await brainDocumentBlame(s, "alpha", "projects/alpha/notes/note.md"))[0]?.text).toBe("managed note");
    const sourceHead = (await git(e.repo, ["rev-parse", "HEAD"])).trim();
    const updated = await s.brainFor("alpha").write({ kind: "human" }, { agent: "supervisor:mount", role: "supervisor" }, "projects/alpha/notes/note.md", "managed update");
    expect(updated.commit).toBeTruthy();expect((await git(e.repo, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
    expect(readFileSync(path.join(managed, "docs/note.md"), "utf8")).toBe("managed update\n");
  });

  it.each(["alpha", "beta"])("scopes copied README ancestry from project %s", async (owner) => {
    const { s } = setup();
    const brain = s.brainFor("alpha");
    await brain.ensure();
    const sourcePath = `projects/${owner}/source/README.md`;
    const source = Array.from({ length: 30 }, (_, i) => `shared index line ${i}`).join("\n") + "\n";
    put(brain.root, sourcePath, source);
    commitAll(brain.root, "private beta README history");
    const privateHash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    put(brain.root, "projects/alpha/copied/README.md", source.replace("line 0", "line zero"));
    // Modify the source in the same commit so Git's --follow infers the copy, as in demo seed.
    put(brain.root, sourcePath, `${source}extra source index line\n`);
    commitAll(brain.root, "copied project indexes");
    const copiedHash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    const raw = await git(brain.root, ["log", "--follow", "--format=%H", "--name-status", "HEAD", "--", "projects/alpha/copied/README.md"]);
    expect(raw).toMatch(/C\d+/);
    expect(raw).toContain(`${sourcePath}\tprojects/alpha/copied/README.md`);
    const history = await brainDocumentHistory(s, "alpha", "projects/alpha/copied/README.md");
    expect(history.map(entry => entry.commit)).toEqual(owner === "alpha" ? [copiedHash, privateHash] : [copiedHash]);
    const original = await brainCommitDetail(s, "alpha", "projects/alpha/copied/README.md", privateHash);
    if (owner === "alpha") expect(original?.diff).toContain("shared index line");
    else expect(original).toBeNull();
    expect(await brainCommitDetail(s, "alpha", "projects/alpha/copied/README.md", copiedHash)).not.toBeNull();
  });
});
