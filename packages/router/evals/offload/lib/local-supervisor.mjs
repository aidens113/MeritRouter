import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { readFixtureState } from "./isolated-router.mjs";
import { materializeWorkerCandidate } from "./fixture-candidate.mjs";

export const readOnlyKinds = new Set(["scout", "summarize", "review"]);
const LocalTags = z.object({ models: z.tuple([z.object({
  name: z.string().min(1), size: z.number().int().min(1_000_000),
  remote_host: z.string().optional(), remote_model: z.string().optional(),
})]) });

export async function localModelSource(address, model) {
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" ||
      !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("--ollama-url must identify an isolated 127.0.0.1 HTTP listener");
  }
  const response = await fetch(new URL("/api/tags", url), { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama model listing failed (HTTP ${response.status})`);
  const tags = LocalTags.safeParse(await response.json());
  const entry = tags.success ? tags.data.models[0] : null;
  if (!entry || entry.name !== model || entry.remote_host || entry.remote_model || /(?:^|[-:])cloud(?:$|[-:])/i.test(model)) {
    throw new Error("Start an isolated Ollama instance with one downloaded local model and cloud disabled");
  }
  return { url: url.origin, model };
}

export function localBrief(raw, requests, allowCode = false) {
  const writable = !readOnlyKinds.has(raw.kind);
  if (writable && !allowCode) throw new Error("Coding fixtures require an independent container grader");
  const refs = raw.contextFiles.map((file) => `app:${file}`);
  const terminalShape = JSON.stringify({
    summary: "Describe the actual finding or change", findings: [],
    criteria: [{ index: 0, status: writable ? "unknown" : "met", evidenceRefs: refs.slice(0, 1) }],
    selfCheck: { notTested: [], assumptions: [], riskiestChange: "State any risk", checkNext: [] },
  });
  return {
    kind: writable ? "edit" : raw.kind,
    goal: raw.goal,
    scope: { repository: "app", writable, ...(writable ? { allowedPaths: raw.allowedPaths } : {}) },
    context: {
      files: raw.contextFiles,
      notes: [
        writable
          ? "Use the provided context below. If source is missing, call read_files once with {\"alias\":\"app\",\"files\":[{\"path\":\"src/example.ts\"}]} using the actual paths. For each changed file call write_file with its relative path and full updated content. The supervisor runs the fixture check independently. Report checks you could not run in selfCheck.notTested and mark any criterion that depends on that check unknown. Use unmet only for an observed failure or omitted work."
          : "Put the complete answer in the result summary and findings. The supervisor writes ANSWER.md from that text.",
        ...(writable && raw.prompt ? [`Fixture requirements: ${raw.prompt}`] : []),
        `Use the supplied source references verbatim: ${refs.join(", ")}.`,
        ...(raw.kind === "summarize" ? [] : [`Call submit_result with these top-level fields, replacing the sample text with your result: ${terminalShape}`]),
      ].join("\n"),
    },
    tools: writable ? ["read_files", "search_text", "write_file"] : ["list_files", "read_file", "search"],
    doneWhen: [raw.goal],
    budget: { requests },
    report: { detail: "brief" },
  };
}

export async function runLocalFixture({ config, mcpConfig, slug, dir, base, raw, source, requests, grade, gradeCoding, review }) {
  const { mcpServers } = JSON.parse(readFileSync(mcpConfig, "utf8"));
  const client = new Client({ name: "local-offload-stdio-supervisor", version: "1" });
  let taskId;
  try {
    await client.connect(new StdioClientTransport({ ...mcpServers.meritrouter, cwd: dir }));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
      const message = result.content?.[0]?.text;
      if (result.isError || typeof message !== "string") throw new Error(message ?? `MCP ${name} failed`);
      return JSON.parse(message);
    };
    const writable = !readOnlyKinds.has(raw.kind);
    const submitted = await call("delegate", { brief: localBrief(raw, requests, Boolean(gradeCoding)) });
    if (!submitted.ok || typeof submitted.taskId !== "string") throw new Error(`Brief rejected: ${JSON.stringify(submitted.errors)}`);
    taskId = submitted.taskId;
    if (submitted.routePreview?.excluded?.some(({model}) => model === `ollama/${source.model}`) &&
        !submitted.routePreview.candidates?.includes(`ollama/${source.model}`)) {
      console.log(`Route preview for ${source.model}: ${JSON.stringify(submitted.routePreview.excluded)}`);
    }
    const outcome = await call("await", { taskIds: [taskId], timeoutSeconds: 240, detail: "brief" });
    if (!outcome.completed?.includes(taskId)) {
      return { task: raw.id, pass: false, taskId, reason: "The worker did not submit a completed report in the wait window" };
    }
    const { result, candidate, toolTrace } = await readFixtureState(config, slug, taskId);
    const expected = `ollama/${source.model}`;
    const available = result?.executionStatus === "completed" && result.servedEndpoints.length > 0 &&
      result.servedEndpoints.every((endpoint) => endpoint === expected);
    if (!available) {
      return {
        task: raw.id, pass: false, taskId, reason: result?.stopReason, diagnostic: result?.summary,
        servedEndpoints: result?.servedEndpoints, requests: result?.usage.modelRequests, toolTrace,
      };
    }
    let check;
    let attribution;
    const report = [result.summary, ...result.findings.map((finding) => finding.description)].join("\n\n");
    if (writable) {
      if (!candidate || candidate.baseCommit !== base || result.baseCommits.app !== base || result.scopeViolation?.length) {
        return { task: raw.id, pass: false, taskId, requests: result.usage.modelRequests, reason: "No in-scope worker candidate on the fixture base" };
      }
      attribution = materializeWorkerCandidate(dir, { base, head: candidate.head, taskId, endpoint: expected, allowedPaths: raw.allowedPaths });
      check = await gradeCoding(raw.id, dir);
    } else {
      writeFileSync(path.join(dir, "ANSWER.md"), report, { flag: "wx" });
      check = grade(raw.id, dir);
    }
    const reviewEvidence = review ? await review({ report, check: check.output, checkPassed: check.ok }) : undefined;
    const refusal = result.acceptanceStatus === "unmet"
      ? ["MeritRouter marked the worker result unmet.", ...result.verification?.reasons ?? []].join(" ").slice(0, 900)
      : undefined;
    const accepted = !refusal && check.ok && (!review || (reviewEvidence?.ok && reviewEvidence.recommendation === "accept"));
    const reason = [refusal, reviewEvidence?.reason, check.output].filter(Boolean).join("\n").slice(0, 4000) || "Fixture grading produced no output";
    let acceptance = result.acceptanceStatus;
    let decisionError;
    try {
      acceptance = (await call(accepted ? "accept" : "reject", { taskId, reason })).acceptanceStatus;
    } catch (error) {
      decisionError = error.message;
    }
    return {
      task: raw.id, pass: accepted && !decisionError && acceptance === "met", taskId, check: check.output, checkPassed: check.ok,
      ...(refusal || decisionError ? { reason: decisionError ?? refusal, diagnostic: report, toolTrace } : {}),
      ...(attribution ? { attribution } : {}), ...(reviewEvidence ? { review: reviewEvidence } : {}),
      servedEndpoints: result.servedEndpoints, requests: result.usage.modelRequests,
      providerAttempts: result.usage.providerAttempts, acceptance,
    };
  } finally {
    await client.close();
  }
}
