import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { AdmissionDenied, GatewayError } from "../core/errors.js";
import { ClientConnectionsConfigSchema, type ClientConnectionsConfig } from "../config/schema.js";
import {
  CLIENT_CONNECTION_HOST, CLIENT_CONNECTION_MAX_BODY_BYTES, CLIENT_CONNECTION_MODEL, CLIENT_CONNECTION_MODELS,
  ClientConnectionError, ClientConnectionRequestSchema, ClientConnectionShowSchema,
  clientResponse, finishReason, ollamaMessage, openaiUsage, parseClientChat,
  type ClientConnectionDispatch, type ClientChatResponse, type ParsedClientChat,
} from "./protocol.js";

export interface ClientConnectionsStatus {
  enabled: boolean;
  state: "off" | "starting" | "running" | "error";
  running: boolean;
  host: "127.0.0.1";
  port: number;
  project: string | null;
  openaiBaseUrl: string;
  ollamaBaseUrl: string;
  models: Array<{ id: string; name: string }>;
  activeRequests: number;
  error: string | null;
  bufferedStreaming: true;
}
export interface ClientConnectionsOptions { dispatch: ClientConnectionDispatch }
const localNames = new Set(["localhost", "127.0.0.1", "[::1]"]);
function localUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && localNames.has(url.hostname.toLowerCase()) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
function failure(res: ServerResponse, path: string, error: ClientConnectionError): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.end(); return; }
  const value = path.startsWith("/v1/") ? { error: { message: error.message, type: error.code, code: error.code, param: null } } : { error: error.message };
  json(res, error.status, value);
}
function safeError(error: unknown, signal?: AbortSignal): ClientConnectionError {
  if (signal?.aborted) return signal.reason instanceof ClientConnectionError ? signal.reason : new ClientConnectionError(499, "request_cancelled", "The client request was cancelled.");
  if (error instanceof ClientConnectionError) return error;
  if (error instanceof z.ZodError) return new ClientConnectionError(400, "invalid_request", error.issues.slice(0, 8).map(issue => issue.path.map(String).join(".") + ": " + issue.message).join("; "));
  if (error instanceof AdmissionDenied) return new ClientConnectionError(429, error.reason, "The selected project's routing or budget policy refused this request.");
  if (error instanceof GatewayError) {
    if (error.kind === "timeout") return new ClientConnectionError(504, "request_timeout", "The model request timed out.");
    if (error.kind === "aborted") return new ClientConnectionError(499, "request_cancelled", "The model request was cancelled.");
    if (error.kind === "rate_limited" || error.kind === "pool_exhausted") return new ClientConnectionError(429, "capacity_unavailable", "Configured model capacity is unavailable.");
  }
  // Provider exceptions can include credential-bearing URLs or headers. Keep their details local.
  return new ClientConnectionError(502, "model_request_failed", "The selected project could not complete this model request. Inspect its request history in MeritRouter.");
}
async function readJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const advertised = req.headers["content-length"];
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > CLIENT_CONNECTION_MAX_BODY_BYTES))
    throw new ClientConnectionError(413, "body_too_large", "Request body exceeds the 2 MiB limit.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const abort = () => { if (!req.complete) req.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of req) {
      if (signal.aborted) throw signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > CLIENT_CONNECTION_MAX_BODY_BYTES) throw new ClientConnectionError(413, "body_too_large", "Request body exceeds the 2 MiB limit.");
      chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new ClientConnectionError(400, "invalid_json", "Request body must contain valid JSON."); }
  } finally { signal.removeEventListener("abort", abort); }
}
function nativeUsage(value: ClientChatResponse): Record<string, number> {
  return { ...(value.usage.inputTokens === null ? {} : { prompt_eval_count: value.usage.inputTokens }),
    ...(value.usage.outputTokens === null ? {} : { eval_count: value.usage.outputTokens }) };
}
function deliver(res: ServerResponse, parsed: ParsedClientChat, value: ClientChatResponse): void {
  const created = Date.now(), content = value.message.content;
  res.setHeader("x-meritrouter-streaming", "buffered");
  if (parsed.protocol === "openai") {
    const base = { id: "chatcmpl-" + randomUUID(), created: Math.floor(created / 1000), model: CLIENT_CONNECTION_MODEL };
    const usage = openaiUsage(value);
    if (!parsed.stream) return json(res, 200, { ...base, object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content, ...(value.message.tool_calls ? { tool_calls: value.message.tool_calls } : {}) }, finish_reason: finishReason(value), logprobs: null }], usage });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    const chunk = (delta: unknown, final: string | null = null) => res.write("data: " + JSON.stringify({ ...base, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: final, logprobs: null }], ...(parsed.includeUsage ? { usage: null } : {}) }) + "\n\n");
    chunk({ role: "assistant", content: "" });
    if (content) chunk({ content });
    if (value.message.tool_calls?.length) chunk({ tool_calls: value.message.tool_calls.map((call, index) => ({ ...call, index })) });
    chunk({}, finishReason(value));
    if (parsed.includeUsage) res.write("data: " + JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage }) + "\n\n");
    res.end("data: [DONE]\n\n");
    return;
  }
  const base = { model: CLIENT_CONNECTION_MODEL, created_at: new Date(created).toISOString() };
  const payload = parsed.protocol === "ollama-chat" ? { message: ollamaMessage(value) } : { response: content ?? "" };
  const final = { ...base, done: true, done_reason: finishReason(value), ...nativeUsage(value) };
  if (!parsed.stream) return json(res, 200, { ...final, ...payload });
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform" });
  res.write(JSON.stringify({ ...base, ...payload, done: false }) + "\n");
  res.end(JSON.stringify({ ...final, ...(parsed.protocol === "ollama-chat" ? { message: { role: "assistant", content: "" } } : { response: "" }) }) + "\n");
}

/** One explicit lifecycle owner (the panel); ordinary SDK instances never create listeners. */
export class ClientConnectionsController {
  private desired = ClientConnectionsConfigSchema.parse({});
  private state: ClientConnectionsStatus["state"] = "off";
  private error: string | null = null;
  private server: Server | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly options: ClientConnectionsOptions) {}

  status(): ClientConnectionsStatus {
    const url = "http://" + CLIENT_CONNECTION_HOST + ":" + this.desired.port;
    return { enabled: this.desired.enabled, state: this.state, running: this.state === "running",
      host: CLIENT_CONNECTION_HOST, port: this.desired.port, project: this.desired.project,
      openaiBaseUrl: url + "/v1", ollamaBaseUrl: url, models: CLIENT_CONNECTION_MODELS.map(value => ({ ...value })),
      activeRequests: this.active.size, error: this.error, bufferedStreaming: true };
  }

  sync(raw: ClientConnectionsConfig): Promise<ClientConnectionsStatus> {
    const config = ClientConnectionsConfigSchema.parse(raw);
    const run = this.chain.then(() => this.apply(config));
    this.chain = run.catch(() => undefined);
    return run;
  }
  async close(): Promise<void> {
    await this.sync({ ...this.desired, enabled: false });
  }
  private async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const abort of this.active) abort.abort(new ClientConnectionError(503, "connections_disabled", "Client connections were disabled or reconfigured."));
    if (server) {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      await Promise.allSettled([...this.pending]);
      server.closeAllConnections();
      await closed;
    }
  }
  private async apply(config: ClientConnectionsConfig): Promise<ClientConnectionsStatus> {
    if (JSON.stringify(config) === JSON.stringify(this.desired) && (this.state === "running" || this.state === "off")) return this.status();
    this.desired = config;
    this.state = config.enabled ? "starting" : "off";
    this.error = null;
    await this.stop();
    if (!config.enabled) return this.status();
    const server = createServer((req, res) => {
      const run = this.handle(req, res, config).catch(() => { if (!res.writableEnded) res.destroy(); });
      this.pending.add(run);
      void run.finally(() => this.pending.delete(run));
    });
    server.requestTimeout = config.request_timeout_seconds * 1000;
    server.headersTimeout = Math.min(10_000, server.requestTimeout);
    server.keepAliveTimeout = 1000;
    server.maxHeadersCount = 64;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const error = (err: Error) => reject(err);
        server.once("error", error);
        server.listen({ host: CLIENT_CONNECTION_HOST, port: config.port, exclusive: true }, () => { server.off("error", error); resolve(); });
      });
      this.state = "running";
      server.on("error", () => { this.state = "error"; this.error = "The local compatibility listener failed. Toggle connections to retry."; });
    } catch (error) {
      this.server = null;
      this.state = "error";
      this.error = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "Port " + config.port + " is already in use. Choose another port."
        : "Cannot bind the local compatibility listener on port " + config.port + ".";
    }
    return this.status();
  }

  private admit(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host, parsedHost = host ? localUrl("http://" + host) : null;
    if (!parsedHost || parsedHost.pathname !== "/" || parsedHost.search || parsedHost.hash || Number(parsedHost.port || 80) !== req.socket.localPort)
      throw new ClientConnectionError(403, "forbidden_host", "Only the local listener's loopback Host is accepted.");
    const origin = req.headers.origin;
    if (origin) {
      const parsedOrigin = localUrl(origin);
      if (!parsedOrigin || parsedOrigin.origin !== origin)
        throw new ClientConnectionError(403, "forbidden_origin", "Only HTTP(S) origins on localhost, 127.0.0.1 or [::1] are accepted.");
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "Content-Type, Authorization");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("access-control-allow-private-network", "true");
    }
  }
  private async handle(req: IncomingMessage, res: ServerResponse, config: ClientConnectionsConfig): Promise<void> {
    let path = "/";
    let abort: AbortController | undefined, timer: NodeJS.Timeout | undefined;
    const disconnected = () => { if (!res.writableEnded) abort?.abort(new ClientConnectionError(499, "request_cancelled", "The client disconnected.")); };
    try {
      this.admit(req, res);
      path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/$/, "") || "/";
      if (this.state !== "running") throw new ClientConnectionError(503, "connections_disabled", "Client connections are disabled.");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const method = req.method;
      if ((method === "GET" || method === "HEAD") && path === "/") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(method === "HEAD" ? "" : "MeritRouter compatibility API is running."); return;
      }
      if (method === "GET" && path === "/v1/models") return json(res, 200, { object: "list", data: [{ id: CLIENT_CONNECTION_MODEL, object: "model", created: 0, owned_by: "meritrouter" }] });
      if (method === "GET" && path === "/api/version") return json(res, 200, { version: "0.1.0-meritrouter", meritrouter: true });
      if (method === "GET" && path === "/api/tags") return json(res, 200, { models: [{ name: CLIENT_CONNECTION_MODEL + ":latest", model: CLIENT_CONNECTION_MODEL + ":latest",
        modified_at: "1970-01-01T00:00:00.000Z", size: 0, digest: "meritrouter-virtual-route",
        details: { parent_model: "", format: "meritrouter", family: "meritrouter", families: ["meritrouter"], parameter_size: "automatic", quantization_level: "" } }] });
      if (method !== "POST" || !["/v1/chat/completions", "/api/chat", "/api/generate", "/api/show"].includes(path))
        throw new ClientConnectionError(404, "unsupported_endpoint", "This endpoint is not supported by MeritRouter client connections.");
      if (this.active.size >= config.max_concurrent) throw new ClientConnectionError(429, "concurrency_limit", "The Connections concurrent request limit is reached.");
      abort = new AbortController();
      this.active.add(abort);
      req.once("aborted", disconnected); res.once("close", disconnected);
      const controller = abort;
      timer = setTimeout(() => controller.abort(new ClientConnectionError(504, "request_timeout", "The client request exceeded its configured timeout.")), config.request_timeout_seconds * 1000);
      timer.unref();
      const raw = await readJson(req, abort.signal);
      if (path === "/api/show") {
        ClientConnectionShowSchema.parse(raw);
        return json(res, 200, { capabilities: ["completion", "tools"], parameters: "num_predict " + config.max_output_tokens,
          details: { format: "meritrouter", family: "meritrouter", families: ["meritrouter"], parameter_size: "automatic", quantization_level: "" },
          model_info: { "general.architecture": "meritrouter" }, template: "", license: "Upstream model terms apply." });
      }
      const parsed = parseClientChat(path, raw, config);
      const request = ClientConnectionRequestSchema.parse({ project: config.project, profile: config.profile, chat: parsed.chat });
      if (abort.signal.aborted) throw abort.signal.reason;
      const result = await this.options.dispatch(request, abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      deliver(res, parsed, clientResponse(result));
    } catch (error) { failure(res, path, safeError(error, abort?.signal)); }
    finally {
      if (timer) clearTimeout(timer);
      req.off("aborted", disconnected); res.off("close", disconnected);
      if (abort) this.active.delete(abort);
    }
  }
}
