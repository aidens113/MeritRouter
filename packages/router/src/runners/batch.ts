import type { ChatMessage } from "../gateway/types.js";
import { estimateTokens } from "../gateway/types.js";
import type { GateAttempt, GateResponse } from "../gateway/gate.js";
import { AdmissionDenied } from "../core/errors.js";
import { compileOutputSchema } from "../core/validate.js";
import { evidenceUniverse, extractJson, validateWorkerOutput, type EvidenceUniverse, OUTPUT_CONTRACT } from "../core/worker-output.js";
import { loadSources, renderSources, type ContextSource } from "../context/sources.js";
import { canonicalJson } from "../storage/tasks.js";
import { ask, baseResult, type RunContext, type RunOutcome } from "./types.js";
import { planLimits } from "../routing/select.js";
import { taskBrief } from "./prompts.js";
import { baseCommitsFor, contextManifest } from "./completion.js";
import type { WorkerTask } from "../core/task.js";
import { criterionTexts } from "../core/task.js";

/** Tasks that may share one prompt: same profile, data boundary, and response requirements. */
export function batchKey(spec: WorkerTask): string | null {
  // Explicit per-task token caps cannot be enforced exactly inside a shared response.
  if (spec.budget?.maxInputTokens !== undefined || spec.budget?.maxOutputTokens !== undefined) return null;
  return canonicalJson({
    profile: spec.profile,
    repos: [...spec.repositoryAliases].sort(),
    baseCommits: spec.context.baseCommits ?? {},
    outputSchema: spec.constraints.outputSchema ?? null,
  });
}

interface Item {
  itemId: string;
  ctx: RunContext;
  sources: ContextSource[];
  universe: EvidenceUniverse;
  manifestRef: string;
  estTokens: number;
}

function batchSystemPrompt(): string {
  return `You are a bounded worker answering several independent items in one response. Each item has its own goal, criteria, and sources; never use one item's sources as evidence for another.

Respond with one JSON object: {"items": [{"id": "<item id>", "result": <result object>} | {"id": "<item id>", "error": "<why it cannot be answered>"}]}
Include every item id exactly once. Each <result object> follows this contract:
${OUTPUT_CONTRACT}`;
}

function renderItem(item: Item): string {
  return `<item id="${item.itemId}">\n${taskBrief(item.ctx.spec)}\nSources:\n${renderSources(item.sources) || "(none)"}\n</item>`;
}

/**
 * Run compatible completion tasks as prompt-level batches. One physical request is reserved
 * per round, charged once to every participating task. Completed items are retained; only
 * missing or invalid items are retried, as a new execution linked by retry_of.
 */
export async function runBatch(ctxs: RunContext[]): Promise<Map<string, RunOutcome>> {
  const outcomes = new Map<string, RunOutcome>();
  const first = ctxs[0]!;
  const perItemOut = first.profile.batching.per_item_output_tokens;
  const items: Item[] = [];
  for (const [i, ctx] of ctxs.entries()) {
    const sources = await loadSources(ctx.cfg, ctx.spec, ctx.artifacts);
    const manifestRef = ctx.artifacts.writeJson({ taskId: ctx.taskId, kind: "context_manifest", label: "context sources", value: contextManifest(sources) });
    const item: Item = { itemId: `i${i + 1}`, ctx, sources, universe: evidenceUniverse(sources), manifestRef, estTokens: 0 };
    item.estTokens = estimateTokens([{ role: "user", content: renderItem(item) }]);
    items.push(item);
  }
  const done = async (item: Item, outcome: RunOutcome, artifactRefs: string[]) => {
    outcome.result.artifactRefs = [item.manifestRef, ...artifactRefs, ...outcome.result.artifactRefs];
    outcome.result.baseCommits = await baseCommitsFor(item.ctx);
    outcomes.set(item.ctx.taskId, outcome);
  };

  // Pack items so each physical request fits every pool member's context and output limits.
  const pool = planLimits(first.plan, first.cfg.routing.max_endpoint_fallbacks);
  const systemTokens = estimateTokens([{ role: "system", content: batchSystemPrompt() }]);
  const fits = (group: Item[]) => {
    const out = group.length * perItemOut + 300;
    const input = systemTokens + group.reduce((s, it) => s + it.estTokens, 0);
    return out <= pool.outputLimitTokens && input + out <= pool.contextLimitTokens;
  };
  const chunks: Item[][] = [];
  let current: Item[] = [];
  for (const item of items) {
    if (!fits([item])) {
      await done(
        item,
        {
          state: "failed",
          result: baseResult({
            executionStatus: "failed",
            stopReason: "context_does_not_fit",
            summary: `item needs ~${item.estTokens} input tokens; pool context limit is ${pool.contextLimitTokens}`,
            unresolvedCriteria: criterionTexts(item.ctx.spec),
          }),
        },
        [],
      );
      continue;
    }
    if (current.length && !fits([...current, item])) {
      chunks.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) chunks.push(current);
  for (const chunk of chunks) await runChunk(chunk, done);
  return outcomes;
}

type Done = (item: Item, outcome: RunOutcome, artifactRefs: string[]) => Promise<void>;

async function runChunk(chunk: Item[], done: Done): Promise<void> {
  const first = chunk[0]!.ctx;
  const admission = first.gate.admission;
  const perItemOut = first.profile.batching.per_item_output_tokens;
  const maxRounds = 1 + first.cfg.execution.max_invalid_output_retries;
  let pending: Item[] = [...chunk];

  let retryOf: string | undefined;
  let lastErrors = new Map<string, string[]>();
  for (let round = 0; round < maxRounds && pending.length; round++) {
    // Members whose own request budget is spent cannot join another physical request.
    for (const item of [...pending]) {
      if (admission.taskTotals(item.ctx.taskId).requests >= item.ctx.budget.maxModelRequests) {
        pending = pending.filter((p) => p !== item);
        await done(item, { state: "budget_exhausted", result: baseResult({ executionStatus: "budget_exhausted", stopReason: "model request budget exhausted during batch retries", unresolvedCriteria: criterionTexts(item.ctx.spec) }) }, []);
      }
    }
    if (!pending.length) break;

    const executionId = admission.createExecution("batch", first.spec.profile, pending.map((p) => ({ taskId: p.ctx.taskId, itemId: p.itemId })), retryOf);
    retryOf = executionId;
    const messages: ChatMessage[] = [
      { role: "system", content: batchSystemPrompt() },
      { role: "user", content: pending.map(renderItem).join("\n\n") },
    ];
    const request = {
      executionId,
      purpose: round === 0 ? "batch" : "batch_retry",
      chat: { messages, max_tokens: pending.length * perItemOut + 300, temperature: 0.2, response_format: { type: "json_object" as const } },
    };
    // One physical request serves every pending item: record it in each item's session, each
    // noting that it was shared and with whom. `ask` itself records nothing (session: null).
    const sessions = pending.flatMap((p) => (p.ctx.session ? [{ item: p, session: p.ctx.session }] : []));
    for (const { item, session } of sessions) {
      session.note(`shared batch request (round ${round + 1}, ${pending.length} item(s)); this task is item ${item.itemId}`, {
        executionId,
        itemId: item.itemId,
        members: pending.map((p) => ({ taskId: p.ctx.taskId, itemId: p.itemId })),
      });
      session.syncMessages(messages);
      session.modelRequest(request);
    }
    let res: GateResponse;
    try {
      res = await ask(
        { ...first, session: null },
        { ...request, participants: pending.map((p) => ({ taskId: p.ctx.taskId, leaseOwner: p.ctx.leaseOwner, budget: p.ctx.budget, weight: p.estTokens })) },
      );
    } catch (err) {
      const attempts = (err as { attempts?: GateAttempt[] }).attempts;
      for (const { session } of sessions) session.modelError({ executionId, error: err, ...(attempts ? { attempts } : {}) });
      admission.finishExecution(executionId, "failed", { error: (err as Error).message });
      if (err instanceof AdmissionDenied && err.taskId && ["cancel_requested", "lease_lost", "task_not_active", "deadline_exceeded"].includes(err.reason)) {
        // Drop the member that cannot participate and retry the round without it.
        const bad = pending.find((p) => p.ctx.taskId === err.taskId)!;
        pending = pending.filter((p) => p !== bad);
        const state = err.reason === "cancel_requested" ? "cancelled" : err.reason === "deadline_exceeded" ? "failed" : "interrupted";
        await done(bad, { state, result: baseResult({ executionStatus: state, stopReason: err.reason, unresolvedCriteria: criterionTexts(bad.ctx.spec) }) }, []);
        round--;
        continue;
      }
      throw Object.assign(err as Error, { batchPendingTaskIds: pending.map((p) => p.ctx.taskId) });
    }
    for (const { session } of sessions) session.modelResponse(res);
    const response = res.response;
    for (const p of pending) if (p.ctx !== first) p.ctx.attempts.push(...res.attempts);

    const text = response.message.content ?? "";
    const responseRef = first.artifacts.write({ taskId: null, executionId, kind: "batch_response", label: `batch ${executionId}`, content: text });
    lastErrors = new Map();
    let items: Array<Record<string, unknown>> = [];
    try {
      const raw = extractJson(text) as { items?: unknown };
      if (!Array.isArray(raw.items)) throw new Error("response has no items array");
      items = raw.items as Array<Record<string, unknown>>;
    } catch (err) {
      for (const p of pending) lastErrors.set(p.ctx.taskId, [(err as Error).message]);
    }

    const byId = new Map<string, Array<Record<string, unknown>>>();
    for (const it of items) {
      const id = typeof it.id === "string" ? it.id : "";
      byId.set(id, [...(byId.get(id) ?? []), it]);
    }
    const known = new Set(pending.map((p) => p.itemId));
    const invented = [...byId.keys()].filter((id) => !known.has(id));
    const coverage = { executionId, invented, duplicated: [] as string[], missing: [] as string[], completed: [] as string[], invalid: [] as string[] };

    const stillPending: Item[] = [];
    for (const item of pending) {
      const entries = byId.get(item.itemId) ?? [];
      const fail = (errors: string[]) => {
        item.ctx.session?.note(`batch item ${item.itemId} rejected`, { executionId, errors });
        lastErrors.set(item.ctx.taskId, errors);
        admission.setMemberOutcome(executionId, item.ctx.taskId, `invalid: ${errors.join("; ").slice(0, 500)}`);
        stillPending.push(item);
      };
      if (lastErrors.has(item.ctx.taskId)) {
        fail(lastErrors.get(item.ctx.taskId)!);
        continue;
      }
      if (entries.length === 0) {
        coverage.missing.push(item.itemId);
        fail([`item ${item.itemId} missing from response`]);
        continue;
      }
      if (entries.length > 1) {
        coverage.duplicated.push(item.itemId);
        fail([`item ${item.itemId} appears ${entries.length} times`]);
        continue;
      }
      const entry = entries[0]!;
      if (typeof entry.error === "string") {
        coverage.invalid.push(item.itemId);
        fail([`worker reported error: ${entry.error}`]);
        continue;
      }
      const validator = item.ctx.spec.constraints.outputSchema ? compileOutputSchema(item.ctx.spec.constraints.outputSchema) : undefined;
      const v = validateWorkerOutput(entry.result, {
        acceptanceCriteria: criterionTexts(item.ctx.spec),
        universe: item.universe,
        ...(validator ? { dataValidator: validator } : {}),
      });
      if (!v.ok) {
        coverage.invalid.push(item.itemId);
        fail(v.errors);
        continue;
      }
      coverage.completed.push(item.itemId);
      item.ctx.session?.note(`batch item ${item.itemId} accepted`, { executionId });
      admission.setMemberOutcome(executionId, item.ctx.taskId, "completed");
      await done(
        item,
        {
          state: "completed",
          result: baseResult({
            executionStatus: "completed",
            acceptanceStatus: v.value.acceptanceStatus,
            stopReason: "worker_answered_in_batch",
            summary: v.value.output.summary,
            findings: v.value.output.findings,
            ...(v.value.output.data !== undefined ? { data: v.value.output.data } : {}),
            unresolvedCriteria: v.value.unresolvedCriteria,
          }),
          evidence: { universe: item.universe, output: v.value.output },
        },
        [responseRef],
      );
    }
    admission.finishExecution(executionId, stillPending.length ? "partial" : "completed", coverage);
    pending = stillPending;
  }

  for (const item of pending) {
    const errors = lastErrors.get(item.ctx.taskId) ?? ["no valid result"];
    await done(
      item,
      {
        state: "failed",
        result: baseResult({
          executionStatus: "failed",
          stopReason: "invalid_output",
          summary: `batch item failed validation: ${errors.join("; ")}`,
          unresolvedCriteria: criterionTexts(item.ctx.spec),
        }),
      },
      [],
    );
  }
}
