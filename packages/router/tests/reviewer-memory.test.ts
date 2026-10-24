import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { MemoryPreferences } from "../src/brain/preferences.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { reviewResult, type ReviewDeps, type ReviewRequest } from "../src/verification/review.js";
import { verdictRecords } from "../src/verification/calibration.js";
import { baseResult, type RunContext } from "../src/runners/types.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
const author = endpoint({ providerId: "openrouter", gatewayModelId: "author/frontier:free", totalParametersB: 700 });
const reviewer = endpoint({ providerId: "groq", gatewayModelId: "reviewer/review", totalParametersB: 400 });
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

it("injects fresh role-budgeted memory into the actual independent reviewer while preserving its narrower ACL", async () => {
  env = makeEnv({ config: baseConfig({ coding: { runner: "native" }, verification: { cache_verdicts: false, failure: { max_quality_retries: 0 } }, brain: { path: "brain", project: "demo", memory_context: { role_tokens: { reviewer: 300 } } }, roles: { reviewer: { brain_grants: [{ pattern: "global/preferences/**", mode: "read" }] } } }), endpoints: [author, reviewer], files: { "src/app.ts": "export const redisLabel = 1;\n" } });
  let reviewerText = "", authorText = "";
  const client = new ScriptedClient(req => {
    const served = servedFor(sy!, req);
    if (req.tools?.some(tool => tool.function.name === "submit_verdict")) {
      reviewerText = JSON.stringify(req.messages);
      const pkg = String(req.messages[1]!.content), revision = /examinedRevision: (\S+)/.exec(pkg)![1]!, policyVersion = /policyVersion: (\S+)/.exec(pkg)![1]!, ref = /## Patch against the base \((artifact:[A-Za-z0-9_-]+)/.exec(pkg)![1]!;
      return reply(null, { ...served, toolCalls: [call("submit_verdict", { verdict: "pass", examinedRevision: revision, policyVersion, criteria: [{ id: "label", outcome: "pass", evidenceRefs: [ref] }], blockingFindings: [], missingEvidence: [], recommendedAction: "accept" })] });
    }
    authorText = JSON.stringify(req.messages);
    if (!req.messages.some(message => message.role === "tool")) return reply(null, { ...served, toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "redisLabel = 1", new_text: "redisLabel = 2" })] });
    return reply(null, { ...served, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1"))] });
  });
  sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
  const preference = "Preserve clear accessible product behavior in reviews.";
  const store = new MemoryPreferences(sy.brain, () => ({ actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: preference, sourceRef: "literal-user-message", scope: "global", project: "demo", expiresAt: Date.now() + 60_000, operation: "write", id: "review-quality" }));
  await store.writePreference("trusted", { id: "review-quality", body: preference }, null);
  await store.writeProject({ kind: "human" }, { agent: "human:test", role: "human" }, { id: "redis-private", kind: "project_fact", body: "Redis private author-only cluster secret.", source: { kind: "observation", ref: "artifact:private" } }, null);
  const [submitted] = await sy.submitTasks([{ profile: "implement", goal: "Update Redis label", repositoryAliases: ["core"], writableRepository: "core", hints: { difficulty: "T3" }, constraints: { allowedPaths: ["src/**"], acceptanceCriteria: [{ id: "label", text: "Redis label is 2", verify: "review" }] } }]);
  const result = await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 60 });
  expect(result.pending).toHaveLength(0);
  expect(result.completed[0]!.acceptanceStatus).toBe("met");
  expect(authorText).toContain("Redis private author-only cluster secret");
  expect(reviewerText).toContain(preference);
  expect(reviewerText).not.toContain("Redis private author-only cluster secret");
  const refs = sy.db.prepare("SELECT id FROM artifacts WHERE task_id=? AND kind='memory_manifest'").all(submitted!.taskId) as Array<{ id: string }>;
  const manifest = refs.map(row => JSON.parse(sy!.artifacts.read(`artifact:${row.id}`)!.content.toString())).find(value => value.role === "reviewer");
  expect(manifest).toMatchObject({ role: "reviewer", tokenBudget: 300 });
  expect(manifest.estimatedTokens).toBeLessThanOrEqual(300);
  expect(manifest.entries.map((entry: { ref: string }) => entry.ref)).toEqual(["brain:global/preferences/review-quality.md"]);
}, 90_000);

it("cancellation before evaluator preparation exits before touching stores or dispatching", async () => {
  const controller = new AbortController(); controller.abort(new Error("review cancelled"));
  await expect(reviewResult({} as ReviewDeps, { signal: controller.signal } as ReviewRequest)).rejects.toThrow("review cancelled");
});

it("memory-enabled review refuses an existing legacy cached verdict and rechecks again after revocation", async () => {
  env = makeEnv({ config: baseConfig({ verification: { cache_verdicts: true, failure: { max_quality_retries: 0 } }, brain: { path: "brain", project: "demo", memory_context: { enabled: false } } }), endpoints: [author, reviewer] });
  const reviews: string[] = [];
  const client = new ScriptedClient(req => {
    reviews.push(JSON.stringify(req.messages));
    const pkg = String(req.messages[1]!.content), revision = /examinedRevision: (\S+)/.exec(pkg)![1]!, policyVersion = /policyVersion: (\S+)/.exec(pkg)![1]!;
    return reply(null, { ...servedFor(sy!, req), toolCalls: [call("submit_verdict", { verdict: "pass", examinedRevision: revision, policyVersion, criteria: [{ id: "label", outcome: "pass", evidenceRefs: ["inline"] }], blockingFindings: [], missingEvidence: [], recommendedAction: "accept" })] });
  });
  const fixed = { run: async (_ctx: RunContext) => ({ state: "completed" as const, result: baseResult({ executionStatus: "completed", stopReason: "worker_submitted", summary: "fixed candidate", changedPaths: ["src/app.ts"], scopeViolation: [], protectedPathsChanged: [], baseCommits: { core: "0".repeat(40) } }), evidence: { revision: "fixed-memory-tree" } }) };
  sy = open(env, client, { worker: true, coding: fixed });
  const submit = async (label: string) => {
    const [task] = await sy!.submitTasks([{ profile: "implement", label, goal: "Review fixed candidate", repositoryAliases: ["core"], writableRepository: "core", context: { inlineText: "candidate reference" }, hints: { difficulty: "T3" }, constraints: { allowedPaths: ["src/**"], acceptanceCriteria: [{ id: "label", text: "Candidate is correct", verify: "review" }] } }]);
    const done = await sy!.awaitResults([task!.taskId], { timeoutSeconds: 30 });
    expect(done.completed[0]?.acceptanceStatus).toBe("met");
    return task!.taskId;
  };
  const first = await submit("legacy");
  expect(verdictRecords(sy.db, { taskId: first })[0]?.cacheKey).toMatch(/^vk-/);
  sy.cfg.brain.memory_context.enabled = true;
  const body = "Review accessibility carefully across every project.";
  let operation: "write" | "revoke" = "write";
  const store = new MemoryPreferences(sy.brain, () => ({ actor: { agent: "initiator:test", role: "final_supervisor" }, originalInstruction: body, sourceRef: "literal-user-message", scope: "global", project: "demo", expiresAt: Date.now() + 60_000, operation, id: "cache-safety" }));
  const written = await store.writePreference("trusted", { id: "cache-safety", body }, null);
  const second = await submit("fresh-memory");
  expect(reviews).toHaveLength(2); expect(reviews[1]).toContain(body);
  expect(verdictRecords(sy.db, { taskId: second })[0]).toMatchObject({ cacheKey: null, cachedFrom: null });
  expect(sy.tasks.events(second, 100).some(event => event.type === "review_cache_bypassed")).toBe(true);
  operation = "revoke"; await store.revokePreference("trusted", "cache-safety", written.digest);
  await submit("revoked-memory");
  expect(reviews).toHaveLength(3); expect(reviews[2]).not.toContain(body);
}, 90_000);
