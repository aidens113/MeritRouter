#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config/load.js";
import { MODALITIES, PROFILE_NAMES, TIER_NAMES } from "./config/schema.js";
import { Switchyard } from "./core/service.js";
import { createCodingRunner } from "./runners/coding/index.js";
import { routingPreview } from "./admin/insights.js";

/**
 * MCP stdio server for Claude Code. Runs the worker loop in-process; jobs continue only while
 * the session keeps this process alive (state is persisted incrementally and recovered on the
 * next start).
 */
async function main(): Promise<void> {
  const configArg = process.argv.indexOf("--config");
  const cfg = loadConfig(configArg > 0 ? process.argv[configArg + 1] : undefined);
  const sy = new Switchyard(cfg, { worker: true, coding: createCodingRunner(cfg) });
  sy.recover();

  const server = new McpServer({ name: "switchyard", version: "0.1.0" });
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const fail = (err: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (err as Error).message ?? String(err) }] });

  server.registerTool(
    "submit_tasks",
    {
      title: "Submit worker tasks",
      description:
        "Validate and persist one or more tasks for external worker models. Returns task ids immediately. " +
        "Profiles: summarize (completion over supplied context), inspect/analyze/review (read-only repository investigation), implement (bounded edits in an isolated worktree). " +
        "Each task needs goal and constraints.acceptanceCriteria; pass context.fileRefs as '<alias>:<path>[#Lstart-Lend]' so workers load files themselves. " +
        "Optional hints.difficulty (T1-T4) skips the difficulty classifier; routing.tier sets a minimum tier.",
      inputSchema: { tasks: z.array(z.record(z.string(), z.unknown())).min(1).max(50) },
    },
    async ({ tasks }) => {
      try {
        return json({ submitted: await sy.submitTasks(tasks) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "await_results",
    {
      title: "Wait for task results",
      description: "Wait inside the package until the tasks finish or the bounded wait elapses. Prefer this over repeated status checks.",
      inputSchema: { taskIds: z.array(z.string()).min(1), timeoutSeconds: z.number().int().positive().optional() },
    },
    async ({ taskIds, timeoutSeconds }, extra) => {
      try {
        return json(await sy.awaitResults(taskIds, { ...(timeoutSeconds ? { timeoutSeconds } : {}), signal: extra.signal }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Get task status",
      description: "Current state, tier, request usage, and recent events for tasks (or the most recent tasks when no ids are given).",
      inputSchema: { taskIds: z.array(z.string()).optional() },
    },
    async ({ taskIds }) => json(taskIds?.length ? sy.getStatus(taskIds) : sy.listTasks(undefined, 20)),
  );

  server.registerTool(
    "collect_results",
    {
      title: "Collect finished results",
      description: "Return results (with evidence, artifact and patch references) for tasks that have finished, without waiting.",
      inputSchema: { taskIds: z.array(z.string()).min(1) },
    },
    async ({ taskIds }) => json(sy.collectResults(taskIds)),
  );

  server.registerTool(
    "cancel_tasks",
    {
      title: "Cancel tasks",
      description: "Persist cancellation; no further model requests are dispatched for these tasks.",
      inputSchema: { taskIds: z.array(z.string()).min(1) },
    },
    async ({ taskIds }) => json(sy.cancelTasks(taskIds)),
  );

  server.registerTool(
    "resume_task",
    {
      title: "Resume an interrupted task",
      description: "Requeue an interrupted task. Coding tasks keep their previous worktree as evidence and start fresh.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => {
      try {
        return json({ taskId, state: sy.resumeTask(taskId) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "read_artifact",
    {
      title: "Read an artifact",
      description: "Read a stored artifact (logs, patches, transcripts) by its artifact:<id> reference.",
      inputSchema: { ref: z.string(), maxBytes: z.number().int().positive().max(500_000).optional() },
    },
    async ({ ref, maxBytes }) => {
      const a = sy.artifacts.read(ref);
      if (!a) return fail(new Error(`unknown artifact ${ref}`));
      const limit = maxBytes ?? 60_000;
      return { content: [{ type: "text" as const, text: a.content.subarray(0, limit).toString("utf8") + (a.content.length > limit ? `\n[truncated at ${limit} of ${a.content.length} bytes]` : "") }] };
    },
  );

  server.registerTool(
    "preview_route",
    {
      title: "Preview model routing",
      description: "Show which models would serve a task type at a tier, in order, and why others are excluded.",
      inputSchema: { profile: z.enum(PROFILE_NAMES), tier: z.enum(TIER_NAMES), modalities: z.array(z.enum(MODALITIES)).optional() },
    },
    async ({ profile, tier, modalities }) => {
      const p = routingPreview(sy, profile, tier, modalities ?? ["text"]);
      return json({ floorB: p.floorB, forced: p.forced, candidates: p.explanations.filter((e) => e.eligible).map((e) => e.endpointId), excluded: p.explanations.filter((e) => !e.eligible).map((e) => ({ model: e.endpointId, why: e.reasons })) });
    },
  );

  server.registerTool(
    "usage_summary",
    {
      title: "Usage summary",
      description: "Tasks, physical model requests, tokens, and failures over a recent window.",
      inputSchema: { hours: z.number().positive().max(24 * 31).optional() },
    },
    async ({ hours }) => json(sy.usage(Date.now() - (hours ?? 24) * 3_600_000)),
  );

  const shutdown = async () => {
    await sy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`switchyard mcp: ${(err as Error).message}\n`);
  process.exit(1);
});
