import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RULEBOOK } from "../src/scoring/rulebook.js";
import { classifierCouldMatter, decide, type TaskFeatures } from "../src/scoring/score.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { MeritRouter } from "../src/core/service.js";
import { endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
});

const features = (o: Partial<TaskFeatures> = {}): TaskFeatures => ({
  mode: "read_only",
  linesInScope: 300,
  linesApproximate: false,
  contextTokens: 2000,
  repositories: 1,
  acceptanceCriteria: 2,
  checksRequired: false,
  outputSchema: false,
  retryAfterFailure: false,
  inputModalities: ["text"],
  scopeSample: [],
  ...o,
});

const spec = (o: Record<string, unknown> = {}) =>
  WorkerTaskSchema.parse({ profile: "inspect", goal: "g", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["a", "b"] }, ...o });

const base = { rulebookVersion: "v", confidence: null, rationale: null, suggestedTier: null };

describe("rulebook scoring", () => {
  it("scores measured features with an auditable breakdown", () => {
    env = makeEnv();
    const c = decide(env.cfg, DEFAULT_RULEBOOK, spec(), features(), { ...base, basis: "rules", tags: null });
    // read-only +1, 300 lines +1
    expect(c.score).toBe(2);
    expect(c.tier).toBe("T1");
    expect(c.breakdown.map((l) => l.rule)).toEqual(["mode", "lines_in_scope", "context_tokens"]);
  });

  it("tags only add points; a cross-cutting security refactor lands in T3", () => {
    env = makeEnv();
    const c = decide(env.cfg, DEFAULT_RULEBOOK, spec(), features({ mode: "coding", linesInScope: 4000 }), {
      ...base,
      basis: "rules+classifier",
      confidence: 0.9,
      tags: { kind: "refactor", reasoning: "cross_cutting", novelty: "existing_pattern", risk: ["security"], environment: [], ambiguity: "low" },
    });
    // coding 3 + 4000 lines 2 + refactor 2 + cross-cutting 3 + security 2 = 12 -> beyond T3 (11) -> T4
    expect(c.score).toBe(12);
    expect(c.tier).toBe("T4");
    expect(c.rejectReason).toMatch(/split the task/);
  });

  it("high ambiguity returns the task to the supervisor; low confidence rounds up", () => {
    env = makeEnv();
    const amb = decide(env.cfg, DEFAULT_RULEBOOK, spec(), features(), { ...base, basis: "rules+classifier", confidence: 0.9, tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "high" } });
    expect(amb.tier).toBe("T4");
    expect(amb.rejectReason).toMatch(/clarification/);
    const unsure = decide(env.cfg, DEFAULT_RULEBOOK, spec(), features(), { ...base, basis: "rules+classifier", confidence: 0.2, tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" } });
    expect(unsure.tier).toBe("T2");
    // Low confidence never rounds a T3 task up into T4: uncertainty alone does not take work from workers.
    const unsureT3 = decide(env.cfg, DEFAULT_RULEBOOK, spec(), features({ mode: "coding", linesInScope: 1644, contextTokens: 13252, acceptanceCriteria: 4, checksRequired: true }), {
      ...base,
      basis: "rules+classifier",
      confidence: 0.2,
      tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" },
    });
    expect(unsureT3.score).toBe(8);
    expect(unsureT3.tier).toBe("T3");
    expect(unsureT3.breakdown.some((l) => l.rule === "low_confidence")).toBe(false);
  });

  it("supervisor hints and minimum tiers can raise but never lower the tier", () => {
    env = makeEnv();
    const hinted = decide(env.cfg, DEFAULT_RULEBOOK, spec({ hints: { difficulty: "T3" } }), features(), { ...base, basis: "rules+hint", tags: null });
    expect(hinted.tier).toBe("T3");
    const low = decide(env.cfg, DEFAULT_RULEBOOK, spec({ hints: { difficulty: "T1" } }), features({ mode: "coding", linesInScope: 6000 }), { ...base, basis: "rules+hint", tags: null });
    expect(low.tier).toBe("T2");
    const analyze = decide(env.cfg, DEFAULT_RULEBOOK, spec({ profile: "analyze" }), features(), { ...base, basis: "rules", tags: null });
    expect(analyze.tier).toBe("T2");
  });

  it("the classifier is skipped when tags cannot change the outcome", () => {
    env = makeEnv();
    expect(classifierCouldMatter(env.cfg, DEFAULT_RULEBOOK, 1)).toBe(true);
    // At a measured T3, tags can still reach T4 or reject (ambiguity: high), so it runs.
    expect(classifierCouldMatter(env.cfg, DEFAULT_RULEBOOK, 9)).toBe(true);
    // Beyond T3 nothing a tag does can change the outcome.
    expect(classifierCouldMatter(env.cfg, DEFAULT_RULEBOOK, 12)).toBe(false);
  });
});

describe("classifier batching and caching", () => {
  it("classifies concurrent tasks with one shared request and reuses cached verdicts", async () => {
    env = makeEnv({ endpoints: [endpoint({ totalParametersB: 120 })] });
    let classifyCalls = 0;
    const client = new ScriptedClient((req) => {
      const sys = String(req.messages[0]!.content);
      if (sys.startsWith("You classify")) {
        classifyCalls++;
        const ids = [...String((req.messages[1] as { content: string }).content).matchAll(/<item id="(c\d+)">/g)].map((m) => m[1]);
        return reply(JSON.stringify({ items: ids.map((id) => ({ id, tags: { kind: "locate", reasoning: "lookup", novelty: "existing_pattern", risk: [], environment: [], ambiguity: "low" }, confidence: 0.9, rationale: "simple", suggestedTier: "T2" })) }), servedFor(sy!, req));
      }
      const tools = req.tools ?? [];
      if (tools.length) {
        return reply(null, { ...servedFor(sy!, req), toolCalls: [{ id: "1", type: "function", function: { name: "submit_result", arguments: JSON.stringify(goodOutput(1, "core:src/app.ts#L1-L2")) } }] });
      }
      return reply(JSON.stringify(goodOutput()), servedFor(sy!, req));
    });
    sy = open(env, client, { worker: true });
    const task = (goal: string) => ({ profile: "analyze", goal, repositoryAliases: ["core"], context: { fileRefs: ["core:src/app.ts"] }, constraints: { acceptanceCriteria: ["find add"] } });
    const subs = await sy.submitTasks([task("one"), task("two")]);
    const out = await sy.awaitResults(subs.map((s) => s.taskId), { timeoutSeconds: 10 });
    expect(out.completed.map((r) => r.executionStatus)).toEqual(["completed", "completed"]);
    expect(classifyCalls).toBe(1);
    expect(out.completed[0]!.classification).toMatchObject({ basis: "rules+classifier", tier: "T2" });
    // Same spec again: cached, no new classification request.
    const again = await sy.submitTasks([task("one")]);
    await sy.awaitResults([again[0]!.taskId], { timeoutSeconds: 10 });
    expect(classifyCalls).toBe(1);
  });
});
