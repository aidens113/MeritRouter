#!/usr/bin/env node
// Builds a self-contained demo workspace for the panel in apps/panel/.demo/ (gitignored):
// a config with three projects (demo: the calculator service, with `core` and `app` repositories;
// storefront, whose repository is also aliased `app`; legacy-billing, archived at the end), their
// git fixture repositories, manual models, and real task/request history produced by
// running tasks through Switchyard with a scripted in-process provider client (no network, no
// quota). Every provider (built-in ones with fake keys, a custom keyless "lab" server, and the paid
// Anthropic route) points at 127.0.0.1 on a closed port, as do the OpenRouter catalog and Hugging
// Face lookups, so pressing Scan or Test in the panel never leaves the machine: listings just fail.
// Independent reviews come from the same scripted client: one unqualified reviewer that cannot
// settle a criterion, and one qualified reviewer that fails an answer, sees it repaired, and passes it.
// Calibration gets real signals too: a job that integrates a reviewed power() change and later
// undoes it (a false approval), a reviewer fail a person overrules (a false rejection), a reused
// verdict, and two forced background audits (one agrees, one disagrees).
// It also runs three more standalone jobs (one finished, one planned as a diamond task graph with
// plan_work where two coding nodes contend for a file lease, one paused on a question), fills the
// brain (in .demo/brain, never your home folder), and records a little paid spend through a fake
// direct paid client, so the Jobs, Brain, and Provider keys pages have content. A nested team job
// (parent -> sub-supervisor -> two workers) shows the team view: a carved sub-job budget, two
// integrations onto the sub-job's branch where the second is rebased, team channel posts of each
// kind, and a redundant plan node whose twin runs race. One team-vs-single comparison is
// recorded (the same read-only goal as a two-node team job and as one agent) for the Teams view;
// every job's metrics come from the stored runs themselves. Agent sessions (and
// their event logs) come from those runs themselves; only the interrupted task's session, which
// never ran, is recorded by hand (through the same store calls a worker makes, including one
// resume), so it shows a `resumed` event and the Resume action. Web search is on through a pool of a
// fake Tavily key and a SearXNG instance at the same closed local port; one inspection searches
// (Tavily answers 429 and cools down, SearXNG answers) and fetches a page through fake web
// transports (no request leaves the machine), so tasks, sessions, and the keys page show web calls.
//
//   pnpm --filter switchyard-router build
//   pnpm --filter switchyard-panel seed:demo
//   SWITCHYARD_CONFIG=.demo/switchyard.config.yaml pnpm --filter switchyard-panel dev
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { GatewayError, ProviderError, Switchyard, WorkerTaskSchema, insights, parseConfig, planComparison, runComparison } from "switchyard-router";

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
/** A git fixture repository with one commit. */
function fixtureRepo(dir, contents) {
  for (const [rel, content] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "add", "-A");
  git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-q", "-m", "init");
}
fixtureRepo(repo, files);
// Three projects (the panel's grid): the calculator service (two repositories, the `core` one
// every recorded task works in, and a web front end aliased `app`), a storefront whose only
// repository is also aliased `app` (aliases are per project), and an archived billing project.
fixtureRepo(path.join(demo, "web"), { "index.html": "<!doctype html><title>Calculator</title>\n", "README.md": "# Calculator web front end\n" });
fixtureRepo(path.join(demo, "storefront"), { "src/cart.ts": "export function total(items: Array<{ price: number; qty: number }>) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n", "README.md": "# Storefront\n" });
fixtureRepo(path.join(demo, "billing"), { "invoice.py": "def total(lines):\n    return sum(l['amount'] for l in lines)\n", "README.md": "# Legacy billing\n" });

const checkedAt = new Date().toISOString();
const ep = (o) => ({
  displayName: o.gatewayModelId,
  contextLimitTokens: 128000,
  outputLimitTokens: 8192,
  inputModalities: ["text"],
  supportsTools: true,
  supportsStructuredOutput: true,
  pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, source: "demo" },
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
    // Per-model limits are enforced; a tokens-per-minute limit would push the demo's quick runs onto other models.
    rateLimits: { rpm: 30, rpd: 1000 },
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
    providerId: "openai",
    gatewayModelId: "gpt-4.1",
    displayName: "GPT-4.1",
    totalParametersB: null,
    activeParametersB: null,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] },
    enabled: false,
    inputModalities: ["text", "image"],
    pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8, freeVerified: false, source: "manual" },
    notes: "Paid model; listed for comparison only.",
  }),
  // Native web search (decision D9): one model whose search is turned on for tasks that need the
  // web, and one that searches on every request. Both are priced, so they serve only paid requests.
  ep({
    providerId: "openrouter",
    gatewayModelId: "anthropic/claude-haiku-4.5",
    displayName: "Claude Haiku 4.5 (OpenRouter)",
    totalParametersB: null,
    activeParametersB: null,
    ignoreSizeFloor: true,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] },
    contextLimitTokens: 200000,
    outputLimitTokens: 16000,
    outputLimitSource: "provider",
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 5, freeVerified: false, source: "openrouter_price" },
    nativeWebSearch: { via: "openrouter_plugin", engine: "native", usdPerSearch: 0.01, priceDetail: "OpenRouter pricing.web_search (USD per web search)", source: "discovery", detail: "OpenRouter supported_parameters includes web_search_options", sourceUrl: "https://openrouter.ai/docs/api/api-reference/models/get-models", checkedAt: "2026-10-21" },
    sourceUrls: ["https://openrouter.ai/anthropic/claude-haiku-4.5"],
  }),
  ep({
    providerId: "openrouter",
    gatewayModelId: "perplexity/sonar",
    displayName: "Perplexity Sonar",
    totalParametersB: null,
    activeParametersB: null,
    ignoreSizeFloor: true,
    params: { source: "unknown", confidence: "unknown", confirmed: false, evidence: [] },
    contextLimitTokens: 127000,
    outputLimitTokens: 8000,
    outputLimitSource: "provider",
    supportsTools: false,
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1, freeVerified: false, source: "openrouter_price" },
    nativeWebSearch: { via: "always_on", usdPerSearch: 0.005, priceDetail: "OpenRouter pricing.request (one search per request assumed)", source: "registry", detail: "OpenRouter: Perplexity models search natively by default; SwitchYard never sends the switch that turns it off", sourceUrl: "https://openrouter.ai/docs/guides/features/web-search", checkedAt: "2026-10-21" },
    sourceUrls: ["https://openrouter.ai/perplexity/sonar"],
  }),
];

writeFileSync(
  path.join(demo, "models.yaml"),
  `# Demo catalog written by scripts/seed-demo.mjs\n${YAML.stringify({ version: 1, overrides: {}, endpoints })}`,
);

// One fake free_tier key per provider the demo models use: only the scripted provider client sees
// them. Each provider's base URL points at a closed local port, so a panel Scan or key Test fails
// fast without any request leaving the machine.
const OFFLINE = "http://127.0.0.1:9";
const demoKey = (id, extra = {}) => ({ base_url: `${OFFLINE}/${id}/v1`, ...extra, keys: [{ label: `demo ${id} key (fake)`, api_key: `demo-${id}-NOT-A-REAL-KEY`, billing_class: "free_tier" }] });
const raw = {
  version: 1,
  providers: {
    nvidia: demoKey("nvidia"),
    groq: demoKey("groq"),
    cerebras: demoKey("cerebras"),
    openrouter: demoKey("openrouter"),
    // Google lists models at an absolute URL outside its base URL; models_path keeps the list offline too.
    google: demoKey("google", { models_path: "/models" }),
    // A custom keyless server (a local Ollama or llama.cpp would look like this).
    lab: { display_name: "Lab server (demo)", base_url: `${OFFLINE}/lab/v1`, no_key: true },
  },
  storage: { directory: ".switchyard" },
  models: { file: "models.yaml" },
  // Enrichment sources are offline too: the demo never fetches the OpenRouter catalog or Hugging Face.
  discovery: { interval_minutes: 0, openrouter_models_url: `${OFFLINE}/openrouter-catalog/models`, huggingface_api_url: `${OFFLINE}/huggingface/api/models` },
  projects: {
    demo: { name: "Calculator service", repositories: { core: { path: "repo" }, app: { path: "web" } } },
    storefront: { name: "Storefront", repositories: { app: { path: "storefront" } }, team: { max_agents: 2 } },
    "legacy-billing": { name: "Legacy billing", repositories: { billing: { path: "billing", writable: false } } },
  },
  execution: { max_concurrent_tasks: 4, lease_seconds: 30 },
  scoring: { batch_window_ms: 50 },
  coding: { runner: "native" },
  // The brain lives inside the demo folder so seeding never touches ~/.switchyard/brain.
  brain: { path: "brain", project: "demo", access_approver: "supervisor", global_requires_approval: true },
  supervisor: { question_timeout_seconds: 86400 },
  // Agents' web search: a pool of a (fake) Tavily key and a SearXNG instance, both on the closed
  // port; the seed answers them in-process. Tavily answers 429, so the call moves on to SearXNG.
  web: { search: { tavily: { api_key: "demo-tavily-NOT-A-REAL-KEY", base_url: `${OFFLINE}/tavily` }, searxng: { base_url: `${OFFLINE}/searxng` } } },
  team: { max_agents: 3 },
  // Paid routing is on with small budgets; the demo key is fake and only a fake client ever sees it.
  paid: {
    enabled: true,
    budgets: { per_day_usd: 1, per_week_usd: 5, per_month_usd: 15 },
    tiers: { T1: "on_free_exhaustion", T2: "on_free_exhaustion", T3: "on_free_exhaustion", T4: "never" },
    providers: { anthropic: { kind: "anthropic", base_url: `${OFFLINE}/anthropic` } },
    models: [
      { provider: "anthropic", model: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5 (paid)", input_usd_per_million: 3, output_usd_per_million: 15, context_limit_tokens: 200000, output_limit_tokens: 16000, input_modalities: ["text", "image"], supports_tools: true, supports_structured_output: false, ignore_size_floor: true },
    ],
  },
  profiles: {
    summarize: { mode: "completion", min_total_parameters_b: 30, max_model_requests: 4, max_output_tokens: 2000, classify: "never", batching: { enabled: true, max_items: 4, per_item_output_tokens: 500 } },
    inspect: { mode: "read_only", min_total_parameters_b: 30, max_model_requests: 4, tools: "repository_read", classify: "never" },
    // 10 requests leave room for strict verification's review reserve (6) on critical analyses.
    analyze: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 10, tools: "repository_read_and_artifacts", classify: "auto", min_tier: "T2" },
    implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" },
    review: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 4, tools: "repository_read_and_artifacts" },
    supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, max_output_tokens: 4000, classify: "never", min_tier: "T3" },
  },
};
const configPath = path.join(demo, "switchyard.config.yaml");
writeFileSync(
  configPath,
  `# SwitchYard demo configuration (generated by apps/panel/scripts/seed-demo.mjs).\n# The provider keys are fake: the demo data was produced by a scripted in-process provider client.\n${YAML.stringify(raw)}`,
);
const cfg = parseConfig(raw, configPath);

// ---------- scripted gateway ----------
let offset = 0; // how far in the past "now" is for the phase being recorded
const clock = () => Date.now() - offset;
let scenario = "ok";
let sy;

const served = (req) => {
  const e = sy.catalog.endpoints().find((x) => x.route.provider === req.provider && x.route.model === req.model);
  return { model: e.route.model, provider: e.providerId, id: e.id };
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

    // Every free key is rate limited for a minute (a short cooldown, so later phases have them back).
    if (scenario === "free_exhausted") throw new GatewayError("rate_limited", "429 rate limited (demo)", 429, 60_000, false);
    if (scenario === "rate_limit_first" && s.id === "nvidia/meta/llama-3.3-70b-instruct") {
      throw new GatewayError("rate_limited", "429 Too Many Requests from nvidia (demo)", 429, 30_000, false);
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

    // Independent reviews of supervisors' promotions to global knowledge (D9): every lesson passes.
    if (user.includes("Promotion review: judge the lesson")) return promotionReviewTurn(req, s, user);

    // Prompt batches of summarize tasks (ids i1..iN).
    const batchIds = [...user.matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]);
    if (batchIds.length) {
      const items = batchIds.map((id) => ({ id, result: result(1, "inline", "The log shows a timeout while connecting to the database at step 3.") }));
      return reply(JSON.stringify({ items }), s);
    }

    if (scenario === "garbage") return reply("Sure! Here is a summary of the log: it failed.", s);

    // Standalone job supervisors (scripted per job, keyed on the goal in the brief).
    if (sys.startsWith("# Supervisor charter")) return supervisorTurn(req, s);
    // SwitchYard's native coding worker: edit, then submit.
    if (req.tools?.some((t) => t.function.name === "replace_in_file")) return codingTurn(req, s, user);
    // Independent reviewers: one verdict per review, decided by the task's goal.
    if (req.tools?.some((t) => t.function.name === "submit_verdict")) return reviewerTurn(s, user);
    // Background audits: a review task that returns its verdict as data.
    if (user.includes("Audit: review the submitted work")) return auditTurn(s, user);

    // Web research: search, read the first result, then submit citing the stored page.
    if (WEB_GOAL.test(user) && req.tools?.some((t) => t.function.name === "web_search")) {
      const tools = req.messages.filter((m) => m.role === "tool");
      const tc = (name, args) => ({ toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name, arguments: JSON.stringify(args) } }], out: 40 });
      if (tools.length === 0) return reply(null, s, tc("web_search", { query: "JavaScript Number('') empty string returns 0", max_results: 3 }));
      if (tools.length === 1) return reply("The first result is the reference page; reading it.", s, tc("web_fetch", { url: "https://docs.example.org/javascript/number" }));
      const ref = /ref: (artifact:\S+)/.exec(textOf(tools[1]))?.[1] ?? "inline";
      const out = {
        summary: "The language reference confirms Number('') is 0 (an empty string converts to zero), which is why handle() accepts a missing parameter as 0.",
        findings: [{ description: "Number('') returns 0, not NaN, per the fetched reference page.", evidenceRefs: [ref] }],
        criteria: [{ index: 0, status: "met", evidenceRefs: [ref] }],
      };
      return reply(null, s, tc("submit_result", out));
    }

    // Read-only investigations: read a file first, then submit_result citing it.
    if (req.tools?.length) {
      const toolTurns = req.messages.filter((m) => m.role === "tool").length;
      if (toolTurns === 0) {
        return reply(null, s, { toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ alias: "core", path: "src/server.ts" }) } }], out: 40 });
      }
      const criteria = (user.match(/^\s*\[\d+\]/gm) ?? []).length || 1;
      // The rounding analysis: its repair restates the same (correct) answer with the lines checked.
      if (/was not accepted/.test(user) && ROUNDING.test(user)) {
        const again = {
          summary: "Rechecked: add() does not round. Number() parses '2.5' as 2.5 and add() returns the exact floating-point sum; only the client's display rounds.",
          findings: [{ description: "add() returns a + b with no rounding.", evidenceRefs: ["core:src/app.ts#L1-L3"] }],
          criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/app.ts#L1-L3"] }],
        };
        return reply(null, s, { toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name: "submit_result", arguments: JSON.stringify(again) } }] });
      }
      // A repair run is told why the previous answer was not accepted; it submits a corrected one.
      if (/was not accepted/.test(user) && MISSING_B.test(user)) {
        const fixed = {
          summary: "Corrected: a missing b and an empty b behave differently. Missing: query.b is undefined, Number(undefined) is NaN, and handle() throws 'bad input'. Empty (?b=): Number('') is 0, so the request silently sums as if b were 0.",
          findings: [
            { description: "Missing b: Number(undefined) is NaN, so the NaN check on line 6 throws 'bad input'; the request is rejected.", evidenceRefs: ["core:src/server.ts#L5-L6"] },
            { description: "Empty b (?b=): Number('') is 0 and passes the NaN check, so handle() returns a + 0 instead of rejecting it.", evidenceRefs: ["core:src/server.ts#L4-L7"] },
          ],
          criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/server.ts#L4-L7"] }],
        };
        return reply(null, s, { toolCalls: [{ id: `call_${callNo}`, type: "function", function: { name: "submit_result", arguments: JSON.stringify(fixed) } }] });
      }
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

// The inspection that researches on the web (web_search, then web_fetch).
const WEB_GOAL = /what the web says/;

// The answer a reviewer fails once (it conflates a missing b with an empty one), then passes repaired.
const MISSING_B = /missing b parameter/;
// An answer the reviewer keeps failing although it is right: a person overrules it (a false rejection).
const ROUNDING = /round fractional inputs/;

/** A reviewer's verdict, from the evidence package: binding fields, criteria ids, and a ref it was given. */
function reviewerTurn(s, pkg) {
  const field = (k) => new RegExp(`^${k}: (.+)$`, "m").exec(pkg)?.[1].trim() ?? "";
  const goal = field("Goal");
  const ids = [...pkg.matchAll(/^- ([\w.-]+) \[verify: /gm)].map((m) => m[1]);
  const ref = /\((artifact:[^;)\s]+)/.exec(pkg)?.[1] ?? /core:src\/[\w.]+#L\d+-L\d+/.exec(pkg)?.[0] ?? "inline";
  const bind = { examinedRevision: field("examinedRevision"), policyVersion: field("policyVersion"), missingEvidence: [], blockingFindings: [] };
  let verdict;
  if (/negative numbers/.test(goal)) {
    verdict = {
      ...bind,
      verdict: "inconclusive",
      criteria: ids.map((id) => ({ id, outcome: "inconclusive", evidenceRefs: [ref], reason: "server.ts accepts negatives, but nothing given shows how refunds call handle()." })),
      missingEvidence: ["The refund code path: whether a refund passes a negative a or b to handle(), or subtracts with a positive amount."],
      recommendedAction: "needs_supervisor",
    };
  } else if (ROUNDING.test(goal)) {
    verdict = {
      ...bind,
      verdict: "fail",
      criteria: ids.map((id) => ({ id, outcome: "fail", evidenceRefs: [ref], reason: "The answer ignores that the gateway may round a fractional string before handle() sees it." })),
      blockingFindings: [{ description: "Claims no rounding happens without checking how fractional inputs reach handle().", evidenceRefs: [ref], criterionId: ids[0] }],
      recommendedAction: "repair",
      score: 0.4,
    };
  } else if (MISSING_B.test(goal) && !/Corrected:/.test(pkg)) {
    verdict = {
      ...bind,
      verdict: "fail",
      criteria: ids.map((id) => ({ id, outcome: "fail", evidenceRefs: ["core:src/server.ts#L4-L6"], reason: "The answer says a missing parameter sums as 0. A missing b is undefined and Number(undefined) is NaN, so handle() throws; only an empty b (?b=) becomes 0." })),
      blockingFindings: [{ description: "Conflates a missing b (rejected: NaN, throws 'bad input') with an empty b (accepted as 0). The stated behaviour is wrong for the case the goal asks about.", evidenceRefs: ["core:src/server.ts#L4-L6"], criterionId: ids[0] }],
      recommendedAction: "repair",
      score: 0.3,
    };
  } else {
    verdict = { ...bind, verdict: "pass", criteria: ids.map((id) => ({ id, outcome: "pass", evidenceRefs: [ref] })), recommendedAction: "accept", score: 0.9 };
  }
  return reply(null, s, { toolCalls: [call("submit_verdict", verdict)], out: 260 });
}

/** An audit task's answer: a verdict on the audited work, as data. It disagrees on the "addition" inspection. */
function auditTurn(s, pkg) {
  const field = (k) => new RegExp(`^${k}: (.+)$`, "m").exec(pkg)?.[1].trim() ?? "";
  const ids = [...pkg.matchAll(/^- ([\w.-]+) \[verify: /gm)].map((m) => m[1]);
  const disagree = /had the goal: Which function does the addition/.test(pkg);
  const verdict = {
    verdict: disagree ? "fail" : "pass",
    examinedRevision: field("examinedRevision"),
    policyVersion: field("policyVersion"),
    criteria: ids.map((id) => ({ id, outcome: disagree ? "fail" : "pass", evidenceRefs: ["inline"], ...(disagree ? { reason: "The cited lines show where add() is called, not where it is imported from." } : {}) })),
    blockingFindings: disagree ? [{ description: "The cited lines do not support the claim about where add() is imported.", evidenceRefs: ["inline"] }] : [],
    missingEvidence: [],
    recommendedAction: disagree ? "needs_supervisor" : "accept",
  };
  const out = { summary: `Audit verdict: ${verdict.verdict}.`, findings: [{ description: `Audit verdict: ${verdict.verdict}`, evidenceRefs: ["inline"] }], criteria: [{ index: 0, status: "met", evidenceRefs: ["inline"] }], data: verdict };
  return reply(null, s, { toolCalls: [call("submit_result", out)], out: 220 });
}

/** A promotion review's answer: a passing verdict on the lesson against the rubric, as data. */
function promotionReviewTurn(req, s, pkg) {
  const field = (k) => new RegExp(`^${k}: (.+)$`, "m").exec(pkg)?.[1].trim() ?? "";
  const ids = [...pkg.matchAll(/^- ([\w.-]+) \[verify: /gm)].map((m) => m[1]);
  const verdict = {
    verdict: "pass",
    examinedRevision: field("examinedRevision"),
    policyVersion: field("policyVersion"),
    criteria: ids.map((id) => ({ id, outcome: "pass", evidenceRefs: ["inline"] })),
    blockingFindings: [],
    missingEvidence: [],
    recommendedAction: "accept",
  };
  const criteria = (pkg.match(/^\s*\[\d+\]/gm) ?? []).length || 1;
  const out = { summary: "The lesson holds beyond its project.", findings: [{ description: "Generic practice; names nothing of its project.", evidenceRefs: ["inline"] }], criteria: Array.from({ length: criteria }, (_, i) => ({ index: i, status: "met", evidenceRefs: ["inline"] })), data: verdict };
  if (req.tools?.some((t) => t.function.name === "submit_result")) return reply(null, s, { toolCalls: [call("submit_result", out)], out: 220 });
  return reply(JSON.stringify(out), s, { out: 220 });
}

const call = (name, args) => ({ id: `call_${++callNo}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const assistantTurns = (req) => req.messages.filter((m) => m.role === "assistant").length;
const hasCheck = (fn) => `node -e "process.exit(require('fs').readFileSync('src/app.ts','utf8').includes('${fn}')?0:1)"`;
const multiplyCheck = hasCheck("multiply");
const powerCheck = hasCheck("power");

// Every helper a scripted coding worker adds, with its operator.
const OPS = { multiply: "*", subtract: "-", divide: "/", modulo: "%", power: "**" };

function codingTurn(req, s, user) {
  if (user.includes(SUB_WORKER)) return subTeamCodingTurn(req, s, user);
  // The goal comes first in the brief ("Add divide(a, b) ..."); the brain context after it may name other functions.
  const named = /Add (\w+)\(a, b\)/.exec(user)?.[1];
  const fn = named && OPS[named] ? named : /multiply/i.test(user) ? "multiply" : "subtract";
  const op = OPS[fn];
  if (assistantTurns(req) === 0) {
    const calls = [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: `export function ${fn}(a: number, b: number) {\n  return a ${op} b;\n}\n\nexport function add` })];
    // In the job, the worker also asks for brain access it does not have (left pending for you).
    if (fn === "multiply") calls.push(call("brain_request_access", { pattern: "projects/demo/decisions/**", mode: "write", reason: "Record that arithmetic helpers live in src/app.ts so later briefs reuse them." }));
    return reply(`Adding ${fn}() next to add().`, s, { toolCalls: calls, out: 120 });
  }
  return reply(null, s, { toolCalls: [call("submit_result", { summary: `Added ${fn}(a, b) to src/app.ts.`, findings: [{ description: `${fn}() is exported from src/app.ts`, evidenceRefs: ["core:src/app.ts#L1-L3"] }], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/app.ts#L1-L3"] }] })] });
}

// ---------- the nested team job (parent -> sub-supervisor -> workers) ----------
// The parent plans a redundant survey node and a sub-job; the sub-job delegates mean() and
// range() to two workers that both edit src/app.ts. range's worker adds the same mean() first
// (mean is not on its base yet), so when the sub-supervisor integrates both in one turn, the
// queue rebases range's work and drops the duplicate commit. Workers and supervisors post to the
// team channel (a finding, a blocker, interface contracts).
const SUB_WORKER = "Sub-team worker:";
const TEAM_PARENT = "through a sub-team";
const TEAM_CHILD = "Sub-team: implement mean(a, b) and range(a, b)";
const helperText = (fn, body) => `export function ${fn}(a: number, b: number) {\n  return ${body};\n}\n\nexport function add`;
const MEAN = helperText("mean", "(a + b) / 2");
const RANGE = helperText("range", "Math.abs(a - b)");

function subTeamCodingTurn(req, s, user) {
  const n = assistantTurns(req);
  // The goal comes first in the brief; brain context after it may name the other worker's helper.
  const range = /Add (mean|range)\(a, b\)/.exec(user)?.[1] === "range";
  const done = (fn) => call("submit_result", { summary: `Added ${fn} to src/app.ts.`, findings: [{ description: `${fn} is exported from src/app.ts`, evidenceRefs: ["core:src/app.ts#L1-L3"] }], criteria: [{ index: 0, status: "met", evidenceRefs: ["core:src/app.ts#L1-L3"] }] });
  if (!range) {
    if (n === 0) {
      return reply("Adding mean() above add(), and telling range's worker where it goes.", s, {
        toolCalls: [
          call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: MEAN }),
          call("post_channel", { kind: "finding", text: "mean(a, b) now sits directly above add() in src/app.ts.\nPut range(a, b) between mean and add so our hunks stay apart.", refs: ["range"] }),
        ],
        out: 140,
      });
    }
    return reply(null, s, { toolCalls: [done("mean(a, b)")] });
  }
  // range's worker: its base predates mean, so it adds the same mean() first, then range().
  if (n === 0) {
    return reply("mean() is not on my base yet; adding it first so range's check can import it.", s, {
      toolCalls: [
        call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: MEAN }),
        call("post_channel", { kind: "blocker", text: "My base does not have mean() yet, so I added the same mean() first.\nIntegrate mean before range; the queue should drop my duplicate.", refs: [] }),
      ],
      out: 140,
    });
  }
  if (n === 1) return reply("Now range() between mean and add.", s, { toolCalls: [call("replace_in_file", { path: "src/app.ts", old_text: "export function add", new_text: RANGE })], out: 90 });
  return reply(null, s, { toolCalls: [done("range(a, b)")] });
}

const lastCallsOf = (req) => [...req.messages].reverse().find((m) => m.role === "assistant")?.tool_calls?.map((c) => c.function.name) ?? [];

/** The sub-supervisor: delegate both workers, wait, integrate both in one turn, report, finish. */
function subJobTurn(req) {
  const n = assistantTurns(req);
  const last = lastCallsOf(req);
  const lastTool = textOf(req.messages.at(-1));
  const finish = call("finish_job", { status: "completed", summary: "mean(a, b) and range(a, b) are on the sub-job branch; range's duplicate mean commit was dropped by the queue's rebase.", verified: [{ claim: "both helpers exported on the sub-job branch", evidence: "job checks after each integration" }], not_verified: [] });
  if (n === 0) {
    return {
      text: "Two small helpers in one file: one worker each; they take turns on the file lease.",
      calls: [
        call("brain_set_job_section", { body: "Delegated mean and range (both edit src/app.ts; range waits for mean's lease)." }),
        call("delegate", {
          tasks: [
            { label: "mean", profile: "implement", goal: `${SUB_WORKER} Add mean(a, b) to src/app.ts next to add().`, acceptance_criteria: ["mean is exported from src/app.ts"], allowed_paths: ["src/app.ts"], checks: [hasCheck("mean")], difficulty: "T2" },
            { label: "range", profile: "implement", goal: `${SUB_WORKER} Add range(a, b) to src/app.ts next to add().`, acceptance_criteria: ["range is exported from src/app.ts"], allowed_paths: ["src/app.ts"], checks: [hasCheck("range")], difficulty: "T2" },
          ],
        }),
      ],
    };
  }
  if (n > 20) return { text: "Stopping.", calls: [finish] };
  if (last.includes("delegate")) return { text: "Waiting for both workers.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
  if (last.includes("await_tasks")) {
    if (/: still /.test(lastTool)) return { text: "Still running; waiting again.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
    return { text: "Both finished with passing checks. Integrating both; the queue takes them one at a time.", calls: [call("integrate_task", { task_id: "mean" }), call("integrate_task", { task_id: "range" })] };
  }
  if (last.includes("integrate_task")) {
    return {
      text: "Both integrated. Recording what happened for the parent.",
      calls: [
        call("post_channel", { kind: "finding", text: "Both helpers are on the sub-job branch. range's first commit repeated mean's change; the merge queue rebased range and dropped it.", refs: ["range"] }),
        call("brain_set_job_section", { body: "mean and range integrated (range rebased; its duplicate mean commit dropped). Job checks passed after each." }),
      ],
    };
  }
  return { text: "Done.", calls: [finish] };
}

/** The parent: plan a redundant survey and a sub-job, publish the helpers' contract, wait, integrate the sub-job's branch. */
function teamParentTurn(req) {
  const n = assistantTurns(req);
  const last = lastCallsOf(req);
  const lastTool = textOf(req.messages.at(-1));
  const finish = call("finish_job", { status: "completed", summary: "The sub-team delivered mean(a, b) and range(a, b); its branch is integrated onto this job's branch with each worker's attribution.", verified: [{ claim: "mean and range exported on the job branch", evidence: "job checks after the integration" }], not_verified: [] });
  if (n === 0) {
    return {
      text: "A survey and a self-contained sub-goal: plan them, and hand the helpers to a sub-team.",
      calls: [
        call("brain_set_current_state", { body: "**Goal:** mean() and range() delivered by a sub-team.\n\n**Plan (plan_work v1):** survey (redundant, T1) and helpers (sub-supervisor with its own workers).\n\n**Status:** dispatched." }),
        call("post_channel", { kind: "interface_contract", text: "Every helper is exported from src/app.ts as (a: number, b: number) => number, placed above add().", refs: [] }),
        call("plan_work", {
          nodes: [
            { label: "survey", profile: "inspect", goal: "List the exported helpers in src/app.ts and their signatures.", acceptance_criteria: ["names every exported function with its line"], file_refs: ["core:src/app.ts"], difficulty: "T1", redundancy: 2 },
            { label: "helpers", profile: "supervise", goal: `${TEAM_CHILD} with two workers.`, acceptance_criteria: ["mean and range are exported from src/app.ts"], checks: [hasCheck("mean"), hasCheck("range")] },
          ],
          note: "a redundant survey and one sub-team",
        }),
      ],
    };
  }
  if (n > 30) return { text: "Stopping.", calls: [finish] };
  if (last.includes("plan_work")) return { text: "Waiting for the survey and the sub-team.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
  if (last.includes("await_tasks")) {
    if (/: still /.test(lastTool)) return { text: "The sub-team is still working; waiting again.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
    return { text: "The sub-team finished. Integrating its branch onto the job branch.", calls: [call("integrate_task", { task_id: "helpers" })] };
  }
  return { text: "Done.", calls: [finish] };
}

const JOB_A = [
  () => ({ text: "I'll keep the plan in the working document, then delegate one bounded implement task.", calls: [call("brain_set_current_state", { body: "**Goal:** add multiply(a, b) to the calculator and integrate it.\n\n**Plan:**\n1. Implementer adds multiply() in src/app.ts (allowed: src/**).\n2. Integrate onto the job branch and run the check.\n\n**Status:** delegated, waiting on the implementer." }), call("delegate", { tasks: [{ label: "multiply", profile: "implement", goal: "Add multiply(a, b) to src/app.ts next to add().", acceptance_criteria: ["multiply is exported from src/app.ts"], allowed_paths: ["src/**"], checks: [multiplyCheck], difficulty: "T2" }] })] }),
  () => ({ text: "Waiting for the implementer.", calls: [call("await_tasks", { timeout_seconds: 60 })] }),
  () => ({ text: "The implementer finished with its check passing. Integrating its commit onto the job branch.", calls: [call("integrate_task", { task_id: "multiply" })] }),
  () => ({ text: "Verifying on the job branch myself rather than trusting the report.", calls: [call("run_check", { command: multiplyCheck })] }),
  () => ({
    text: "Check passed. Recording the decision and a reusable lesson.",
    calls: [
      call("brain_write", { path: "projects/demo/decisions/arithmetic-helpers.md", content: "# Decision: arithmetic helpers live in src/app.ts\n\nStatus: accepted\n\n## Context\n\nThe calculator service needs add, subtract, and multiply. `handle()` in src/server.ts only parses input.\n\n## Decision\n\n- Pure arithmetic helpers are exported from `src/app.ts`.\n- `src/server.ts` validates input and calls them; it holds no arithmetic itself.\n\n## Consequences\n\n- New operations are one small implement brief with `allowed_paths: src/app.ts`.\n" }),
      call("brain_promote_lesson", { title: "Verify integrated work on the job branch", body: "A worker's passing check proves its own worktree, not the integrated branch. After `integrate_task`, run the same check with `run_check` before recording the ledger entry.\n\n- Cheap: one command, no model request.\n- Catches cherry-pick conflicts resolved the wrong way.", sources: ["projects/demo/working/job-" + "JOBID" + ".md"] }),
      call("brain_promote_lesson", { title: "Ask before changing what callers see on failure", body: "Status codes and error bodies are part of an interface. When a fix would change them, ask the person who owns the interface first, and record the answer where later briefs will find it.", sources: ["projects/demo/working/job-" + "JOBID" + ".md"] }),
    ],
  }),
  () => ({ text: "Recording the validated outcome in the ledger.", calls: [call("brain_append_ledger", { title: "Integrated multiply", changed: "src/app.ts on the job branch", why: "job goal", validation: "`" + multiplyCheck + "` -> exit 0", outcome: "Accepted", follow_up: "none" })] }),
  () => ({ text: "Done.", calls: [call("finish_job", { status: "completed", summary: "multiply(a, b) added to src/app.ts by the implementer and integrated onto the job branch.", verified: [{ claim: "multiply is exported on the job branch", evidence: "run_check exit 0" }], not_verified: ["handle() does not expose multiply yet (out of scope)"] })] }),
];
const JOB_B = [
  () => ({ text: "Before changing error handling I need a decision that belongs to the user.", calls: [call("brain_set_current_state", { body: "**Goal:** make handle() reject missing parameters.\n\n**Open decision:** status code for missing parameters (asked the user).\n\n**Plan once answered:** one implement brief for src/server.ts plus a review." }), call("ask_user", { question: "Should a missing a or b parameter return HTTP 400 with a JSON error body, or keep throwing so the framework returns 500?", options: ["Return 400 with a JSON error", "Keep throwing (500)"] })] }),
];
// Job D: integrates a reviewed power(), confirms it on the branch, then finds the defect the
// reviewer missed and undoes the task through attribution (calibration: a false approval).
const JOB_D = [
  () => ({ text: "Delegating power() as a high-importance change: the API is public, so it gets an independent review.", calls: [call("delegate", { tasks: [{ label: "power", profile: "implement", goal: "Add power(a, b) to src/app.ts next to add().", acceptance_criteria: ["power is exported from src/app.ts"], allowed_paths: ["src/**"], checks: [powerCheck], difficulty: "T2", importance: "high", importance_reason: "power() becomes part of the public calculator API." }] })] }),
  () => ({ text: "Waiting for the implementer and its review.", calls: [call("await_tasks", { timeout_seconds: 60 })] }),
  () => ({ text: "Reviewed and passed. Integrating it onto the job branch.", calls: [call("integrate_task", { task_id: "power" })] }),
  () => ({ text: "Running the check on the job branch.", calls: [call("run_check", { command: powerCheck })] }),
  () => ({ text: "Reading the integrated code again: power(-8, 0.5) returns NaN, and the API must reject a fractional exponent of a negative base. Undoing the task.", calls: [call("undo", { kind: "task", target: "power", reason: "power(-8, 0.5) returns NaN; the API must reject a fractional exponent of a negative base" })] }),
  () => ({ text: "Done.", calls: [call("finish_job", { status: "blocked", summary: "power() was integrated, then undone: it returns NaN for a fractional exponent of a negative base. Re-delegate with a criterion for that case.", verified: [], not_verified: ["power(a, b) behaviour for a < 0 and fractional b"], follow_up: "re-delegate power with a negative-base criterion" })] }),
];
let jobAId = "";

// Job C plans a diamond with plan_work: scan -> (divide, modulo) -> check-exports. divide and
// modulo both edit src/app.ts, so modulo waits for divide's file lease. modulo is planned at T3,
// so the critical path runs through it. The join starts only on accepted inputs.
const JOB_C_PLAN = [
  { label: "scan", profile: "inspect", goal: "Find where the arithmetic helpers live and how handle() calls them.", acceptance_criteria: ["names the file and lines of add()"], file_refs: ["core:src/app.ts"], difficulty: "T1" },
  { label: "divide", profile: "implement", goal: "Add divide(a, b) to src/app.ts next to add().", acceptance_criteria: ["divide is exported from src/app.ts"], allowed_paths: ["src/app.ts"], checks: [hasCheck("divide")], depends_on: ["scan"], difficulty: "T2" },
  { label: "modulo", profile: "implement", goal: "Add modulo(a, b) to src/app.ts next to add().", acceptance_criteria: ["modulo is exported from src/app.ts"], allowed_paths: ["src/**"], checks: [hasCheck("modulo")], depends_on: ["scan"], difficulty: "T3" },
  { label: "check-exports", profile: "inspect", goal: "Confirm the new helpers are exported next to add().", acceptance_criteria: ["lists every exported helper"], file_refs: ["core:src/app.ts"], depends_on: ["divide", "modulo"], difficulty: "T1", requires_accepted_inputs: true },
];

/** Job C's supervisor: plan, wait (accepting upstream results a node waits on), integrate, finish. */
function jobCTurn(req) {
  const n = assistantTurns(req);
  if (n === 0) {
    return {
      text: "Four parts with a clear order: plan them as a graph so independent nodes run in parallel.",
      calls: [
        call("brain_set_current_state", { body: "**Goal:** add divide() and modulo() next to add().\n\n**Plan (plan_work v1):** scan -> divide, modulo -> check-exports.\n\n**Status:** plan dispatched." }),
        call("plan_work", { nodes: JOB_C_PLAN, note: "diamond: one scan, two helpers, one check" }),
      ],
    };
  }
  const lastCalls = [...req.messages].reverse().find((m) => m.role === "assistant")?.tool_calls?.map((c) => c.function.name) ?? [];
  const lastTool = textOf(req.messages.at(-1));
  const finish = call("finish_job", {
    status: "completed",
    summary: "divide(a, b) integrated onto the job branch; modulo(a, b) is done in its worktree and waits for a follow-up integration (it edits the same lines).",
    verified: [{ claim: "every plan node finished", evidence: "await_tasks" }],
    not_verified: ["modulo is not on the job branch yet"],
  });
  if (n > 30) return { text: "Stopping.", calls: [finish] };
  if (lastCalls.includes("plan_work") || lastCalls.includes("accept_task")) return { text: "Waiting for the plan's nodes.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
  if (lastCalls.includes("await_tasks")) {
    const awaiting = [...new Set([...lastTool.matchAll(/awaiting_acceptance:([\w,]+)/g)].flatMap((m) => m[1].split(",")))];
    if (awaiting.length) return { text: "check-exports waits on accepted inputs; both helpers passed their checks.", calls: awaiting.map((id) => call("accept_task", { task_id: id, reason: "Its check passed on the submitted revision and the diff adds only the requested helper." })) };
    if (/: still /.test(lastTool)) return { text: "Still running; waiting again.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
    return { text: "All nodes finished. Integrating divide onto the job branch.", calls: [call("integrate_task", { task_id: "divide" })] };
  }
  return { text: "Done.", calls: [finish] };
}

// ---------- the recorded comparison (team vs single agent) ----------
// The team run plans two independent read-only nodes, so two agents run at once; the single run
// is one inspect task on the same goal. Both take the read-only path of the scripted client.
const COMPARE_GOAL = "Where does handle() validate its input, and what does add() return? (team vs single comparison)";

function compareTurn(req) {
  const n = assistantTurns(req);
  const last = lastCallsOf(req);
  const lastTool = textOf(req.messages.at(-1));
  const finish = call("finish_job", { status: "completed", summary: "handle() validates a and b with Number() and a NaN check in src/server.ts; add() returns a + b.", verified: [{ claim: "both answers cite src/server.ts", evidence: "the two inspect results" }], not_verified: [] });
  if (n === 0) {
    return {
      text: "Two independent lookups: plan them as parallel nodes.",
      calls: [
        call("plan_work", {
          nodes: [
            { label: "find-validation", profile: "inspect", goal: "Where does handle() validate its input?", acceptance_criteria: ["cites the exact lines"], file_refs: ["core:src/server.ts"], difficulty: "T1" },
            { label: "find-add", profile: "inspect", goal: "What does add() return, and where is it called?", acceptance_criteria: ["cites the exact lines"], file_refs: ["core:src/server.ts"], difficulty: "T1" },
          ],
          note: "two parallel lookups",
        }),
      ],
    };
  }
  if (n > 20) return { text: "Stopping.", calls: [finish] };
  if (last.includes("plan_work") || (last.includes("await_tasks") && /: still /.test(lastTool))) return { text: "Waiting for both lookups.", calls: [call("await_tasks", { timeout_seconds: 60 })] };
  return { text: "Both lookups are in.", calls: [finish] };
}

function supervisorTurn(req, s) {
  const brief = textOf(req.messages[1]);
  if (brief.includes(COMPARE_GOAL)) {
    const step = compareTurn(req);
    return reply(step.text, s, { toolCalls: step.calls, in: 2500 + Math.round(Math.random() * 2000), out: 200 });
  }
  if (brief.includes(TEAM_CHILD) || brief.includes(TEAM_PARENT)) {
    const step = brief.includes(TEAM_CHILD) ? subJobTurn(req) : teamParentTurn(req);
    return reply(step.text, s, { toolCalls: step.calls, in: 3000 + Math.round(Math.random() * 3000), out: 250 });
  }
  // Each job's goal names a function no other job's goal does: power (Job D), divide (Job C), multiply (Job A).
  if (!/power\(a, b\)/.test(brief) && /divide\(a, b\)/.test(brief)) {
    const step = jobCTurn(req);
    return reply(step.text, s, { toolCalls: step.calls, in: 3000 + Math.round(Math.random() * 3000), out: 250 });
  }
  const script = /power\(a, b\)/.test(brief) ? JOB_D : /multiply/.test(brief) ? JOB_A : JOB_B;
  // Job B only gets past its question when the seeder shuts the worker down: end the run there.
  if (script === JOB_B && assistantTurns(req) >= JOB_B.length) throw new GatewayError("aborted", "worker shut down while waiting for an answer (demo)", undefined, undefined, false);
  const step = script[Math.min(assistantTurns(req), script.length - 1)]();
  const calls = step.calls.map((c) => ({ ...c, function: { ...c.function, arguments: c.function.arguments.replace("JOBID", jobAId) } }));
  return reply(step.text, s, { toolCalls: calls.length ? calls : undefined, in: 3000 + Math.round(Math.random() * 3000), out: 250 });
}

/** Fake direct paid client: never makes a network call; bills 1,200 input and 400 output tokens. */
const directCalls = [];
const directClient = {
  async complete(r) {
    directCalls.push(r.model);
    const items = [...textOf(r.chat.messages[1]).matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]);
    const body = items.length ? { items: items.map((id) => ({ id, result: result(1, "inline", "The log shows the payment webhook timing out after three retries.") })) } : result(1, "inline", "The log shows the payment webhook timing out after three retries.");
    return {
      message: { content: JSON.stringify(body) },
      finishReason: "stop",
      usage: { inputTokens: 1200, outputTokens: 400, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" },
      telemetry: { servedModel: r.model, servedProvider: `paid:${r.providerName}`, providerAttempts: 1, providerAttemptsExact: true, cacheHit: false, headers: {} },
      httpStatus: 200,
    };
  },
};

/**
 * The scripted client and the fake paid client behind SwitchYard's provider-client seam: requests
 * still go through key selection, limits, and key state, but never over the network.
 */
const NO_RATE_LIMITS = { family: "none", observedAt: 0, retryAfterMs: null, windows: [] };
const providerClient = {
  async complete(r) {
    const res = r.provider.id === "anthropic" ? await directClient.complete({ model: r.model, providerName: r.provider.id, chat: r.chat }) : await client.complete({ model: r.model, provider: r.provider.id, ...r.chat });
    return { ...res, rateLimits: { ...NO_RATE_LIMITS, observedAt: Date.now() } };
  },
};

// Fake web: the SearXNG instance answers searches, and the built-in page fetch gets a public
// address and a reference page, all in-process.
const webFetch = async (url) =>
  url.includes("/tavily/")
    ? new Response(JSON.stringify({ detail: { error: "Rate limit exceeded (demo)" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7200" } })
    : new Response(
    JSON.stringify({
      query: new URL(url).searchParams.get("q"),
      results: [
        { title: "Number() - JavaScript reference", url: "https://docs.example.org/javascript/number", content: "Number('') returns 0; Number(undefined) returns NaN.", engine: "demo" },
        { title: "Type conversion pitfalls", url: "https://blog.example.org/type-conversion", content: "Empty strings convert to 0 in numeric contexts.", engine: "demo" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const REFERENCE_PAGE = "<html><head><title>Number() - JavaScript reference</title></head><body><h1>Number()</h1><p>Number(value) converts value to a number.</p><h2>Strings</h2><ul><li>Number('42') is 42</li><li>Number('') is 0: an empty or whitespace-only string converts to zero</li><li>Number('abc') is NaN</li></ul><p>Number(undefined) is NaN; Number(null) is 0.</p><p>See <a href=\"/javascript/parseFloat\">parseFloat()</a> for parsing prefixes.</p></body></html>";
const webPage = {
  resolve: async () => ["93.184.216.34"],
  transport: async () => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(REFERENCE_PAGE), truncated: false }),
};

sy = new Switchyard(cfg, { providerClient, now: clock, pollIntervalMs: 40, webFetch, webPage });
const started = { v: false };
const startWorker = () => {
  if (!started.v) sy.startWorker(40);
  started.v = true;
};

async function phase(hoursAgo, label, tasks, opts = {}) {
  offset = Math.round(hoursAgo * HOUR);
  scenario = opts.scenario ?? "ok";
  // A qualification purpose sends the tasks to the reserved `_qualification` project (no project named).
  const subs = await sy.submitTasks(tasks, opts.purpose ? { purpose: opts.purpose } : { project: opts.project ?? "demo" });
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
// Importance and verification: a critical analysis is strict (it waits for an explicit decision,
// left pending so the task page shows Accept/Reject); a high one is deep: its reviewer holds no
// review qualification yet (reviewer_unqualified) and cannot settle the criterion, so a person
// accepts it from the CLI and a decision shows.
const critical = await phase(12.5, "critical analysis (strict: needs a decision)", [
  {
    profile: "analyze",
    label: "billing-rounding",
    goal: "Find where handle() could produce a wrong sum for the billing reconciliation report.",
    repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/server.ts", "core:src/app.ts"] },
    importance: "critical",
    importanceReason: "The billing reconciliation report sums with handle(); a wrong total is a financial error.",
    constraints: {
      acceptanceCriteria: [
        { id: "root-cause", text: "identifies every input that yields a wrong sum, with line references", verify: "evidence" },
        { id: "fix", text: "proposes a minimal fix", verify: "evidence" },
      ],
    },
  },
]);
const high = await phase(12, "high-importance analysis (deep: awaits review)", [
  {
    profile: "analyze",
    goal: "Check whether handle() accepts negative numbers and whether that matters for refunds.",
    repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/server.ts"] },
    importance: "high",
    importanceReason: "Refund amounts are negative; rejecting them would block refunds.",
    constraints: { acceptanceCriteria: ["states whether negative numbers are accepted, citing the line"] },
  },
]);
for (const r of high.completed) {
  if (r.acceptanceStatus === "needs_supervisor") insights.decideTaskAcceptance(sy, r.taskId, "accept", { kind: "human", id: "cli:demo" }, "Read server.ts myself: Number() keeps the sign and nothing rejects negatives.");
}
if (!critical.completed.some((r) => r.acceptanceStatus === "needs_supervisor")) console.warn("  warning: the critical analysis did not end needs_supervisor");

// Reviewers now hold the review qualification (deterministic illustrative rows), so the next deep
// review is qualified: it fails the first answer, the one repair corrects it, and the re-review passes.
{
  const t0 = Date.now() - 12 * HOUR;
  const insertRun = sy.db.prepare("INSERT INTO qualification_runs (id, endpoint_id, suite_version, status, started_at, finished_at, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertRes = sy.db.prepare("INSERT INTO qualification_results (run_id, endpoint_id, eval_id, family, tier, trial, outcome, task_id, detail_json, created_at) VALUES (?, ?, ?, 'review', 'T3', ?, ?, NULL, ?, ?)");
  for (const endpointId of ["cerebras/qwen-3-235b-a22b-instruct-2507", "groq/openai/gpt-oss-120b", "openrouter/z-ai/glm-4.5-air:free"]) {
    const runId = `qr_demo_review_${endpointId.replace(/[^a-z0-9]+/gi, "_")}`;
    insertRun.run(runId, endpointId, "demo-suite-1", "completed", t0, t0 + 20 * 60_000, JSON.stringify({ demo: true }));
    for (let trial = 0; trial < 8; trial++) insertRes.run(runId, endpointId, `review-t3-${(trial % 4) + 1}`, Math.floor(trial / 4) + 1, trial === 5 ? "fail" : "pass", JSON.stringify({ demo: true }), t0 + trial * 60_000);
  }
}
const repaired = await phase(11.5, "deep review: fails, repaired, passes", [
  {
    profile: "analyze",
    label: "missing-b",
    goal: "Does handle() reject a request with a missing b parameter? Explain what a client gets back.",
    repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/server.ts"] },
    importance: "high",
    importanceReason: "Clients rely on a 400 for a missing parameter; a silent 0 would corrupt their totals.",
    constraints: { acceptanceCriteria: [{ id: "missing-vs-empty", text: "states what a missing b and an empty b each do, citing the lines", verify: "evidence" }] },
  },
]);
if (!repaired.completed.some((r) => r.acceptanceStatus === "met")) console.warn("  warning: the repaired deep review did not end met");

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
await phase(0.8, "web research (search, then fetch)", [inspect("Check what the web says about Number('') returning 0")]);
await phase(0.5, "recent summaries", [summarize("Summarise the latest canary log"), inspect("Is add() covered by any validation?")]);

// The other projects run their own work through the same worker.
await phase(6, "storefront: summaries", [summarize("Summarise the checkout error log"), summarize("Summarise the payment provider webhook log")], { project: "storefront" });
await phase(0.4, "storefront: recent summary", [summarize("Summarise the cart service log after the deploy")], { project: "storefront" });
await phase(30, "legacy billing: summary (archived below)", [summarize("Summarise the month-end invoice run log")], { project: "legacy-billing" });
// One qualification trial: it runs in the reserved `_qualification` project, never a user project,
// and is viewed under /all/qualification (linked to an illustrative run below).
const qualificationTrial = await phase(29, "qualification: one eval trial (reserved project)", [summarize("Summarise the qualification fixture's build log (eval trial)", { label: "completion-t1-1" })], { purpose: "qualification" });

// Paid route: every free model is "cooling down", so the paid model serves (fake direct client).
sy.vault.add({ provider: "anthropic", label: "demo card (fake key)", secret: "sk-ant-demo-NOT-A-REAL-KEY-7f3a", billingClass: "paid_postpaid", monthlyCapUsd: 10, expiresAt: Date.now() + 90 * 24 * HOUR });
sy.vault.add({ provider: "anthropic", label: "prepaid credits (fake key)", secret: "sk-ant-demo-PREPAID-FAKE-91c2", billingClass: "paid_credits", prepaidBalanceUsd: 4 });
await phase(2.5, "paid fallback: free exhausted -> paid model", [summarize("Summarise the payment webhook log (free capacity exhausted)")], { scenario: "free_exhausted" });
if (!directCalls.length) console.warn("  warning: the paid model was not used");

// Standalone job: supervisor delegates, integrates, verifies, and records memory.
offset = Math.round(2 * HOUR);
scenario = "ok";
const jobA = await sy.startJob({ project: "demo", goal: "Add multiply(a, b) to the calculator and integrate it onto a job branch.", repositories: ["core"], acceptanceCriteria: ["multiply is exported from src/app.ts on the job branch"], checks: [multiplyCheck], label: "add-multiply" });
jobAId = jobA.taskId;
startWorker();
const jobAOut = await sy.awaitResults([jobA.taskId], { timeoutSeconds: 180 });
const ra = jobAOut.completed[0];
console.log(`  ${"job: add multiply (finished)".padEnd(44)} ${ra ? `${ra.executionStatus}/${ra.acceptanceStatus}` : "did not finish"}`);

// A planned job: plan_work records a diamond task graph; two coding nodes contend for a file lease.
offset = Math.round(1.9 * HOUR);
const jobC = await sy.startJob({ project: "demo", goal: "Add divide(a, b) and modulo(a, b) to the calculator, planned as a task graph.", repositories: ["core"], acceptanceCriteria: ["divide and modulo are exported from src/app.ts"], label: "plan-divide-modulo" });
const jobCOut = await sy.awaitResults([jobC.taskId], { timeoutSeconds: 240 });
const rc = jobCOut.completed[0];
const planC = insights.jobPlan(sy, jobC.taskId);
console.log(
  `  ${"job: divide + modulo (plan_work diamond)".padEnd(44)} ${rc ? `${rc.executionStatus}/${rc.acceptanceStatus}` : "did not finish"}; plan v${planC?.plan?.version ?? "-"}, critical path ${planC?.criticalPath.labels.join(" -> ") || "-"}, lease waits ${planC?.nodes.reduce((a, x) => a + x.leaseWaits, 0) ?? 0}`,
);

// A person's notes in the brain, committed as "human".
offset = Math.round(1.8 * HOUR);
await insights.brainWrite(sy, "projects/demo/facts/runtime.md", "# Runtime facts\n\n- The calculator service runs on Node 22 behind the API gateway.\n- `GET /sum?a=&b=` is the only public route today.\n- Requests time out after 5 seconds at the gateway.\n");
await insights.brainWrite(sy, "projects/demo/repos/core.md", "# core (calculator service)\n\n| Path | What it holds |\n| --- | --- |\n| `src/app.ts` | Pure arithmetic helpers |\n| `src/server.ts` | Input parsing and validation for `handle()` |\n\nTests: none yet. Add checks as `node -e` one-liners until a test runner exists.\n");
await insights.brainWrite(sy, "projects/storefront/facts/checkout.md", "# Checkout facts\n\n- `total()` in `src/cart.ts` sums price times quantity; there are no discounts yet.\n- Prices are in cents, so totals are integers.\n", "storefront");
// Storefront promotions to global/ (decision D9), for the project Brain page: a lesson that names
// the project and its files is rejected by the project-specificity check and kept as a project
// lesson; a generic one is approved by a person (its review task, if one started, is cancelled).
{
  const sfBrain = sy.brainFor("storefront");
  const sfSupervisor = { kind: "agent", role: "supervisor", taskId: null, jobId: null, tier: "T3", grants: [] };
  const sfActor = { agent: "supervisor", role: "supervisor", model: "cerebras/qwen-3-235b-a22b-instruct-2507" };
  const facts = ["projects/storefront/facts/checkout.md"];
  await sfBrain.promoteLesson(sfSupervisor, sfActor, "Storefront totals are in cents", "In storefront, `total()` in src/cart.ts returns cents, so the app repository never formats money itself.", facts);
  const generic = await sfBrain.promoteLesson(sfSupervisor, sfActor, "Keep money in integer minor units", "Store and sum prices as integers of the smallest currency unit (cents, pence). Convert to a decimal string only when displaying. Floating-point sums drift and break equality checks in tests.", facts);
  const pending = generic.id ? sfBrain.promotions.get(generic.id) : null;
  if (pending?.review.task_id) sy.cancelTasks([pending.review.task_id], "storefront");
  if (generic.id && (generic.status === "pending_review" || generic.status === "pending_approval")) await sy.decidePromotion("storefront", generic.id, true, "you", "Applies to any project that handles money.");
  const sfPromotions = sy.promotions({ project: "storefront" });
  console.log(`  ${"storefront: promotions to global/".padEnd(44)} ${sfPromotions.map((x) => x.status).join(", ") || "none"}`);
}
const decision = "projects/demo/decisions/arithmetic-helpers.md";
if (sy.brain.exists(decision)) {
  const text = insights.brainRead(sy, decision).content;
  await insights.brainWrite(sy, decision, `${text.trimEnd()}\n- Reviewed by a person: keep helpers free of I/O so they stay trivially testable.\n`);
}

// ---------- calibration signals ----------
// A person confirms the repaired analysis (its passing review is then confirmed correct).
const repairedId = repaired.completed.find((r) => r.acceptanceStatus === "met")?.taskId;
if (repairedId) insights.decideTaskAcceptance(sy, repairedId, "accept", { kind: "human", id: "cli:demo" }, "Matches what server.ts does for a missing and an empty b.");

// Job D: a reviewed change is integrated, confirmed by a job check, then undone (a false approval).
offset = Math.round(1.7 * HOUR);
scenario = "ok";
const jobD = await sy.startJob({ project: "demo", goal: "Add power(a, b) to the calculator and integrate it onto a job branch.", repositories: ["core"], acceptanceCriteria: ["power is exported from src/app.ts on the job branch"], label: "add-power" });
const jobDOut = await sy.awaitResults([jobD.taskId], { timeoutSeconds: 180 });
const rd = jobDOut.completed[0];
console.log(`  ${"job: add power (integrated, then undone)".padEnd(44)} ${rd ? `${rd.executionStatus}/${rd.acceptanceStatus}` : "did not finish"}`);

// The nested team job: parent -> sub-supervisor -> two workers, a redundant node, and the channel.
offset = Math.round(1.65 * HOUR);
const jobE = await sy.startJob({ project: "demo", goal: `Deliver mean(a, b) and range(a, b) ${TEAM_PARENT}, with a redundant survey.`, repositories: ["core"], acceptanceCriteria: ["mean and range are exported from src/app.ts on the job branch"], checks: [hasCheck("mean"), hasCheck("range")], label: "team-helpers" });
const jobEOut = await sy.awaitResults([jobE.taskId], { timeoutSeconds: 300 });
const re = jobEOut.completed[0];
const teamE = insights.jobTeam(sy, jobE.taskId);
const twinsE = insights.jobPlan(sy, jobE.taskId)?.nodes.find((x) => x.label === "survey")?.twins;
const rebasedE = teamE?.queues.flatMap((q) => q.items).filter((i) => i.rebased).length ?? 0;
console.log(
  `  ${"job: nested team (sub-job, queue, channel)".padEnd(44)} ${re ? `${re.executionStatus}/${re.acceptanceStatus}` : "did not finish"}; ${teamE?.subJobs ?? 0} sub-job, ${teamE?.queues.reduce((a, q) => a + q.items.length, 0) ?? 0} integrations (${rebasedE} rebased), ${teamE?.channel.total ?? 0} posts, survey twins ${twinsE?.status ?? "none"}`,
);
if (!rebasedE) console.warn("  warning: no integration of the nested job was rebased");
if (twinsE?.status !== "verified") console.warn(`  warning: the redundant survey ended ${twinsE?.status ?? "without twins"}${twinsE?.reason ? ` (${twinsE.reason})` : ""}`);

// One recorded comparison: the same goal as a team job and as a single agent, metrics for both.
offset = Math.round(1.62 * HOUR);
const cmpPlan = planComparison(sy, { goals: [{ id: "find-validation", goal: COMPARE_GOAL, repository: "core", profile: "inspect", acceptanceCriteria: ["cites the exact lines"], singleRequests: 4, teamRequests: 16 }] });
const cmp = await runComparison(sy, cmpPlan, { timeoutSeconds: 180 });
const cmpRes = cmp.results[0];
console.log(
  `  ${"comparison: team vs single (read-only goal)".padEnd(44)} ${cmp.status}; ${cmpRes ? `team ${cmpRes.team.metrics.state} peak ${cmpRes.team.metrics.peakParallelism}, ${cmpRes.team.metrics.requests} requests; single ${cmpRes.single.metrics.state}, ${cmpRes.single.metrics.requests} requests` : "no result"}`,
);
if (!cmpRes || cmpRes.team.metrics.peakParallelism < 2) console.warn("  warning: the comparison's team run never had two agents running at once");

// A reviewer keeps failing a right answer; a person overrules it (a false rejection).
const rounding = await phase(1.6, "deep review overruled by a person", [
  {
    profile: "analyze",
    label: "rounding",
    goal: "Does add() round fractional inputs such as 2.5? Answer with the lines that show it.",
    repositoryAliases: ["core"],
    context: { fileRefs: ["core:src/app.ts", "core:src/server.ts"] },
    importance: "high",
    importanceReason: "Invoices sum fractional amounts; rounding would change totals.",
    constraints: { acceptanceCriteria: [{ id: "rounding", text: "states whether add() rounds, citing the lines", verify: "evidence" }] },
  },
]);
for (const r of rounding.completed) {
  if (r.acceptanceStatus === "needs_supervisor") insights.decideTaskAcceptance(sy, r.taskId, "accept", { kind: "human", id: "cli:demo" }, "add() returns a + b unrounded; the gateway passes the string through. The reviewer is wrong here.");
  else console.warn(`  warning: the rounding analysis ended ${r.acceptanceStatus}, not needs_supervisor`);
}

// The same deep analysis twice: the second reuses the first one's verdict (no reviewer runs).
const cacheTask = (label) => ({
  profile: "analyze",
  label,
  goal: "Which line of server.ts rejects non-numeric input, and what error does the client see?",
  repositoryAliases: ["core"],
  context: { fileRefs: ["core:src/server.ts"] },
  importance: "high",
  importanceReason: "Client error handling depends on the exact error.",
  constraints: { acceptanceCriteria: [{ id: "line", text: "names the line and the error, citing it", verify: "evidence" }] },
});
await phase(1.4, "deep analysis (reviewed)", [cacheTask("non-numeric-a")]);
const reused = await phase(1.3, "same analysis again (verdict reused)", [cacheTask("non-numeric-b")]);
if (!reused.completed.some((r) => r.verification?.reviews?.some((x) => x.flags.includes("cached_verdict")))) console.warn("  warning: the repeated analysis did not reuse the cached verdict");

// Two background audits, forced on chosen results (sampling itself is off while seeding).
offset = Math.round(1.2 * HOUR);
const auditOf = [
  sy.listTasks(["completed"], 300).find((t) => /Add multiply/.test(t.goal)),
  sy.listTasks(["completed"], 300).find((t) => /Which function does the addition/.test(t.goal)),
].filter(Boolean);
for (const t of auditOf) {
  const a = await sy.auditor.consider(t.taskId, { force: true });
  if (a.auditTaskId) await sy.awaitResults([a.auditTaskId], { timeoutSeconds: 60 });
  sy.auditor.gradeFinished();
  console.log(`  ${`audit: ${t.goal.slice(0, 36)}`.padEnd(44)} ${a.decision}${a.decision === "sampled" ? "" : ` (${a.reason})`}`);
}

// A second job that pauses on a question for you. The worker is shut down while the supervisor
// waits, so the job is left interrupted with the question unanswered.
offset = 0;
const jobB = await sy.startJob({ project: "demo", goal: "Make handle() reject requests with a missing a or b parameter.", repositories: ["core"], acceptanceCriteria: ["a missing parameter is rejected", "existing sums still work"], label: "reject-missing-params" });
let asked = [];
for (let i = 0; i < 300 && !asked.length; i++) {
  await new Promise((r) => setTimeout(r, 100));
  asked = sy.questions({ taskId: jobB.taskId });
}
console.log(`  ${"job: reject missing params (asks you)".padEnd(44)} ${asked.length ? `question ${asked[0].id} pending` : "no question was asked"}`);

// A second pending access request, from an analyst on an earlier task.
const analyst = sy.listTasks(["completed"], 300).find((t) => t.profile === "analyze");
if (analyst) {
  const principal = sy.brainAccess.principalFor("analyst", { project: "demo", effort: "adhoc", task: analyst.taskId, repos: ["core"], jobId: null, tier: "T2" });
  sy.brainAccess.request(principal, "projects/demo/facts/**", "read", "The root cause depends on how the gateway times out requests; the runtime facts note has that.");
}

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
  // The real trial task above belongs to the first run (its eval and trial), so the Qualification
  // page lists it with the model under test.
  const trialTask = qualificationTrial.completed[0]?.taskId;
  if (trialTask) {
    const [endpointId] = plan[0];
    qual
      .prepare("INSERT INTO qualification_tasks (task_id, run_id, eval_id, trial, endpoint_id, fixture_path, evaluated) VALUES (?, ?, 'completion-t1-1', 1, ?, '(demo fixture)', 1)")
      .run(trialTask, `qr_demo_${endpointId.replace(/[^a-z0-9]+/gi, "_")}`, endpointId);
  }
})();

await sy.close();

// Tasks left in non-terminal states for the Tasks page. They go straight into the store:
// submitTasks() would kick the scheduler and run them in this process.
offset = 0;
const idle = new Switchyard(cfg, { providerClient, worker: false, now: clock });
const store = (specs, project = "demo") => idle.tasks.submit(specs.map((x) => WorkerTaskSchema.parse(x)), { project });
const [queued] = store([summarize("Summarise the payments log (queued: no worker running)")]);
store([summarize("Summarise the follow-up incident report", { id: "followup_after_payments", dependsOn: [queued.taskId] })]);
// The storefront's job waits in its queue: no worker is running.
store(
  [
    {
      profile: "supervise",
      label: "discount-codes",
      goal: "Add a percentage discount code to total() in src/cart.ts and integrate it onto a job branch.",
      repositoryAliases: ["app"],
      constraints: { acceptanceCriteria: ["total() applies a valid discount code", "an unknown code is rejected"] },
    },
  ],
  "storefront",
);
store([summarize("Summarise the abandoned-cart report (queued: no worker running)")], "storefront");
const [interrupted] = store([inspect("List every exported function (interrupted when the worker stopped)")]);
idle.db.prepare("UPDATE tasks SET state = 'interrupted', state_reason = 'worker lease expired', started_at = ?, run_count = 2, updated_at = ? WHERE id = ?").run(Date.now() - 20 * 60_000, Date.now(), interrupted.taskId);
idle.tasks.event(interrupted.taskId, "interrupted", { previousOwner: "demo-worker" });
// The task never ran (it went straight into the store), so its session is recorded by hand: the
// worker died with a read_file call in flight, a restarted worker resumed the session from its log
// (settling the call), and then that worker stopped too before its request was answered.
if (!idle.sessions.forTask(interrupted.taskId).length) {
  const t0 = Date.now() - 20 * 60_000;
  const at = (ms) => {
    offset = Date.now() - (t0 + ms);
  };
  const messages = [
    { role: "system", content: "You are a bounded read-only worker (inspector) for SwitchYard. Use the repository tools, cite exact lines, and finish with submit_result." },
    { role: "user", content: ["Goal:", "List every exported function (interrupted when the worker stopped)", "", "Acceptance criteria (assess each by index):", "  [0] cites the exact lines", "", "Files: core:src/server.ts"].join("\n") },
  ];
  const tools = ["read_file", "list_files", "search", "submit_result"].map((name) => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } }));
  at(300);
  const rec = idle.sessions.create({ taskId: interrupted.taskId, role: "inspector", agentLabel: `inspector:${interrupted.taskId}`, profile: "inspect", tier: "T1" });
  at(700);
  rec.syncMessages(messages);
  rec.modelRequest({ executionId: "x_demo_interrupted", purpose: "tool_loop", chat: { messages, max_tokens: 4096, tools } });
  at(4_200);
  const read = { id: "call_read_server", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/server.ts" }) } };
  const served = "groq/openai/gpt-oss-120b";
  rec.modelResponse({
    requestId: "r_demo_interrupted",
    endpoint: { id: served },
    response: {
      message: { role: "assistant", content: null, tool_calls: [read] },
      finishReason: "tool_calls",
      usage: { inputTokens: 412, outputTokens: 38, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" },
      telemetry: { servedModel: "openai/gpt-oss-120b", servedProvider: "groq" },
    },
    attempts: [{ endpointId: served, outcome: "succeeded" }],
    estimatedInputTokens: 400,
  });
  rec.syncMessages([...messages, { role: "assistant", content: null, tool_calls: [read] }]);
  rec.toolIntent({ callId: read.id, name: "read_file", args: { path: "src/server.ts" }, sideEffect: "read" });
  at(4_300);
  rec.end("interrupted", "process_died");
  // A restarted worker reopens the session and settles the read that never returned.
  at(64_000);
  const again = idle.sessions.reopen(rec.id);
  const plan = idle.sessions.planResume(rec.id);
  again.resumed(plan.summary, plan.actions, plan);
  const resumedMessages = [...plan.messages, { role: "user", content: plan.summary }];
  again.syncMessages(resumedMessages);
  again.modelRequest({ executionId: "x_demo_interrupted_2", purpose: "tool_loop", chat: { messages: resumedMessages, max_tokens: 4096, tools } });
  at(95_000);
  again.end("interrupted", "worker lease expired");
}
offset = 0;

// Key states for the Provider keys page, as of now: a second groq key the provider rejected
// (invalid), and the cerebras key cooling down for a while after a 429. Both are fake.
const revoked = idle.vault.add({ provider: "groq", label: "old key (revoked, fake)", secret: "gsk_demo-REVOKED-NOT-REAL-0d1e", billingClass: "free_tier" });
idle.providers.keys.recordFailure(idle.providers.credentials().get(`vault:${revoked.id}`), new ProviderError("auth_invalid", "401 Invalid API Key (demo)", { provider: "groq", status: 401 }));
idle.providers.keys.recordFailure(idle.providers.credentials().get("config:cerebras:literal:0"), new ProviderError("rate_limited", "429 Too Many Requests (demo)", { provider: "cerebras", status: 429, retryAfterMs: 45 * 60_000 }));
// Global knowledge (D9): approve one of Job A's two promotions as a person (the other stays
// waiting), add glossary terms, and add then revert a lesson so the Knowledge page shows a removal.
for (let i = 0; i < 100 && idle.promotions({ status: "pending_review" }).length; i++) {
  await idle.settlePromotions();
  await new Promise((r) => setTimeout(r, 50));
}
const waitingLessons = idle.promotions({ status: "pending_approval" });
if (waitingLessons.length < 2) console.warn(`warning: expected 2 promotions waiting for approval, found ${waitingLessons.length}`);
const verifyLesson = waitingLessons.find((p) => p.title.startsWith("Verify integrated work"));
if (verifyLesson) await insights.decideGlobalPromotion(idle, verifyLesson.project, verifyLesson.id, true, "you", "Holds for any repository with integration branches.");
await insights.brainWrite(idle, "global/glossary.md", "# Glossary\n\nShared terms. Supervisors maintain this file.\n\n- **Job branch**: the branch a job's supervisor integrates workers' commits onto before you merge it.\n- **Integration check**: a command run on the job branch after integrating, not in a worker's worktree.\n- **Lease**: a time-limited claim on a file or repository that keeps two workers from editing it at once.\n");
const handLesson = await idle.brainFor("storefront").promoteLesson({ kind: "human", name: "you" }, { agent: "human", role: "human" }, "Prefer feature flags over long-lived branches", "Merge small changes behind a flag instead of keeping a branch open for weeks.", []);
await insights.revertGlobalEntry(idle, handLesson.path, "you", "Too broad: some teams ship from release branches by design.");
// A supervisor's approved lesson reverted by a person: its promotion record becomes `reverted`
// (who and why), shown on the storefront Brain page and in Knowledge's recent decisions.
const moneyLesson = idle.promotions({ project: "storefront", status: "approved" }).find((p) => p.title.startsWith("Keep money in integer minor units"));
if (moneyLesson?.global_path) {
  const out = await insights.revertGlobalEntry(idle, moneyLesson.global_path, "you", "Duplicates the team's money-handling guide; keep one source.");
  console.log(`  ${"storefront: approved lesson reverted".padEnd(44)} promotion ${out.promotionStatus ?? "has no record"}`);
} else console.warn("  warning: no approved storefront lesson to revert");

// The billing project is retired: archived, with its history kept.
insights.archiveProject(idle, "legacy-billing");
await idle.close();

// The demo config samples 20% of passed results for audit (seeding forced its two audits instead).
raw.verification = { ...(raw.verification ?? {}), audit_sample_rate: 0.2 };
writeFileSync(
  configPath,
  `# SwitchYard demo configuration (generated by apps/panel/scripts/seed-demo.mjs).\n# The provider keys are fake: the demo data was produced by a scripted in-process provider client.\n${YAML.stringify(raw)}`,
);

console.log(
  `\nDemo ready. Start the panel against it with:\n  SWITCHYARD_CONFIG="${configPath}" pnpm --filter switchyard-panel dev\n(a relative SWITCHYARD_CONFIG resolves against apps/panel, e.g. SWITCHYARD_CONFIG=.demo/switchyard.config.yaml)`,
);
if (!existsSync(path.join(demo, ".switchyard"))) process.exitCode = 1;
