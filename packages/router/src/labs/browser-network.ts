import { z } from "zod";
import type { LabManager } from "./lab.js";
import type { LabRecord } from "./store.js";
import type { BrowserCheck, BrowserEvidence } from "./browser-schema.js";
import { labValues } from "./environment.js";
import { substitute } from "./recipe.js";
import { inspectLabListeners, processOwnership } from "./process-ownership.js";
import type { BrowserProtocol } from "./browser-protocol.js";
const Paused = z.object({ requestId: z.string(), request: z.object({ url: z.string().max(16384), method: z.string() }), resourceType: z.string() });
const CSP = "sandbox allow-same-origin; default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data:; style-src http: https: 'unsafe-inline'; font-src http: https: data:; media-src 'none'; manifest-src 'none'";
export interface BrowserEndpoint {
  origin: string;
  pid: number;
  token: string;
  port: number;
}
export async function ownedBrowserEndpoint(manager: LabManager, lab: LabRecord, serviceName: string, expected?: BrowserEndpoint): Promise<BrowserEndpoint> {
  const status = manager.status(lab.project, lab.name);
  const service = status.services.find(item => item.name === serviceName);
  const recipe = status.lab.recipe.services[serviceName];
  if (status.lab.state !== "running" || !service?.pid || !service.token || service.state !== "running" || !recipe?.ready || !("http" in recipe.ready))
    throw new Error("browser check requires a declared running HTTP service");
  const url = new URL(substitute(recipe.ready.http, labValues(status.lab)));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !Object.values(lab.ports).includes(Number(url.port)))
    throw new Error("browser service origin is outside its allocated loopback boundary");
  const endpoint = { origin: url.origin, pid: service.pid, token: service.token, port: Number(url.port) };
  if (expected && Object.entries(expected).some(([key, value]) => endpoint[key as keyof BrowserEndpoint] !== value))
    throw new Error("browser service identity changed during check");
  if (await processOwnership(service.pid, service.token) !== "owned")
    throw new Error("browser service process ownership could not be verified");
  const listeners = await inspectLabListeners(service.pid, service.token, Object.values(lab.ports));
  if (!listeners.some(listener => listener.port === endpoint.port))
    throw new Error("browser service port is not owned by its declared process tree");
  return endpoint;
}
/** Chrome never continues network requests: only this broker may fetch and fulfill them. */
export class BrowserResourceBroker {
  private readonly work = new Set<Promise<void>>();
  private failure: Error | null = null;
  private seen = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly manager: LabManager, readonly lab: LabRecord, readonly spec: BrowserCheck, readonly endpoint: BrowserEndpoint, readonly protocol: BrowserProtocol, readonly evidence: BrowserEvidence, readonly signal: AbortSignal, readonly stop: (message: string) => void) {
  }
  violation(message: string): void {
    if (this.evidence.violations.length < 20)
      this.evidence.violations.push(this.manager.redact(this.lab.project, this.lab.name, message).slice(0, 2000));
  }
  paused(params: unknown, sessionId: string): void {
    if (this.signal.aborted)
      return;
    this.evidence.requests = Math.min(101, ++this.seen);
    if (this.seen > this.spec.max_resources) {
      this.violation("Browser resource count exceeded its limit");
      this.stop("browser resource count exceeded");
      return;
    }
    const operation = this.queue.then(async () => {
      if (!this.signal.aborted)
        await this.fulfill(params, sessionId);
    }).catch(error => {
      this.failure = error instanceof Error ? error : new Error("browser broker failed");
      this.stop("browser broker failed");
    });
    this.queue = operation;
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation));
  }
  private async deny(id: string, sessionId: string, message: string): Promise<void> {
    this.violation(message);
    await this.protocol.call("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }, sessionId);
    this.stop("browser policy denied request");
  }
  private async fulfill(raw: unknown, sessionId: string): Promise<void> {
    const request = Paused.parse(raw);
    const url = new URL(request.request.url);
    if (url.origin !== this.endpoint.origin || url.protocol !== "http:" || url.username || url.password)
      return this.deny(request.requestId, sessionId, "Denied navigation or subresource outside the declared service origin");
    if (!["GET", "HEAD"].includes(request.request.method) || !["Document", "Stylesheet", "Image", "Font", "Other"].includes(request.resourceType))
      return this.deny(request.requestId, sessionId, "Denied non-static browser request");
    await ownedBrowserEndpoint(this.manager, this.lab, this.spec.service, this.endpoint);
    const response = await fetch(url, { method: request.request.method, redirect: "manual", signal: this.signal, headers: { accept: "*/*" } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return this.deny(request.requestId, sessionId, "Browser redirects are refused; configure the final service path explicitly");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const next = await reader.read();
        if (next.done)
          break;
        size += next.value.byteLength;
        if (size > this.spec.max_resource_bytes || this.evidence.responseBytes + next.value.byteLength > this.spec.max_total_bytes) {
          await reader.cancel();
          return this.deny(request.requestId, sessionId, "Browser response exceeded its byte limit");
        }
        this.evidence.responseBytes += next.value.byteLength;
        chunks.push(Buffer.from(next.value));
      }
    }
    await ownedBrowserEndpoint(this.manager, this.lab, this.spec.service, this.endpoint);
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream").slice(0, 200);
    await this.protocol.call("Fetch.fulfillRequest", {
      requestId: request.requestId,
      responseCode: response.status,
      responseHeaders: [
        { name: "Content-Type", value: contentType },
        { name: "Content-Security-Policy", value: CSP },
        { name: "X-DNS-Prefetch-Control", value: "off" },
        { name: "Cache-Control", value: "no-store" },
        { name: "Referrer-Policy", value: "no-referrer" },
        { name: "Cross-Origin-Resource-Policy", value: "same-origin" },
      ],
      body: Buffer.concat(chunks).toString("base64"),
    }, sessionId);
  }
  async idle(): Promise<void> {
    while (this.work.size)
      await Promise.all([...this.work]);
    if (this.failure)
      throw this.failure;
  }
}
