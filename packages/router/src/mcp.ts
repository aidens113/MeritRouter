#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config/load.js";
import { MODALITIES, PROFILE_NAMES, TIER_NAMES } from "./config/schema.js";
import { Switchyard } from "./core/service.js";
import { routingPreview, jobDetail, sessionDetail, sessionsView } from "./admin/insights.js";
import { blame } from "./attribution/index.js";
import type { Principal } from "./brain/access.js";
import { SessionStatusSchema } from "./sessions/events.js";

/**
 * MCP stdio server for Claude Code. Runs the worker loop in-process; jobs continue only while
 * the session keeps this process alive (state is persisted incrementally and recovered on the
 * next start).
 */
async function main(): Promise<void> {
  const configArg = process.argv.indexOf("--config");
  const cfg = loadConfig(configArg > 0 ? process.argv[configArg + 1] : undefined);
  const sy = new Switchyard(cfg, { worker: true });
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

  // ---------- jobs (standalone supervisor) ----------
  server.registerTool(
    "start_job",
    {
      title: "Start a SwitchYard-supervised job",
      description: "Hand a whole goal to SwitchYard's own supervisor (models configured under supervisor), which plans, delegates, verifies, and integrates onto a job branch. Use when you want SwitchYard to run the job end to end instead of supervising tasks yourself.",
      inputSchema: { goal: z.string().min(1), repositories: z.array(z.string()).min(1), acceptanceCriteria: z.array(z.string()).optional(), checks: z.array(z.string()).optional(), label: z.string().optional() },
    },
    async (a) => {
      try {
        return json(await sy.startJob({ goal: a.goal, repositories: a.repositories, ...(a.acceptanceCriteria ? { acceptanceCriteria: a.acceptanceCriteria } : {}), ...(a.checks ? { checks: a.checks } : {}), ...(a.label ? { label: a.label } : {}) }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool("job_status", { title: "Job status", description: "A job's state, workers, branch, pending questions, and result.", inputSchema: { jobId: z.string() } }, async ({ jobId }) => {
    const j = jobDetail(sy, jobId);
    if (!j) return fail(new Error(`unknown job ${jobId}`));
    const { transcript: _t, ...rest } = j;
    return json(rest);
  });
  server.registerTool("list_questions", { title: "Questions from supervisors", description: "Questions SwitchYard supervisors are waiting on.", inputSchema: {} }, async () => json(sy.questions()));
  server.registerTool("answer_question", { title: "Answer a supervisor's question", description: "Answer a pending question so the job continues.", inputSchema: { id: z.number().int(), answer: z.string().min(1) } }, async ({ id, answer }) => {
    try {
      sy.answerQuestion(id, answer, "claude-code");
      return json({ answered: id });
    } catch (err) {
      return fail(err);
    }
  });

  // ---------- agent sessions (read-only; resume belongs to S2) ----------
  server.registerTool(
    "list_sessions",
    {
      title: "List agent sessions",
      description:
        "Agent sessions, newest first: one per model-driven run (each task run, retry, or escalation; each classification). " +
        "Each row has the role, agent label, task and job, status and stop reason, model request and tool call counts, and the last event seq. " +
        "Filter by status (one or several), taskId, jobId, or parentSessionId (the sessions a session delegated).",
      inputSchema: {
        status: z.union([SessionStatusSchema, z.array(SessionStatusSchema).min(1)]).optional(),
        taskId: z.string().min(1).optional(),
        jobId: z.string().min(1).optional(),
        parentSessionId: z.string().min(1).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ status, taskId, jobId, parentSessionId, limit }) => {
      try {
        return json(sessionsView(sy, { ...(status ? { status } : {}), ...(taskId ? { taskId } : {}), ...(jobId ? { jobId } : {}), ...(parentSessionId ? { parentSessionId } : {}), limit: limit ?? 50 }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_session",
    {
      title: "Get an agent session's timeline",
      description:
        "One session with a page of its event log in order: started, message, model_request, model_response, model_error, tool_intent, tool_outcome, note, workspace, ended. " +
        "Also returns its delegated child sessions and the other sessions of the same task. " +
        "Pages hold at most `limit` events (default 200) after `afterSeq`; when hasMore is true, call again with afterSeq set to the last returned seq. " +
        "`corrupt` lists log lines that failed validation and were skipped.",
      inputSchema: { sessionId: z.string().min(1), afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ sessionId, afterSeq, limit }) => {
      try {
        const d = sessionDetail(sy, sessionId, { afterSeq: afterSeq ?? 0, limit: limit ?? 200 });
        if (!d) return fail(new Error(`unknown session ${sessionId}`));
        return json(d);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------- brain: Claude Code acts as a supervisor (reads everything, writes its project) ----------
  const effort = "claude-code";
  const principal = (): Principal => sy.brainAccess.principalFor("supervisor", { project: sy.brain.project, effort, task: null, repos: Object.keys(cfg.repositoryPaths), jobId: null, tier: null });
  const actor = { agent: "supervisor:claude-code", role: "supervisor", model: "claude-code" };
  const brainTool = (name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, run: (a: Record<string, unknown>) => Promise<unknown> | unknown) =>
    server.registerTool(name, { title: name.replace(/_/g, " "), description, inputSchema }, async (a: Record<string, unknown>) => {
      try {
        await sy.brain.ensure();
        return json(await run(a));
      } catch (err) {
        return fail(err);
      }
    });
  brainTool("brain_search", "Search shared knowledge: working documents, decisions, lessons, worker reports.", { query: z.string(), prefix: z.string().optional() }, async (a) => {
    await sy.brain.refreshIndex();
    return sy.brain.search(principal(), String(a.query), { ...(a.prefix ? { prefix: String(a.prefix) } : {}), limit: 10 });
  });
  brainTool("brain_read", "Read a brain entry, or one section of it (e.g. 'Current State').", { path: z.string(), section: z.string().optional() }, (a) => sy.brain.read(principal(), String(a.path), a.section ? { section: String(a.section) } : {}));
  brainTool("brain_list", "List brain entries under a prefix (index of working documents: README.md).", { prefix: z.string().optional() }, (a) => sy.brain.list(principal(), String(a.prefix ?? "")));
  brainTool("brain_start_working_doc", "Create a working document for an effort (header, Current State, briefs, ledger, open questions).", { effort: z.string(), title: z.string(), scope: z.string(), currentState: z.string() }, (a) =>
    sy.brain.createWorkingDoc(principal(), actor, String(a.effort), { title: String(a.title), statusDetail: "Started from Claude Code", owner: actor.agent, scope: String(a.scope), currentState: String(a.currentState) }),
  );
  brainTool("brain_set_current_state", "Rewrite a working document's Current State (<= the configured line limit).", { path: z.string(), body: z.string() }, (a) => sy.brain.setCurrentState(principal(), actor, String(a.path), String(a.body)));
  brainTool(
    "brain_append_ledger",
    "Append a Work Ledger entry; validation must be the exact command run and its observed result, or 'not validated' and why.",
    { path: z.string(), title: z.string(), changed: z.string(), why: z.string(), validation: z.string(), outcome: z.enum(["Accepted", "Partial", "Reverted", "Blocked"]), followUp: z.string() },
    (a) => sy.brain.appendLedger(principal(), actor, String(a.path), { title: String(a.title), agent: actor.agent, changed: String(a.changed), why: String(a.why), validation: String(a.validation), outcome: a.outcome as "Accepted", followUp: String(a.followUp) }),
  );
  brainTool("brain_write", "Create or replace a note in your project (decisions/, facts/, repos/<alias>.md).", { path: z.string(), content: z.string() }, (a) => sy.brain.write(principal(), actor, String(a.path), String(a.content)));
  brainTool("brain_promote_lesson", "Promote a reusable lesson to global knowledge.", { title: z.string(), body: z.string(), sources: z.array(z.string()).optional() }, (a) => sy.brain.promoteLesson(principal(), actor, String(a.title), String(a.body), (a.sources as string[] | undefined) ?? []));
  brainTool("brain_access_requests", "Workers' pending requests for more brain access.", {}, () => sy.brainAccess.list({ status: "pending" }));
  brainTool("brain_decide_request", "Approve or deny a worker's brain access request.", { id: z.number().int(), approve: z.boolean(), reason: z.string() }, (a) => sy.brainAccess.decide(Number(a.id), a.approve === true, actor.agent, String(a.reason)));

  server.registerTool(
    "blame",
    { title: "Line attribution", description: "Which agent and model wrote each line of a file (SwitchYard commits carry Agent/Model trailers). Use a job branch as ref to inspect a SwitchYard job.", inputSchema: { repository: z.string(), path: z.string(), ref: z.string().optional() } },
    async ({ repository, path: file, ref }) => {
      const repo = cfg.repositoryPaths[repository];
      if (!repo) return fail(new Error(`unknown repository ${repository}`));
      try {
        const lines = await blame(repo.path, file, ref ?? "HEAD");
        return json(lines.map((l) => ({ line: l.line, agent: l.agent ?? l.authorName, model: l.model, role: l.role, task: l.task, commit: l.commit.slice(0, 12), text: l.text })));
      } catch (err) {
        return fail(err);
      }
    },
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
