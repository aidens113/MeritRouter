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
  it.each(["command", "opencode"] as const)("refuses %s workers under every host policy without launching processes or models", async runner => {
    for (const outside_repository of ["disabled", "human_only", "supervisor"]) {
      env = makeEnv({ config: baseConfig({ coding: { runner, command: "placeholder" }, security: { outside_repository } }) });
      const marker = path.join(env.dir, "external-process-started");
      const script = path.join(env.dir, "forbidden-agent.cjs");
      writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
      env.cfg.coding.command = `"${process.execPath}" "${script}"`;
      const before = readFileSync(path.join(env.repo, "src/app.ts"), "utf8");
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo }).toString().trim();
      const client = new ScriptedClient(() => reply(JSON.stringify(goodOutput())));
      sy = open(env, client, { worker: true, coding: createCodingRunner(env.cfg) });
      const [submitted] = await sy.submitTasks([implementTask]);
      const result = (await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 15 })).completed[0]!;
      expect(result).toMatchObject({ executionStatus: "failed", acceptanceStatus: "not_verified", stopReason: "worker_sandbox_unavailable", patchRefs: [], checks: [] });
      expect(result.usage.modelRequests).toBe(0);
      expect(client.requests).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(path.join(env.repo, "src/app.ts"), "utf8")).toBe(before);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.repo }).toString().trim()).toBe(head);
      expect(sy.db.prepare("SELECT task_id FROM workspaces WHERE task_id=?").get(submitted!.taskId)).toBeUndefined();
      await sy.close(); sy = undefined; env.cleanup(); env = undefined;
    }
  }, 30000);
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
