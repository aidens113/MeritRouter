// The MCP server over Streamable HTTP, for clients that cannot launch a local process (ChatGPT
// through a tunnel, Codex or another agent pointed at a URL).
//
// Access: with a token (SWITCHYARD_MCP_TOKEN) every request must carry it, as
// `Authorization: Bearer <token>` or as the last path segment (`/mcp/<token>`, for ChatGPT,
// which cannot send custom headers). A token is required whenever the server listens on a
// non-loopback address. Without a token the server listens on loopback only and also refuses
// requests whose Host or Origin is not a loopback name, so neither a web page (DNS rebinding) nor
// a tunnel can reach a tokenless server.
//
// Each client session gets its own McpServer (an McpServer serves one transport); all of them
// share the process's Switchyard.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PATH = "/mcp";
export const MCP_TOKEN_ENV = "SWITCHYARD_MCP_TOKEN";
/** Largest request body accepted (submit_tasks may carry up to 50 tasks with inline text). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Whether a host name or address is loopback (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(h);
}

/** Why the server must not start with this host and token, or null when it may. */
export function httpAccessProblem(host: string, token: string | undefined): string | null {
  if (token || isLoopbackHost(host)) return null;
  return `listening on ${host} (not loopback) needs a bearer token: set ${MCP_TOKEN_ENV} (for example to the output of \`openssl rand -hex 32\`)`;
}

export interface HttpServeOptions {
  host: string;
  /** 0 picks a free port; the handle's url carries the one chosen. */
  port: number;
  token?: string | undefined;
  /** A new server for each client session. */
  build: () => McpServer;
}

export interface HttpHandle {
  /** The endpoint URL (without any token). */
  url: string;
  port: number;
  close(): Promise<void>;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** The host name of a Host header (`name:port`, `[v6]:port`). */
function hostName(header: string): string {
  const v6 = /^\[([^\]]+)\]/.exec(header);
  if (v6) return v6[1]!;
  return header.replace(/:\d+$/, "");
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError(`request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Start the HTTP endpoint at `http://<host>:<port>/mcp`. */
export async function serveHttp(opts: HttpServeOptions): Promise<HttpHandle> {
  const problem = httpAccessProblem(opts.host, opts.token);
  if (problem) throw new Error(problem);
  const token = opts.token || undefined;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  /** True when the request may proceed; otherwise the refusal was sent. */
  const admit = (req: IncomingMessage, res: ServerResponse, pathToken: string | undefined): boolean => {
    if (token) {
      const auth = req.headers.authorization ?? "";
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
      const presented = bearer ?? pathToken;
      if (presented && sameSecret(presented, token)) return true;
      rpcError(res, 401, -32001, "unauthorized: send the token as Authorization: Bearer <token>", { "www-authenticate": 'Bearer realm="switchyard"' });
      return false;
    }
    const host = req.headers.host;
    if (!host || !isLoopbackHost(hostName(host))) {
      rpcError(res, 403, -32001, `forbidden host ${host ?? "(none)"}: without ${MCP_TOKEN_ENV} only loopback names are served`);
      return false;
    }
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname;
      } catch {
        // An unparsable origin is refused below.
      }
      if (!isLoopbackHost(originHost)) {
        rpcError(res, 403, -32001, `forbidden origin ${origin}`);
        return false;
      }
    }
    if (pathToken !== undefined) {
      rpcError(res, 404, -32601, "not found");
      return false;
    }
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== MCP_PATH.slice(1) || parts.length > 2) return rpcError(res, 404, -32601, "not found");
    const pathToken = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
    if (!admit(req, res, pathToken)) return;

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const known = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !known) return rpcError(res, 404, -32001, "session not found: initialize a new session");

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return err instanceof RangeError ? rpcError(res, 413, -32600, err.message) : rpcError(res, 400, -32700, "parse error: the body is not JSON");
      }
      if (known) return known.transport.handleRequest(req, res, body);
      if (!isInitializeRequest(body)) return rpcError(res, 400, -32000, "no session: send initialize first (without an mcp-session-id header)");
      const server = opts.build();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    if (req.method === "GET" || req.method === "DELETE") {
      if (!known) return rpcError(res, 400, -32000, "an mcp-session-id header is required");
      return known.transport.handleRequest(req, res);
    }
    rpcError(res, 405, -32000, "method not allowed", { allow: "GET, POST, DELETE" });
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => rpcError(res, 500, -32603, `internal error: ${(err as Error).message ?? String(err)}`));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${shownHost}:${port}${MCP_PATH}`,
    port,
    close: async () => {
      for (const { server } of [...sessions.values()]) await server.close().catch(() => undefined);
      sessions.clear();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}
