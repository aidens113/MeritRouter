import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeritRouter } from "../src/core/service.js";
import { createCodingRunner } from "../src/runners/coding/index.js";
import { baseConfig, goodOutput, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

const implementTask = {
  profile: "implement", goal: "Add subtract", repositoryAliases: ["core"], writableRepository: "core",
  hints: { difficulty: "T2" }, constraints: { acceptanceCriteria: ["subtract exists"], allowedPaths: ["src/**"], checks: ["node --version"] },
};

describe("external coding containment", () => {
  // The external command/opencode runner was removed (supervisor-offload): it can no longer be
  // configured, so no external process or model can ever be launched through it.
  it.each(["command", "opencode"] as const)("refuses a %s runner at config parse", runner => {
    expect(() => makeEnv({ config: baseConfig({ coding: { runner, command: "placeholder" } }) })).toThrow(/coding\.runner.*no longer supported.*native/s);
  });
});

describe("process quoting", () => {
  it("keeps arguments with spaces intact through the shell", async () => {
    env = makeEnv();
    const { runProcess, minimalEnv, quoteShellArg } = await import("../src/runners/coding/process.js");
    expect(quoteShellArg(`a "b"`, "win32")).toBe(`"a ""b"""`);
    expect(quoteShellArg("it's", "linux")).toBe("'it'\\''s'");
    const r = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "two words", "C:/dir with space/x"], { cwd: env.repo, env: minimalEnv({}), timeoutMs: 20_000, shell: true });
    expect(JSON.parse(r.stdout.trim())).toEqual(["two words", "C:/dir with space/x"]);
  });
});
