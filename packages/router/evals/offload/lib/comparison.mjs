import { execFileSync, spawnSync } from "node:child_process";

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
const readOnly = new Set(["scout", "summarize", "review"]);

export function claudeArguments({ mcpConfig, arm, raw, model, cost, operatorAvailable = false }) {
  const offload = arm === "offload";
  const workerInstructions = readOnly.has(raw.kind)
    ? `Use a read-only ${raw.kind} worker focused on ${raw.contextFiles.join(", ")} and write its verified findings to ANSWER.md yourself.`
    : `Use a writable ${raw.kind} worker scoped to ${raw.allowedPaths.join(", ")}. Include "npm test" in the brief. After reviewing and accepting its result, apply its MeritRouter commit to this checkout by cherry-pick so authorship is preserved. The task commit carries a Task trailer and can be found with git log --all. If offload cannot finish, complete the task yourself within the same scope.`;
  const pendingInstructions = operatorAvailable
    ? " If await returns pendingActions, the operator is reviewing the exact request in the panel. Use Bash(sleep 45) before retrying await so the operator has time to decide."
    : "";
  const prompt = offload
    ? `${raw.prompt}\n\nUse this repository's MeritRouter MCP (repository alias app). ${workerInstructions} Begin with delegate. Give the worker an observable acceptance criterion and relevant files. Use await with a bounded timeout, handle inbox requests, then accept or reject after checking its report.${pendingInstructions}`
    : raw.prompt;
  return [
    "--print", "--verbose", "--output-format", "stream-json", "--model", model,
    "--max-budget-usd", String(cost), "--no-session-persistence", "--disable-slash-commands",
    "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Bash(git log *) Bash(git show *) Bash(git status *) Bash(git diff *) Bash(git cherry-pick *) Bash(npm test)" +
      (offload ? " mcp__meritrouter__*" : "") + (offload && operatorAvailable ? " Bash(sleep 45)" : ""),
    "--tools", "Read,Glob,Grep,Write,Edit,Bash",
    "--", prompt,
  ];
}

export function parseClaudeRun(run, arm) {
  const fail = (failure) => ({ valid: false, failure });
  if (run.error) return fail(run.error.code ?? "Claude failed to start");
  let events;
  try {
    events = (run.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return fail("Claude did not emit readable stream JSON");
  }
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const final = events.findLast((event) => event.type === "result");
  if (!Array.isArray(init?.mcp_servers)) return fail("Claude did not report MCP configuration");
  if (arm === "baseline" ? init.mcp_servers.length !== 0
    : init.mcp_servers.length !== 1 || init.mcp_servers[0]?.name !== "meritrouter" || init.mcp_servers[0]?.status !== "connected") {
    return fail("Claude connected to an unexpected set of MCP servers");
  }
  if (run.status !== 0 || final?.is_error !== false || !Number.isSafeInteger(final.usage?.output_tokens) || final.usage.output_tokens <= 0) {
    return fail(`Claude exited without usable supervisor telemetry (${final?.subtype ?? run.status})`);
  }
  const uses = new Map();
  for (const { type, message } of events) {
    if (type !== "assistant" || !Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "tool_use" && typeof part.id === "string") uses.set(part.id, part);
    }
  }
  return {
    valid: true,
    model: init.model ?? null,
    usage: final.usage,
    apiEquivalentUsd: Number.isFinite(final.total_cost_usd) ? final.total_cost_usd : null,
    durationMs: Number.isFinite(final.duration_ms) ? final.duration_ms : null,
    bashCalls: [...uses.values()].filter((part) => part.name === "Bash").length,
    localCheckCalls: [...uses.values()].filter((part) => part.name === "Bash" && /\bnpm\s+test\b/.test(part.input?.command ?? "")).length,
    delegateCalls: [...uses.values()].filter((part) => part.name === "mcp__meritrouter__delegate").length,
  };
}

export function fixtureDelta(dir, base, allowedPaths, acceptedIds) {
  git(dir, "add", "--all");
  const raw = git(dir, "diff", "--cached", "--numstat", "--no-renames", "-z", base);
  const outOfScope = [];
  let changedLines = 0;
  let workerLines = 0;
  for (const record of raw.split("\0").filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unexpected Git numstat");
    const [, added, deleted, file] = match;
    if (!allowedPaths.includes(file) || added === "-" || deleted === "-") {
      outOfScope.push(file);
      continue;
    }
    const lines = Number(added) + Number(deleted);
    changedLines += lines;
    if (!acceptedIds.length) continue;
    const commit = git(dir, "log", "-1", "--format=%H%x00%(trailers:key=Task,valueonly)", `${base}..HEAD`, "--", file).trim();
    const [hash, task] = commit.split("\0");
    if (!hash || !task || !acceptedIds.includes(task.trim())) continue;
    const fileDiff = spawnSync("git", ["diff", "--cached", "--quiet", hash, "--", file], { cwd: dir, windowsHide: true });
    // Attribute the net delta only if one accepted worker commit produced the entire final
    // delta for this file. A mix of supervisor and worker edits remains unattributed.
    if (fileDiff.status === 0 && git(dir, "diff", "--name-only", base, `${hash}^`, "--", file).trim() === "") workerLines += lines;
  }
  return { changedLines, workerLines, outOfScope };
}

export function summarizeComparison(results, suiteSize) {
  const baseline = results.filter((row) => row.arm === "baseline");
  const offload = results.filter((row) => row.arm === "offload");
  const passed = (rows) => rows.filter((row) => row.pass).length;
  const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
  const output = (rows) => sum(rows, (row) => row.claude.usage.output_tokens);
  const ratio = (part, total) => total > 0 ? part / total : null;
  const helped = offload.filter((row) => row.pass && row.worker?.acceptedIds.length && row.claude.delegateCalls > 0 &&
    (readOnly.has(row.kind) || row.delta.workerLines > 0)).length;
  const compared = baseline.length === offload.length && new Set(baseline.map((row) => row.task)).size === baseline.length &&
    new Set(offload.map((row) => row.task)).size === offload.length && baseline.every((before) =>
      offload.some((after) => after.task === before.task && before.claude.model && before.claude.model === after.claude.model));
  const passingCode = offload.filter((row) => row.pass && !readOnly.has(row.kind));
  const workerCommands = sum(offload, (row) => row.pass ? (row.worker?.acceptedChecks ?? 0) : 0);
  const supervisorChecks = sum(offload, (row) => row.claude.localCheckCalls);
  const spend = (rows) => rows.every((row) => row.claude.apiEquivalentUsd !== null)
    ? sum(rows, (row) => row.claude.apiEquivalentUsd) : null;
  const metrics = {
    fullSuite: compared && baseline.length === suiteSize,
    baselinePassed: passed(baseline),
    offloadPassed: passed(offload),
    tasksWithAcceptedOffload: helped,
    offloadedTaskShare: ratio(helped, offload.length),
    workerLineShare: ratio(sum(passingCode, (row) => row.delta.workerLines), sum(passingCode, (row) => row.delta.changedLines)),
    workerCheckShare: ratio(workerCommands, workerCommands + supervisorChecks),
    workerVerifiedChecks: workerCommands,
    supervisorCheckCalls: supervisorChecks,
    supervisorTerminalCalls: { baseline: sum(baseline, (row) => row.claude.bashCalls), offload: sum(offload, (row) => row.claude.bashCalls) },
    supervisorOutputTokens: { baseline: output(baseline), offload: output(offload) },
    supervisorOutputTokenReduction: output(baseline) ? 1 - output(offload) / output(baseline) : null,
    supervisorApiEquivalentUsd: { baseline: spend(baseline), offload: spend(offload) },
    workerRequests: sum(offload, (row) => row.worker?.requests ?? 0),
  };
  return {
    ...metrics,
    accepted: metrics.fullSuite && metrics.baselinePassed >= suiteSize - 1 &&
      metrics.offloadPassed >= metrics.baselinePassed - 1 && metrics.offloadedTaskShare >= 0.6 &&
      metrics.workerLineShare >= 0.6 && metrics.workerCheckShare >= 0.6 &&
      metrics.supervisorOutputTokenReduction >= 0.4,
  };
}

export function summarizeLocalFixtures({ rows, planned, suiteSize, model, compare }) {
  const sum = (selector) => rows.reduce((total, row) => total + selector(row), 0);
  const passed = rows.filter((row) => row.pass).length;
  const completeSuite = planned === suiteSize && rows.length === suiteSize && new Set(rows.map((row) => row.task)).size === suiteSize;
  const hasUsage = (usage) => Number.isSafeInteger(usage?.input) && usage.input >= 0 &&
    Number.isSafeInteger(usage?.output) && usage.output > 0;
  const paired = compare && rows.length === planned && rows.every((row) => hasUsage(row.baseline?.usage) && hasUsage(row.review?.usage));
  const tokens = (field) => paired ? { input: sum((row) => row[field].usage.input), output: sum((row) => row[field].usage.output) } : null;
  const baselineTokens = tokens("baseline");
  const reviewTokens = tokens("review");
  const baselinePassed = compare ? rows.filter((row) => row.baseline?.pass).length : null;
  const outputReduction = baselineTokens?.output ? 1 - reviewTokens.output / baselineTokens.output : null;
  const tokenTotal = (usage) => usage.input + usage.output;
  // Charge the measured direct attempt for each task returned to the supervisor.
  const fallbackTokens = paired ? {
    input: sum((row) => row.pass ? 0 : row.baseline.usage.input),
    output: sum((row) => row.pass ? 0 : row.baseline.usage.output),
  } : null;
  const estimatedOutputReduction = paired ? 1 - (reviewTokens.output + fallbackTokens.output) / baselineTokens.output : null;
  const offloadShare = passed / planned;
  const taskTargetMet = completeSuite && offloadShare >= 0.6;
  const qualityComparable = Boolean(paired && passed >= baselinePassed - 1);
  return {
    localModel: model, planned, completed: rows.length, passed, completeSuite, offloadShare, taskTargetMet,
    workerRequests: sum((row) => row.requests ?? 0),
    missingWorkerUsage: rows.filter((row) => !Number.isSafeInteger(row.requests)).length,
    workerChangedLines: sum((row) => row.pass ? (row.attribution?.changedLines ?? 0) : 0),
    baselinePassed, baselineTokens, reviewTokens, fallbackTokens, qualityComparable,
    supervisorOutputTokenReduction: outputReduction,
    supervisorTotalTokenReduction: baselineTokens ? 1 - tokenTotal(reviewTokens) / tokenTotal(baselineTokens) : null,
    estimatedOutputTokenReductionWithFallback: estimatedOutputReduction,
    estimatedTotalTokenReductionWithFallback: paired
      ? 1 - (tokenTotal(reviewTokens) + tokenTotal(fallbackTokens)) / tokenTotal(baselineTokens) : null,
    supervisorProxyTargetMet: taskTargetMet && qualityComparable && estimatedOutputReduction !== null && estimatedOutputReduction >= 0.4,
    results: rows,
  };
}
