import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, linkSync, symlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { RepoReader, normalizeRelPath } from "../src/context/repo-reader.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import { harnessV2Tools } from "../src/harness/operation-dispatch.js";
import { executeOperation, operationStatus } from "../src/harness/operation-lifecycle.js";
import { operationRegistry } from "../src/harness/operation-registry.js";
import { FAULT_ENV, resetFaults } from "../src/core/faults.js";
import { runProcess, minimalEnv } from "../src/runners/coding/process.js";
const roots: string[] = [];
afterEach(() => {
  delete process.env[FAULT_ENV]; resetFaults(); for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "merit-harness-v2-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, "src/a.txt"), "first\r\nsecond\r\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const stored = new Map<string, Buffer>();
  let counter = 0;
  const events: Array<{
    type: string;
    [key: string]: unknown;
  }> = [];
  const env = {
    ctx: {
      taskId: "task", taskProject: "demo", signal: new AbortController().signal, now: Date.now, taskLease: { taskId: "task", owner: "worker", runCount: 1, incarnation: "a".repeat(32), project: "demo" }, tasks: { dispatchable: () => true, get: () => ({ row: { deadline_at: null } }) }, cfg: { configPath: path.join(root, "private.yaml"), brain: { project: "demo" } }, spec: { profile: "implement", context: {} }, session: { toolIntent: (value: Record<string, unknown>) => { events.push({ type: "intent", ...value }); return events.length; }, toolOutcome: (intent: number, value: Record<string, unknown>) => events.push({ type: "outcome", intent, ...value }) }, artifacts: {
        write: ({ content }: {
          content: string;
        }) => { const ref = `artifact:a${++counter}`; stored.set(ref, Buffer.from(content)); return ref; }, get: (ref: string) => stored.has(ref) ? { id: ref.slice(9), task_id: "task" } : undefined, readScoped: (ref: string) => ({ row: { id: ref.slice(9), task_id: "task" }, content: stored.get(ref)! })
      }
    }, role: "implementer", readers: new Map([["app", new RepoReader("app", root, null)]]), workspace: { alias: "app", root, allowedPaths: ["src/**"] }, universe: { refs: new Map() }, edits: new Set(), allowArtifacts: true
  } as unknown as HarnessEnv;
  const invoke = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await harnessV2Tools(env).find(tool => tool.def.function.name === name)!.run(args, env));
  return { root, env, invoke, events, stored };
}
describe("Harness v2 executable contract", () => {
  it("pages listings and literal search without omission", async () => {
    const { root, invoke } = fixture();
    for (let i = 0;i < 7;i++)
      writeFileSync(path.join(root, `src/page${i}.txt`), "match.literal\n");
    const paths: string[] = [], matches: string[] = [];
    for (let offset = 0;;) {
      const result = await invoke("list_paths", { limit: 3, offset });
      paths.push(...result.data.files);
      if (result.data.nextOffset === null)
        break;
      offset = result.data.nextOffset;
    }
    for (let offset = 0;;) {
      const result = await invoke("search_text", { pattern: "match.literal", limit: 2, offset });
      matches.push(...result.data.matches.map((m: {
        path: string;
      }) => m.path));
      if (result.data.nextOffset === null)
        break;
      offset = result.data.nextOffset;
    }
    expect(new Set(paths).size).toBe(8);
    expect(new Set(matches).size).toBe(7);
  });
  it("retains containment against hard links, junction parents and configuration writes", async () => {
    const { root, env, invoke } = fixture(), outside = mkdtempSync(path.join(tmpdir(), "merit-harness-outside-"));
    roots.push(outside);
    writeFileSync(path.join(outside, "secret"), "private");
    linkSync(path.join(outside, "secret"), path.join(root, "src/hard"));
    symlinkSync(outside, path.join(root, "src/junction"), "junction");
    env.ctx.cfg.configPath = path.join(root, "src/protected");
    for (const target of ["src/hard", "src/junction/secret", "src/protected", "../escape"]) {
      const result = await invoke("apply_edits", { edits: [{ action: "create", path: target, content: "must not write" }] });
      expect(result.status).toBe("failed");
    }
    expect(readFileSync(path.join(outside, "secret"), "utf8")).toBe("private");
  });
  it("stops a partially applied group when its captured lease is revoked", async () => {
    const { env, invoke } = fixture();
    let live = true;
    vi.spyOn(env.ctx.tasks, "dispatchable").mockImplementation(() => live ? {} as never : undefined);
    const add = env.edits.add.bind(env.edits);
    vi.spyOn(env.edits, "add").mockImplementation(value => { live = false; return add(value); });
    const result = await invoke("apply_edits", { edits: [{ action: "create", path: "src/one", content: "one" }, { action: "create", path: "src/two", content: "two" }] });
    expect(result.status).toBe("unknown_effect");
    expect(result.data.applied).toBe(1);
    live = true;
    expect((await invoke("list_paths")).data.files).not.toContain("src/two");
  });
  it("recovers settled and uncertain operation status from its own validated session notes", async () => {
    const { env, root, invoke } = fixture(), logPath = path.join(root, "session.jsonl");
    writeFileSync(logPath, "");
    let seq = 0;
    Object.assign(env.ctx.session!, { logPath, note: (text: string, data: unknown) => { appendFileSync(logPath, JSON.stringify({ seq: ++seq, at: Date.now(), type: "note", data: { text, data } }) + "\n"); return seq; } });
    const result = await invoke("list_paths");
    env.ctx.tasks = Object.assign(Object.create(Object.getPrototypeOf(env.ctx.tasks)),env.ctx.tasks);
    expect((await operationStatus(env, result.operationId)).status).toBe("succeeded");
    env.ctx.session!.note("fixture interrupted command", { kind: "harness_v2_operation", taskId: "task", operationId: "uncertain", sideEffect: "command" });
    expect((await operationStatus(env, "uncertain")).status).toBe("unknown_effect");
    expect((await operationStatus(env, "foreign")).status).toBe("unknown");
  });
  it("reads 50 files in one call and preserves 49 successes with one missing", async () => {
    const { root, invoke } = fixture(); for (let i = 0;i < 49;i++)
      writeFileSync(path.join(root, `src/${i}.txt`), `file ${i}`); const result = await invoke("read_files", { files: [...Array.from({ length: 49 }, (_, i) => `src/${i}.txt`), "missing"] }); expect(result.status).toBe("succeeded"); expect(result.data.filter((f: {
        status: string;
      }) => f.status === "succeeded")).toHaveLength(49); expect(result.data[49].status).toBe("failed");
  });
  it("normalizes directory roots and Windows separators without allowing file-target dot or escapes", async () => {
    const { invoke } = fixture(); for (const dir of ["", ".", "./", ".\\"]) {
      const result = await invoke("list_paths", { dir });
      expect(result.status).toBe("succeeded");
      expect(result.data.files).toContain("src/a.txt");
    } expect((await invoke("read_files", { files: ["src\\a.txt"] })).data[0].status).toBe("succeeded"); expect(() => normalizeRelPath(".")).toThrow(); expect((await invoke("list_paths", { dir: "../" })).status).toBe("failed");
  });
  it("refuses ambiguous implicit aliases and conflicting schema fields", async () => { const { env, invoke } = fixture(); env.workspace = undefined; env.readers.set("other", env.readers.get("app")!); expect((await invoke("read_files", { files: ["src/a.txt"] })).diagnostics[0]).toContain("Choose alias"); });
  it("preflights hashes across a group before any write; preserves CRLF and rejects omissions", async () => { const { root, invoke } = fixture(); const file = (await invoke("read_files", { files: ["src/a.txt"] })).data[0]; expect((await invoke("apply_edits", { edits: [{ action: "create", path: "src/new", content: "new" }, { action: "patch", path: "src/a.txt", expected_sha256: "0".repeat(64), old_text: "first", new_text: "changed" }] })).status).toBe("failed"); expect((await invoke("list_paths")).data.files).not.toContain("src/new"); expect((await invoke("apply_edits", { edits: [{ action: "replace", path: "src/a.txt", expected_sha256: file.sha256, whole_file: true, content: "// rest unchanged" }] })).status).toBe("failed"); expect((await invoke("apply_edits", { edits: [{ action: "patch", path: "src/a.txt", expected_sha256: file.sha256, old_text: "first\nsecond", new_text: "edited\nsecond" }] })).status).toBe("succeeded"); expect(readFileSync(path.join(root, "src/a.txt"), "utf8")).toBe("edited\r\nsecond\r\n"); });
  it("journals each batch child and blocks dependent effects after failure", async () => { const { invoke, events } = fixture(); const result = await invoke("batch", { items: [{ id: "bad", operation: "read_files", args: { alias: "unknown", files: ["src/a.txt"] } }, { id: "skip", operation: "apply_edits", depends_on: ["bad"], args: { edits: [{ action: "create", path: "src/new", content: "never" }] } }, { id: "good", operation: "list_paths", args: { dir: "." } }] }); expect(result.data[1].result.status).toBe("blocked"); expect(result.data[2].result.status).toBe("succeeded"); expect(events.filter(e => e.type === "intent")).toHaveLength(2); });
  it("keeps large output lossless via scoped pages", async () => {
    const { root, invoke, stored } = fixture(); writeFileSync(path.join(root, "src/large"), "abc😀".repeat(25000)); const result = await invoke("read_files", { files: ["src/large"] }); expect(result.data.artifact).toBeTruthy(); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32768); let reconstructed = "", offset = 0; for (;;) {
      const page = await invoke("read_output_page", { ref: result.data.artifact, offset, length: 2000 });
      reconstructed += page.data.text;
      if (page.data.nextOffset === null)
        break;
      offset = page.data.nextOffset;
    } expect(reconstructed).toBe(stored.get(result.data.artifact)!.toString("utf8"));
  });
  it("does not swallow simulated interruption or run later file effects", async () => { const { invoke, root } = fixture(); process.env[FAULT_ENV] = "after_tool_run:1:write_file"; await expect(invoke("apply_edits", { edits: [{ action: "create", path: "src/one", content: "one" }, { action: "create", path: "src/two", content: "two" }] })).rejects.toThrow("simulated crash"); expect(readFileSync(path.join(root, "src/one"), "utf8")).toBe("one"); expect((await invoke("list_paths")).data.files).not.toContain("src/two"); });
  it("waits for cancelled work to quiesce and prevents operations after lease loss", async () => { const { env } = fixture(); let stopped = false; const result = await executeOperation({ name: "slow", description: "fixture", args: z.object({ timeout_ms: z.number() }), sideEffect: "read", async run(_, child) { await new Promise<void>(resolve => child.ctx.signal.addEventListener("abort", () => setTimeout(() => { stopped = true; resolve(); }, 20), { once: true })); return "stopped"; } }, { timeout_ms: 5 }, env); expect(stopped).toBe(true); expect(result.status).toBe("timed_out"); vi.spyOn(env.ctx.tasks, "dispatchable").mockReturnValue(undefined); const reader = operationRegistry().find(op => op.name === "list_paths")!; expect((await executeOperation(reader, {}, env)).status).toBe("failed"); });
  it("kills a timed-out process before a delayed write", async () => { const { root } = fixture(), marker = path.join(root, "late"); const result = await runProcess(process.execPath, ["-e", `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1500)`], { cwd: root, env: minimalEnv({}), timeoutMs: 100 }); expect(result.killed).toBe("timeout"); await new Promise(resolve => setTimeout(resolve, 1600)); expect((await import("node:fs")).existsSync(marker)).toBe(false); }, 10000);
});
