import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editTools, type HarnessEnv } from "../src/harness/tools.js";
import { editOperations } from "../src/harness/edit-operations.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(nestedWorkspace = false) {
  const temp = mkdtempSync(path.join(tmpdir(), "meritrouter-metadata-write-"));
  roots.push(temp);
  const root = nestedWorkspace ? path.join(temp, ".MeritRouter", "jobs", "job", "repositories", "app") : path.join(temp, "app");
  mkdirSync(root, { recursive: true });
  const env = {
    ctx: {
      cfg: { configPath: path.join(temp, "config.yaml") }, signal: new AbortController().signal,
      taskId: "task", taskLease: { taskId: "task", owner: "worker", runCount: 1, incarnation: "a".repeat(32), project: "demo" },
      tasks: { dispatchable: () => true }, session: null,
    },
    role: "implementer", readers: new Map(), universe: { refs: new Map() }, allowArtifacts: false,
    workspace: { alias: "app", root, allowedPaths: ["**/*"] }, edits: new Set(),
  } as unknown as HarnessEnv;
  const invoke = (name: string, args: Record<string, unknown>) => editTools().find(tool => tool.def.function.name === name)!.run(args, env);
  return { root, env, invoke };
}

const privatePaths = [
  ".MeritRouter/state.db", ".meritrouter/state.db", ".MERITROUTER/state.db", "nested/.mErItRoUtEr/state.db",
  "nested\\.MeritRouter\\state.db", ".MeritRouter./state.db", ".MeritRouter /state.db",
];

describe("repository mutation metadata boundary", () => {
  it.each(privatePaths)("refuses write/replace/delete through reserved path %s before effects", async privatePath => {
    const { root, env, invoke } = fixture();
    for (const name of ["write_file", "replace_in_file", "delete_file"]) {
      await expect(invoke(name, { path: privatePath, content: "bad", old_text: "private", new_text: "bad" })).rejects.toThrow();
    }
    expect(existsSync(path.join(root, ".MeritRouter"))).toBe(false);
    expect(existsSync(path.join(root, "nested"))).toBe(false);
    expect(env.edits.size).toBe(0);
  });

  it("preserves existing private contents for every legacy edit tool", async () => {
    const { root, invoke } = fixture();
    mkdirSync(path.join(root, ".MeritRouter"));
    const target = path.join(root, ".MeritRouter", "state.db");
    writeFileSync(target, "private");
    for (const name of ["write_file", "replace_in_file", "delete_file"]) {
      await expect(invoke(name, { path: ".MeritRouter/state.db", content: "bad", old_text: "private", new_text: "bad" })).rejects.toThrow(/Private MeritRouter metadata/);
      expect(readFileSync(target, "utf8")).toBe("private");
    }
  });

  it.each(["create", "replace", "patch", "delete"])("preflights whole batch before %s metadata mutation", async action => {
    const { root, env } = fixture();
    const operation = editOperations()[0]!;
    mkdirSync(path.join(root, ".MeritRouter"));
    const target = path.join(root, ".MeritRouter", "state.db");
    writeFileSync(target, "private");
    const metadataEdit = {
      action, path: action === "create" ? ".MeritRouter/new.db" : ".MeritRouter/state.db",
      content: "bad", expected_sha256: createHash("sha256").update("private").digest("hex"),
      old_text: "private", new_text: "bad", whole_file: true,
    };
    await expect(operation.run(operation.args.parse({ edits: [
      { action: "create", path: "src/new.ts", content: "safe but must not apply" }, metadataEdit,
    ] }), env)).rejects.toThrow(/Private MeritRouter metadata/);
    expect(existsSync(path.join(root, "src"))).toBe(false);
    expect(existsSync(path.join(root, ".MeritRouter", "new.db"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("private");
    expect(env.edits.size).toBe(0);
  });

  it("keeps ordinary source mutable even when workspace is beneath an ancestor metadata directory", async () => {
    const { root, env, invoke } = fixture(true);
    await invoke("write_file", { path: "src/app.ts", content: "before" });
    await invoke("replace_in_file", { path: "src/app.ts", old_text: "before", new_text: "after" });
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toBe("after");
    const operation = editOperations()[0]!;
    expect(await operation.run(operation.args.parse({ edits: [{ action: "create", path: "src/another.ts", content: "ordinary" }] }), env)).toMatchObject({ status: "succeeded", applied: 1 });
    await invoke("delete_file", { path: "src/app.ts" });
    expect(existsSync(path.join(root, "src", "app.ts"))).toBe(false);
  });

  it("retains physical alias protections for metadata hardlinks and directory junctions", async () => {
    const { root, invoke } = fixture();
    mkdirSync(path.join(root, ".MeritRouter"));
    const target = path.join(root, ".MeritRouter", "state.db");
    writeFileSync(target, "private");
    linkSync(target, path.join(root, "alias.db"));
    symlinkSync(path.join(root, ".MeritRouter"), path.join(root, "alias-dir"), process.platform === "win32" ? "junction" : "dir");
    await expect(invoke("write_file", { path: "alias.db", content: "bad" })).rejects.toThrow(/hard links/);
    await expect(invoke("write_file", { path: "alias-dir/state.db", content: "bad" })).rejects.toThrow(/linked parent/);
    expect(readFileSync(target, "utf8")).toBe("private");
  });
});
