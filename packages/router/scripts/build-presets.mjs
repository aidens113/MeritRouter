// Generates examples/presets/*.yaml from examples/meritrouter.config.example.yaml.
// Run: node scripts/build-presets.mjs   (keeps the example's comments; presets differ only where noted)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = readFileSync(path.join(root, "examples/meritrouter.config.example.yaml"), "utf8");
const out = path.join(root, "examples/presets");
mkdirSync(out, { recursive: true });

// Delegated delivery uses the configured delivery-budget ceiling (600 by default).
// This profile adds no smaller ceiling; explicit strict evidence and spending policies still gate dispatch.
const supervise = {
  mode: "supervisor",
  tools: "supervisor",
  min_total_parameters_b: 100,
  max_model_requests: null,
  max_output_tokens: 8000,
  classify: "never",
  min_tier: "T3",
};

const anthropic = { kind: "anthropic", base_url: "https://api.anthropic.com" };
const claudeModel = {
  provider: "anthropic",
  model: "REPLACE-with-a-model-id",
  display_name: "Claude (set the model id and current prices before use)",
  context_limit_tokens: 200000,
  output_limit_tokens: 16000,
  input_modalities: ["text", "image"],
  supports_tools: true,
  ignore_size_floor: true,
};

const presets = {
  "claude-code": {
    header: "Preset: claude-code. The MCP client is FINAL supervisor; MeritRouter supervisors own delegated delivery using the strongest eligible route. Reviewed quality evidence is optional unless strict routing is configured.",
    edits: [[["brain", "project"], "my-project"], [["profiles", "supervise"], supervise]],
  },
  "standalone-free": {
    header: "Preset: standalone-free. MeritRouter's own supervisor runs on the most capable eligible free model; workers are free.",
    edits: [
      [["profiles", "supervise"], supervise],
      [["brain", "project"], "my-project"],
      [["supervisor"], { endpoints: [], paid_policy: "never", max_concurrent_jobs: 1 }],
      [["paid"], { enabled: false, budgets: { per_week_usd: 0 }, tiers: { T1: "never", T2: "never", T3: "never", T4: "never" }, max_paid_attempts: 2, providers: {}, models: [] }],
    ],
  },
  "standalone-hybrid": {
    header: "Preset: standalone-hybrid. A paid supervisor (set the model and prices), free workers, paid fallback for T3 only when free models are exhausted.",
    edits: [
      [["profiles", "supervise"], supervise],
      [["brain", "project"], "my-project"],
      [["paid"], { enabled: true, budgets: { per_week_usd: 5 }, tiers: { T1: "never", T2: "never", T3: "on_free_exhaustion", T4: "never" }, max_paid_attempts: 2, providers: { anthropic }, models: [claudeModel] }],
      [["supervisor"], { endpoints: ["paid:anthropic/REPLACE-with-a-model-id"], paid_policy: "preferred", max_concurrent_jobs: 1 }],
    ],
  },
  "standalone-paid": {
    header: "Preset: standalone-paid. Paid supervisor; paid models preferred for T2-T3 and used for T4 work; free models for T1.",
    edits: [
      [["profiles", "supervise"], supervise],
      [["brain", "project"], "my-project"],
      [["paid"], { enabled: true, budgets: { per_week_usd: 20, per_month_usd: 60 }, tiers: { T1: "never", T2: "preferred", T3: "preferred", T4: "premium" }, max_paid_attempts: 2, providers: { anthropic }, models: [claudeModel] }],
      [["supervisor"], { endpoints: ["paid:anthropic/REPLACE-with-a-model-id"], paid_policy: "preferred", max_concurrent_jobs: 1 }],
    ],
  },
};

for (const [name, p] of Object.entries(presets)) {
  const doc = YAML.parseDocument(example);
  doc.commentBefore = ` ${p.header}\n Generated from meritrouter.config.example.yaml by scripts/build-presets.mjs.\n${doc.commentBefore ?? ""}`;
  for (const [keyPath, value] of p.edits) doc.setIn(keyPath, doc.createNode(value));
  writeFileSync(path.join(out, `${name}.yaml`), doc.toString());
  console.log(`wrote examples/presets/${name}.yaml`);
}
