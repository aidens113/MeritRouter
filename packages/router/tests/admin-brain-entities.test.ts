import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Switchyard } from "../src/core/service.js";
import { brainCommitDetail, brainDocumentBlame, brainDocumentHistory, brainDocumentRelated, brainDocumentVisible } from "../src/admin/brain-entities.js";
import { git } from "../src/workspaces/git.js";
import { baseConfig, commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

function setup(mount = false) {
  const base = baseConfig();
  env = makeEnv({ config: {
    ...base, repositories: {},
    brain: { path: "brain", project: "alpha", ...(mount ? { mounts: [{ prefix: "projects/alpha/notes", path: "repo", commit: true }] } : {}) },
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
    commitAll(brain.root);
    const oldHash = (await git(brain.root, ["rev-parse", "HEAD"])).trim();
    renameSync(path.join(brain.root, "projects/alpha/old.md"), path.join(brain.root, "projects/alpha/current.md"));
    commitAll(brain.root);
    const detail = await brainCommitDetail(s, "alpha", "projects/alpha/current.md", oldHash);
    expect(detail?.diff).toContain("+historical content");
    expect(detail?.path).toBe("projects/alpha/current.md");
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
});
