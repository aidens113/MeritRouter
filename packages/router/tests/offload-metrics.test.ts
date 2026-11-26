import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema, type WorkerResult } from "../src/core/task.js";
import { syntheticResult, type ClaimLimits } from "../src/storage/tasks.js";
import { SupervisorChannelStore } from "../src/storage/supervisor-channel.js";
import { toolRefs } from "../src/core/channel.js";
import { offloadReport } from "../src/admin/offload-metrics.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const LIMITS: ClaimLimits = { maxConcurrent: 10, maxWritersPerRepo: 10, leaseMs: 600_000, defaultTimeoutMs: 600_000 };

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: env!.repo, encoding: "utf8", windowsHide: true }).trim();
}

/** A commit with Task/Model trailers, as a worker's commit carries them. */
function workerCommit(file: string, task: string, model: string | null, seconds: number): string {
  writeFileSync(path.join(env!.repo, file), `${file}\n${task}\n`);
  git("add", "--", file);
  const trailers = model ? `Task: ${task}\nModel: ${model}\nAgent: worker:${task}` : `Agent: lead`;
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", `Change ${file}\n\n${trailers}`], {
    cwd: env!.repo,
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: `${seconds} +0000`, GIT_COMMITTER_DATE: `${seconds} +0000` },
  });
  return git("rev-parse", "HEAD");
}

function done(id: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return { ...syntheticResult(id, "completed", "done"), acceptanceStatus: "met", summary: `did ${id}`, usage: { ...syntheticResult(id, "completed", "done").usage, modelRequests: 3, inputTokens: 1000, outputTokens: 200, tokenUsageBasis: "provider_reported" }, ...extra };
}

function submitAndFinish(s: MeritRouter, id: string, result: WorkerResult, writableRepo?: string) {
  s.tasks.submit([
    WorkerTaskSchema.parse({
      id,
      profile: writableRepo ? "implement" : "inspect",
      goal: `Do the work for ${id}, specifically change a file and run the checks`,
      repositoryAliases: ["core"],
      ...(writableRepo ? { writableRepository: "core" } : {}),
      constraints: { acceptanceCriteria: ["x"], ...(writableRepo ? { allowedPaths: [writableRepo] } : {}) },
    }),
  ]);
  const claimed = s.tasks.claim(`owner-${id}`, LIMITS).map((t) => t.row.id);
  expect(claimed).toContain(id);
  s.tasks.finish(id, `owner-${id}`, result, result.executionStatus === "completed" ? "completed" : "failed");
}

describe("offloadReport", () => {
  it("counts tasks by kind/outcome, commands run, model usage and channel activity exactly", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });

    submitAndFinish(sy, "t_met", done("t_met", { checks: [{ command: "pnpm test", exitCode: 0, logRef: "log:1" }] }));
    submitAndFinish(sy, "t_failed", { ...syntheticResult("t_failed", "failed", "broke"), acceptanceStatus: "unmet", checks: [{ command: "pnpm test", exitCode: 1, logRef: "log:2" }] });

    // A worker question, answered, on t_met.
    const store = new SupervisorChannelStore(sy.db);
    const { message: q } = store.post({ taskId: "t_met", direction: "worker_to_supervisor", kind: "question", body: "Should I touch the config too?" });
    store.answer(q.id, { kind: "answer", body: "No, leave it." });
    // A tool request, granted.
    const { message: tr } = store.post({ taskId: "t_met", direction: "worker_to_supervisor", kind: "tool_request", body: "need write", refs: toolRefs(["write_file"]) });
    store.answer(tr.id, { kind: "grant", body: "granted", refs: toolRefs(["write_file"]) });

    const report = await offloadReport(sy, {});

    expect(report.totalTasks).toBe(2);
    const outcomes = report.tasksByKindOutcome.map((r) => `${r.kind}:${r.acceptanceStatus}`).sort();
    expect(outcomes).toEqual(["inspect:met", "inspect:unmet"]);

    expect(report.commandsRun).toEqual({ total: 2, passed: 1, failed: 1, didNotFinish: 0, byTaskKind: [{ kind: "inspect", count: 2 }] });

    expect(report.modelUsage.modelRequests).toBe(3); // only t_met overrides usage; t_failed keeps the synthetic zero usage
    expect(report.modelUsage.inputTokens).toBe(1000);
    expect(report.modelUsage.tokenBasis).toBe("mixed"); // t_met: provider_reported, t_failed: unknown

    expect(report.channelActivity.questions).toBe(1);
    expect(report.channelActivity.toolRequests).toBe(1);
    expect(report.channelActivity.answeredCount).toBe(2);
    expect(report.channelActivity.medianAnswerLatencyMs).not.toBeNull();

    expect(report.acceptanceRate.firstAttempt).toEqual({ met: 1, total: 2 });
    expect(report.acceptanceRate.afterRework).toEqual({ met: 0, total: 0 });

    expect(report.contextCompression.bytesOfReportReturned).toBeGreaterThan(0);
    expect(report.contextCompression.tasksCounted).toBe(2);
    expect(report.estimates).toContain("acceptedLines.byModel[].classification");
  });

  it("attributes accepted changed lines to the commit's Model trailer, separates non-accepted and non-model commits, and counts rework as afterRework", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });

    const freeModel = "openrouter/vendor/big-a:free"; // matches the default fixture endpoint (free)
    submitAndFinish(sy, "t_accepted", done("t_accepted"), "accepted.txt");
    submitAndFinish(sy, "t_rejected", { ...syntheticResult("t_rejected", "completed", "done"), acceptanceStatus: "unmet" }, "rejected.txt");

    workerCommit("accepted.txt", "t_accepted", freeModel, 1_700_000_100);
    workerCommit("rejected.txt", "t_rejected", freeModel, 1_700_000_110);
    workerCommit("lead-note.txt", "", null, 1_700_000_120); // no Task trailer: an "other author" commit

    const report = await offloadReport(sy, {});
    const line = report.acceptedLines;
    expect(line.byModel.some((m) => m.model === freeModel && m.classification === "free" && m.added > 0)).toBe(true);
    expect(line.notAccepted.commits).toBeGreaterThanOrEqual(1);
    expect(line.otherAuthors.commits).toBeGreaterThanOrEqual(1);
  });

  it("counts a reworked task's final acceptance under afterRework, not firstAttempt", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    submitAndFinish(sy, "t_v1", { ...syntheticResult("t_v1", "completed", "done"), acceptanceStatus: "unmet" });
    submitAndFinish(sy, "t_v2", done("t_v2"));
    new SupervisorChannelStore(sy.db).recordRework({ taskId: "t_v2", reworkOf: "t_v1" });

    const report = await offloadReport(sy, {});
    expect(report.acceptanceRate.firstAttempt).toEqual({ met: 0, total: 0 });
    expect(report.acceptanceRate.afterRework).toEqual({ met: 1, total: 1 });
    expect(report.channelActivity.reworks).toBe(0); // recordRework alone posts no channel message
  });

  it("scopes to a named project and to given sessionTaskIds", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    submitAndFinish(sy, "t_a", done("t_a"));
    submitAndFinish(sy, "t_b", done("t_b"));
    const scoped = await offloadReport(sy, { sessionTaskIds: ["t_a"] });
    expect(scoped.totalTasks).toBe(1);
    const unscoped = await offloadReport(sy, {});
    expect(unscoped.totalTasks).toBe(2);
  });
});
