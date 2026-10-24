import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { Brain, BrainConflictError } from "../src/brain/brain.js";
import { openDatabase } from "../src/storage/db.js";
import { makeEnv, type Env } from "./helpers.js";
import { brainCatalogPage, brainSearchPage } from "../src/admin/brain-catalog.js";
import type { MeritRouter } from "../src/core/service.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let env: Env | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { vi.restoreAllMocks(); db?.close(); env?.cleanup(); });

describe("indexed Brain browsing", () => {
  it("pages visible metadata and scopes search before ranking/limit without rereading unchanged bodies", async () => {
    env = makeEnv();
    db = openDatabase(env.cfg.storageDir);
    const brain = new Brain(env.cfg, db);
    await brain.ensure();
    const put = (rel: string, text: string) => {
      const abs = path.join(brain.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    };
    for (let i = 0; i < 160; i++) put(`projects/foreign/${i}.md`, "# Needle\nneedle needle needle");
    for (let i = 0; i < 8; i++) put(`projects/demo/notes/${i}.md`, "# Needle\nneedle");
    // Foreign project's index is populated independently, as in a shared installation.
    await new Brain({ ...env.cfg, brain: { ...env.cfg.brain, project: "foreign" } }, db).refreshIndex();
    await brain.refreshIndex();
    const first = await brain.catalog({ kind: "human" }, { scope: "project", prefix: "projects/demo/notes/", limit: 3 });
    const second = await brain.catalog({ kind: "human" }, { scope: "project", prefix: "projects/demo/notes/", limit: 3, after: first.next! });
    expect(first.entries, JSON.stringify({ project: brain.project, rows: db.prepare("SELECT path FROM brain_files").all() })).toHaveLength(3);
    expect(second.entries).toHaveLength(3);
    expect(new Set([...first.entries, ...second.entries].map(e => e.path)).size).toBe(6);
    expect(brain.search({ kind: "human" }, "needle", { scope: "project", limit: 3 })).toHaveLength(3);
    expect(brain.search({ kind: "human" }, "needle", { scope: "project", limit: 3 }).every(e => e.path.startsWith("projects/demo/"))).toBe(true);
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    await brain.refreshIndex();
    await brain.catalog({ kind: "human" });
    expect(spy).not.toHaveBeenCalled();
    const sy = { projects: { get: (slug: string) => slug === "demo" ? { slug } : null }, brainFor: () => brain } as unknown as MeritRouter;
    const page = await brainCatalogPage(sy, { project: "demo", prefix: "projects/demo/notes/", limit: 3 });
    const next = await brainCatalogPage(sy, { project: "demo", prefix: "projects/demo/notes/", limit: 3, after: page.next! });
    expect(new Set([...page.entries, ...next.entries].map(e => e.path)).size).toBe(6);
    const search = await brainSearchPage(sy, { project: "demo", query: "needle", limit: 3 });
    expect(search.next).toBe(3);
    put("projects/demo/notes/0.md", "# Changed needle\nDifferent content updates the scoped generation.\n");
    await brain.refreshIndex();
    await expect(brainCatalogPage(sy, { project: "demo", prefix: "projects/demo/notes/", limit: 3, after: page.next! })).rejects.toMatchObject({ code: "brain_cursor_stale" });
    await expect(brainSearchPage(sy, { project: "demo", query: "needle", offset: 3, generation: search.generation })).rejects.toMatchObject({ code: "brain_cursor_stale" });
  });

  it("rejects stale concurrent writes and create collisions under the repository lock", async () => {
    env = makeEnv();
    db = openDatabase(env.cfg.storageDir);
    const brain = new Brain(env.cfg, db);
    const principal = { kind: "human" } as const;
    const actor = { agent: "test-human", role: "human" };
    const rel = "projects/demo/notes/cas.md";
    await brain.write(principal, actor, rel, "# Initial\n", undefined, { expectedDigest: null });
    const original = brain.read(principal, rel);
    const results = await Promise.allSettled([
      brain.write(principal, actor, rel, "# Writer A\n", undefined, { expectedDigest: original.digest }),
      brain.write(principal, actor, rel, "# Writer B\n", undefined, { expectedDigest: original.digest }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(brain.write(principal, actor, rel, "# Overwrite\n", undefined, { expectedDigest: null })).rejects.toBeInstanceOf(BrainConflictError);
    const current = brain.read(principal, rel);
    const catalog = await brain.catalog(principal, { prefix: rel });
    expect(catalog.entries[0]?.title).toBe(current.content.trim().slice(2));
  });
});
