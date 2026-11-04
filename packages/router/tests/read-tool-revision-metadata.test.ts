import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { RepoReader } from "../src/context/repo-reader.js";
import { repoTools, type HarnessEnv } from "../src/harness/tools.js";
import { editOperations } from "../src/harness/edit-operations.js";
import { makeEnv, type Env } from "./helpers.js";

const fixtures: Env[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const source = makeEnv({ files: { "src/a.txt": "first\r\nsecond\r\n" } });
  fixtures.push(source);
  const env = {
    ctx: { taskId: "task", taskProject: "demo", signal: new AbortController().signal,
      now: Date.now, taskLease: { taskId: "task", owner: "worker", runCount: 1, incarnation: "a".repeat(32), project: "demo" },
      tasks: { dispatchable: () => true, get: () => ({ row: { deadline_at: null } }) },
      cfg: source.cfg, spec: { profile: "implement", context: {} },
      session: { toolIntent: () => 1, toolOutcome: () => undefined } },
    role: "implementer", readers: new Map([["core", new RepoReader("core", source.repo, null)]]),
    workspace: { alias: "core", root: source.repo, allowedPaths: ["src/**"] },
    universe: { refs: new Map() }, edits: new Set(), allowArtifacts: true,
  } as unknown as HarnessEnv;
  const read = (args: Record<string, unknown> = {}) => repoTools([...env.readers.keys()]).find(t => t.def.function.name === "read_file")!.run({ alias: "core", path: "src/a.txt", ...args }, env);
  const edit = async (args: unknown) => { const op = editOperations()[0]!; return op.run(op.args.parse(args), env); };
  return { source, env, read, edit };
}

it("exposes the full raw CRLF hash for full, ranged and capped legacy reads", async () => {
  const { source, read } = fixture();
  const file = path.join(source.repo, "src/a.txt"), expected = hash(readFileSync(file));
  expect(expected).not.toBe(hash(Buffer.from("first\nsecond\n")));
  expect(await read()).toContain(`sha256: ${expected} (entire original file bytes)`);
  const ranged = await read({ start_line: 2, end_line: 2 });
  expect(ranged).toContain("ref: core:src/a.txt#L2-L2");
  expect(ranged).toContain(`sha256: ${expected}`);
  writeFileSync(file, "large\r\n".repeat(10000));
  const capped = await read();
  expect(capped).toContain(`sha256: ${hash(readFileSync(file))}`);
  expect(capped).toContain("[truncated; narrow the request]");
});

it("requires fresh raw hashes after actual edits and preserves stale/malformed refusal", async () => {
  const { source, read, edit } = fixture();
  const file = path.join(source.repo, "src/a.txt"), original = hash(readFileSync(file));
  const patch = (expected_sha256: string, old_text: string, new_text: string) => ({ edits: [{ action: "patch", path: "src/a.txt", expected_sha256, old_text, new_text }] });
  await edit(patch(original, "first\nsecond", "edited\nsecond"));
  expect(readFileSync(file, "utf8")).toBe("edited\r\nsecond\r\n");
  const fresh = hash(readFileSync(file));
  expect(fresh).not.toBe(original);
  expect(await read()).toContain(`sha256: ${fresh}`);
  const before = readFileSync(file);
  await expect(edit(patch(original, "edited", "wrong"))).rejects.toThrow("revision conflict");
  await expect(edit({ edits: [JSON.stringify(patch(fresh, "edited", "wrong").edits[0])] })).rejects.toThrow();
  expect(readFileSync(file)).toEqual(before);
  await edit(patch(fresh, "edited", "fresh"));
  expect(readFileSync(file, "utf8")).toBe("fresh\r\nsecond\r\n");
});

it("binds hashes to explicit aliases and retains pinned snapshot revisions", async () => {
  const { source, env, read } = fixture();
  const other = makeEnv({ files: { "src/a.txt": "other\n" } }); fixtures.push(other);
  env.readers.set("other", new RepoReader("other", other.repo, null));
  expect(await read({ alias: "other" })).toContain(`sha256: ${hash(readFileSync(path.join(other.repo, "src/a.txt")))}`);
  await expect(read({ alias: "unknown" })).rejects.toThrow("unknown alias");
  await expect(read({ path: "../outside" })).rejects.toThrow();
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.repo, encoding: "utf8" }).trim();
  const original = execFileSync("git", ["show", `${revision}:src/a.txt`], { cwd: source.repo });
  env.readers.set("core", new RepoReader("core", source.repo, revision));
  writeFileSync(path.join(source.repo, "src/a.txt"), "changed working tree\n");
  const pinned = await read();
  expect(pinned).toContain(`revision: ${revision}`);
  expect(pinned).toContain(`sha256: ${hash(original)}`);
  expect(pinned).not.toContain("changed working tree");
});
