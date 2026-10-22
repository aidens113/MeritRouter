import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { httpAccessProblem, isLoopbackHost, MCP_TOKEN_ENV } from "../src/mcp/http.js";
import { mcpOptions } from "../src/mcp/serve.js";
import { makeEnv, summarizeTask, type Env } from "./helpers.js";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TOKEN = "test-token-0123456789abcdef";
let env: Env | undefined;
let client: Client | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill();
    await exited;
  }
  child = undefined;
  env?.cleanup();
  env = undefined;
});

/** Start `switchyard mcp --http --port 0` and wait for the URL it prints. */
async function startHttp(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Promise<{ url: string; stderr: () => string }> {
  env = makeEnv();
  let stderr = "";
  child = spawn(process.execPath, [path.join(dist, "cli.js"), "mcp", "--config", env.cfg.configPath, "--http", "--port", "0", ...extraArgs], { env: { PATH: process.env.PATH ?? "", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const proc = child;
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL printed: ${stderr}`)), 30_000);
    proc.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
      const m = /at (http:\/\/\S+\/mcp)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stderr}`));
    });
  });
  return { url, stderr: () => stderr };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };

/** A raw POST with any headers (fetch cannot set Host). */
function raw(url: string, headers: Record<string, string>, body: unknown = INIT): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe("MCP over Streamable HTTP", () => {
  it("decides access from the host and token", () => {
    for (const h of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.1.example.com"]) expect(isLoopbackHost(h)).toBe(false);
    expect(httpAccessProblem("127.0.0.1", undefined)).toBeNull();
    expect(httpAccessProblem("0.0.0.0", undefined)).toMatch(MCP_TOKEN_ENV);
    expect(httpAccessProblem("0.0.0.0", TOKEN)).toBeNull();
    expect(mcpOptions({})).toMatchObject({ http: false, host: "127.0.0.1", port: 4478, worker: true });
    expect(mcpOptions({ port: "5000", "no-worker": true })).toMatchObject({ http: true, port: 5000, worker: false });
    expect(() => mcpOptions({ port: "http" })).toThrow(/--port/);
  });

  it("lists the tools and serves calls to a loopback client without a token, refusing other hosts and origins", async () => {
    const { url } = await startHttp();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    client = new Client({ name: "codex-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(36);
    expect(names).toContain("submit_tasks");
    expect(text(await client.callTool({ name: "get_plan", arguments: { jobId: "no-such-job" } }))).toBe("unknown job no-such-job");
    const ok = await client.callTool({ name: "submit_tasks", arguments: { tasks: [summarizeTask({ idempotencyKey: "http-1" })] } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(text(ok)).submitted[0].taskId).toMatch(/^t_/);

    // DNS rebinding and tunnels: a tokenless server answers loopback names only.
    const port = new URL(url).port;
    expect((await raw(url, { host: `evil.example:${port}` })).status).toBe(403);
    expect((await raw(url, { origin: "https://evil.example" })).status).toBe(403);
    expect((await raw(url, {})).status).toBe(200);
    expect((await raw(`${url}/some-token`, {})).status).toBe(404);
    expect((await raw(url.replace(/\/mcp$/, "/other"), {})).status).toBe(404);
    // A request on a session that does not exist asks the client to start again.
    expect((await raw(url, { "mcp-session-id": "nope" })).status).toBe(404);
  }, 60_000);

  it("requires the token on every request when one is set: bearer header or path", async () => {
    const { url, stderr } = await startHttp([], { [MCP_TOKEN_ENV]: TOKEN });
    expect(stderr()).not.toContain(TOKEN);
    expect((await raw(url, {})).status).toBe(401);
    expect((await raw(url, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await raw(`${url}/wrong`, {})).status).toBe(401);
    // With a token, the token is the guard: any Host may reach it (a tunnel forwards its own name).
    expect((await raw(url, { authorization: `Bearer ${TOKEN}`, host: "tunnel.example" })).status).toBe(200);

    const refused = new Client({ name: "no-token", version: "1" });
    await expect(refused.connect(new StreamableHTTPClientTransport(new URL(url)))).rejects.toThrow();

    client = new Client({ name: "bearer", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    expect((await client.listTools()).tools).toHaveLength(36);
    await client.close();

    // ChatGPT cannot send headers: the token as the last path segment works too.
    client = new Client({ name: "path-token", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/${TOKEN}`)));
    expect(text(await client.callTool({ name: "job_status", arguments: { jobId: "no-such-job" } }))).toBe("unknown job no-such-job");
  }, 60_000);

  it("refuses to listen off loopback without a token", async () => {
    env = makeEnv();
    child = spawn(process.execPath, [path.join(dist, "mcp.js"), "--config", env.cfg.configPath, "--http", "--host", "0.0.0.0", "--port", "0"], { env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolve) => child!.once("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/0\.0\.0\.0 \(not loopback\) needs a bearer token: set SWITCHYARD_MCP_TOKEN/);
  }, 30_000);
});
