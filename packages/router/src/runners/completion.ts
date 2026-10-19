import type { ChatMessage } from "../gateway/types.js";
import { compileOutputSchema } from "../core/validate.js";
import { evidenceUniverse, extractJson, validateWorkerOutput } from "../core/worker-output.js";
import { loadSources, renderSources, readersFor, type ContextSource } from "../context/sources.js";
import { ask, baseResult, type RunContext, type RunOutcome } from "./types.js";
import { systemPrompt, taskBrief } from "./prompts.js";
import { criterionTexts } from "../core/task.js";

export function contextManifest(sources: ContextSource[]) {
  return sources.map((s) => ({ ref: s.ref, sha256: s.sha256, commit: s.commit, uncommittedChanges: s.dirty, lines: s.totalLines }));
}

export async function baseCommitsFor(ctx: RunContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [alias, reader] of readersFor(ctx.cfg, ctx.spec)) out[alias] = reader.commit ?? (await reader.headSha());
  return out;
}

/** One-shot completion: summaries, extraction, classification over supplied context. */
export async function runCompletion(ctx: RunContext): Promise<RunOutcome> {
  const { spec, profile } = ctx;
  const sources = await loadSources(ctx.cfg, spec, ctx.artifacts);
  const manifestRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, kind: "context_manifest", label: "context sources", value: contextManifest(sources) });
  const universe = evidenceUniverse(sources);
  const validator = spec.constraints.outputSchema ? compileOutputSchema(spec.constraints.outputSchema) : undefined;
  const maxTokens = Math.min(profile.max_output_tokens, spec.budget?.maxOutputTokens ?? Infinity);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt("Answer from the supplied sources only.") },
    { role: "user", content: `${taskBrief(spec)}\nSources:\n${renderSources(sources) || "(none)"}` },
  ];
  const executionId = ctx.gate.admission.createExecution("task", spec.profile, [{ taskId: ctx.taskId, itemId: ctx.taskId }]);
  const responseRefs: string[] = [];
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= ctx.cfg.execution.max_invalid_output_retries; attempt++) {
    const { response } = await ask(ctx, {
      executionId,
      purpose: attempt === 0 ? "completion" : "completion_repair",
      chat: { messages, max_tokens: maxTokens, temperature: 0.2, response_format: { type: "json_object" } },
    });
    const text = response.message.content ?? "";
    responseRefs.push(ctx.artifacts.write({ taskId: ctx.taskId, executionId, kind: "model_response", label: `response ${attempt + 1}`, content: text }));

    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch (err) {
      lastErrors = [(err as Error).message];
    }
    if (raw !== undefined) {
      const v = validateWorkerOutput(raw, {
        acceptanceCriteria: criterionTexts(spec),
        universe,
        ...(validator ? { dataValidator: validator } : {}),
      });
      if (v.ok) {
        ctx.gate.admission.finishExecution(executionId, "completed");
        return {
          state: "completed",
          result: baseResult({
            executionStatus: "completed",
            acceptanceStatus: v.value.acceptanceStatus,
            stopReason: "worker_answered",
            summary: v.value.output.summary,
            findings: v.value.output.findings,
            ...(v.value.output.data !== undefined ? { data: v.value.output.data } : {}),
            unresolvedCriteria: v.value.unresolvedCriteria,
            artifactRefs: [manifestRef, ...responseRefs],
            baseCommits: await baseCommitsFor(ctx),
          }),
        };
      }
      lastErrors = v.errors;
    }
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `Your answer was rejected:\n- ${lastErrors.join("\n- ")}\nReturn a corrected JSON object only.`,
    });
  }

  ctx.gate.admission.finishExecution(executionId, "failed", { errors: lastErrors });
  return {
    state: "failed",
    result: baseResult({
      executionStatus: "failed",
      stopReason: "invalid_output",
      summary: `worker output failed validation: ${lastErrors.join("; ")}`,
      unresolvedCriteria: criterionTexts(spec),
      artifactRefs: [manifestRef, ...responseRefs],
      baseCommits: await baseCommitsFor(ctx),
    }),
  };
}
