import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWindowsJobExecutable } from "../src/harness/windows-job-executable.js";

// The production helpers share one OS-temp cache per source; this suite compiles its own trivial
// source (unique per run) so pruning and tampering never touch a cache other test files rely on.
vi.mock("../src/harness/windows-command-job.js", () => ({ windowsCommandJobExecutable: () => Promise.reject(new Error("probe: helper cache refused")) }));
const { runCommandProcess } = await import("../src/harness/command-process.js");

const windows = process.platform === "win32";
const source = `// cache probe ${randomBytes(8).toString("hex")}\npublic static class MeritRouterCacheProbe { public static int Main() { return 7; } }\n`;
const root = path.join(tmpdir(), `meritrouter-command-job-${createHash("sha256").update(source).digest("hex").slice(0, 20)}`);
const executable = path.join(root, "job.exe"), manifest = path.join(root, "manifest.json");
const helper = createWindowsJobExecutable(source, "command");
const exitCode = (file: string) => new Promise<number | null>(resolve => execFile(file, [], { windowsHide: true }, error => resolve(error ? (error as { code?: number }).code ?? null : 0)));
const retained = (suffix: string) => readdirSync(root).filter(name => name.startsWith("unverified-") && name.endsWith(suffix));
const expectVerified = async (file: string) => {
  expect(file).toBe(executable);
  const record = JSON.parse(readFileSync(manifest, "utf8")) as { executable: string };
  expect(record.executable).toBe(createHash("sha256").update(readFileSync(executable)).digest("hex"));
  expect(await exitCode(file)).toBe(7);
};

describe.skipIf(!windows)("native helper cache in OS temp", () => {
  beforeAll(async () => { await expectVerified(await helper()); });
  afterAll(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it("reinstalls a cache pruned to its executable, retaining the unverified executable unexecuted", async () => {
    unlinkSync(manifest);
    await expectVerified(await helper());
    expect(retained("-job.exe")).toHaveLength(1);
  });

  it("reinstalls a cache pruned to its manifest", async () => {
    unlinkSync(executable);
    await expectVerified(await helper());
    expect(retained("-manifest.json").length).toBeGreaterThanOrEqual(1);
  });

  it("treats an interrupted (empty) manifest as an incomplete installation", async () => {
    writeFileSync(manifest, "");
    await expectVerified(await helper());
  });

  it("concurrent processes repairing the same pruned cache converge on one verified helper", async () => {
    unlinkSync(manifest);
    const other = createWindowsJobExecutable(source, "command");
    const [a, b] = await Promise.all([helper(), other()]);
    expect(b).toBe(a); await expectVerified(a);
    expect(existsSync(`${manifest}.lock`)).toBe(false);
  });

  it("still refuses an executable altered under an intact manifest, on every call", async () => {
    appendFileSync(executable, Buffer.from("altered"));
    const altered = readFileSync(executable);
    await expect(helper()).rejects.toThrow(/identity changed/);
    await expect(helper()).rejects.toThrow(/identity changed/);
    expect(readFileSync(executable).equals(altered)).toBe(true);
  });
});

describe.skipIf(!windows)("command helper initialization failure", () => {
  it("names the cause in the unsent command result instead of discarding it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-test-"));
    try {
      const id = `rc_${randomBytes(16).toString("hex")}`, nonce = randomBytes(32).toString("hex");
      const { result } = await runCommandProcess({ command: "echo never", cwd: dir, env: {}, timeoutMs: 5000 }, { id, nonce, proofPath: path.join(dir, "completion.json"), cancelPath: path.join(dir, "cancel") });
      expect(result).toMatchObject({ exitCode: null, killed: "containment_unavailable" });
      expect(result.stderr).toContain("probe: helper cache refused");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
