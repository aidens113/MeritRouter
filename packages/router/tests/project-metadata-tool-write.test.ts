import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { editTools, type HarnessEnv } from "../src/harness/tools.js";
import { editOperations } from "../src/harness/edit-operations.js";
import { executeOperation } from "../src/harness/operation-lifecycle.js";
import { createRepositoryEffects } from "../src/workspaces/repository-command.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";
import { makeEnv, type Env } from "./helpers.js";
let fixture: Env | undefined;
afterEach(() => { fixture?.cleanup(); fixture = undefined; });
function setup() {
  fixture = makeEnv({ files: { "app.txt": "original" } });
  let valid = true;
  const env = { ctx: { taskId: "task", signal: new AbortController().signal, now: Date.now,
    taskLease: { taskId: "task", owner: "worker", runCount: 1, incarnation: "a".repeat(32), project: "demo" },
    tasks: { dispatchable: () => valid, get: () => ({ row: { deadline_at: null } }) }, cfg: fixture.cfg,
    spec: { profile: "implement", context: {} } }, role: "implementer", readers: new Map(), universe: { refs: new Map() },
    workspace: { alias: "core", root: fixture.repo, allowedPaths: null }, edits: new Set(), allowArtifacts: false } as unknown as HarnessEnv;
  return { env, revoke: () => { valid = false; } };
}
function pending() { const directory = path.join(fixture!.repo, ".git", "meritrouter-publications"); mkdirSync(directory); writeFileSync(path.join(directory, "unknown.json"), "{}"); }
for (const [name, args] of [ ["write_file", { path: "app.txt", content: "bad" }], ["replace_in_file", { path: "app.txt", old_text: "original", new_text: "bad" }], ["delete_file", { path: "app.txt" }] ] as const) {
  it(`blocks direct ${name} without injected guard when publication history requires reconciliation`, async () => {
    const { env } = setup(); pending();
    await expect(editTools().find(tool => tool.def.function.name === name)!.run(args, env)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(readFileSync(path.join(fixture!.repo, "app.txt"), "utf8")).toBe("original"); expect(env.edits.size).toBe(0);
  });
}
it("rethrows typed refusal through V2 edit and operation boundaries", async () => {
  const { env } = setup(); pending(); const definition = editOperations()[0]!;
  await expect(executeOperation(definition, { edits: [{ action: "create", path: "new.txt", content: "bad" }] }, env)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
});
it("rechecks the captured task lease after waiting for source mutation admission", async () => {
  const { env, revoke } = setup(); env.repositoryEffects = createRepositoryEffects(fixture!.repo);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = withRepositoryMutation([fixture!.repo], async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready; const write = editTools()[0]!.run({ path: "app.txt", content: "bad" }, env); revoke(); release(); await held;
  await expect(write).rejects.toMatchObject({ reason: "lease_lost" }); expect(readFileSync(path.join(fixture!.repo, "app.txt"), "utf8")).toBe("original");
});
it("supports nested V2 effects under the same host capability", async () => {
  const { env } = setup(); const result = await editOperations()[0]!.run({ edits: [{ action: "create", path: "new.txt", content: "yes" }] }, env);
  expect(result).toMatchObject({ status: "succeeded", applied: 1 }); expect(readFileSync(path.join(fixture!.repo, "new.txt"), "utf8")).toBe("yes");
});
