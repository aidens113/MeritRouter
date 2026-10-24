import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serveHttp } from "../../mcp/http.js";
import { AdmissionDenied } from "../../core/errors.js";
import { declaredCheckTool, availableTools, type HarnessEnv, type HarnessTool } from "../../harness/tools.js";
import { requestBudgetTool } from "../../harness/budget-tools.js";
import { labHarnessTools } from "../../labs/tools.js";
import { evidenceUniverse } from "../../core/worker-output.js";
import type { RunContext } from "../types.js";
import { minimalEnv } from "./process.js";
import { harnessV2Tools } from "../../harness/operation-dispatch.js";
import { operationRegistry } from "../../harness/operation-registry.js";
import { RepoReader } from "../../context/repo-reader.js";

export interface TaskToolsBridge {
  url: string;
  token: string;
  tools: string[];
  idle(): Promise<void>;
  close(): Promise<void>;
}

const CheckArgs = z.object({ command: z.string().min(1).max(16_000) }).strict();
const BudgetArgs = z.object({ requests: z.number().int().positive().max(1000), reason: z.string().trim().min(1).max(16_000) }).strict();

/** Task-scoped MCP capabilities, not the install-wide supervisor/server tool set. */
export async function startTaskTools(ctx: RunContext, worktree: string, home: string): Promise<TaskToolsBridge> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([ctx.signal, lifetime.signal]);
  // Budget growth is shared with the model gateway; the bridge has its own abortable lifetime.
  const toolCtx: RunContext = { ...ctx, signal,
    get budget() { return ctx.budget; },
    set budget(value) { ctx.budget = value; },
  };
  const env: HarnessEnv = {
    ctx: toolCtx, role: "implementer", readers: new Map(), universe: evidenceUniverse([]), allowArtifacts: false, edits: new Set(),
    checks: { commands: ctx.spec.constraints.checks ?? [], cwd: worktree, env: minimalEnv({ HOME: home, USERPROFILE: home, CI: "1" }), timeoutMs: ctx.cfg.execution.check_timeout_seconds * 1000, maxRuns: ctx.cfg.coding.max_check_runs_per_task },
  };
  const alias = ctx.spec.writableRepository;
  if (alias) env.readers.set(alias, new RepoReader(alias, worktree, null));
  const tools = availableTools([...harnessV2Tools(env), declaredCheckTool(), requestBudgetTool(), ...labHarnessTools()], env);
  const operationSchemas = new Map(operationRegistry().map(def => [def.name, def.args]));
  let closing = false;
  let serial: Promise<void> = Promise.resolve();

  const active = () => {
    if (closing || signal.aborted || ctx.session?.ended) throw new Error("external task tools are closed or interrupted");
    const status = ctx.tasks.activeStatus(ctx.taskId, ctx.leaseOwner);
    if (status !== "active") throw new AdmissionDenied(status === "lease_lost" ? "lease_lost" : status === "cancel_requested" ? "cancel_requested" : "task_not_active", `task ${ctx.taskId} is not active under this execution lease`);
    const row = ctx.tasks.get(ctx.taskId)!.row;
    if (row.deadline_at !== null && ctx.now() >= row.deadline_at) throw new AdmissionDenied("deadline_exceeded", "task deadline exceeded");
  };
  // Active waits/checks stop when ownership changes, even if no further HTTP call arrives.
  const watchdog = setInterval(() => { try { active(); } catch (error) { lifetime.abort(error); } }, 100);
  watchdog.unref?.();

  const invoke = (tool: HarnessTool, args: Record<string, unknown>) => {
    const run = serial.then(async () => {
      active();
      const intent = ctx.session?.toolIntent({ callId: `external-${randomUUID()}`, name: tool.def.function.name, args, sideEffect: tool.sideEffect, idempotent: tool.idempotent });
      try {
        const output = await tool.run(args, env);
        active();
        const ok = tool.outputSucceeded?.(output) ?? true;
        if (intent !== undefined) ctx.session!.toolOutcome(intent, { ok, output });
        return { ...(!ok ? {isError:true} : {}), content: [{ type: "text" as const, text: output }] };
      } catch (error) {
        const text = (error as Error).message;
        if (intent !== undefined) ctx.session!.toolOutcome(intent, { ok: false, output: text });
        return { isError: true, content: [{ type: "text" as const, text }] };
      }
    });
    serial = run.then(() => undefined, () => undefined);
    return run;
  };
  const token = `sy-task-${randomBytes(24).toString("hex")}`;
  try {
    const http = await serveHttp({ host: "127.0.0.1", port: 0, token, build: () => {
      const server = new McpServer({ name: "meritrouter-task", version: "0.1.0" });
      for (const tool of tools) {
        const name = tool.def.function.name;
        const description = tool.def.function.description;
        const schema = operationSchemas.get(name);
        if (schema) server.registerTool(name, { description, inputSchema: schema }, args => invoke(tool, args));
        else if (name === "run_check") server.registerTool(name, { description, inputSchema: CheckArgs }, args => invoke(tool, args));
        else if (name === "request_more_budget") server.registerTool(name, { description, inputSchema: BudgetArgs }, args => invoke(tool, args));
        else if (name.startsWith("lab_")) server.registerTool(name, { description, inputSchema: z.object({}).catchall(z.unknown()) }, args => invoke(tool, args));
      }
      return server;
    } });
    return { url: http.url, token, tools: tools.map(tool => tool.def.function.name), idle: () => serial, close: async () => {
      closing = true;
      clearInterval(watchdog);
      lifetime.abort("external task bridge closed");
      await serial;
      await http.close();
    } };
  } catch (error) {
    clearInterval(watchdog);
    lifetime.abort(error);
    throw error;
  }
}

/** No token is written to TASK.md; command agents must deliberately connect with these env vars. */
export function taskToolsBrief(bridge: TaskToolsBridge): string {
  return `\n## MeritRouter task tools\n\nA task-scoped MCP server exposes ${bridge.tools.join(", ") || "no optional tools"}. OpenCode is configured to connect as meritrouter_task; its tool names have that prefix. Command agents can connect using MERITROUTER_TASK_TOOLS_URL and the bearer token in MERITROUTER_TASK_TOOLS_TOKEN. These credentials authorize this task only; do not print or persist them.\nUse run_check with an exactly declared command; other commands and excess check runs are refused. Ask request_more_budget before your model requests run out; it waits for approval without spending model requests. An approval raises only the request cap, never token or paid caps. A command agent must implement this MCP connection itself; the runner does not assume it uses these tools.\n`;
}
