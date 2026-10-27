import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Brain } from "../src/brain/brain.js";
import { openDatabase } from "../src/storage/db.js";
import { brainDocumentHistoryPage } from "../src/admin/brain-entities.js";
import { brainMemoryManifestPreview } from "../src/admin/brain-memory-manifest.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { blame } from "../src/attribution/index.js";
import type { MeritRouter } from "../src/core/service.js";
import { commitAll, makeEnv, type Env } from "./helpers.js";

let env: Env | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { db?.close(); env?.cleanup(); });

describe("bounded Brain provenance", () => {
  it("binds history continuation to HEAD, project, path and page size", async () => {
    env = makeEnv(); db = openDatabase(env.cfg.storageDir);
    const brain = new Brain(env.cfg, db);
    await brain.ensure();
    const rel = "projects/demo/notes/history.md";
    mkdirSync(path.dirname(path.join(brain.root, rel)), { recursive: true });
    for (let i = 0; i < 3; i++) { writeFileSync(path.join(brain.root, rel), `# Revision ${i}\n`); commitAll(brain.root, `Revision ${i}`); }
    const sy = { projects: { get: (slug: string) => slug === "demo" ? { slug } : null }, brainFor: () => brain } as unknown as MeritRouter;
    const first = await brainDocumentHistoryPage(sy, "demo", rel, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    const next = await brainDocumentHistoryPage(sy, "demo", rel, { limit: 2, cursor: first.next! });
    expect(next.entries).toHaveLength(1);
    expect(new Set([...first.entries, ...next.entries].map(entry => entry.commit)).size).toBe(3);
    await expect(brainDocumentHistoryPage(sy, "demo", rel, { limit: 1, cursor: first.next! })).rejects.toMatchObject({ code: "brain_cursor_stale" });
    writeFileSync(path.join(brain.root, rel), "# New HEAD\n"); commitAll(brain.root, "New HEAD");
    await expect(brainDocumentHistoryPage(sy, "demo", rel, { limit: 2, cursor: first.next! })).rejects.toMatchObject({ code: "brain_cursor_stale" });
    const abort = new AbortController(); abort.abort();
    await expect(blame(brain.root, rel, "HEAD", { signal: abort.signal, timeoutMs: 1000 })).rejects.toThrow(/abort|failed/i);
  }, 30000);

  it("reads actual manifest artifacts only after project ownership and integrity checks", async () => {
    env = makeEnv(); db = openDatabase(env.cfg.storageDir);
    const artifacts = new ArtifactStore(db, env.cfg.storageDir);
    const insert = db.prepare("INSERT INTO tasks (id,spec_hash,profile,spec_json,state,created_at,updated_at,project_id) VALUES (?,'fixture','inspect','{}','completed',1,1,?)");
    insert.run("task-demo", "demo"); insert.run("task-foreign", "foreign");
    const manifest = { schemaVersion: 1, role: "inspector", project: "demo", generatedAt: 1, tokenBudget: 4000, estimatedTokens: 100, entries: [{ ref: "brain:projects/demo/notes/test.md", digest: "a".repeat(64), reason: "fixture reference", estimatedTokens: 100 }], omissions: [] };
    artifacts.writeJson({ taskId: "task-demo", kind: "memory_manifest", label: "actual stored fixture", value: manifest });
    artifacts.writeJson({ taskId: "task-foreign", kind: "memory_manifest", label: "must stay hidden", value: { ...manifest, project: "foreign" } });
    // brainMemoryManifestPreview reads through `sy.projectStores`; this fixture's own (transitional, same-DB) stores.
    const sy = { db, artifacts, projects: { get: (slug: string) => slug === "demo" ? { slug } : null },
      projectStores: (project: string) => ({ project, db, artifacts }) } as unknown as MeritRouter;
    const receipts = brainMemoryManifestPreview(sy, { project: "demo" });
    expect(receipts).toHaveLength(1); expect(receipts[0]?.manifest).toEqual(manifest);
    expect(() => brainMemoryManifestPreview(sy, { project: "demo", taskId: "task-foreign" })).toThrow(/unavailable/);
    artifacts.writeJson({ taskId: "task-demo", kind: "memory_manifest", label: "invalid scoped receipt", value: { ...manifest, project: "foreign" } });
    expect(brainMemoryManifestPreview(sy, { project: "demo" }).filter(receipt => receipt.manifest === null)).toHaveLength(1);
  });
});
