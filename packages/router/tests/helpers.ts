import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { parseConfig, type ResolvedConfig } from "../src/config/load.js";
import type { ChatRequest, ChatResponse } from "../src/gateway/types.js";
import { GatewayError } from "../src/core/errors.js";
import { BUILTIN_PROVIDERS } from "../src/providers/registry.js";
import type { FetchLike } from "../src/providers/transport.js";
import { Switchyard, type SwitchyardOptions } from "../src/core/service.js";

export const NOW_ISO = new Date().toISOString();

/** A manual catalog endpoint; provider/model default to openrouter/vendor/big-a:free (routed directly). */
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

/** One free_tier key (a literal test secret) for each provider the tests route to. */
export function testProviders(ids: string[] = ["openrouter", "groq", "cerebras", "mistral"]): Record<string, unknown> {
  return Object.fromEntries(ids.map((id) => [id, { keys: [{ label: `${id} test key`, api_key: `test-${id}-key`, billing_class: "free_tier" }] }]));
}

export function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    providers: testProviders(),
    storage: { directory: ".switchyard" },
    brain: { path: "brain", project: "demo" },
    models: { file: "models.yaml" },
    // Scheduled discovery is off in tests; `scan()` runs it on demand.
    discovery: { interval_minutes: 0 },
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
  o: { model?: string; provider?: string; usage?: Partial<ChatResponse["usage"]>; toolCalls?: ChatResponse["message"]["tool_calls"] } = {},
): ChatResponse {
  return {
    message: { content, ...(o.toolCalls ? { tool_calls: o.toolCalls } : {}) },
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported", ...o.usage },
    telemetry: {
      servedModel: o.model ?? "vendor/big-a:free",
      servedProvider: o.provider ?? "openrouter",
      providerAttempts: 1,
      providerAttemptsExact: true,
      cacheHit: false,
      headers: {},
    },
    httpStatus: 200,
  };
}

// ---------- fake providers ----------

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

function recordCall(url: string, init: { method: string; headers: Record<string, string>; body?: string }): FakeProviderCall {
  const auth = init.headers.authorization ?? init.headers.Authorization ?? null;
  return { url, method: init.method, headers: { ...init.headers }, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null, key: auth?.startsWith("Bearer ") ? auth.slice(7) : null };
}

/**
 * A fake provider behind an injectable fetch (`SwitchyardOptions.providerFetch`). By default it
 * answers chat completions with a good result for the requested model, lists no models, and
 * returns 404 for anything else (the OpenRouter catalog, Hugging Face).
 */
export class FakeProvider {
  readonly calls: FakeProviderCall[] = [];
  constructor(public handler: FakeProviderHandler = (call) => (call.url.endsWith("/chat/completions") ? providerChat(String(call.body?.model)) : call.url.endsWith("/models") ? providerModels([]) : providerJson({ error: { message: "not found" } }, 404))) {}

  readonly fetch: FetchLike = async (url, init) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const call = recordCall(url, init);
    this.calls.push(call);
    return this.handler(call, this.calls.length);
  };

  /** Chat completion requests only. */
  chats(): FakeProviderCall[] {
    return this.calls.filter((c) => c.url.endsWith("/chat/completions"));
  }
}

/** A chat request as a scripted provider sees it: the provider it went to and the key it used. */
export interface ScriptedRequest extends ChatRequest {
  /** Built-in provider id from the URL, or `<id>` of a custom `https://[api.]<id>.test` provider. */
  provider: string;
  url: string;
  key: string | null;
}

export type Handler = (req: ScriptedRequest, n: number, signal?: AbortSignal) => ChatResponse | Promise<ChatResponse>;

/** The provider a request URL belongs to. */
export function providerOfUrl(url: string): string {
  const builtIn = BUILTIN_PROVIDERS.find((p) => !p.baseUrl.includes("{") && url.startsWith(p.baseUrl));
  if (builtIn) return builtIn.id;
  const labels = new URL(url).hostname.split(".");
  return labels.length > 1 && labels[labels.length - 1] === "test" ? labels[labels.length - 2]! : labels[0]!;
}

const STATUS_OF: Partial<Record<GatewayError["kind"], number>> = { rate_limited: 429, pool_exhausted: 402, auth: 401, bad_request: 400, unknown_model: 404, timeout: 408, policy_violation: 451, server: 502 };

/** A thrown error as the HTTP answer a provider would give (or a dropped connection). */
function errorAnswer(err: unknown): Response {
  if (err instanceof GatewayError) {
    if (err.kind === "aborted") throw new DOMException(err.message, "AbortError");
    if (err.kind === "transport") throw new TypeError(`fetch failed: ${err.message}`);
    const status = err.kind === "server" ? (err.status && err.status >= 500 ? err.status : 502) : STATUS_OF[err.kind] ?? 500;
    const headers: Record<string, string> = err.retryAfterMs !== undefined ? { "retry-after": String(err.retryAfterMs / 1000) } : {};
    return providerJson({ error: { message: err.message, ...(err.kind === "pool_exhausted" ? { code: "insufficient_quota" } : {}) } }, status, headers);
  }
  throw new TypeError(`fetch failed: ${(err as Error)?.message ?? String(err)}`);
}

/** A ChatResponse as an OpenAI-compatible HTTP answer. */
function chatAnswer(res: ChatResponse, requestedModel: string): Response {
  const u = res.usage;
  const usage =
    u.inputTokens === null && u.outputTokens === null
      ? undefined
      : {
          prompt_tokens: u.inputTokens,
          completion_tokens: u.outputTokens,
          ...(u.cachedInputTokens !== null ? { prompt_tokens_details: { cached_tokens: u.cachedInputTokens } } : {}),
          ...(u.reasoningTokens !== null ? { completion_tokens_details: { reasoning_tokens: u.reasoningTokens } } : {}),
          ...(u.reportedCostUsd !== null ? { cost: u.reportedCostUsd } : {}),
        };
  return providerJson({
    id: "chatcmpl-scripted",
    model: res.telemetry.servedModel ?? requestedModel,
    choices: [{ index: 0, message: { role: "assistant", content: res.message.content, ...(res.message.tool_calls?.length ? { tool_calls: res.message.tool_calls } : {}) }, finish_reason: res.finishReason }],
    ...(usage ? { usage } : {}),
  });
}

/**
 * A scripted provider: an injectable fetch that turns each chat completion into a `ChatRequest`
 * for `handler` and its `ChatResponse` (or thrown `GatewayError`) back into the provider's HTTP
 * answer, so requests go through the real provider client, key rotation, and limits. Model lists
 * are empty and anything else is 404.
 */
export class ScriptedClient {
  readonly requests: ScriptedRequest[] = [];
  readonly calls: FakeProviderCall[] = [];
  constructor(public handler: Handler) {}

  readonly fetch: FetchLike = async (url, init) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const call = recordCall(url, init);
    this.calls.push(call);
    if (!url.endsWith("/chat/completions")) return url.endsWith("/models") ? providerModels([]) : providerJson({ error: { message: "not found" } }, 404);
    const b = call.body ?? {};
    const req: ScriptedRequest = {
      model: String(b.model),
      messages: b.messages as ChatRequest["messages"],
      max_tokens: Number(b.max_tokens ?? b.max_completion_tokens),
      ...(b.temperature !== undefined ? { temperature: b.temperature as number } : {}),
      ...(b.tools !== undefined ? { tools: b.tools as ChatRequest["tools"] } : {}),
      ...(b.tool_choice !== undefined ? { tool_choice: b.tool_choice as ChatRequest["tool_choice"] } : {}),
      ...(b.response_format !== undefined ? { response_format: b.response_format as ChatRequest["response_format"] } : {}),
      provider: providerOfUrl(url),
      url,
      key: call.key,
    };
    this.requests.push(structuredClone(req));
    try {
      return chatAnswer(await this.handler(req, this.requests.length, init.signal), req.model);
    } catch (err) {
      return errorAnswer(err);
    }
  };
}

export function goodOutput(criteria = 1, ref = "inline", extra: Record<string, unknown> = {}) {
  return {
    summary: "done",
    findings: [{ description: "a finding", evidenceRefs: [ref] }],
    criteria: Array.from({ length: criteria }, (_, i) => ({ index: i, status: "met", evidenceRefs: [ref] })),
    ...extra,
  };
}

/** Open a Switchyard whose providers are the given fake (a ScriptedClient or FakeProvider). */
export function open(env: Env, client: { fetch: FetchLike }, opts: SwitchyardOptions = {}): Switchyard {
  return new Switchyard(env.cfg, { providerFetch: client.fetch, pollIntervalMs: 50, ...opts });
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

/** The endpoint a request was sent to, so a reply can claim the right served model. */
export function servedFor(sy: Switchyard, req: Pick<ChatRequest, "model">): { model: string; provider: string } {
  const provider = (req as Partial<ScriptedRequest>).provider;
  const eps = sy.catalog.endpoints().filter((e) => e.route.model === req.model);
  const ep = eps.find((e) => e.route.provider === provider) ?? eps[0];
  if (!ep) throw new Error(`no endpoint for ${provider ?? "?"}/${req.model}`);
  return { model: ep.route.model, provider: ep.providerId };
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
