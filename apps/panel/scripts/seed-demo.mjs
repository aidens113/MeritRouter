#!/usr/bin/env node
// Builds a self-contained demo workspace for the panel in apps/panel/.demo/ (gitignored):
// a config, a git fixture repository, manual models, and real task/request history produced by
// running tasks through Switchyard with a scripted in-process gateway (no network, no quota).
//
//   pnpm --filter switchyard-router build
//   pnpm --filter switchyard-panel seed:demo
//   SWITCHYARD_CONFIG=.demo/switchyard.config.yaml pnpm --filter switchyard-panel dev
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { GatewayError, Switchyard, WorkerTaskSchema, insights, parseConfig } from "switchyard-router";

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, "..", ".demo");
const HOUR = 3_600_000;

// ---------- workspace ----------
try {
  rmSync(demo, { recursive: true, force: true });
} catch (err) {
  if (err.code === "EBUSY" || err.code === "EPERM") {
    console.error(`Cannot replace ${demo}: a running panel or worker still has the demo database open. Stop it and run this again.`);
    process.exit(1);
  }
  throw err;
}
mkdirSync(demo, { recursive: true });
const repo = path.join(demo, "repo");
const files = {
  "src/app.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  "src/server.ts":
    'import { add } from "./app";\n\nexport function handle(query: Record<string, string>) {\n  const a = Number(query.a);\n  const b = Number(query.b);\n  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("bad input");\n  return { sum: add(a, b) };\n}\n',
  "README.md": "# Calculator service\n\nA tiny fixture repository used by the SwitchYard panel demo.\n",
};
for (const [rel, content] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
}
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "add", "-A");
git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-q", "-m", "init");

const checkedAt = new Date().toISOString();
const ep = (o) => ({
  displayName: o.gatewayModelId,
  contextLimitTokens: 128000,
  outputLimitTokens: 8192,
  inputModalities: ["text"],
  supportsTools: true,
  supportsStructuredOutput: true,
  pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "free_platforms" },
  sourceUrls: [],
  checkedAt,
  ...o,
  id: `${o.providerId}/${o.gatewayModelId}`,
});

const endpoints = [
  ep({
    providerId: "nvidia",
    gatewayModelId: "meta/llama-3.3-70b-instruct",
    displayName: "Llama 3.3 70B Instruct",
    totalParametersB: 70.6,
    activeParametersB: null,
    params: { source: "huggingface", confidence: "exact", confirmed: true, evidence: [{ source: "huggingface", totalB: 70.6, activeB: null, detail: "safetensors total 70,553,706,496 (meta-llama/Llama-3.3-70B-Instruct)" }, { source: "name", totalB: 70, activeB: null, detail: "'70b' in model id" }] },
    outputLimitTokens: 4096,
    outputLimitSource: "default",
    sourceUrls: ["https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct"],
    rateLimits: { rpm: 40, rpd: null },
  }),
  ep({
    providerId: "groq",
    gatewayModelId: "openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B",
    totalParametersB: 117,
    activeParametersB: 5.1,
    params: { source: "huggingface", confidence: "exact", confirmed: true, evidence: [{ source: "huggingface", totalB: 116.8, activeB: null, detail: "safetensors total (openai/gpt-oss-120b)" }, { source: "description", totalB: 117, activeB: 5.1, detail: "'117B parameters with 5.1B active' in description" }] },
    contextLimitTokens: 131072,
    outputLimitTokens: 32768,
    outputLimitSource: "provider",
    sourceUrls: ["https://huggingface.co/openai/gpt-oss-120b", "https://console.groq.com/docs/models"],
    rateLimits: { rpm: 30, rpd: 1000, tpm: 8000 },
  }),
  ep({
    providerId: "cerebras",
    gatewayModelId: "qwen-3-235b-a22b-instruct-2507",
    displayName: "Qwen3 235B A22B",
    totalParametersB: 235,
    activeParametersB: 22,
    params: { source: "name", confidence: "heuristic", confirmed: true, evidence: [{ source: "name", totalB: 235, activeB: 22, detail: "'235b-a22b' in model id" }] },
    contextLimitTokens: 65536,
    outputLimitTokens: 16000,
    outputLimitSource: "provider",
  }),
  ep({
    providerId: "openrouter",
    gatewayModelId: "qwen/qwen3-coder:free",
    displayName: "Qwen3 Coder 480B A35B",
    totalParametersB: 480,
    activeParametersB: 35,
    params: { source: "huggingface", confidence: "agreed", confirmed: true, evidence: [{ source: "description", totalB: 480, activeB: 35, detail: "'480B total, 35B active' in description" }, { source: "name", totalB: 480, activeB: 35, detail: "hugging_face_id Qwen/Qwen3-Coder-480B-A35B-Instruct" }] },
    contextLimitTokens: 262144,
    outputLimitTokens: 8000,
    outputLimitSource: "provider",
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "openrouter_price" },
    sourceUrls: ["https://openrouter.ai/qwen/qwen3-coder:free"],
  }),
  ep({
    providerId: "openrouter",
    gatewayModelId: "z-ai/glm-4.5-air:free",
    displayName: "GLM 4.5 Air",
    totalParametersB: 106,
    activeParametersB: 12,
    params: { source: "description", confidence: "heuristic", confirmed: false, evidence: [{ source: "description", totalB: 106, activeB: 12, detail: "'106B total parameters with 12B active' in description" }] },
    contextLimitTokens: 131072,
    outputLimitTokens: 4096,
    outputLimitSource: "default",
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "openrouter_price" },
  }),
  ep({
    providerId: "google",
    gatewayModelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    totalParametersB: null,
    activeParametersB: null,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] },
    contextLimitTokens: 1048576,
    outputLimitTokens: 65536,
    outputLimitSource: "provider",
    inputModalities: ["text", "image", "audio", "video", "file"],
  }),
  ep({
    providerId: "openrouter",
    gatewayModelId: "mistralai/mistral-small-3.2-24b-instruct:free",
    displayName: "Mistral Small 3.2 24B",
    totalParametersB: 24,
    activeParametersB: null,
    params: { source: "name", confidence: "agreed", confirmed: true, evidence: [{ source: "name", totalB: 24, activeB: null, detail: "'24b' in model id" }, { source: "description", totalB: 24, activeB: null, detail: "'24B parameters' in description" }] },
    inputModalities: ["text", "image"],
    contextLimitTokens: 96000,
    outputLimitTokens: 8192,
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "openrouter_price" },
  }),
  ep({
    providerId: "groq",
    gatewayModelId: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B Instant",
    totalParametersB: 8,
    activeParametersB: null,
    supportsStructuredOutput: false,
    contextLimitTokens: 131072,
    outputLimitTokens: 8192,
  }),
  ep({
    providerId: "github",
    gatewayModelId: "openai/gpt-4.1",
    displayName: "GPT-4.1",
    totalParametersB: null,
    activeParametersB: null,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] },
    enabled: false,
    inputModalities: ["text", "image"],
    pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8, freeVerified: false, source: "manual" },
    notes: "Paid model; listed for comparison only.",
  }),
];

writeFileSync(
  path.join(demo, "models.yaml"),
  `# Demo catalog written by scripts/seed-demo.mjs\n${YAML.stringify({ version: 1, overrides: {}, endpoints })}`,
);

const agent = path.join(here, "demo-agent.mjs");
const raw = {
  version: 1,
  gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_chains: false },
  storage: { directory: ".switchyard" },
  models: { file: "models.yaml" },
  discovery: { interval_minutes: 0, free_platforms: ["groq", "nvidia", "cerebras", "google"] },
  repositories: { core: { path: "repo" } },
  execution: { max_concurrent_tasks: 4, lease_seconds: 30 },
  scoring: { batch_window_ms: 50 },
  coding: { runner: "command", command: `node "${agent}"` },
  profiles: {
    summarize: { mode: "completion", min_total_parameters_b: 30, max_model_requests: 4, max_output_tokens: 2000, classify: "never", batching: { enabled: true, max_items: 4, per_item_output_tokens: 500 } },
    inspect: { mode: "read_only", min_total_parameters_b: 30, max_model_requests: 4, tools: "repository_read", classify: "never" },
    analyze: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 6, tools: "repository_read_and_artifacts", classify: "auto", min_tier: "T2" },
    implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" },
    review: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 4, tools: "repository_read_and_artifacts" },
  },
};
const configPath = path.join(demo, "switchyard.config.yaml");
writeFileSync(
  configPath,
  `# SwitchYard demo configuration (generated by apps/panel/scripts/seed-demo.mjs).\n# The gateway URL is a placeholder: the demo data was produced by a scripted in-process gateway.\n${YAML.stringify(raw)}`,
);
const cfg = parseConfig(raw, configPath);

// ---------- scripted gateway ----------
let offset = 0; // how far in the past "now" is for the phase being recorded
const clock = () => Date.now() - offset;
let scenario = "ok";
let sy;

const served = (req) => {
  const chain = req.model.replace(/^auto:/, "");
  const e = sy.catalog.endpoints().find((x) => x.chainName === chain);
  return { model: e.gatewayModelId, provider: e.providerId, id: e.id };
};
const usage = (i, o) => ({ inputTokens: i, outputTokens: o, cachedInputTokens: Math.round(i * 0.2), reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" });
const reply = (content, s, o = {}) => ({
  message: { content, ...(o.toolCalls ? { tool_calls: o.toolCalls } : {}) },
  finishReason: o.toolCalls ? "tool_calls" : "stop",
  usage: usage(o.in ?? 900 + Math.round(Math.random() * 2600), o.out ?? 120 + Math.round(Math.random() * 600)),
  telemetry: { servedModel: s.model, servedProvider: s.provider, providerAttempts: o.attempts ?? 1, providerAttemptsExact: false, cacheHit: false, headers: {} },
  httpStatus: 200,
});
const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join("") : "");
const result = (criteria, ref, summary) => ({
  summary,
  findings: [{ description: summary, evidenceRefs: [ref] }],
  criteria: Array.from({ length: criteria }, (_, i) => ({ index: i, status: "met", evidenceRefs: [ref] })),
});
let callNo = 0;

const client = {
  name: "demo-scripted",
  async complete(req) {
    callNo++;
    const s = served(req);
    const sys = textOf(req.messages[0]);
    const user = textOf(req.messages[1]);
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 40));

    if (scenario === "rate_limit_first" && s.id === "nvidia/meta/llama-3.3-70b-instruct") {
      throw new GatewayError("rate_limited", "429 Too Many Requests from nvidia (all keys cooling down)", 429, 30_000, false);
    }
    if (scenario === "policy" && s.id === "nvidia/meta/llama-3.3-70b-instruct") {
      return reply(JSON.stringify(result(1, "inline", "done")), { model: "meta/llama-3.1-8b-instruct", provider: "nvidia" });
    }

    // Difficulty classifier (batched, ids c1..cN).
    if (sys.startsWith("You classify software tasks")) {
      const ids = [...user.matchAll(/<item id="(c\d+)">/g)].map((m) => m[1]);
      const items = ids.map((id) => ({
        id,
        tags: { kind: "diagnose", reasoning: "multi_step", novelty: "existing_pattern", risk: ["public_api_change"], environment: [], ambiguity: "low" },
        confidence: 0.82,
        rationale: "Needs to follow input validation across two files and explain the failure mode.",
        suggestedTier: "T2",
      }));
      return reply(JSON.stringify({ items }), s, { in: 600, out: 90 });
    }

    // Prompt batches of summarize tasks (ids i1..iN).
    const batchIds = [...user.matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]);
    if (batchIds.length) {
      const items = batchIds.map((id) => ({ id, result: result(1, "inline", "The log shows a timeout while connecting to the database at step 3.") }));
      return reply(JSON.stringify({ items }), s);
    }

    if (scenario === "garbage") return reply("Sure! Here is a summary of the log: it failed.", s);

    // Read-only investigations: read a file first, then submit_result citing it.
    if (req.tools?.length) {
      const toolTurns = req.messages.filter((m) => m.role === "tool").length;
      if (toolTurns === 0) {
        return reply(null, s, { toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ alias: "core", path: "src/server.ts" }) } }], out: 40 });
      }
      const criteria = (user.match(/^\s*\[\d+\]/gm) ?? []).length || 1;
      const out = {
        summary: "handle() parses a and b with Number(); empty strings become 0, so a missing parameter silently sums as 0 instead of failing.",
        findings: [
          { description: "Number('') is 0, so a missing query parameter is not rejected by the NaN check.", evidenceRefs: ["core:src/server.ts#L4-L6"] },
          { description: "add() itself is correct; the problem is input validation in handle().", evidenceRefs: ["core:src/server.ts#L1-L1"] },
        ],
        criteria: Array.from({ length: criteria }, (_, i) => ({ index: i, status: i === 0 ? "met" : "unknown", evidenceRefs: ["core:src/server.ts#L4-L6"], ...(i ? { note: "Could not confirm without running the service." } : {}) })),
      };
      return reply(null, s, { toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name: "submit_result", arguments: JSON.stringify(out) } }] });
    }

    // Coding agent traffic through the job gateway, and plain completions.
    if (!sys.includes("bounded worker")) return reply("Plan: add subtract() next to add() and export it.", s, { in: 1500, out: 200 });
    return reply(JSON.stringify(result(1, "inline", "The log reports ERROR: boom at step 3, after the connection pool was exhausted.")), s);
  },
};

let coding = null;
try {
  const mod = await import(pathToFileURL(path.resolve(here, "../../../packages/router/dist/runners/coding/index.js")).href);
  coding = mod.createCodingRunner(cfg);
} catch (err) {
  console.warn(`coding runner unavailable (${err.message}); the implement task will fail instead`);
}

sy = new Switchyard(cfg, { client, admin: null, coding, now: clock, pollIntervalMs: 40 });
const started = { v: false };
const startWorker = () => {
  if (!started.v) sy.startWorker(40);
  started.v = true;
};

async function phase(hoursAgo, label, tasks, opts = {}) {
  offset = Math.round(hoursAgo * HOUR);
  scenario = opts.scenario ?? "ok";
  const subs = await sy.submitTasks(tasks);
  startWorker();
  const out = await sy.awaitResults(subs.map((s) => s.taskId), { timeoutSeconds: opts.timeout ?? 60 });
  const states = out.completed.map((r) => `${r.executionStatus}${r.acceptanceStatus !== "not_verified" ? `/${r.acceptanceStatus}` : ""}`);
  console.log(`  ${label.padEnd(44)} ${states.join(", ")}${out.timedOut ? " (timed out)" : ""}`);
  return out;
}

const summarize = (goal, extra = {}) => ({
  profile: "summarize",
  goal,
  context: { inlineText: `2026-10-19T08:12:03Z INFO start job\n2026-10-19T08:12:05Z WARN pool at 95%\n2026-10-19T08:12:09Z ERROR: boom at step 3 (connection timeout)\n` },
  constraints: { acceptanceCriteria: ["mentions the error and the step it happened at"] },
  ...extra,
});
const accessLog = (lines) =>
  Array.from({ length: lines }, (_, i) => `2026-10-1${i % 7}T0${i % 10}:00:00Z GET /v1/chat/completions 200 ${300 + (i % 97)}ms key=${i % 4} model=auto:sy-${(i * 7919).toString(16).padStart(6, "0")}`).join(String.fromCharCode(10));
const inspect = (goal) => ({ profile: "inspect", goal, repositoryAliases: ["core"], context: { fileRefs: ["core:src/server.ts"] }, constraints: { acceptanceCriteria: ["cites the exact lines"] } });

console.log(`Seeding demo workspace in ${demo}`);

// Routing overrides first so they shape the recorded history.
insights.addRoutingOverride(sy, { profile: "review", tier: null, kind: "prefer", endpointId: "cerebras/qwen-3-235b-a22b-instruct-2507", allowBelowFloor: false, note: "Reviews read better from Qwen3 235B in our spot checks.", enabled: true });
insights.addRoutingOverride(sy, { profile: "summarize", tier: "T1", kind: "block", endpointId: "openrouter/qwen/qwen3-coder:free", allowBelowFloor: false, note: "Keep the 480B coder quota for implementation work.", enabled: true });
insights.addRoutingOverride(sy, { profile: "implement", tier: "T2", kind: "force", endpointId: "openrouter/qwen/qwen3-coder:free", allowBelowFloor: false, note: "Trial: force the coder model for T2 implementation (disabled).", enabled: false });
insights.setModelOverride(sy, "openrouter/qwen/qwen3-coder:free", { deniedProfiles: ["summarize"], note: "Reserved for code work." });
insights.setModelOverride(sy, "groq/llama-3.1-8b-instant", { forceStatus: "disabled", note: "Too small for any configured task type." });

await phase(22, "summaries (morning)", [summarize("Summarise the nightly job log"), summarize("Summarise the deploy log for release 4.2"), summarize("Summarise the cron failure log")]);
await phase(19.5, "inspections", [inspect("Where does handle() validate its input?"), inspect("Which function does the addition and where is it imported?")]);
await phase(17, "fallback: nvidia rate limited -> next model", [summarize("Summarise the queue worker log after the outage")], { scenario: "rate_limit_first" });
await phase(14, "analysis (classifier scores it)", [
  {
    profile: "analyze",
    goal: "Explain why GET /sum?a=2 returns {sum: 2} instead of an error and propose a fix.",
    repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/server.ts", "core:src/app.ts"] },
    constraints: { acceptanceCriteria: ["identifies the root cause with line references", "proposes a minimal fix", "states how to verify it"] },
  },
]);
await phase(11, "batch of three summaries (one request)", [summarize("Summarise shard 1 log"), summarize("Summarise shard 2 log"), summarize("Summarise shard 3 log")]);
await phase(9, "failure: model returns prose instead of JSON", [summarize("Summarise the billing export log")], { scenario: "garbage" });
await phase(7, "review (preferred model override)", [
  { profile: "review", goal: "Review the input validation in handle() for edge cases.", repositoryAliases: ["core"], context: { fileRefs: ["core:src/server.ts"] }, constraints: { acceptanceCriteria: ["lists each unhandled edge case", "rates severity"] } },
]);
await phase(5, "implement in an isolated worktree", [
  {
    profile: "implement",
    goal: "Add a subtract(a, b) function to src/app.ts next to add().",
    repositoryAliases: ["core"],
    writableRepository: "core",
    hints: { difficulty: "T2" },
    constraints: {
      acceptanceCriteria: ["subtract is exported from src/app.ts"],
      allowedPaths: ["src/**"],
      checks: [`node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('subtract')?0:1)"`],
    },
  },
], { timeout: 120 });
await phase(3, "too large: returned to the supervisor (T4)", [
  summarize("Summarise this full week of gateway access logs", {
    context: { inlineText: accessLog(4200) },
  }),
]);
await phase(1.5, "served-model mismatch (quarantine)", [summarize("Summarise the auth service log", { routing: { endpointId: "nvidia/meta/llama-3.3-70b-instruct" } })], { scenario: "policy" });
await phase(0.5, "recent summaries", [summarize("Summarise the latest canary log"), inspect("Is add() covered by any validation?")]);

// Qualification history (illustrative rows so the leaderboard has content).
const qual = sy.db;
const insertRun = qual.prepare("INSERT INTO qualification_runs (id, endpoint_id, suite_version, status, started_at, finished_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertRes = qual.prepare("INSERT INTO qualification_results (run_id, endpoint_id, eval_id, family, tier, trial, outcome, task_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)");
const plan = [
  ["groq/openai/gpt-oss-120b", { completion: [0.9, 0.8, 0.7], read_only: [0.85, 0.7, 0.5] }],
  ["cerebras/qwen-3-235b-a22b-instruct-2507", { completion: [0.95, 0.9, 0.8], read_only: [0.9, 0.8, 0.65], coding: [0.8, 0.7, 0.55] }],
  ["nvidia/meta/llama-3.3-70b-instruct", { completion: [0.85, 0.6, 0.35], read_only: [0.7, 0.45, 0.2] }],
  ["openrouter/qwen/qwen3-coder:free", { coding: [0.9, 0.85, 0.7], read_only: [0.85, 0.75, 0.6] }],
];
const tiers = ["T1", "T2", "T3"];
let seedRand = 7;
const rand = () => ((seedRand = (seedRand * 16807) % 2147483647) / 2147483647);
qual.transaction(() => {
  for (const [endpointId, fams] of plan) {
    const runId = `qr_demo_${endpointId.replace(/[^a-z0-9]+/gi, "_")}`;
    const t0 = Date.now() - 30 * HOUR;
    insertRun.run(runId, endpointId, "demo-suite-1", "completed", t0, t0 + 40 * 60_000, JSON.stringify({ demo: true }));
    for (const [family, rates] of Object.entries(fams)) {
      tiers.forEach((tier, ti) => {
        for (let trial = 0; trial < 6; trial++) {
          const outcome = rand() < rates[ti] ? "pass" : rand() < 0.1 ? "infra_error" : "fail";
          insertRes.run(runId, endpointId, `${family}-${tier.toLowerCase()}-${(trial % 3) + 1}`, family, tier, Math.floor(trial / 3) + 1, outcome, JSON.stringify({ demo: true }), t0 + trial * 60_000);
        }
      });
    }
  }
})();

await sy.close();

// Tasks left in non-terminal states for the Tasks page. They go straight into the store:
// submitTasks() would kick the scheduler and run them in this process.
offset = 0;
const idle = new Switchyard(cfg, { client, admin: null, worker: false });
const store = (specs) => idle.tasks.submit(specs.map((x) => WorkerTaskSchema.parse(x)));
const [queued] = store([summarize("Summarise the payments log (queued: no worker running)")]);
store([summarize("Summarise the follow-up incident report", { id: "followup_after_payments", dependsOn: [queued.taskId] })]);
const [interrupted] = store([inspect("List every exported function (interrupted when the worker stopped)")]);
idle.db.prepare("UPDATE tasks SET state = 'interrupted', state_reason = 'worker lease expired', started_at = ?, run_count = 1, updated_at = ? WHERE id = ?").run(Date.now() - 20 * 60_000, Date.now(), interrupted.taskId);
idle.tasks.event(interrupted.taskId, "interrupted", { previousOwner: "demo-worker" });
await idle.close();

console.log(
  `\nDemo ready. Start the panel against it with:\n  SWITCHYARD_CONFIG="${configPath}" pnpm --filter switchyard-panel dev\n(a relative SWITCHYARD_CONFIG resolves against apps/panel, e.g. SWITCHYARD_CONFIG=.demo/switchyard.config.yaml)`,
);
if (!existsSync(path.join(demo, ".switchyard"))) process.exitCode = 1;
