import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { parseConfig, type ResolvedConfig } from "../src/config/load.js";
import type { ChatRequest, ChatResponse, InferenceClient } from "../src/gateway/types.js";
import { Switchyard, type SwitchyardOptions } from "../src/core/service.js";

export const NOW_ISO = new Date().toISOString();

/** A manual catalog endpoint; platform/model default to openrouter/vendor/big-a:free. */
export function endpoint(overrides: Record<string, unknown> = {}) {
  const providerId = (overrides.providerId as string) ?? "openrouter";
  const gatewayModelId = (overrides.gatewayModelId as string) ?? "vendor/big-a:free";
  return {
    id: `${providerId}/${gatewayModelId}`,
    providerId,
    gatewayModelId,
    displayName: gatewayModelId,
    totalParametersB: 550,
    activeParametersB: 55,
    contextLimitTokens: 64000,
    outputLimitTokens: 8000,
    inputModalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true },
    sourceUrls: ["https://example.com/model"],
    checkedAt: NOW_ISO,
    ...overrides,
  };
}

export function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    gateway: { adapter: "freellmapi", base_url: "http://127.0.0.1:9/v1", require_verified_chains: false },
    storage: { directory: ".switchyard" },
    brain: { path: "brain", project: "demo" },
    models: { file: "models.yaml" },
    repositories: { core: { path: "repo" } },
    execution: { max_concurrent_tasks: 4, lease_seconds: 30 },
    scoring: { batch_window_ms: 50 },
    profiles: {
      summarize: { mode: "completion", min_total_parameters_b: 30, max_model_requests: 4, max_output_tokens: 2000, classify: "never", batching: { enabled: true, max_items: 4, per_item_output_tokens: 500 } },
      inspect: { mode: "read_only", min_total_parameters_b: 30, max_model_requests: 4, tools: "repository_read", classify: "never" },
      analyze: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 6, tools: "repository_read_and_artifacts", classify: "auto", min_tier: "T2" },
      implement: { mode: "coding", min_total_parameters_b: 100, max_model_requests: 8, tools: "scoped_edit_and_checks", workspace: "isolated_worktree" },
      review: { mode: "read_only", min_total_parameters_b: 100, max_model_requests: 4, tools: "repository_read_and_artifacts" },
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

export function commitAll(repo: string, message = "change") {
  gitIn(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  gitIn(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", message);
}

export function makeEnv(opts: { config?: Record<string, unknown>; endpoints?: unknown[]; overrides?: Record<string, unknown>; files?: Record<string, string> } = {}): Env {
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
  commitAll(repo, "init");
  writeFileSync(path.join(dir, "models.yaml"), YAML.stringify({ version: 1, endpoints: opts.endpoints ?? [endpoint()], overrides: opts.overrides ?? {} }));
  const raw = opts.config ?? baseConfig();
  const configPath = path.join(dir, "switchyard.config.yaml");
  writeFileSync(configPath, YAML.stringify(raw));
  const cfg = parseConfig(raw, configPath);
  return { dir, repo, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function reply(
  content: string | null,
  o: { model?: string; provider?: string; attempts?: number; usage?: Partial<ChatResponse["usage"]>; toolCalls?: ChatResponse["message"]["tool_calls"] } = {},
): ChatResponse {
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

/** In-process gateway double. By default replies as the endpoint whose chain was requested. */
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

/** Map a chain name back to the endpoint so replies can claim the right served model. */
export function servedFor(sy: Switchyard, req: ChatRequest): { model: string; provider: string } {
  const chain = req.model.replace(/^auto:/, "");
  const ep = sy.catalog.endpoints().find((e) => e.chainName === chain)!;
  return { model: ep.gatewayModelId, provider: ep.providerId };
}

// ---------- fake direct provider (direct providers P2) ----------

/** One HTTP request a fake provider received. */
export interface FakeProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** The bearer key, when one was sent. */
  key: string | null;
}

export type FakeProviderHandler = (call: FakeProviderCall, n: number) => Response | Promise<Response>;

export function providerJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** An OpenAI-compatible chat completion for `model`. */
export function providerChat(
  model: string,
  o: { content?: string | null; toolCalls?: ChatResponse["message"]["tool_calls"]; promptTokens?: number; completionTokens?: number; headers?: Record<string, string> } = {},
): Response {
  const content = o.content === undefined ? JSON.stringify(goodOutput()) : o.content;
  return providerJson(
    {
      id: "chatcmpl-test",
      model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(o.toolCalls ? { tool_calls: o.toolCalls } : {}) }, finish_reason: o.toolCalls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: o.promptTokens ?? 100, completion_tokens: o.completionTokens ?? 50 },
    },
    200,
    o.headers,
  );
}

/** An OpenAI-shaped model list. */
export function providerModels(models: Array<string | Record<string, unknown>>): Response {
  return providerJson({ object: "list", data: models.map((m) => (typeof m === "string" ? { id: m, object: "model" } : { object: "model", ...m })) });
}

/**
 * A fake provider behind an injectable fetch (`SwitchyardOptions.providerFetch`). By default it
 * answers chat completions with a good result for the requested model, lists no models, and
 * returns 404 for anything else (the OpenRouter catalog, Hugging Face).
 */
export class FakeProvider {
  readonly calls: FakeProviderCall[] = [];
  constructor(public handler: FakeProviderHandler = (call) => (call.url.endsWith("/chat/completions") ? providerChat(String(call.body?.model)) : call.url.endsWith("/models") ? providerModels([]) : providerJson({ error: { message: "not found" } }, 404))) {}

  readonly fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const auth = init.headers.authorization ?? init.headers.Authorization ?? null;
    const call: FakeProviderCall = { url, method: init.method, headers: { ...init.headers }, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null, key: auth?.startsWith("Bearer ") ? auth.slice(7) : null };
    this.calls.push(call);
    return this.handler(call, this.calls.length);
  };

  /** Chat completion requests only. */
  chats(): FakeProviderCall[] {
    return this.calls.filter((c) => c.url.endsWith("/chat/completions"));
  }
}

/** A manual catalog endpoint routed directly to `provider` (free through free_tier keys by default). */
export function directEndpoint(provider: string, model: string, overrides: Record<string, unknown> = {}) {
  return endpoint({
    providerId: provider,
    gatewayModelId: model,
    route: { kind: "direct", provider, model },
    pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeVerified: true, freeBasis: "key" },
    ...overrides,
  });
}
