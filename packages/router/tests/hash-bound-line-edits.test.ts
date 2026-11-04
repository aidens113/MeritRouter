import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { editOperations } from "../src/harness/edit-operations.js";
import { harnessV2Tools } from "../src/harness/operation-dispatch.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { RepoReader } from "../src/context/repo-reader.js";
import { NativeRecipeEditSchema, nativeRecipeOperation, projectNativeOperation, projectNativeReplaceLines } from "../src/attribution/native-edit-projection.js";
import { recoveredEditActor } from "../src/attribution/recovered-edit-provenance.js";
import { applyResume } from "../src/harness/resume.js";
import { FAULT_ENV, resetFaults } from "../src/core/faults.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import type { ModelEndpoint } from "../src/models/catalog.js";
import { makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

const fixtures: Env[] = []; let sy: MeritRouter | undefined;
afterEach(async () => { delete process.env[FAULT_ENV]; resetFaults(); await sy?.close(); sy = undefined; for (const f of fixtures.splice(0)) f.cleanup(); });
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const replacements = [{ start_line: 2, end_line: 3, new_lines: ["      let e1: AppError | undefined;", "      let e2: AppError | undefined;"] }];
const content = "// α\n      let e1: AppError;\n      let e2: AppError;\n// end\n";
function fixture(text = content) {
  const f = makeEnv({ files: { "src/a.ts": text } }); fixtures.push(f);
  const env = { ctx: { taskId: "task", taskProject: "demo", cfg: f.cfg, now: Date.now, spec: { context: {} }, signal: new AbortController().signal,
    taskLease: { taskId: "task", owner: "owner", runCount: 1, project: "demo", incarnation: "a".repeat(32) },
    tasks: { dispatchable: () => true }, session: null }, readers: new Map([["core", new RepoReader("core", f.repo, null)]]),
    workspace: { alias: "core", root: f.repo, allowedPaths: ["src/**"] }, edits: new Set(), universe: { refs: new Map() } } as unknown as HarnessEnv;
  const op = editOperations()[0]!;
  return { f, env, file: path.join(f.repo, "src/a.ts"), run: async (edits: unknown[]) => op.run(op.args.parse({ edits }), env) };
}
it.each(["\n", "\r\n"])("preserves %j and unicode while exact bad-indent patch fails and explicit multi-range edit succeeds", async newline => {
  const { file, run } = fixture(content.replace(/\n/g, newline));
  const original = readFileSync(file), expected_sha256 = hash(original);
  await expect(run([{ action: "patch", path: "src/a.ts", expected_sha256, old_text: "        let e1: AppError;\n        let e2: AppError;", new_text: "wrong" }])).rejects.toThrow("matches 0");
  expect(readFileSync(file)).toEqual(original);
  const edit = { action: "replace_lines", path: "src/a.ts", expected_sha256, replacements: [{ start_line: 1, end_line: 1, new_lines: ["// β", "// import"] }, ...replacements] };
  await run([edit]);
  const actual = readFileSync(file, "utf8");
  expect(actual).toBe(["// β", "// import", ...replacements[0]!.new_lines, "// end", ""].join(newline));
  expect(projectNativeOperation(original.toString("utf8"), nativeRecipeOperation(NativeRecipeEditSchema.parse(edit)))).toBe(actual);
  await expect(run([edit])).rejects.toThrow("revision conflict");
});

it("defines terminal empty records, no-final-newline files and explicit deletion without fuzzy matching", () => {
  expect(projectNativeReplaceLines("a\nb\n", [{ start_line: 2, end_line: 2, new_lines: [] }])).toBe("a\n");
  expect(projectNativeReplaceLines("a\nb\n", [{ start_line: 3, end_line: 3, new_lines: [] }])).toBe("a\nb");
  expect(projectNativeReplaceLines("a\nb", [{ start_line: 2, end_line: 2, new_lines: ["β", ""] }])).toBe("a\nβ\n");
  expect(projectNativeReplaceLines("", [{ start_line: 1, end_line: 1, new_lines: ["α"] }])).toBe("α");
  expect(projectNativeReplaceLines("a\r\nb\r\n", [{ start_line: 1, end_line: 3, new_lines: [] }])).toBe("");
});

it.each([
  [{ start_line: 0, end_line: 1, new_lines: ["bad"] }],
  [{ start_line: 1, end_line: 99, new_lines: [] }],
  [{ start_line: 3, end_line: 2, new_lines: [] }],
  [{ start_line: 1, end_line: 2, new_lines: [] }, { start_line: 2, end_line: 3, new_lines: [] }],
  [{ start_line: 3, end_line: 3, new_lines: [] }, { start_line: 1, end_line: 1, new_lines: [] }],
  [{ start_line: 1, end_line: 1, new_lines: ["two\nlines"] }],
].map(ranges => ({ ranges })))("rejects malformed, overlapping, reversed or out-of-bounds ranges before any group write ($ranges)", async ({ ranges }) => {
  const { f, file, run } = fixture(); const original = readFileSync(file);
  await expect(run([{ action: "create", path: "src/new.ts", content: "no" }, { action: "replace_lines", path: "src/a.ts", expected_sha256: hash(original), replacements: ranges }])).rejects.toThrow();
  expect(existsSync(path.join(f.repo, "src/new.ts"))).toBe(false); expect(readFileSync(file)).toEqual(original);
});

it("refuses duplicate file edits, stale source, path escape and lost authority before writes", async () => {
  const { f, env, file, run } = fixture(); const original = readFileSync(file);
  const edit = { action: "replace_lines", path: "src/a.ts", expected_sha256: hash(original), replacements };
  await expect(run([edit, edit])).rejects.toThrow("Duplicate edit target");
  await expect(run([{ ...edit, expected_sha256: "0".repeat(64) }])).rejects.toThrow("revision conflict");
  await expect(run([{ ...edit, path: "../outside" }])).rejects.toThrow();
  writeFileSync(file, "changed\n"); await expect(run([edit])).rejects.toThrow("revision conflict");
  writeFileSync(file, original); env.ctx.tasks.dispatchable = () => undefined;
  await expect(run([edit])).rejects.toThrow(/lease/);
  expect(readFileSync(file)).toEqual(original); expect(existsSync(path.join(f.repo, "src/new.ts"))).toBe(false);
});

it("advertises flat line-edit fields to clients that discard union branches", () => {
  const { env } = fixture();
  const tool = harnessV2Tools(env).find(t => t.def.function.name === "apply_edits")!;
  const schema = tool.def.function.parameters as { properties: { edits: { items: { properties: { action: { enum: string[] }; replacements: { items: { properties: Record<string, unknown> } } } } } } };
  expect(schema.properties.edits.items.properties.action.enum).toContain("replace_lines");
  expect(Object.keys(schema.properties.edits.items.properties.replacements.items.properties)).toEqual(["start_line", "end_line", "new_lines"]);
});

it("rechecks the same original raw hash under the acquired write capability", async () => {
  const { env, file, run } = fixture(); const original = readFileSync(file);
  let checks = 0;
  env.workspace!.guard = () => { if (++checks === 2) writeFileSync(file, "external change\n"); return null; };
  const result = await run([{ action: "replace_lines", path: "src/a.ts", expected_sha256: hash(original), replacements }]);
  expect(result).toMatchObject({ status: "partial", applied: 0 });
  expect(readFileSync(file, "utf8")).toBe("external change\n");
  expect(env.edits.size).toBe(0);
});

it.each(["normal", "tampered", "crash-resume"])("proves exact line-edit model authorship and guarded recovery (%s)", async mode => {
  const f = makeEnv({ files: { "src/a.ts": content } }); fixtures.push(f);
  sy = open(f, new ScriptedClient(() => { throw Error("No provider allowed"); }));
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "source", profile: "implement", goal: "Line edit recovery", repositoryAliases: ["core"], writableRepository: "core", constraints: { allowedPaths: ["src/**"], acceptanceCriteria: ["fixture"] } })], { project: f.cfg.brain.project });
  const task = sy.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 600000, defaultTimeoutMs: 600000 })[0]!;
  const ws = await new Worktrees(sy.db, path.join(f.cfg.storageDir, "worktrees")).prepare({ taskId: "source", run: 1, alias: "core", sourcePath: f.repo });
  const base = (await git(ws.worktreePath, ["rev-parse", "HEAD"])).trim();
  const file = path.join(ws.worktreePath, "src/a.ts"), previous = readFileSync(file, "utf8");
  const edit = { action: "replace_lines", path: "src/a.ts", expected_sha256: hash(previous), replacements };
  const args = { edits: [edit] }, actor = { agent: "implementer:source", role: "implementer", task: "source", tier: "T2" };
  const session = sy.sessions.create({ taskId: "source", role: "implementer", agentLabel: actor.agent, profile: "implement", tier: "T2" });
  session.setWorkspace({ repos: [{ alias: "core", worktree: ws.worktreePath, baseCommit: base, head: base, branch: null }] });
  const executionId = sy.admission.createExecution("task", "implement", [{ taskId: "source", itemId: "source" }]);
  const call = { id: "line-edit", type: "function" as const, function: { name: "apply_edits", arguments: JSON.stringify(args) } };
  session.syncMessages([{ role: "user", content: "Bounded model line edit" }]);
  session.modelRequest({ executionId, purpose: "coding", chat: { messages: [{ role: "user", content: "Bounded model line edit" }], max_tokens: 1000 } });
  session.modelResponse({ requestId: "line-request", endpoint: { id: "fixture/original" } as ModelEndpoint, estimatedInputTokens: 10, attempts: [], response: reply(null, { model: "original", provider: "fixture", toolCalls: [call] }) });
  session.toolIntent({ callId: call.id, name: "apply_edits", args, sideEffect: "edit" });
  const env = { ctx: { taskId: "source", cfg: f.cfg, tasks: sy.tasks, now: Date.now, signal: new AbortController().signal, spec: task.spec, session,
    taskLease: { taskId: "source", owner: "owner", runCount: task.row.run_count, incarnation: task.row.lease_incarnation, project: task.row.project_id } },
    readers: new Map([["core", new RepoReader("core", ws.worktreePath, null)]]), workspace: { alias: "core", root: ws.worktreePath, allowedPaths: ["src/**"] },
    edits: new Set(), universe: { refs: new Map() }, toolInvocationId: `${session.id}:${call.id}` } as unknown as HarnessEnv;
  const op = editOperations()[0]!;
  if (mode === "crash-resume") {
    process.env[FAULT_ENV] = "after_tool_run:1:replace_lines";
    await expect(op.run(op.args.parse(args), env)).rejects.toThrow("simulated crash");
    delete process.env[FAULT_ENV]; resetFaults();
  } else await op.run(op.args.parse(args), env);
  sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,endpoint_id,served_model,served_provider,project_id) VALUES(?,?,'coding','fixture/original','succeeded',?,10,1000,'fixture/original','original','fixture',?)").run("line-request", executionId, Date.now(), task.row.project_id);
  sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,run_count,lease_incarnation) VALUES('line-request','source',10,20,1,?)").run(task.row.lease_incarnation);
  session.end("interrupted", "process_died");
  const plan = sy.sessions.planResume(session.id)!;
  const current = sy.sessions.reopen(session.id);
  if (mode === "tampered") writeFileSync(file, "forged\n");
  await git(ws.worktreePath, ["add", "-A"]);
  const proof = recoveredEditActor({ tasks: sy.tasks, cfg: f.cfg, now: Date.now }, { taskId: "source", sessionId: current.id, alias: "core", worktree: ws.worktreePath, actor });
  if (mode === "tampered") await expect(proof).rejects.toThrow();
  else {
    expect((await proof).actor).toMatchObject({ request: "line-request", model: "fixture/original" });
    if (mode === "crash-resume") {
      expect(plan.actions.some(action => action.kind === "reconcile_edits")).toBe(true);
      env.ctx.session = current;
      const result = await applyResume({ env, messages: plan.messages, tools: harnessV2Tools(env), terminal: {
        def: { type: "function", function: { name: "submit", description: "finish", parameters: { type: "object" } } },
        accept: async () => ({ ok: true as const, value: "done" }),
      } }, { plan, actor, pointer: null });
      expect(result.kind).toBe("continue");
      expect((await git(ws.worktreePath, ["log", "-1", "--format=%B"]))).toContain("Model: fixture/original");
      expect((await git(ws.worktreePath, ["status", "--porcelain"]))).toBe("");
      expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toContain("let e1: AppError | undefined;");
    }
  }
});
