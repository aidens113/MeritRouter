import type { ChatMessage, ChatTool, ChatToolCall } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import { compileOutputSchema } from "../core/validate.js";
import { evidenceUniverse, validateWorkerOutput, type EvidenceUniverse } from "../core/worker-output.js";
import { loadSources, readersFor, renderSources } from "../context/sources.js";
import { sliceLines, type RepoReader } from "../context/repo-reader.js";
import { AdmissionDenied } from "../core/errors.js";
import { ask, baseResult, type RunContext, type RunOutcome } from "./types.js";
import { planLimits } from "../routing/select.js";
import { systemPrompt, taskBrief } from "./prompts.js";
import { baseCommitsFor, contextManifest } from "./completion.js";

const MAX_TOOL_RESULT_CHARS = 16_000;

function repoTools(aliases: string[], withArtifacts: boolean): ChatTool[] {
  const alias = { type: "string", enum: aliases, description: "Repository alias" };
  const tools: ChatTool[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a repository directory (git-tracked and untracked-not-ignored).",
        parameters: {
          type: "object",
          properties: { alias, dir: { type: "string", description: "Directory relative to repo root; empty for root" }, glob: { type: "string" } },
          required: ["alias"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file (numbered lines). Use line ranges for large files.",
        parameters: {
          type: "object",
          properties: { alias, path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
          required: ["alias", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description: "Search file contents with an extended regular expression. Returns path:line matches.",
        parameters: {
          type: "object",
          properties: { alias, pattern: { type: "string" }, path_glob: { type: "string" }, ignore_case: { type: "boolean" } },
          required: ["alias", "pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_result",
        description: "Submit the final JSON result. This ends the task.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: { description: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } },
                required: ["description", "evidenceRefs"],
              },
            },
            criteria: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  status: { type: "string", enum: ["met", "unmet", "unknown"] },
                  evidenceRefs: { type: "array", items: { type: "string" } },
                  note: { type: "string" },
                },
                required: ["index", "status", "evidenceRefs"],
              },
            },
            data: {},
          },
          required: ["summary", "findings", "criteria"],
        },
      },
    },
  ];
  if (withArtifacts) {
    tools.splice(3, 0, {
      type: "function",
      function: {
        name: "read_artifact",
        description: "Read a stored artifact (logs, traces, earlier results) by its artifact:<id> reference.",
        parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
      },
    });
  }
  return tools;
}

function cap(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated; narrow the request]` : text;
}

/** Execute one read-only tool call. Errors are returned to the model as tool output. */
async function executeTool(
  call: ChatToolCall,
  ctx: RunContext,
  readers: Map<string, RepoReader>,
  universe: EvidenceUniverse,
  allowArtifacts: boolean,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return "error: arguments are not valid JSON";
  }
  const reader = typeof args.alias === "string" ? readers.get(args.alias) : undefined;
  try {
    switch (call.function.name) {
      case "list_files": {
        if (!reader) return `error: unknown alias; use one of ${[...readers.keys()].join(", ")}`;
        const r = await reader.listFiles(String(args.dir ?? ""), typeof args.glob === "string" ? args.glob : undefined);
        return cap(`${r.files.join("\n")}${r.truncated ? "\n[more files not shown; narrow dir or glob]" : ""}`) || "(no files)";
      }
      case "read_file": {
        if (!reader) return `error: unknown alias; use one of ${[...readers.keys()].join(", ")}`;
        const f = await reader.readFile(String(args.path));
        universe.refs.set(`${reader.alias}:${f.relPath}`, f.totalLines);
        const s = sliceLines(f.content, Number(args.start_line) || undefined, Number(args.end_line) || undefined);
        return cap(`ref: ${reader.alias}:${f.relPath}#L${s.start}-L${s.end} (of ${f.totalLines} lines)\n${s.text}`);
      }
      case "search": {
        if (!reader) return `error: unknown alias; use one of ${[...readers.keys()].join(", ")}`;
        const r = await reader.search(String(args.pattern), {
          ...(typeof args.path_glob === "string" ? { pathGlob: args.path_glob } : {}),
          ignoreCase: args.ignore_case === true,
        });
        return cap(r.matches.map((m) => `${reader.alias}:${m.path}#L${m.line}: ${m.text}`).join("\n") + (r.truncated ? "\n[more matches]" : "")) || "(no matches)";
      }
      case "read_artifact": {
        if (!allowArtifacts) return "error: artifacts are not available to this profile";
        const a = ctx.artifacts.read(String(args.ref));
        if (!a) return "error: unknown artifact";
        const text = a.content.toString("utf8");
        universe.refs.set(`artifact:${a.row.id}`, text.split("\n").length);
        return cap(text);
      }
      default:
        return `error: unknown tool ${call.function.name}`;
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

/** Replace the oldest tool outputs with a stub until the conversation fits the budget. */
function compact(messages: ChatMessage[], maxInputTokens: number): void {
  for (const m of messages) {
    if (estimateTokens(messages) <= maxInputTokens) return;
    if (m.role === "tool" && !m.content.startsWith("[elided")) m.content = "[elided to fit context; call the tool again if needed]";
  }
}

/** Read-only repository investigation with a bounded tool loop. */
export async function runReadOnly(ctx: RunContext): Promise<RunOutcome> {
  const { spec, profile } = ctx;
  const readers = readersFor(ctx.cfg, spec);
  const sources = await loadSources(ctx.cfg, spec, ctx.artifacts, readers);
  const manifestRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, kind: "context_manifest", label: "context sources", value: contextManifest(sources) });
  const universe = evidenceUniverse(sources);
  const validator = spec.constraints.outputSchema ? compileOutputSchema(spec.constraints.outputSchema) : undefined;
  const allowArtifacts = profile.tools === "repository_read_and_artifacts";
  const tools = repoTools(spec.repositoryAliases, allowArtifacts);
  const maxTokens = Math.min(profile.max_output_tokens, spec.budget?.maxOutputTokens ?? Infinity);
  const limits = planLimits(ctx.plan, ctx.cfg.routing.max_endpoint_fallbacks);
  const inputBudget = Math.max(2000, limits.contextLimitTokens - maxTokens - estimateTokens([], tools) - 500);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt(
        `Investigate the repositories (${spec.repositoryAliases.join(", ")}) with the read-only tools, then call submit_result exactly once. You cannot modify anything.`,
      ),
    },
    { role: "user", content: `${taskBrief(spec)}\nProvided context:\n${renderSources(sources) || "(none)"}` },
  ];
  const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
  const transcriptRef = () =>
    ctx.artifacts.writeJson({ taskId: ctx.taskId, executionId, kind: "transcript", label: "tool loop transcript", value: messages });
  const finish = async (outcome: RunOutcome): Promise<RunOutcome> => {
    ctx.gate.admission.finishExecution(executionId, outcome.state);
    outcome.result.artifactRefs = [manifestRef, transcriptRef(), ...outcome.result.artifactRefs];
    outcome.result.baseCommits = await baseCommitsFor(ctx);
    return outcome;
  };

  let invalidSubmissions = 0;
  let lastErrors: string[] = [];
  for (;;) {
    const used = ctx.gate.admission.taskTotals(ctx.taskId).requests;
    const remaining = ctx.budget.maxModelRequests - used;
    if (remaining <= 0) {
      return finish({
        state: "budget_exhausted",
        result: baseResult({
          executionStatus: "budget_exhausted",
          stopReason: `model request budget (${ctx.budget.maxModelRequests}) exhausted before submit_result`,
          unresolvedCriteria: spec.constraints.acceptanceCriteria,
        }),
      });
    }
    if (remaining === 1) {
      messages.push({ role: "user", content: "This is your final model request. Call submit_result now with what you have; mark unverified criteria as unknown." });
    }
    compact(messages, inputBudget);

    let response;
    try {
      ({ response } = await ask(ctx, {
        executionId,
        purpose: "tool_loop",
        chat: { messages, max_tokens: maxTokens, temperature: 0.2, tools, tool_choice: remaining === 1 ? "required" : "auto" },
      }));
    } catch (err) {
      if (err instanceof AdmissionDenied && err.reason === "task_request_budget_exhausted") continue;
      throw err;
    }

    const calls = response.message.tool_calls ?? [];
    messages.push({ role: "assistant", content: response.message.content, ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length === 0) {
      messages.push({ role: "user", content: "Use the tools to investigate, then call submit_result. Plain text answers are not accepted." });
      continue;
    }
    for (const call of calls) {
      if (call.function.name !== "submit_result") {
        messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call, ctx, readers, universe, allowArtifacts) });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(call.function.arguments || "{}");
      } catch {
        raw = undefined;
      }
      const v =
        raw === undefined
          ? { ok: false as const, errors: ["submit_result arguments are not valid JSON"] }
          : validateWorkerOutput(raw, {
              acceptanceCriteria: spec.constraints.acceptanceCriteria,
              universe,
              ...(validator ? { dataValidator: validator } : {}),
            });
      if (v.ok) {
        return finish({
          state: "completed",
          result: baseResult({
            executionStatus: "completed",
            acceptanceStatus: v.value.acceptanceStatus,
            stopReason: "worker_submitted",
            summary: v.value.output.summary,
            findings: v.value.output.findings,
            ...(v.value.output.data !== undefined ? { data: v.value.output.data } : {}),
            unresolvedCriteria: v.value.unresolvedCriteria,
          }),
        });
      }
      lastErrors = v.errors;
      invalidSubmissions++;
      messages.push({ role: "tool", tool_call_id: call.id, content: `rejected:\n- ${v.errors.join("\n- ")}\nFix and call submit_result again.` });
      if (invalidSubmissions > ctx.cfg.execution.max_invalid_output_retries) {
        return finish({
          state: "failed",
          result: baseResult({
            executionStatus: "failed",
            stopReason: "invalid_output",
            summary: `worker output failed validation: ${lastErrors.join("; ")}`,
            unresolvedCriteria: spec.constraints.acceptanceCriteria,
          }),
        });
      }
    }
  }
}
