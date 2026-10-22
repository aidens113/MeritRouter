import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { checkHostResolves, checkWebUrl, guardedLookup, SsrfRefusal, systemResolver, urlHost, type Resolver } from "./address-guard.js";
import { htmlToText } from "./html-text.js";

/**
 * SwitchYard's own page fetch (used when Ollama's web_fetch is not available): http(s) only,
 * every host checked against the SSRF guard before the request and at connection time, each
 * redirect target checked again (at most `maxRedirects`), a timeout, and a byte cap on the
 * decoded body. HTML is reduced to readable text.
 */

export interface PageResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Buffer;
  /** The body was cut at the byte cap. */
  truncated: boolean;
}

/** One HTTP GET without following redirects (injectable for tests). */
export type PageTransport = (url: URL, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => Promise<PageResponse>;

export interface FetchedPage {
  /** The final URL after redirects. */
  url: string;
  title: string;
  content: string;
  links: string[];
  contentType: string;
  bytes: number;
  truncated: boolean;
}

export interface PageFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  transport?: PageTransport;
  resolve?: Resolver;
  signal?: AbortSignal;
}

const USER_AGENT = "SwitchYard/1 (agent web_fetch)";
const TEXTUAL = /^(?:text\/|application\/(?:xhtml\+xml|xml|json|ld\+json|javascript|rss\+xml|atom\+xml)|[a-z]+\/[a-z0-9.+-]*\+(?:json|xml)$)/i;

/** The real transport: node http(s) with the guarded DNS lookup, a timeout, and a decoded-byte cap. */
export const nodeTransport: PageTransport = (url, opts) =>
  new Promise<PageResponse>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const done = (err: Error | null, value?: PageResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as unknown as http.RequestOptions["lookup"],
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5", "accept-encoding": "gzip, deflate, br" },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return done(null, { status, headers, body: Buffer.alloc(0), truncated: false });
        }
        const enc = (headers["content-encoding"] ?? "").toLowerCase();
        let stream: Readable = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (c: Buffer) => {
          if (truncated) return;
          const room = opts.maxBytes - size;
          if (c.length > room) {
            chunks.push(c.subarray(0, room));
            size += room;
            truncated = true;
            req.destroy();
            done(null, { status, headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        stream.on("end", () => done(null, { status, headers, body: Buffer.concat(chunks), truncated }));
        stream.on("error", (e) => done(e));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(new Error(`timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(new Error("aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // The guarded lookup refused the address at connection time: an SSRF refusal, not a failure.
    req.on("error", (e) => done((e as NodeJS.ErrnoException).code === "ESSRF" ? new SsrfRefusal(e.message) : e));
    req.end();
  });

function charsetOf(contentType: string): string {
  return /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? "utf-8";
}

function decode(body: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Fetch one page with SwitchYard's own client (see the module comment). */
export async function fetchPage(rawUrl: string, o: PageFetchOptions): Promise<FetchedPage> {
  const transport = o.transport ?? nodeTransport;
  const resolve = o.resolve ?? systemResolver;
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const u = checkWebUrl(current);
    await checkHostResolves(urlHost(u), resolve);
    const res = await transport(u, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, ...(o.signal ? { signal: o.signal } : {}) });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= o.maxRedirects) throw new Error(`too many redirects (more than ${o.maxRedirects})`);
      current = new URL(res.headers.location, u).href;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`${u.host} answered HTTP ${res.status}`);
    const contentType = (res.headers["content-type"] ?? "text/html").split(",")[0]!.trim();
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    if (!TEXTUAL.test(mediaType)) throw new Error(`unsupported content type ${mediaType || "(none)"}: only text pages can be read`);
    const text = decode(res.body, contentType);
    const page = /html|xml/.test(mediaType) && /<html|<body|<head|<p\b|<div\b/i.test(text) ? htmlToText(text, u.href) : { title: "", text: text.trim(), links: [] };
    return { url: u.href, title: page.title, content: page.text, links: page.links, contentType: mediaType, bytes: res.body.length, truncated: res.truncated };
  }
}
