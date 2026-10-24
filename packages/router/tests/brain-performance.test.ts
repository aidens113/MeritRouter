import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Brain } from "../src/brain/brain.js";
import { openDatabase } from "../src/storage/db.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { db?.close(); env?.cleanup(); });

describe("isolated Brain metadata benchmark", () => {
  it.runIf(process.env.MERITROUTER_BRAIN_BENCH === "1")("records 10k-file cold/warm scoped catalog and search timings", async () => {
    env = makeEnv(); db = openDatabase(env.cfg.storageDir);
    const brain = new Brain(env.cfg, db);
    await brain.ensure();
    for (const project of ["demo", "foreign-a", "foreign-b"]) mkdirSync(path.join(brain.root, "projects", project, "notes"), { recursive: true });
    for (let i = 0; i < 10000; i++) {
      const project = ["demo", "foreign-a", "foreign-b"][i % 3]!;
      writeFileSync(path.join(brain.root, "projects", project, "notes", `${String(i).padStart(5, "0")}.md`), `# Document ${i}\n\nneedle ${project} fixture content\n`);
    }
    const start = performance.now();
    const first = await brain.catalog({ kind: "human" }, { scope: "project", limit: 50 });
    const initialIndexMs = performance.now() - start;
    expect(first.entries).toHaveLength(50);
    const browse: number[] = [], search: number[] = [], freshInstance: number[] = [];
    for (let i = 0; i < 30; i++) {
      let at = performance.now();
      await brain.catalog({ kind: "human" }, { scope: "project", limit: 50 });
      browse.push(performance.now() - at);
      at = performance.now();
      expect(brain.search({ kind: "human" }, "needle", { scope: "project", limit: 30 })).toHaveLength(30);
      search.push(performance.now() - at);
    }
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      await new Brain(env.cfg, db).catalog({ kind: "human" }, { scope: "project", limit: 50 });
      freshInstance.push(performance.now() - at);
    }
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { n: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) };
    };
    console.log(JSON.stringify({ environment: { platform: process.platform, node: process.version }, fixtureFiles: 10000, projectFiles: 3334, initialScopedIndexMs: initialIndexMs, warmBrowseMs: stats(browse), warmSearchMs: stats(search), freshInstanceWithExistingIndexMs: stats(freshInstance) }));
  }, 120000);
});
