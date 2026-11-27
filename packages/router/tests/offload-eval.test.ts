import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const comparisonPath = new URL("../evals/offload/lib/comparison.mjs", import.meta.url).href;
const { claudeArguments, parseClaudeRun, fixtureDelta, git, summarizeComparison } = await import(comparisonPath);

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
