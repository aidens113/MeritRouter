import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Principal } from "../src/brain/access.js";
import type { MeritRouter } from "../src/core/service.js";
import { GatewayError } from "../src/core/errors.js";
import type { ChatRequest } from "../src/gateway/types.js";
import type { ProjectRuntimeBundle } from "../src/projects/runtime-registry.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { capturedLease, type LeaseRef } from "../src/storage/task-leases.js";
import { baseConfig, endpoint, goodOutput, makeEnv, open, reply, ScriptedClient, servedFor } from "./helpers.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const call = (name: string, args: unknown) => ({ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
function verdict(request: ChatRequest) {
  const text = String(request.messages[1]?.content ?? ""), ref = /## Patch against the base \((artifact:[A-Za-z0-9_-]+)/.exec(text)![1]!;
  return { verdict: "pass", examinedRevision: /examinedRevision: (\S+)/.exec(text)![1]!, policyVersion: /policyVersion: (\S+)/.exec(text)![1]!,
    criteria: [...text.matchAll(/^- (\S+) \[verify: /gm)].map(match => ({ id: match[1]!, outcome: "pass", evidenceRefs: [ref] })),
    blockingFindings: [], missingEvidence: [], recommendedAction: "accept" };
}

it.each(["pass", "cancel", "provider_error"] as const)("real split automatic review binds and revokes exact captured reviewer authority: %s", async outcome => {
  const projectDirectory = mkdtempSync(path.join(tmpdir(), "mr-split-review-project-"));
  cleanup.push(() => rmSync(projectDirectory, { recursive: true, force: true }));
  const env = makeEnv({ config: baseConfig({ storage: { layout: "split", directory: "coordination" }, repositories: {},
    projects: { demo: { directory: projectDirectory, repositories: { core: { path: projectDirectory } } } },
    execution: { max_concurrent_tasks: 1, lease_seconds: 30 }, coding: { runner: "native" } }), endpoints: [
    endpoint({ gatewayModelId: "alpha/author:free", totalParametersB: 700 }),
    endpoint({ providerId: "groq", gatewayModelId: "beta/reviewer", totalParametersB: 400 }),
  ] });
  cleanup.push(() => env.cleanup());
  cpSync(env.repo, projectDirectory, { recursive: true });
  let sy!: MeritRouter, bundle!: ProjectRuntimeBundle, lease!: LeaseRef, reviewerId!: string, principal!: Principal;
  let entered!: () => void;
  const reviewerStarted = new Promise<void>(resolve => { entered = resolve; });
  let reviewerRequests = 0;
  const client = new ScriptedClient((request, _count, signal) => {
    const served = servedFor(sy, request);
    if (!lease) {
      const author = bundle.sessions!.list({ status: "running" }).find(session => session.role === "implementer")!;
      lease = capturedLease(bundle.tasks.get(author.taskId!)!);
    }
    if (request.tools?.some(tool => tool.function.name === "submit_verdict")) {
      reviewerRequests++;
      const reviewer = bundle.sessions!.forTask(lease.taskId).find(session => session.role === "reviewer" && session.status === "running")!;
      reviewerId = reviewer.id;
      const proof = { lease, role: "reviewer" as const, sessionId: reviewer.id };
      expect(bundle.executor.authorizeHarnessRole(proof)).toBe(true);
      for (const changed of [{ taskId: "forged" }, { project: "other" }, { owner: "other" }, { runCount: lease.runCount + 1 }, { incarnation: "0".repeat(32) }])
        expect(bundle.executor.authorizeHarnessRole({ ...proof, lease: { ...lease, ...changed } })).toBe(false);
      expect(bundle.executor.authorizeHarnessRole({ ...proof, role: "supervisor" })).toBe(false);
      const forged = bundle.sessions!.create({ taskId: lease.taskId, parentSessionId: reviewer.parentSessionId, role: "reviewer", profile: "review", agentLabel: "not-bound" });
      const context = { project: "demo", effort: "adhoc", task: "change", repos: ["core"], jobId: null, tier: "T3" as const, lease };
      expect(bundle.executor.authorizeHarnessRole({ ...proof, sessionId: forged.id })).toBe(false);
      expect(() => bundle.access!.principalFor("reviewer", { ...context, sessionId: forged.id })).toThrow(/captured harness phase/);
      forged.end("failed", "unbound fixture session");
      principal = bundle.access!.principalFor("reviewer", { ...context, sessionId: reviewer.id });
      expect(request.messages.some(message => String(message.content).includes("review-memory-canary"))).toBe(true);
      entered();
      if (outcome === "cancel") return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new GatewayError("aborted", "fixture review cancelled"))));
      if (outcome === "provider_error") throw new GatewayError("server", "fixture review server error");
      return reply(null, { ...served, toolCalls: [call("submit_verdict", verdict(request))] });
    }
    if (!request.messages.some(message => message.role === "tool")) return reply(null, { ...served, toolCalls: [call("replace_in_file", {
      path: "src/app.ts", old_text: "export function add", new_text: "export function subtract(a: number, b: number) { return a - b; }\n\nexport function add",
    })] });
    return reply(null, { ...served, toolCalls: [call("submit_result", goodOutput(1, "core:src/app.ts#L1-L3"))] });
  });
  sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
  cleanup.push(() => sy.close());
  await sy.createSplitProject({ slug: "demo", directory: projectDirectory });
  bundle = sy.projectStores("demo") as ProjectRuntimeBundle;
  await bundle.brain!.write({ kind: "human" }, { agent: "fixture", role: "supervisor" }, "projects/demo/repos/core.md", "# Repository contract\n\nreview-memory-canary: preserve subtract semantics.\n");
  const [submitted] = await sy.submitTasks([{ profile: "implement", label: "change", goal: "Add subtract to src/app.ts", repositoryAliases: ["core"], writableRepository: "core",
    hints: { difficulty: "T3" }, constraints: { allowedPaths: ["src/**"], acceptanceCriteria: [{ id: "subtract", text: "subtract returns a - b", verify: "review" }] }, budget: { maxModelRequests: 32 } }]);
  const id = submitted!.taskId;
  const task = bundle.tasks.get(id)!;
  await reviewerStarted;
  if (outcome === "cancel") {
    await sy.cancelTasks([id], "demo");
    expect(bundle.executor.authorizeHarnessRole({ lease, role: "reviewer", sessionId: reviewerId! })).toBe(false);
    expect(() => bundle.access!.request(principal!, "projects/demo/decisions/**", "read", "cancelled review")).toThrow();
  }
  const result = await sy.awaitResults([id], { timeoutSeconds: 45 });
  expect(result.timedOut).toBe(false);
  expect(reviewerRequests).toBeGreaterThan(0);
  if (outcome === "pass") expect(result.completed[0]).toMatchObject({ verificationStatus: "passed", acceptanceStatus: "met" });
  expect(bundle.executor.authorizeHarnessRole({ lease, role: "reviewer", sessionId: reviewerId! })).toBe(false);
  expect(() => bundle.access!.request(principal!, "projects/demo/decisions/**", "read", "ended review")).toThrow();
  const sessions = bundle.sessions!.forTask(id), reviewer = sessions.find(session => session.id === reviewerId)!;
  expect(sessions.find(session => session.id === reviewer.parentSessionId)).toMatchObject({ role: "implementer", taskId: id });
  expect(reviewer.modelRequests).toBeGreaterThan(0);
  expect(bundle.tasks.get(id)!.spec.profile).toBe(task.spec.profile);
  expect(sy.db.prepare("SELECT COUNT(*) n FROM tasks WHERE id=?").get(id)).toEqual({ n: 0 });
  expect((bundle.db.prepare("SELECT COUNT(*) n FROM request_charges WHERE task_id=?").get(id) as { n: number }).n).toBeGreaterThan(1);
}, 90000);
