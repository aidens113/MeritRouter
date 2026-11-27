import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

const comparisonPath = new URL("../evals/offload/lib/comparison.mjs", import.meta.url).href;
const { claudeArguments, parseClaudeRun, fixtureDelta, git, summarizeComparison, summarizeLocalFixtures } = await import(comparisonPath);
const localPath = new URL("../evals/offload/lib/local-supervisor.mjs", import.meta.url).href;
const { localBrief, localModelSource } = await import(localPath);
const candidatePath = new URL("../evals/offload/lib/fixture-candidate.mjs", import.meta.url).href;
const { materializeWorkerCandidate, writeFixtureFiles } = await import(candidatePath);

describe("local-only offload smoke", () => {
  it("counts failures in the eight-task denominator and separates measured savings from coverage", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      task: String(index), pass: index < 5, requests: 2,
      attribution: { changedLines: 2 },
      baseline: { pass: index < 6, usage: { input: 100, output: 100 } },
      review: { usage: { input: 175, output: 25 } },
    }));
    const input = { rows, planned: 8, suiteSize: 8, model: "local", compare: true };
    expect(summarizeLocalFixtures(input)).toMatchObject({
      offloadShare: 0.625, taskTargetMet: true, workerChangedLines: 10,
      supervisorOutputTokenReduction: 0.75, supervisorTotalTokenReduction: 0,
      fallbackTokens: { input: 300, output: 300 }, estimatedOutputTokenReductionWithFallback: 0.375,
      estimatedTotalTokenReductionWithFallback: -0.375, supervisorProxyTargetMet: false,
    });
    expect(summarizeLocalFixtures({ ...input, rows: rows.map((row, index) => ({ ...row, pass: index < 6 })) }))
      .toMatchObject({ estimatedOutputTokenReductionWithFallback: 0.5, supervisorProxyTargetMet: true });
    expect(summarizeLocalFixtures({ ...input, rows: rows.slice(0, 5), planned: 5 })).toMatchObject({
      completeSuite: false, taskTargetMet: false, supervisorProxyTargetMet: false,
    });
    expect(summarizeLocalFixtures({ ...input, rows: [{ ...rows[0], review: null }, ...rows.slice(1)] })).toMatchObject({
      taskTargetMet: true, supervisorOutputTokenReduction: null, supervisorProxyTargetMet: false,
    });
  });

  it("turns an answer-file fixture into a read-only brief with an explicit budget", () => {
    expect(localBrief({ kind: "scout", goal: "Trace the fixture bug and report its exact output", contextFiles: ["src/money.ts"] }, 8))
      .toMatchObject({ kind: "scout", scope: { repository: "app", writable: false }, budget: { requests: 8 } });
    expect(() => localBrief({ kind: "implement" }, 8)).toThrow(/container grader/);
    expect(localBrief({
      kind: "implement", goal: "Add one bounded fixture feature", contextFiles: ["src/code.ts"], allowedPaths: ["src/code.ts"],
    }, 8, true)).toMatchObject({ kind: "edit", scope: { repository: "app", writable: true, allowedPaths: ["src/code.ts"] } });
  });

  it("copies only the allowed, attributed Git candidate into its disposable fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-local-candidate-"));
    try {
      git(dir, "init", "--quiet");
      git(dir, "config", "--local", "core.autocrlf", "false");
      const commit = (...args: string[]) => git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", ...args);
      const src = path.join(dir, "src", "code.ts");
      mkdirSync(path.dirname(src));
      writeFileSync(src, "export const a = 1;\n");
      git(dir, "add", "--all");
      commit("-m", "Base");
      const base = git(dir, "rev-parse", "HEAD").trim();
      writeFileSync(src, "export const a = 2;\n");
      git(dir, "add", "--all");
      commit("-m", "Worker change", "-m", "Task: fixture-task\nModel: ollama/model");
      const head = git(dir, "rev-parse", "HEAD").trim();
      const inputs = { base, head, taskId: "fixture-task", endpoint: "ollama/model", allowedPaths: ["src/code.ts"] };
      writeFileSync(src, "ungraded");
      expect(() => materializeWorkerCandidate(dir, { ...inputs, allowedPaths: [] })).toThrow(/outside the fixture brief/);
      expect(() => materializeWorkerCandidate(dir, { ...inputs, endpoint: "ollama/other" })).toThrow(/attribution/);
      expect(() => writeFixtureFiles(dir, ["../escape.ts"], [{ path: "../escape.ts", content: "" }])).toThrow(/invalid/);
      expect(readFileSync(src, "utf8")).toBe("ungraded");
      expect(materializeWorkerCandidate(dir, inputs)).toEqual({ head, files: ["src/code.ts"], changedLines: 2 });
      expect(readFileSync(src, "utf8")).toBe("export const a = 2;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a loopback singleton with downloaded weights and rejects hosted aliases", async () => {
    let models: unknown[] = [{ name: "fixture:8b", size: 2_000_000 }];
    const server = createServer((_req, res) => res.end(JSON.stringify({ models })));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind to TCP");
      const url = `http://127.0.0.1:${address.port}`;
      await expect(localModelSource(url, "fixture:8b")).resolves.toEqual({ url, model: "fixture:8b" });
      await expect(localModelSource("https://example.invalid:1234", "fixture:8b")).rejects.toThrow(/127.0.0.1/);
      models = [{ name: "fixture:8b", size: 2_000_000, remote_host: "example.invalid" }];
      await expect(localModelSource(url, "fixture:8b")).rejects.toThrow(/downloaded local model/);
      models = [{ name: "fixture:cloud", size: 2_000_000 }];
      await expect(localModelSource(url, "fixture:cloud")).rejects.toThrow(/downloaded local model/);
      models = [{ name: "fixture:8b", size: 2_000_000 }, { name: "extra:8b", size: 2_000_000 }];
      await expect(localModelSource(url, "fixture:8b")).rejects.toThrow(/one downloaded/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function claudeStream(mcpServers: unknown[], outputTokens = 100) {
  return {
    status: 0,
    stdout: [
      { type: "system", subtype: "init", model: "fixture-model", mcp_servers: mcpServers },
      {
        type: "assistant", message: { content: [
          { type: "tool_use", id: "a", name: "Bash", input: { command: "git log --all" } },
          { type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } },
          { type: "tool_use", id: "c", name: "mcp__meritrouter__delegate" },
        ] },
      },
      { type: "result", subtype: "success", is_error: false, usage: { output_tokens: outputTokens }, total_cost_usd: 0.01 },
    ].map((event) => JSON.stringify(event)).join("\n"),
  };
}

describe("supervisor offload benchmark evidence", () => {
  const server = { name: "meritrouter", status: "connected" };

  it("isolates MCP configuration and distinguishes direct checks from terminal coordination", () => {
    const raw = { prompt: "Find and record the relevant source file", kind: "scout", contextFiles: ["src/money.ts"] };
    for (const arm of ["baseline", "offload"]) {
      const args = claudeArguments({ mcpConfig: `${arm}.json`, arm, raw, model: "fixture-model", cost: 0.5 });
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain(`${arm}.json`);
      expect(args).toContain("--max-budget-usd");
    }
    expect(parseClaudeRun(claudeStream([server]), "baseline")).toMatchObject({ valid: false });
    expect(parseClaudeRun(claudeStream([]), "offload")).toMatchObject({ valid: false });
    expect(parseClaudeRun(claudeStream([server], 0), "offload")).toMatchObject({ valid: false });
    expect(parseClaudeRun(claudeStream([server]), "offload"))
      .toMatchObject({ valid: true, bashCalls: 2, localCheckCalls: 1, delegateCalls: 1 });
  });

  it("counts only in-scope net file changes matching an accepted worker commit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-eval-attribution-"));
    try {
      const file = path.join(dir, "code.txt");
      const commit = (...message: string[]) => git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", ...message);
      git(dir, "init", "--quiet");
      writeFileSync(file, "before\n");
      git(dir, "add", "--all");
      commit("-m", "Fixture base");
      const base = git(dir, "rev-parse", "HEAD").trim();
      writeFileSync(file, "worker\n");
      git(dir, "add", "--all");
      commit("-m", "Worker edit", "-m", "Task: fixture-task");
      expect(fixtureDelta(dir, base, ["code.txt"], ["fixture-task"]))
        .toEqual({ changedLines: 2, workerLines: 2, outOfScope: [] });
      expect(fixtureDelta(dir, base, ["code.txt"], ["other-task"]).workerLines).toBe(0);
      writeFileSync(file, "worker\nsupervisor\n");
      writeFileSync(path.join(dir, "extra.txt"), "out of scope\n");
      expect(fixtureDelta(dir, base, ["code.txt"], ["fixture-task"]))
        .toEqual({ changedLines: 3, workerLines: 0, outOfScope: ["extra.txt"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires a complete paired suite, evidence of offload, quality, and token reduction", () => {
    const base = parseClaudeRun(claudeStream([]), "baseline");
    const offload = parseClaudeRun(claudeStream([server], 50), "offload");
    const rows = Array.from({ length: 8 }, (_, index) => [
      { task: String(index), kind: "edit", arm: "baseline", pass: true, claude: base },
      {
        task: String(index), kind: "edit", arm: "offload", pass: true, claude: offload,
        worker: { acceptedIds: [`worker-${index}`], acceptedChecks: 2, requests: 4 },
        delta: { changedLines: 3, workerLines: 2 },
      },
    ]).flat();
    expect(summarizeComparison(rows, 8)).toMatchObject({
      accepted: true, offloadedTaskShare: 1, workerLineShare: 2 / 3, workerCheckShare: 2 / 3,
      supervisorOutputTokenReduction: 0.5, workerRequests: 32,
    });
    const incomplete = rows.slice(0, -2);
    expect(summarizeComparison(incomplete, 8)).toMatchObject({ accepted: false, fullSuite: false });
    const missingEvidence = rows.map((row) => row.arm === "offload" ? { ...row, worker: null } : row);
    expect(summarizeComparison(missingEvidence, 8)).toMatchObject({ accepted: false, offloadedTaskShare: 0 });
  });
});
