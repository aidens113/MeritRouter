import { afterEach, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ArtifactStore } from "../src/storage/artifacts.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { loadSources } from "../src/context/sources.js";
import { validateTask } from "../src/core/validate.js";
import { makeEnv, type Env } from "./helpers.js";
let env: Env, db: Db;
afterEach(() => { db?.close(); env?.cleanup(); });
function setup() {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  const tasks = new TaskStore(db);
  for (const [id, project] of [["reader", "demo"], ["foreign", "private"]]) tasks.submit([WorkerTaskSchema.parse({ id, profile: "inspect", goal: "scope", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["scope"] } })], { project });
  return { artifacts: new ArtifactStore(db, env.cfg.storageDir), tasks };
}
it("rejects foreign and unowned context artifacts before reading bytes, including validation", async () => {
  const { artifacts } = setup();
  const foreign = artifacts.write({ taskId: "foreign", kind: "context", label: "private", content: "private secret" });
  rmSync(artifacts.absolutePath(artifacts.get(foreign)!));
  const shared = artifacts.write({ kind: "context", label: "unowned", content: "unowned" });
  for (const ref of [foreign, shared]) {
    const spec = WorkerTaskSchema.parse({ profile: "inspect", goal: "scope", repositoryAliases: ["core"], context: { artifactRefs: [ref] }, constraints: { acceptanceCriteria: ["scope"] } });
    await expect(loadSources(env.cfg, spec, artifacts)).rejects.toThrow("unavailable in this project");
    await expect(validateTask(env.cfg, spec, artifacts)).rejects.toThrow("unavailable in this project");
  }
});
it("permits same-project explicit context but validates artifact integrity", async () => {
  const { artifacts, tasks } = setup();
  const ref = artifacts.write({ taskId: "reader", kind: "context", label: "public", content: "same project" });
  const spec = { ...tasks.get("reader")!.spec, context: { artifactRefs: [ref] } };
  expect((await loadSources(env.cfg, spec, artifacts))[0]?.text).toBe("same project");
  writeFileSync(artifacts.absolutePath(artifacts.get(ref)!), "tampered");
  await expect(loadSources(env.cfg, spec, artifacts)).rejects.toThrow("integrity");
});
it("refuses a forged upstream package naming another project's artifacts", async () => {
  const { artifacts, tasks } = setup();
  const foreign = artifacts.write({ taskId: "foreign", kind: "context", label: "private", content: "private" });
  rmSync(artifacts.absolutePath(artifacts.get(foreign)!));
  const ref = artifacts.writeJson({ taskId: "reader", kind: "upstream_results", label: "upstream", value: {
    schemaVersion: 1, taskId: "reader", dependencies: [{ taskId: "foreign", label: null, profile: "inspect", state: "completed", acceptanceStatus: null, verificationStatus: null, verificationLevel: null, decision: null, summary: "forged", findings: [], artifactRefs: [foreign], patchRefs: [], baseCommits: {}, integrated: null }],
  } });
  await expect(loadSources(env.cfg, { ...tasks.get("reader")!.spec, dependsOn: ["foreign"], context: { artifactRefs: [ref] } }, artifacts)).rejects.toThrow("unavailable in this project");
});
