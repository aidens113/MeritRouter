import { z } from "zod";
import type { LabManager } from "./lab.js";
import type { LabRecord } from "./store.js";
import { ownedBrowserEndpoint, type BrowserEndpoint } from "./browser-network.js";
import type { BrowserJourneyCheck, BrowserJourneyEvidence } from "./browser-journey-schema.js";
import type { JourneyProtocol } from "./browser-journey-dom.js";
import { productDigest } from "../verification/product-spec.js";
import { createHash } from "node:crypto";
const Paused = z.object({ requestId: z.string(), resourceType: z.string(), request: z.object({ url: z.string().max(16384), method: z.string(), headers: z.record(z.string(), z.string()), postData: z.string().max(1024 * 1024).optional(), postDataEntries: z.array(z.object({ bytes: z.string().max(2 * 1024 * 1024).optional() })).max(100).optional() }) });
/** Browser has no network interface to host services. Only this scoped parent broker connects. */
export class JourneyResourceBroker {
  private readonly pending = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private readonly resources: Array<{
    request: string;
    status: number;
    sha256: string;
  }> = [];
  private restart: Promise<void> | null = null;
  constructor(private readonly manager: LabManager, private readonly lab: LabRecord, private readonly spec: BrowserJourneyCheck, public endpoint: BrowserEndpoint, private readonly client: JourneyProtocol, private readonly evidence: BrowserJourneyEvidence, private readonly signal: AbortSignal, private readonly stop: (reason: string) => void) { }
  resourceDigest() { return productDigest(this.resources); }
  pauseForRestart() {
    if (this.restart)
      throw new Error("journey_restart_already_pending"); let release!: () => void; this.restart = new Promise<void>(resolve => { release = resolve; }); this.signal.addEventListener("abort", release, { once: true }); return (endpoint: BrowserEndpoint) => {
        if (endpoint.origin !== this.endpoint.origin)
          throw new Error("journey_restart_origin_changed"); this.endpoint = endpoint; this.restart = null; this.signal.removeEventListener("abort", release); release();
      };
  }
  paused(input: unknown, session: string): void {
    if (this.signal.aborted)
      return;
    const request = Paused.parse(input);
    if (++this.evidence.requests > this.spec.max_resources) {
      this.evidence.requests = Math.min(501, this.evidence.requests);
      this.fail("journey_resource_limit");
      return;
    }
    // Ordered broker effects retain form/cookie ordering and deterministic evidence.
    const work = this.queue.then(() => this.fulfill(request, session)).catch(error => this.fail(error instanceof Error ? error.message : "journey_broker_failed"));
    this.queue = work;
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  private fail(reason: string) {
    this.failure ??= new Error(reason); if (this.evidence.violations.length < 20)
      this.evidence.violations.push(reason.slice(0, 2000)); this.stop(reason);
  }
  private async fulfill(request: z.infer<typeof Paused>, session: string) {
    if (this.restart)
      await this.restart;
    this.signal.throwIfAborted();
    const url = new URL(request.request.url);
    if (url.origin !== this.endpoint.origin || url.protocol !== "http:" || url.username || url.password || !this.spec.methods.includes(request.request.method as BrowserJourneyCheck["methods"][number]) || !["Document", "Stylesheet", "Image", "Font", "Script", "XHR", "Fetch", "Other", "Media"].includes(request.resourceType)) {
      await this.client.call("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" }, session);
      throw new Error("journey_request_scope_denied");
    }
    const headers: Record<string, string> = { accept: "*/*" };
    for (const [name, value] of Object.entries(request.request.headers)) {
      const lower = name.toLowerCase();
      if (["content-type", "cookie"].includes(lower)) {
        if (/[\r\n\0]/.test(value) || value.length > 16000)
          throw new Error("journey_request_header_invalid");
        headers[lower] = value;
      }
    }
    if (!["GET", "HEAD"].includes(request.request.method))
      headers.origin = this.endpoint.origin;
    let body: Buffer | undefined;
    if (request.request.postDataEntries?.length) {
      if (request.request.postDataEntries.some(entry => entry.bytes === undefined))
        throw new Error("journey_request_body_unavailable");
      body = Buffer.concat(request.request.postDataEntries.map(entry => Buffer.from(entry.bytes!, "base64")));
    }
    else if (request.request.postData !== undefined)
      body = Buffer.from(request.request.postData, "utf8");
    if (body && body.length > this.spec.max_request_bytes)
      throw new Error("journey_request_body_limit");
    if (body && ["GET", "HEAD"].includes(request.request.method))
      throw new Error("journey_unexpected_request_body");
    await ownedBrowserEndpoint(this.manager, this.lab, this.spec.service, this.endpoint);
    const response = await fetch(url, { method: request.request.method, headers, redirect: "manual", signal: this.signal, ...(body ? { body: new Uint8Array(body) } : {}) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("journey_redirect_denied");
    }
    if (response.status >= 400 && !(["XHR", "Fetch"].includes(request.resourceType) && this.spec.expected_api_errors.includes(response.status))) {
      await response.body?.cancel();
      throw new Error(`journey_http_failure_${response.status}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done)
          break;
        size += next.value.length;
        this.evidence.responseBytes += next.value.length;
        if (size > this.spec.max_resource_bytes || this.evidence.responseBytes > this.spec.max_total_bytes) {
          await reader.cancel();
          throw new Error("journey_response_limit");
        }
        chunks.push(Buffer.from(next.value));
      }
    await ownedBrowserEndpoint(this.manager, this.lab, this.spec.service, this.endpoint);
    this.resources.push({ request: productDigest({ path: url.pathname, query: url.search, method: request.request.method }), status: response.status, sha256: createHash("sha256").update(Buffer.concat(chunks)).digest("hex") });
    const origin = this.endpoint.origin;
    const csp = `sandbox allow-scripts allow-same-origin allow-forms; default-src 'none'; script-src ${origin} 'unsafe-inline'; connect-src ${origin}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action ${origin}; img-src ${origin} data: blob:; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; media-src ${origin} blob:; manifest-src 'none'`;
    const responseHeaders = [{ name: "Content-Type", value: (response.headers.get("content-type") ?? "application/octet-stream").slice(0, 200) }, { name: "Content-Security-Policy", value: csp }, { name: "Cache-Control", value: "no-store" }, { name: "Referrer-Policy", value: "no-referrer" }, { name: "X-DNS-Prefetch-Control", value: "off" }];
    // Fresh isolated browser cookies go only to this owned origin; no host credentials enter.
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.length > 16000 || /[\r\n\0]/.test(cookie))
        throw new Error("journey_response_cookie_invalid");
      responseHeaders.push({ name: "Set-Cookie", value: cookie });
    }
    await this.client.call("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: response.status, responseHeaders, body: Buffer.concat(chunks).toString("base64") }, session);
  }
  async idle() {
    while (this.pending.size)
      await Promise.all([...this.pending]); if (this.failure)
      throw this.failure;
  }
}
