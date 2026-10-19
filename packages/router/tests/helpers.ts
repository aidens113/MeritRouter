import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { parseConfig, type ResolvedConfig } from "../src/config/load.js";
import type { ChatRequest, ChatResponse, InferenceClient } from "../src/gateway/types.js";
import { Switchyard, type SwitchyardOptions } from "../src/core/service.js";

export const NOW_ISO = new Date().toISOString();

export function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: "big-a",
    providerId: "openrouter",
    providerModelId: "vendor/big-a",
    gatewayModelId: "vendor/big-a:free",
    quotaScopeIds: ["openrouter:account"],
    totalParametersB: 550,
    activeParametersB: 55,
    contextLimitTokens: 64000,
    outputLimitTokens: 8000,
    supportsTools: true,
    supportsImages: false,
    supportsStructuredOutput: true,
    approvedProfiles: ["summarize", "inspect", "analyze", "implement", "review"],
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true },
    sourceUrls: ["https://example.com/model"],
    checkedAt: NOW_ISO,
    ...overrides,
  };
}

export function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_pools: false },
    storage: { directory: ".switchyard" },
    models: { file: "models.yaml" },
    repositories: { core: { path: "repo" } },
    execution: { max_concurrent_tasks: 4, lease_seconds: 30 },
    profiles: {
      summarize: { mode: "completion", min_total_parameters_b: 30, gateway_model: "auto:switchyard-summary", max_output_tokens: 2000, batching: { enabled: true, max_items: 4, per_item_output_tokens: 500 } },
      inspect: { mode: "read_only", min_total_parameters_b: 30, gateway_model: "auto:switchyard-inspect", max_model_requests: 4, tools: "repository_read" },
      analyze: { mode: "read_only", min_total_parameters_b: 100, gateway_model: "auto:switchyard-analysis", max_model_requests: 6, tools: "repository_read_and_artifacts" },
      implement: { mode: "coding", min_total_parameters_b: 100, gateway_model: "auto:switchyard-code", max_model_requests: 8, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" },
      review: { mode: "read_only", min_total_parameters_b: 100, gateway_model: "auto:switchyard-review", max_model_requests: 4, tools: "repository_read_and_artifacts" },
    },
    ...overrides,
  };
}

export interface Env {
  dir: string;
  repo: string;
  cfg: ResolvedConfig;
  cleanup: () => void;
}

function gitIn(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

export function makeEnv(opts: { config?: Record<string, unknown>; endpoints?: unknown[]; files?: Record<string, string> } = {}): Env {
  const dir = mkdtempSync(path.join(tmpdir(), "switchyard-test-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  const files = opts.files ?? {
    "src/app.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    "README.md": "# Fixture\n\nA tiny fixture repository.\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), content);
  }
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  gitIn(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  writeFileSync(path.join(dir, "models.yaml"), YAML.stringify({ version: 1, endpoints: opts.endpoints ?? [endpoint()] }));
  const raw = opts.config ?? baseConfig();
  const configPath = path.join(dir, "switchyard.config.yaml");
  writeFileSync(configPath, YAML.stringify(raw));
  const cfg = parseConfig(raw, configPath);
  return { dir, repo, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function reply(content: string | null, o: { model?: string; provider?: string; attempts?: number; usage?: Partial<ChatResponse["usage"]>; toolCalls?: ChatResponse["message"]["tool_calls"] } = {}): ChatResponse {
  return {
    message: { content, ...(o.toolCalls ? { tool_calls: o.toolCalls } : {}) },
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported", ...o.usage },
    telemetry: {
      servedModel: o.model ?? "vendor/big-a:free",
      servedProvider: o.provider ?? "openrouter",
      providerAttempts: o.attempts ?? 1,
      providerAttemptsExact: false,
      cacheHit: false,
      headers: {},
    },
    httpStatus: 200,
  };
}

export type Handler = (req: ChatRequest, n: number) => ChatResponse | Promise<ChatResponse>;

export class ScriptedClient implements InferenceClient {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(public handler: Handler) {}
  async complete(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    if (signal?.aborted) throw new Error("aborted");
    return this.handler(req, this.requests.length);
  }
}

export function goodOutput(criteria = 1, ref = "inline", extra: Record<string, unknown> = {}) {
  return {
    summary: "done",
    findings: [{ description: "a finding", evidenceRefs: [ref] }],
    criteria: Array.from({ length: criteria }, (_, i) => ({ index: i, status: "met", evidenceRefs: [ref] })),
    ...extra,
  };
}

export function open(env: Env, client: InferenceClient, opts: SwitchyardOptions = {}): Switchyard {
  return new Switchyard(env.cfg, { client, admin: null, pollIntervalMs: 50, ...opts });
}

export function summarizeTask(extra: Record<string, unknown> = {}) {
  return {
    profile: "summarize",
    goal: "Summarise the log",
    context: { inlineText: "line one\nline two\nERROR: boom at step 3" },
    constraints: { acceptanceCriteria: ["mentions the error"] },
    ...extra,
  };
}
