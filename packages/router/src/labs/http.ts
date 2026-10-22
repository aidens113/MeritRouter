import { z } from "zod";
import type { LabManager } from "./lab.js";
import { LabNameSchema, substitute } from "./recipe.js";
import { labValues } from "./environment.js";
import { inspectLabListeners, processOwnership } from "./process-ownership.js";
import { SwitchyardError } from "../core/errors.js";
export const LabHttpInputSchema = z.object({ service: LabNameSchema, method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"), path: z.string().min(1).max(2000).default("/"), headers: z.record(z.string(), z.string().max(2048)).default({}), body: z.string().max(65536).optional(), timeoutMs: z.number().int().min(100).max(10000).default(5000) }).strict();
export type LabHttpInput = z.input<typeof LabHttpInputSchema>;
export interface LabHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  url: string;
}
export async function labHttp(manager: LabManager, project: string, name: string, raw: LabHttpInput): Promise<LabHttpResult> {
  const input = LabHttpInputSchema.parse(raw);
  const before = manager.status(project, name);
  const s = before.services.find(x => x.name === input.service);
  const recipe = before.lab.recipe.services[input.service];
  if (before.lab.state !== "running" || !s || s.state !== "running" || !s.pid || !s.token || !recipe?.ready || !("http" in recipe.ready))
    throw new SwitchyardError("lab_http_unavailable", "HTTP requires a running declared HTTP service in this lab");
  if (await processOwnership(s.pid, s.token) !== "owned")
    throw new SwitchyardError("lab_process_ownership", "HTTP service process ownership could not be verified");
  const base = new URL(substitute(recipe.ready.http, labValues(before.lab)));
  const port = Number(base.port);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || !Object.values(before.lab.ports).includes(port))
    throw new SwitchyardError("lab_scope_denied", "HTTP service is not on this lab's allocated loopback ports");
  if (!input.path.startsWith("/") || input.path.startsWith("//") || /[\\\r\n\u0000]/.test(input.path))
    throw new SwitchyardError("lab_scope_denied", "HTTP path must be relative to this service, without URL or header escapes");
  const url = new URL(input.path, base.origin);
  if (url.origin !== base.origin || url.username || url.password)
    throw new SwitchyardError("lab_scope_denied", "HTTP target escaped the service origin");
  const listeners = await inspectLabListeners(s.pid, s.token, Object.values(before.lab.ports));
  if (!listeners.some(x => x.port === port))
    throw new SwitchyardError("lab_process_ownership", "allocated HTTP port is not currently owned by this service's process tree");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    const lower = key.toLowerCase();
    if (!["accept", "content-type", "if-none-match", "if-modified-since"].includes(lower) || /[\r\n\u0000]/.test(value))
      throw new SwitchyardError("lab_scope_denied", `HTTP header ${key} is not allowed`);
    headers[lower] = value;
  }
  if ((input.method === "GET" || input.method === "HEAD") && input.body !== undefined)
    throw new SwitchyardError("lab_invalid_input", "GET and HEAD cannot carry a body");
  manager.touch(project, name);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("lab HTTP timed out"), input.timeoutMs);
  try {
    const response = await fetch(url, { method: input.method, headers, body: input.body, redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SwitchyardError("lab_http_redirect", "lab HTTP redirects are not followed; use an explicit path on this service");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done)
          break;
        const remaining = 65536 - size;
        if (next.value.byteLength > remaining) {
          if (remaining > 0)
            chunks.push(Buffer.from(next.value.subarray(0, remaining)));
          size = 65536;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(Buffer.from(next.value));
        size += next.value.byteLength;
      }
    }
    const after = manager.status(project, name).services.find(x => x.name === input.service);
    if (after?.state !== "running" || after.pid !== s.pid || after.token !== s.token || await processOwnership(s.pid, s.token) !== "owned")
      throw new SwitchyardError("lab_process_ownership", "HTTP service ownership changed during the request");
    const listenersAfter = await inspectLabListeners(s.pid, s.token, Object.values(before.lab.ports));
    if (!listenersAfter.some(listener => listener.port === port))
      throw new SwitchyardError("lab_process_ownership", "HTTP listening socket ownership changed during the request");
    return { status: response.status, headers: Object.fromEntries([...response.headers].filter(([key]) => ["content-type", "content-length", "etag", "last-modified"].includes(key))), body: Buffer.concat(chunks).toString("utf8"), truncated, url: url.href };
  }
  finally {
    clearTimeout(timeout);
  }
}
