import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ClientConnectionsConfig } from "../config/schema.js";

/** Canonical addresses, including IPv4-mapped IPv6, without DNS or forwarded-header trust. */
export function normalizeClientConnectionHost(raw: string): string {
  let host = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) === 6) { try { host = new URL("http://[" + host + "]/").hostname.slice(1, -1); } catch { return host; } }
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(host);
  if (mapped) { const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16); return [high >> 8, high & 255, low >> 8, low & 255].join("."); }
  return host;
}
export function isClientConnectionLoopback(raw: string): boolean {
  const host = normalizeClientConnectionHost(raw);
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}
export function clientConnectionTokenRequired(config: Pick<ClientConnectionsConfig, "host" | "access_token_hash">): boolean {
  return config.access_token_hash !== null || !isClientConnectionLoopback(config.host);
}
export function clientConnectionTokenMatches(config: Pick<ClientConnectionsConfig, "host" | "access_token_hash">, token?: string): boolean {
  if (!clientConnectionTokenRequired(config)) return true;
  if (!config.access_token_hash || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const actual = createHash("sha256").update(token).digest("hex");
  return timingSafeEqual(Buffer.from(config.access_token_hash), Buffer.from(actual));
}
export function clientConnectionBaseUrl(config: Pick<ClientConnectionsConfig, "host" | "port">): string {
  const normalized = normalizeClientConnectionHost(config.host), host = normalized === "0.0.0.0" ? "127.0.0.1" : normalized === "::" ? "::1" : config.host;
  return "http://" + (isIP(host) === 6 ? "[" + host + "]" : host) + ":" + config.port;
}
