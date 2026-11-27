import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { readFixtureResult } from "./isolated-router.mjs";

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

export function localBrief(raw, requests) {
  if (!readOnlyKinds.has(raw.kind)) throw new Error("Local smoke supports read-only fixture kinds");
  return {
    kind: raw.kind,
    goal: raw.goal,
    scope: { repository: "app", writable: false },
    context: {
      files: raw.contextFiles,
      notes: [
        "Put the complete answer in the result summary and findings. The supervisor writes ANSWER.md from that text.",
        `Use the supplied source references verbatim: ${raw.contextFiles.map((file) => `app:${file}`).join(", ")}.`,
        "Use index 0 for the sole criterion. If using submit_result, include selfCheck with notTested and assumptions arrays, a riskiestChange string, and a checkNext array.",
      ].join("\n"),
    },
    tools: ["list_files", "read_file", "search"],
    doneWhen: [raw.goal],
    budget: { requests },
    report: { detail: "brief" },
  };
}

export async function runLocalFixture({ config, mcpConfig, slug, dir, raw, source, requests, grade }) {
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
    const submitted = await call("delegate", { brief: localBrief(raw, requests) });
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
    const result = await readFixtureResult(config, slug, taskId);
    const expected = `ollama/${source.model}`;
    const available = result?.executionStatus === "completed" && result.servedEndpoints.length > 0 &&
      result.servedEndpoints.every((endpoint) => endpoint === expected);
    if (!available) {
      return {
        task: raw.id, pass: false, taskId, reason: result?.stopReason, diagnostic: result?.summary,
        servedEndpoints: result?.servedEndpoints, requests: result?.usage.modelRequests,
      };
    }
    const answer = [result.summary, ...result.findings.map((finding) => finding.description)].join("\n\n");
    writeFileSync(path.join(dir, "ANSWER.md"), answer, { flag: "wx" });
    const check = grade(raw.id, dir);
    const decision = await call(check.ok ? "accept" : "reject", { taskId, reason: check.output });
    return {
      task: raw.id, pass: check.ok && decision.acceptanceStatus === "met", taskId, check: check.output,
      servedEndpoints: result.servedEndpoints, requests: result.usage.modelRequests,
      providerAttempts: result.usage.providerAttempts, acceptance: decision.acceptanceStatus,
    };
  } finally {
    await client.close();
  }
}
