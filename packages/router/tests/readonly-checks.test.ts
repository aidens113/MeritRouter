import { afterEach, describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/gateway/types.js";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, makeEnv, openWithTestSupervisor as open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
import { WORKER_CHECK_EVENT } from "../src/harness/tools.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;

afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const call = (name: string, args: unknown, id: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe("read-only declared checks", () => {
  it("runs only the declared command and accepts its output artifact as evidence", async () => {
    env = makeEnv();
    let artifactRef = "";
    const client: ScriptedClient = new ScriptedClient((req: ChatRequest) => {
      const s = servedFor(sy!, req);
      const tools = req.tools?.map(tool => tool.function.name) ?? [];
      expect(tools).toContain("run_check");
      const toolResults = req.messages.filter(message => message.role === "tool");
      if (toolResults.length === 0) {
        return reply(null, { ...s, toolCalls: [call("run_check", { command: "node --version && whoami" }, "denied")] });
      }
      if (toolResults.length === 1) {
        expect(String(toolResults[0]!.content)).toContain("not a declared check");
        return reply(null, { ...s, toolCalls: [call("run_check", { command: "node --version" }, "version")] });
      }
      if (toolResults.length === 2) {
        const output = String(toolResults[1]!.content);
        const match = /log (artifact:[A-Za-z0-9_-]+)/.exec(output);
        expect(match).not.toBeNull();
        artifactRef = `${match![1]}#L4`;
        expect(output).toMatch(/v\d+\.\d+\.\d+/);
        return reply(null, {
          ...s,
          toolCalls: [
            call("submit_result", {
              summary: "Reported the Node runtime version from the declared check.",
              findings: [{ description: "Node runtime version", evidenceRefs: [artifactRef] }],
              criteria: [{ index: 0, status: "met", evidenceRefs: [artifactRef] }],
            }, "submit"),
          ],
        });
      }
      throw new Error("unexpected model turn");
    });
    sy = open(env, client, { worker: true });
    const [submitted] = await sy.submitTasks([{
      profile: "inspect",
      goal: "Report the current Node runtime version.",
      repositoryAliases: ["core"],
      constraints: {
        checks: ["node --version"],
        acceptanceCriteria: ["Reports the Node runtime version using command output"],
      },
    }]);
    const result = (await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(result.executionStatus).toBe("completed");
    expect(result.verification?.checks.find(check => check.name === "declared_checks")?.outcome).toBe("passed");
    expect(result.verification?.checks.find(check => check.name === "evidence_provenance")?.outcome).toBe("passed");
    expect(result.findings[0]?.evidenceRefs).toEqual([artifactRef]);
    expect(client.requests).toHaveLength(3);
  }, 30_000);

  it("enforces bounded repeated checks rather than reusing a stale tool-loop cache", async () => {
    env = makeEnv({ config: baseConfig({ coding: { max_check_runs_per_task: 1 } }) });
    const client = new ScriptedClient((req: ChatRequest) => {
      const s = servedFor(sy!, req);
      return reply(null, {
        ...s,
        toolCalls: [call("run_check", { command: "node --version" }, `check-${req.messages.filter(message => message.role === "tool").length}`)],
      });
    });
    sy = open(env, client, { worker: true });
    const [submitted] = await sy.submitTasks([{
      profile: "inspect",
      goal: "Run the Node version check.",
      repositoryAliases: ["core"],
      constraints: {
        checks: ["node --version"],
        acceptanceCriteria: ["Reports the Node runtime version using command output"],
      },
    }]);
    const result = (await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    const runs = sy.tasks.events(submitted!.taskId, 1000).filter(event => event.type === WORKER_CHECK_EVENT);
    expect(result.stopReason).toBe("repeated_tool_call:run_check");
    expect(result.executionStatus).toBe("failed");
    expect(client.requests.length).toBeGreaterThanOrEqual(3);
    expect(runs).toHaveLength(1);
  }, 30_000);

  it("allows five explicit bounded check turns with fixture profile and tier caps", async () => {
    env = makeEnv();
    env.cfg.profiles.inspect!.max_model_requests = 8;
    env.cfg.tiers.T1.max_model_requests = 8;
    const first = "node --version";
    const second = `node -e "console.log('dependency state changed')"`;
    const client = new ScriptedClient((req: ChatRequest) => {
      const s = servedFor(sy!, req);
      const toolResults = req.messages.filter(message => message.role === "tool");
      const commands = [first, second, first, first, first];
      return reply(null, {
        ...s,
        toolCalls: [call("run_check", { command: commands[toolResults.length]! }, `check-${toolResults.length}`)],
      });
    });
    sy = open(env, client, { worker: true });
    const [submitted] = await sy.submitTasks([{
      profile: "inspect",
      goal: "Run declared commands while checking the environment.",
      repositoryAliases: ["core"],
      constraints: {
        checks: [first, second],
        acceptanceCriteria: ["Reports the environment check results"],
      },
      budget: { maxModelRequests: 6 },
    }]);
    const result = (await sy.awaitResults([submitted!.taskId], { timeoutSeconds: 30 })).completed[0]!;
    const runs = sy.tasks.events(submitted!.taskId, 1000)
      .filter(event => event.type === WORKER_CHECK_EVENT)
      .map(event => (event.data as { command: string }).command);
    expect(result.executionStatus).toBe("budget_exhausted");
    expect(result.checks).toHaveLength(5);
    expect(runs).toEqual([first, second, first, first, first]);
    expect(client.requests).toHaveLength(6);
  }, 30_000);

  it("preserves successful check evidence when terminal output is invalid", async () => {
    env = makeEnv();
    const client: ScriptedClient = new ScriptedClient(req => reply(null, { ...servedFor(sy!, req), toolCalls: [call(client.requests.length === 1 ? "run_check" : "submit_result", client.requests.length === 1 ? { command: "node --version" } : { summary: "invalid" }, `turn-${client.requests.length}`)] }));
    sy = open(env, client, { worker: true });
    const [task] = await sy.submitTasks([{ profile: "inspect", goal: "check", repositoryAliases: ["core"], constraints: { checks: ["node --version"], acceptanceCriteria: ["reports version"] } }]);
    const result = (await sy.awaitResults([task!.taskId], { timeoutSeconds: 20 })).completed[0]!;
    expect(result.executionStatus).toBe("failed");
    expect(result.stopReason).toBe("invalid_output");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.exitCode).toBe(0);
  }, 30_000);
});
