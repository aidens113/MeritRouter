import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { Worktrees } from "../src/workspaces/worktree.js";
import { git } from "../src/workspaces/git.js";
import { recoveredEditActor } from "../src/attribution/recovered-edit-provenance.js";
import { projectNativeWrite, projectNativeReplace } from "../src/attribution/native-edit-projection.js";
import type { ModelEndpoint } from "../src/models/catalog.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

it("matches native write and replacement newline/count semantics without interpreting replacement dollars", () => {
  expect(projectNativeWrite(null, "new\r\nfile\r\n")).toBe("new\nfile\n");
  expect(projectNativeWrite("old\r\nfile\r\n", "new\nfile\n")).toBe("new\r\nfile\r\n");
  expect(projectNativeReplace("a\r\na\r\n", "a\n", "$&\n", true)).toEqual({ content: "$&\r\n$&\r\n", count: 2 });
  expect(() => projectNativeReplace("aa", "a", "b", false)).toThrow("matches 2");
  expect(() => projectNativeReplace("aa", "z", "b", false)).toThrow("not found");
  expect(() => projectNativeReplace("aa", "", "b", true)).toThrow("required");
});

async function fixture(kind: "write" | "replace" | "delete" | "recipe" | "partial" | "pending", missingOutcome = true, linked = false, outcomeOk = true, large = false, bracket = false) {
  const basePath = bracket ? "src/[id].ts" : "src/app.ts";
  env = makeEnv(bracket ? { files: { "src/app.ts": "export function add() { return 1; }\n", "src/[id].ts": "export function add() { return 2; }\n" } } : {}); sy = open(env, new ScriptedClient(() => { throw Error("No provider allowed"); }));
  sy.tasks.submit([WorkerTaskSchema.parse({ id: "source", profile: "implement", goal: "Native recovery fixture", repositoryAliases: ["core"], writableRepository: "core", constraints: { allowedPaths: ["src/**"], acceptanceCriteria: ["fixture"] } })], { project: env.cfg.brain.project });
  const task = sy.tasks.claim("owner", { maxConcurrent: 1, maxWritersPerRepo: 1, leaseMs: 600000, defaultTimeoutMs: 600000 })[0]!;
  const ws = await new Worktrees(sy.db, path.join(env.cfg.storageDir, "worktrees")).prepare({ taskId: "source", run: 1, alias: "core", sourcePath: env.repo });
  const base = (await git(ws.worktreePath, ["rev-parse", "HEAD"])).trim(), originalText = readFileSync(path.join(ws.worktreePath, basePath), "utf8");
  const actor = { agent: "implementer:source", role: "implementer", task: "source", tier: "T2" };
  const session = sy.sessions.create({ taskId: "source", role: "implementer", agentLabel: actor.agent, profile: "implement", tier: "T2" });
  const workspace = { repos: [{ alias: "core", worktree: ws.worktreePath, baseCommit: base, head: base, branch: null }] };
  session.setWorkspace(workspace);
  const replacement = large ? `${"b".repeat(1100000)}\nexport function add` : "export function subtract(a: number, b: number) { return a - b; }\nexport function add";
  const patch = { path: basePath, old_text: "export function add", new_text: replacement, replace_all: false };
  const create = { path: "src/recovered.ts", content: large ? `${"a".repeat(1100000)}\n` : "export const recovered = true;\r\n" };
  const edits = [{ action: "create", ...create }, { action: "patch", ...patch, expected_sha256: createHash("sha256").update(originalText).digest("hex") }];
  const name = kind === "write" ? "write_file" : kind === "replace" ? "replace_in_file" : kind === "delete" ? "delete_file" : "apply_edits";
  const args = kind === "write" ? create : kind === "replace" ? patch : kind === "delete" ? { path: basePath } : { edits };
  const call = { id: "origin-edit", type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
  const executionId = sy.admission.createExecution("task", "implement", [{ taskId: "source", itemId: "source" }]);
  session.syncMessages([{ role: "user", content: "Original native goal" }]);
  session.modelRequest({ executionId, purpose: "coding", chat: { messages: [{ role: "user", content: "Original native goal" }], max_tokens: 1000 } });
  session.modelResponse({ requestId: "native-request", endpoint: { id: "fixture/original" } as ModelEndpoint, estimatedInputTokens: 10, attempts: [], response: reply(null, { model: "original", provider: "fixture", toolCalls: [call] }) });
  const parent = session.toolIntent({ callId: call.id, name, args, sideEffect: "edit" });
  if (kind === "recipe" || kind === "partial" || kind === "pending") {
    const first = session.toolIntent({ callId: `${session.id}:${call.id}:file:0`, name: "write_file", args: create, sideEffect: "edit" });
    writeFileSync(path.join(ws.worktreePath, create.path), create.content.replace(/\r\n/g, "\n"));
    session.toolOutcome(first, { ok: true, output: "wrote first file" });
    if (kind === "recipe" || kind === "pending") {
      const second = session.toolIntent({ callId: `${session.id}:${call.id}:file:1`, name: "replace_in_file", args: patch, sideEffect: "edit" });
      if (kind !== "pending") writeFileSync(path.join(ws.worktreePath, patch.path), originalText.replace("export function add", replacement));
      if (!missingOutcome) session.toolOutcome(second, { ok: true, output: "replaced second file" });
    }
    if (!missingOutcome) session.toolOutcome(parent, { ok: true, output: "recipe completed" });
  } else {
    if (kind === "write") writeFileSync(path.join(ws.worktreePath, create.path), create.content.replace(/\r\n/g, "\n"));
    if (kind === "replace") writeFileSync(path.join(ws.worktreePath, patch.path), originalText.replace("export function add", replacement));
    if (kind === "delete") rmSync(path.join(ws.worktreePath, basePath));
    if (!missingOutcome) session.toolOutcome(parent, { ok: outcomeOk, output: outcomeOk ? "native effect completed" : "native effect failed" });
  }
  sy.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,endpoint_id,served_model,served_provider,project_id) VALUES(?,?,'coding','fixture/original','succeeded',?,10,1000,'fixture/original','original','fixture',?)").run("native-request", executionId, Date.now(), task.row.project_id);
  sy.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,run_count,lease_incarnation) VALUES('native-request','source',10,20,1,?)").run(task.row.lease_incarnation);
  session.end("interrupted", "process_died");
  const current = linked ? sy.sessions.create({ taskId: "source", previousSessionId: session.id, role: "implementer", agentLabel: actor.agent, profile: "implement", tier: "T2" }) : sy.sessions.reopen(session.id);
  if (linked) current.setWorkspace(workspace);
  await git(ws.worktreePath, ["add", "-A"]);
  const input = { taskId: "source", sessionId: current.id, alias: "core", worktree: ws.worktreePath, actor };
  const ctx = { tasks: sy.tasks, cfg: env.cfg, now: Date.now };
  return { ws, session, current, ctx, input, base, task, parent };
}

it.each(["write", "replace", "delete", "recipe", "partial", "pending"] as const)("proves model-authored %s effects after interruption without inventing an outcome", async kind => {
  const f = await fixture(kind);
  const count = sy!.sessions.events(f.session.id, { limit: 10000 })!.events.filter(event => event.type === "tool_outcome").length;
  const result = await recoveredEditActor(f.ctx, f.input);
  expect(result.actor).toMatchObject({ model: "fixture/original", request: "native-request" });
  expect(result.head).toBe(f.base); expect(result.observedProjection?.files.length).toBe(kind === "recipe" ? 2 : 1);
  expect(sy!.sessions.events(f.session.id, { limit: 10000 })!.events.filter(event => event.type === "tool_outcome")).toHaveLength(count);
  expect((await git(f.ws.worktreePath, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
});

it("does not promote a recorded failed native edit to success from matching bytes", async () => {
  const f = await fixture("replace", false, false, false);
  await expect(recoveredEditActor(f.ctx, f.input)).rejects.toThrow(/failed/);
});

it("refuses an actor different from the original model-owned effect", async () => {
  const f = await fixture("replace");
  await expect(recoveredEditActor(f.ctx, { ...f.input, actor: { ...f.input.actor, agent: "forged" } })).rejects.toThrow(/actor/);
});

it("bounds the complete projected state when separate files each fit the per-file bound", async () => {
  const f = await fixture("recipe", true, false, true, true);
  await expect(recoveredEditActor(f.ctx, f.input)).rejects.toThrow(/cumulative byte bound/);
});

it("uses literal Git paths for bracketed dynamic route filenames", async () => {
  const f = await fixture("replace", true, false, true, false, true);
  const result = await recoveredEditActor(f.ctx, f.input);
  expect(result.observedProjection?.files.map(file => file.path)).toEqual(["src/[id].ts"]);
});

it("keeps interrupted original effects across a linked session's repeated same-HEAD pointer", async () => {
  const f = await fixture("replace", true, true);
  expect((await recoveredEditActor(f.ctx, f.input)).actor.request).toBe("native-request");
});

it.each(["bytes", "extra_path", "ledger", "child", "mode", "base"] as const)("refuses unproved native %s evidence", async variant => {
  const f = await fixture(variant === "child" ? "recipe" : "replace");
  if (variant === "bytes") writeFileSync(path.join(f.ws.worktreePath, "src/app.ts"), "forged native content");
  if (variant === "extra_path") writeFileSync(path.join(f.ws.worktreePath, "src/extra.ts"), "unproved");
  if (variant === "ledger") sy!.db.prepare("UPDATE model_requests SET served_model='other' WHERE id='native-request'").run();
  if (variant === "child") { const events = sy!.sessions.events(f.session.id, { limit: 10000 })!.events; const child = events.find(event => event.type === "tool_intent" && event.data.callId.endsWith(":file:1"))!; expect(child).toBeDefined(); /* original child/model binding stays immutable; add an unowned extra child below */ f.current.toolIntent({ callId: "forged:file:2", name: "write_file", args: { path: "src/forged.ts", content: "forged" }, sideEffect: "edit" }); }
  if (variant === "base") { sy!.db.prepare("UPDATE sessions SET workspace_json=NULL WHERE id=?").run(f.session.id); }
  await git(f.ws.worktreePath, ["add", "-A"]);
  if (variant === "mode") { const { execFileSync } = await import("node:child_process"); execFileSync("git", ["update-index", "--chmod=+x", "--", "src/app.ts"], { cwd: f.ws.worktreePath }); }
  await expect(recoveredEditActor(f.ctx, f.input)).rejects.toThrow();
});
