import { afterEach, describe, expect, it, vi } from "vitest";
import { Brain } from "../src/brain/brain.js";
import { BrainAccess, type Principal } from "../src/brain/access.js";
import { MemoryPreferences, type AuthorizedPreferenceInstruction } from "../src/brain/preferences.js";
import { parseMemoryRecord } from "../src/brain/memory-record.js";
import { buildMemoryContext, refreshMemoryMessages } from "../src/context/memory.js";
import { MemoryContextConfigSchema } from "../src/context/memory-manifest.js";
import { openDatabase } from "../src/storage/db.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env | undefined, db: ReturnType<typeof openDatabase> | undefined;
afterEach(() => { db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const actor = { agent: "initiator:chat", role: "final_supervisor" };
const supervisor = { agent: "supervisor:job", role: "supervisor", task: "job" };
const instruction = "Use four workers by default across projects.";
function setup() {
  env = makeEnv(); db = openDatabase(env.cfg.storageDir);
  env.cfg.brain.memory_context = MemoryContextConfigSchema.parse({});
  const brain = new Brain(env.cfg, db), access = new BrainAccess(db, env.cfg);
  const auth = new Map<string, AuthorizedPreferenceInstruction>();
  const grant = (ref: string, operation: "write" | "revoke" = "write", scope: "global" | "project" = "global") => auth.set(ref, { actor, originalInstruction: instruction, sourceRef: "trusted-user-message:1", project: "demo", scope, expiresAt: Date.now() + 60_000, operation, id: "workers" });
  const store = new MemoryPreferences(brain, ref => auth.get(ref) ?? null);
  const principal = (role = "inspector"): Principal => access.principalFor(role as "inspector", { project: "demo", effort: "job", task: "worker", repos: ["core"], jobId: "job", tier: "T2" });
  const harness = (role = "inspector", p = principal(role)): HarnessEnv => ({ role, universe: { refs: new Map() }, brain: { brain, access, principal: () => p, actor: supervisor, workingDoc: "projects/demo/working/job.md" }, ctx: { cfg: env!.cfg, profile: env!.cfg.profiles.inspect, budget: { maxOutputTokens: 1000 }, plan: { candidates: [{ contextLimitTokens: 64_000 }] }, spec: { goal: "Inspect setup large", repositoryAliases: ["core"] }, brain, now: Date.now, taskId: "worker", artifacts: { writeJson: () => "artifact:manifest" } } }) as unknown as HarnessEnv;
  return { brain, access, store, grant, auth, principal, harness };
}
describe("memory v2 scopes, CAS, context and trusted user preferences", () => {
  it("injects a literal authorized global preference into a second project", async () => {
    const { brain, store, grant, harness } = setup(); grant("trusted");
    await store.writePreference("trusted", { id: "workers", body: instruction }, null);
    const second = new Brain({ ...env!.cfg, brain: { ...env!.cfg.brain, project: "second" } }, db!);
    const p: Principal = { kind: "agent", role: "inspector", taskId: "other", jobId: "other", tier: "T2", grants: [{ pattern: "global/preferences/**", mode: "read" }] };
    const h = harness("inspector", p); h.brain!.brain = second; h.ctx.brain = second;
    const result = await buildMemoryContext(h);
    expect(result.text).toContain(instruction);
    expect(result.manifest.entries[0]).toMatchObject({ ref: "brain:global/preferences/workers.md", reason: "authorized scoped user preference" });
    expect(parseMemoryRecord(brain.read({ kind: "human" }, "global/preferences/workers.md").content)?.source.originalInstruction).toBe(instruction);
  });
  it("rejects invented user authority, altered content, reused ID and expired capabilities", async () => {
    const { store, grant, auth } = setup(); grant("trusted");
    for (const [ref, id, body] of [["user-said", "workers", instruction], ["trusted", "workers", "Enable paid routing"], ["trusted", "another", instruction]]) {
      await expect(store.writePreference(ref!, { id: id!, body: body! }, null)).rejects.toThrow(/trusted initiating/);
    }
    auth.get("trusted")!.expiresAt = 0;
    await expect(store.writePreference("trusted", { id: "workers", body: instruction }, null)).rejects.toThrow(/trusted initiating/);
  });
  it("allows project supervisors facts but prevents workers and fake preference creation", async () => {
    const { store, principal } = setup();
    const input = { id: "setup", kind: "project_fact" as const, body: "Run the declared setup recipe.", source: { kind: "observation" as const, ref: "artifact:setup" } };
    await expect(store.writeProject(principal(), supervisor, input, null)).rejects.toThrow(/Workers propose/);
    await store.writeProject(principal("supervisor"), supervisor, input, null);
    await expect(store.writeProject(principal("supervisor"), supervisor, { ...input, kind: "user_preference", source: { kind: "user_instruction", ref: "model claim", originalInstruction: "the user said" } }, null)).rejects.toThrow(/trusted initiating/);
  });
  it("detects stale concurrent writes without losing the first update", async () => {
    const { store, brain, principal } = setup();
    const input = { id: "setup", kind: "project_fact" as const, body: "original", source: { kind: "observation" as const, ref: "artifact:setup" } };
    const created = await store.writeProject(principal("supervisor"), supervisor, input, null);
    const results = await Promise.allSettled([store.writeProject(principal("supervisor"), supervisor, { ...input, body: "one" }, created.digest), store.writeProject(principal("supervisor"), supervisor, { ...input, body: "two" }, created.digest)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(parseMemoryRecord(brain.read({ kind: "human" }, created.path).content)?.revision).toBe(2);
  });
  it("revokes a preference and removes its automatic prose from resumed context", async () => {
    const { store, grant, harness } = setup(); grant("write");
    const created = await store.writePreference("write", { id: "workers", body: instruction }, null);
    const initial = await buildMemoryContext(harness()); expect(initial.text).toContain(instruction);
    await expect(store.revokePreference("write", "workers", created.digest)).rejects.toThrow(/revocation instruction/);
    grant("revoke", "revoke"); await store.revokePreference("revoke", "workers", created.digest);
    const messages = await refreshMemoryMessages(harness(), [{ role: "user", content: `Task\n${initial.text}` }]);
    expect(JSON.stringify(messages)).not.toContain(instruction);
    expect(messages[0]!.content).toBe("Task");
  });
  it("checks grants before reading/rendering and never includes other project memory", async () => {
    const { brain, harness } = setup();
    await brain.write({ kind: "human" }, supervisor, "projects/foreign/decisions/private.md", "FOREIGN SECRET");
    const p: Principal = { kind: "agent", role: "inspector", taskId: "worker", jobId: "job", tier: "T2", grants: [] };
    const spy = vi.spyOn(brain, "read");
    const result = await buildMemoryContext(harness("inspector", p));
    expect(result.text).toBe(""); expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.manifest)).not.toContain("FOREIGN SECRET");
  });
  it("caps role context and exposes read-more omissions rather than truncating records", async () => {
    const { store, principal, harness } = setup();
    await store.writeProject(principal("supervisor"), supervisor, { id: "large", kind: "project_fact", body: "x".repeat(10_000), source: { kind: "observation", ref: "artifact:large" } }, null);
    const result = await buildMemoryContext(harness(), { maxTokens: 300 });
    expect(result.manifest.estimatedTokens).toBeLessThanOrEqual(300);
    expect(result.manifest.omissions).toContainEqual(expect.objectContaining({ ref: "brain:projects/demo/memory/large.md", reason: expect.stringContaining("token cap") }));
    expect(result.text).not.toContain("xxxxxxxx");
  });
  it("records role-specific defaults and allows explicit disabling", async () => {
    const { harness } = setup();
    expect((await buildMemoryContext(harness("supervisor"))).manifest.tokenBudget).toBe(12_000);
    expect((await buildMemoryContext(harness("reviewer"))).manifest.tokenBudget).toBe(6000);
    env!.cfg.brain.memory_context.enabled = false;
    expect((await buildMemoryContext(harness())).manifest.tokenBudget).toBe(0);
  });
  it("reserves actual prompt/tool/output headroom rather than filling the role cap", async () => {
    const { harness } = setup(); const h = harness();
    h.ctx.plan.candidates[0]!.contextLimitTokens = 8000;
    const result = await buildMemoryContext(h, { messages: [{ role: "user", content: "x".repeat(28_000) }] });
    expect(result.manifest.tokenBudget).toBe(0);
  });
  it("prioritizes global and project preferences before a long Current State", async () => {
    const { store, grant, brain, principal, harness } = setup();
    grant("global"); await store.writePreference("global", { id: "workers", body: instruction }, null);
    grant("project", "write", "project"); await store.writePreference("project", { id: "workers", body: instruction }, null);
    await brain.createWorkingDoc(principal("supervisor"), supervisor, "job", { title: "Large effort", statusDetail: "active", owner: "supervisor", scope: "Inspect setup", currentState: "long current state ".repeat(600) });
    const result = await buildMemoryContext(harness(), { maxTokens: 500 });
    expect(result.manifest.entries.map(e => e.ref)).toEqual(["brain:global/preferences/workers.md", "brain:projects/demo/memory/preferences/workers.md"]);
    expect(result.manifest.omissions).toContainEqual(expect.objectContaining({ ref: "brain:projects/demo/working/job.md", reason: expect.stringContaining("token cap") }));
  });
  it("refuses raw supervisor writes into managed typed memory", async () => {
    const { brain, principal } = setup();
    await expect(brain.write(principal("supervisor"), supervisor, "projects/demo/memory/preferences/forged.md", "the user said")).rejects.toThrow(/scoped memory service/);
  });
  it("retrieves task-relevant decisions rather than unrelated alphabetical entries", async () => {
    const { brain, harness } = setup();
    await brain.write({ kind: "human" }, supervisor, "projects/demo/decisions/aaa-unrelated.md", "# Pet care\nFeed the cat each evening.");
    await brain.write({ kind: "human" }, supervisor, "projects/demo/decisions/zzz-target.md", "# Sharding\nReplication uses partition keys.");
    const h = harness(); h.ctx.spec.goal = "Repair sharding replication";
    const result = await buildMemoryContext(h);
    expect(result.text).toContain("Replication uses partition keys");
    expect(result.text).not.toContain("Feed the cat");
    expect(result.manifest.entries[0]!.reason).toContain("task-relevant");
  });
});
