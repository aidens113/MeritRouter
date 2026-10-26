import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyResume } from "../src/harness/resume.js";
import { evidenceUniverse } from "../src/core/worker-output.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { capturedLease } from "../src/storage/task-leases.js";
import { WorkspacePointer } from "../src/runners/session-workspace.js";
import { NativeCodingRunner } from "../src/runners/coding/native.js";
import { finishCoding, resumeWorkspace } from "../src/runners/coding/finish.js";
import { SupervisorRunner } from "../src/runners/supervisor.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import * as gitModule from "../src/workspaces/git.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";
import type { RunContext } from "../src/runners/types.js";
import type { ResumePlan } from "../src/sessions/resume.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { MeritRouter } from "../src/core/service.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let environment: Env | undefined, router: MeritRouter | undefined;
afterEach(async () => { vi.restoreAllMocks(); await router?.close(); router = undefined; environment?.cleanup(); environment = undefined; });
const actor = { agent: "worker:resume", role: "implementer" };
async function fixture(policy: "commit" | "reset" = "commit") {
  environment = makeEnv(); const client = new ScriptedClient(() => reply("must not call provider")); router = open(environment, client);
  router.tasks.submit([WorkerTaskSchema.parse({ id: "fixture", profile: "implement", goal: "recover fixture", repositoryAliases: ["core"], writableRepository: "core", constraints: { acceptanceCriteria: ["checked"], allowedPaths: ["**"] } })], { project: environment.cfg.brain.project });
  const task = router.tasks.claim("fixture-owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 600000, defaultTimeoutMs: 600000 })[0]!;
  const worktrees = new Worktrees(router.db, path.join(environment.cfg.storageDir, "worktrees"));
  const ws = await worktrees.prepare({ taskId: task.row.id, run: task.row.run_count, alias: "core", sourcePath: environment.repo });
  worktrees.setStatus(task.row.id, "collected");
  const head = (await git(ws.worktreePath, ["rev-parse", "HEAD"])).trim();
  const rec = router.sessions.create({ taskId: task.row.id, role: "implementer", agentLabel: "fixture" });
  const workspace = { repos: [{ alias: "core", worktree: ws.worktreePath, branch: null, baseCommit: ws.baseSha, head }] };
  const args = { path: "src/app.ts", content: "interrupted edit" }, call = { id: "edit", type: "function" as const, function: { name: "write_file", arguments: JSON.stringify(args) } };
  const messages = [{ role: "system" as const, content: "fixture" }, { role: "user" as const, content: "recover" }, { role: "assistant" as const, content: null, tool_calls: [call] }, { role: "tool" as const, tool_call_id: "edit", content: "interrupted; recovering" }];
  rec.syncMessages(messages); rec.setWorkspace(workspace);
  const intentSeq = rec.toolIntent({ callId: "edit", name: "write_file", args, sideEffect: "edit" });
  const plan: ResumePlan = { messages, actions: [{ kind: "reconcile_edits", policy, repos: workspace.repos, calls: [{ intentSeq, callId: "edit", name: "write_file", args, messageIndex: 3 }], completedCallIds: [] }], summary: "resume fixture", resolvedIntentSeqs: [intentSeq], droppedRequestSeqs: [], workspace, reason: "interrupted", lastEndpointId: null, warnings: [], notAppliedCandidateIntents: [intentSeq] };
  const pointer = new WorkspacePointer(rec, workspace.repos);
  const ctx = { cfg: environment.cfg, taskId: task.row.id, spec: task.spec, tasks: router.tasks, taskLease: capturedLease(task), claimedRunCount: task.row.run_count, taskProject: task.row.project_id, signal: new AbortController().signal, session: rec, attempts: [], now: Date.now, resume: { plan } } as unknown as RunContext;
  const env: HarnessEnv = { ctx, role: "implementer", readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, workspace: { alias: "core", root: ws.worktreePath, allowedPaths: ["**"] }, edits: new Set() };
  const terminal = { def: { type: "function" as const, function: { name: "submit_result", description: "fixture", parameters: { type: "object" } } }, accept: async () => ({ ok: false as const, errors: ["not submitted"] }) };
  return { client, ctx, env, ws, worktrees, rec, plan, pointer, terminal, head };
}
async function pending(root: string) {
  writeFileSync(path.join(root, "pending.txt"), "published source awaiting index");
  const result = await commitSelectedApplication(root, { actor, message: "pending", paths: ["pending.txt"] }, { refPublished: async () => { throw new Error("retain pending"); } });
  if (result.kind !== "reconciliation_required") throw new Error("Expected actual post-ref fixture");
  return readCommitReceipt(root, result.receiptId);
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>, receipt?: Awaited<ReturnType<typeof pending>>) {
  const indexPath = path.resolve(f.ws.worktreePath, (await git(f.ws.worktreePath, ["rev-parse", "--git-path", "index"])).trim());
  return { head: await git(f.ws.worktreePath, ["rev-parse", "HEAD"]), index: readFileSync(indexPath), source: readFileSync(path.join(f.ws.worktreePath, "src/app.ts")),
    workspace: router!.db.prepare("SELECT * FROM workspaces WHERE task_id='fixture'").get(), messages: JSON.stringify(f.plan.messages), seq: f.rec.lastSeq,
    events: router!.sessions.events(f.rec.id, { limit: 10000 })!.events,
    ...(receipt ? { receipt: readFileSync(path.join(receipt.directory, "receipt.json")), original: readFileSync(path.join(receipt.directory, "original.index")), next: readFileSync(path.join(receipt.directory, "next.index")) } : {}) };
}
const resume = (f: Awaited<ReturnType<typeof fixture>>) => applyResume({ env: f.env, messages: f.plan.messages, tools: [], terminal: f.terminal }, { plan: f.plan, actor, pointer: f.pointer });

describe("pending-publication resume and runner boundaries", () => {
  it.each(["commit", "reset"] as const)("refuses %s reconciliation before source, pointer, status or absence-proof writes", async policy => {
    const f = await fixture(policy), receipt = await pending(f.ws.worktreePath), before = await snapshot(f, receipt);
    await expect(resume(f)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(await snapshot(f, receipt)).toEqual(before); expect(f.client.requests).toHaveLength(0);
  });

  it("refuses retained native reuse before ready status or a new session pointer", async () => {
    const f = await fixture(), receipt = await pending(f.ws.worktreePath), before = await snapshot(f, receipt);
    await expect(resumeWorkspace(f.ctx, f.plan.workspace)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    await expect(new NativeCodingRunner().run(f.ctx)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(await snapshot(f, receipt)).toEqual(before); expect(f.client.requests).toHaveLength(0);
  });

  it("refuses supervisor retained reuse before branch, pointer or provider effects", async () => {
    const f = await fixture(), receipt = await pending(f.ws.worktreePath), before = await snapshot(f, receipt), refs = await git(environment!.repo, ["show-ref"]);
    await expect(new SupervisorRunner().run(f.ctx)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(await snapshot(f, receipt)).toEqual(before); expect(await git(environment!.repo, ["show-ref"])).toBe(refs); expect(f.client.requests).toHaveLength(0);
  });

  it("refuses final collection before collected status, evidence or pointer changes", async () => {
    const f = await fixture(), receipt = await pending(f.ws.worktreePath), before = await snapshot(f, receipt), collect = vi.spyOn(f.worktrees, "collect");
    await expect(finishCoding(f.ctx, { ws: f.ws, worktrees: f.worktrees, executionId: "fixture", findings: [], artifactRefs: [], stopReason: "fixture", state: "completed", summaryLead: "" })).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(collect).not.toHaveBeenCalled(); expect(await snapshot(f, receipt)).toEqual(before);
  });

  it("checks an orphaned supervisor worktree before reuse even without a saved pointer", async () => {
    const f = await fixture(), branch = `${f.ctx.cfg.supervisor.branch_prefix}${f.ctx.taskId}`;
    await git(f.ws.worktreePath, ["switch", "-c", branch]);
    const retained = path.join(f.ctx.cfg.storageDir, "worktrees", `job-${f.ctx.taskId}-core`);
    await git(environment!.repo, ["worktree", "move", f.ws.worktreePath, retained]);
    f.ws.worktreePath = retained;
    f.plan.workspace = { repos: [] };
    const receipt = await pending(retained), before = await snapshot(f, receipt), refs = await git(environment!.repo, ["show-ref"]);
    await expect(new SupervisorRunner().run(f.ctx)).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(await snapshot(f, receipt)).toEqual(before); expect(await git(environment!.repo, ["show-ref"])).toBe(refs); expect(f.client.requests).toHaveLength(0);
  });

  it("commits ordinary recovered edits and records their true new head", async () => {
    const f = await fixture(); writeFileSync(path.join(f.ws.worktreePath, "src/app.ts"), "export const recovered = true;\n");
    const out = await resume(f); expect(out.kind).toBe("continue");
    if (out.kind === "continue") expect(out.notAppliedToolIndexes.size).toBe(0);
    const head = (await git(f.ws.worktreePath, ["rev-parse", "HEAD"])).trim(); expect(head).not.toBe(f.head);
    expect((await git(f.ws.worktreePath, ["log", "-1", "--format=%s"]))).toContain("recovered edits");
    const events = router!.sessions.events(f.rec.id, { limit: 10000 })!.events;
    expect(events.filter(event => event.type === "workspace").at(-1)).toMatchObject({ data: { repos: [{ alias: "core", head }] } });
    expect(events.some(event => event.type === "resumed")).toBe(true);
  });

  it("resets only actual uncommitted edits without manufacturing a never-applied proof", async () => {
    const f = await fixture("reset"), initial = readFileSync(path.join(f.ws.worktreePath, "src/app.ts"));
    writeFileSync(path.join(f.ws.worktreePath, "src/app.ts"), "changed\n");
    const out = await resume(f); expect(out.kind).toBe("continue");
    if (out.kind === "continue") expect(out.notAppliedToolIndexes.size).toBe(0);
    expect(readFileSync(path.join(f.ws.worktreePath, "src/app.ts"))).toEqual(initial);
    expect((await git(f.ws.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(f.head); expect(await git(f.ws.worktreePath, ["status", "--porcelain"])).toBe("");
  });

  it("retains exact not-applied proof only for a verified unchanged workspace", async () => {
    const f = await fixture(); const out = await resume(f); expect(out.kind).toBe("continue");
    if (out.kind === "continue") expect([...out.notAppliedToolIndexes]).toEqual([3]);
    expect(router!.sessions.events(f.rec.id, { limit: 10000 })!.events.at(-1)).toMatchObject({ type: "resumed", data: { notAppliedTools: [{ messageIndex: 3 }] } });
  });

  it("does not turn an invalid recorded baseline into unchanged prose or an advanced pointer", async () => {
    const f = await fixture(); f.plan.actions[0] = { ...f.plan.actions[0]!, repos: [{ ...f.plan.workspace!.repos[0]!, head: "0".repeat(40) }] } as typeof f.plan.actions[0];
    writeFileSync(path.join(f.ws.worktreePath, "src/app.ts"), "must remain uncommitted\n"); const before = await snapshot(f);
    await expect(resume(f)).rejects.toThrow(); expect(await snapshot(f)).toEqual(before);
  });

  it("surfaces an actual interrupted sequencer abort failure before staging or proof recording", async () => {
    const f = await fixture(); writeFileSync(path.join(f.ws.worktreePath, "src/app.ts"), "committed change\n");
    await git(f.ws.worktreePath, ["add", "src/app.ts"]); await git(f.ws.worktreePath, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "change"]);
    await git(f.ws.worktreePath, ["revert", "--no-commit", "HEAD"]);
    const marker = path.resolve(f.ws.worktreePath, (await git(f.ws.worktreePath, ["rev-parse", "--git-path", "REVERT_HEAD"])).trim()); expect(existsSync(marker)).toBe(true);
    const before = await snapshot(f), original = gitModule.git;
    vi.spyOn(gitModule, "git").mockImplementation((repo, args, opts) => args[0] === "revert" && args[1] === "--abort" ? Promise.reject(new Error("fixture abort failure")) : original(repo, args, opts));
    await expect(resume(f)).rejects.toThrow("fixture abort failure"); expect(await snapshot(f)).toEqual(before); expect(existsSync(marker)).toBe(true);
  });
});
