import { afterEach, expect, it } from "vitest";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess } from "../src/brain/access.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { refreshMemoryMessages } from "../src/context/memory.js";
import type { MemoryManifest } from "../src/context/memory-manifest.js";
import { estimateTokens, type ChatMessage, type ChatTool } from "../src/gateway/types.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { openDatabase } from "../src/storage/db.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const instruction = "Retain accessible navigation in every project.";
async function setup(contextTokens = 10_000) {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  const brain = new Brain(env.cfg, db), access = new BrainAccess(db, env.cfg);
  let operation: "write" | "revoke" = "write";
  const store = new MemoryPreferences(brain, () => ({ actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: instruction, sourceRef: "literal-user-message", project: "demo", scope: "global", id: "accessibility", expiresAt: Date.now() + 60_000, operation }));
  const written = await store.writePreference("trusted", { id: "accessibility", body: instruction }, null);
  const manifests: MemoryManifest[] = [];
  const principal = () => access.principalFor("inspector", { project: "demo", effort: "effort", task: "task", jobId: null, repos: [], tier: "T2" });
  const harness = { role: "inspector", brain: { brain, access, principal, actor: { agent: "inspector:task", role: "inspector" }, workingDoc: "projects/demo/working/effort.md" }, universe: { refs: new Map() }, ctx: { cfg: env.cfg, taskId: "task", profile: { max_output_tokens: 2000 }, budget: { maxInputTokens: null, maxOutputTokens: null }, spec: { goal: "Inspect navigation", repositoryAliases: [] }, plan: { candidates: [{ contextLimitTokens: contextTokens }] }, brain, now: Date.now, artifacts: { writeJson: ({ value }: { value: MemoryManifest }) => { manifests.push(value); return "artifact:manifest"; } } } } as unknown as HarnessEnv;
  return { harness, manifests, revoke: async () => { operation = "revoke"; await store.revokePreference("trusted", "accessibility", written.digest); } };
}
const tool = (description: string): ChatTool => ({ type: "function", function: { name: "pinned_operation", description, parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } } } });

it("resumed memory includes the actual large pinned tool schemas in headroom and removes old automatic prose", async () => {
  const { harness, manifests } = await setup();
  const smallTools = [tool("read approved files")];
  const original: ChatMessage[] = [{ role: "user", content: "Inspect navigation." }];
  const initial = await refreshMemoryMessages(harness, original, { tools: smallTools, outputTokens: 1000, reservedTokens: 500 });
  expect(JSON.stringify(initial)).toContain(instruction);
  const largeTools = [tool("x".repeat(36_000))], pinned = JSON.stringify(largeTools);
  const refreshed = await refreshMemoryMessages(harness, initial, { tools: largeTools, outputTokens: 1000, reservedTokens: 500 });
  expect(JSON.stringify(refreshed)).not.toContain(instruction);
  expect(manifests.at(-1)).toMatchObject({ tokenBudget: 0, estimatedTokens: 0, entries: [] });
  expect(JSON.stringify(largeTools)).toBe(pinned);
  expect(original).toEqual([{ role: "user", content: "Inspect navigation." }]);
});

it("reserves actual output once and keeps small-context resumed memory inside prompt/tool/output bounds", async () => {
  const { harness, manifests } = await setup(4000);
  const tools = [tool("read")], messages: ChatMessage[] = [{ role: "user", content: "Inspect." }];
  const refreshed = await refreshMemoryMessages(harness, messages, { tools, outputTokens: 1000, reservedTokens: 500 });
  // Profile ceiling is 2000, actual generation is1000. Reserving both would incorrectly omit
  // this useful preference despite its fitting alongside prompt/tool/output and margins.
  expect(JSON.stringify(refreshed)).toContain(instruction);
  expect(manifests.at(-1)!.estimatedTokens).toBeGreaterThan(0);
  expect(estimateTokens(refreshed, tools) + 1000 + 500 + 2000).toBeLessThanOrEqual(4000);
});

it("refreshed memory still rechecks current grants and revocation with unchanged tool schemas", async () => {
  const { harness, manifests, revoke } = await setup();
  const tools = [tool("read")], options = { tools, outputTokens: 1000, reservedTokens: 500 };
  const first = await refreshMemoryMessages(harness, [{ role: "user", content: "Inspect." }], options);
  expect(JSON.stringify(first)).toContain(instruction);
  await revoke();
  const second = await refreshMemoryMessages(harness, first, options);
  expect(JSON.stringify(second)).not.toContain(instruction);
  expect(manifests.at(-1)!.entries).toEqual([]);
});
