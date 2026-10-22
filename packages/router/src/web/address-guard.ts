import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";

/**
 * SSRF protection for the built-in page fetch: only http(s) URLs, and never a host that is or
 * resolves to a loopback, private, link-local, unique-local, carrier-grade NAT, multicast,
 * documentation, or cloud metadata address. Checked on the URL before a request, on every
 * resolved address before connecting (`guardedLookup`, so DNS rebinding between the check and
 * the connection cannot slip through), and again on each redirect target.
 */

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba Cloud metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique-local (AWS metadata fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/** Host names refused without resolving them (local names and metadata services). */
const BLOCKED_NAMES = [/^localhost$/i, /\.localhost$/i, /^metadata\.google\.internal$/i, /\.internal$/i, /\.local$/i, /^metadata$/i];

/**
 * A URL or address the guard refused. Nothing is sent for it, by any backend: the fetch chain
 * stops here instead of trying the next backend.
 */
export class SsrfRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfRefusal";
  }
}

/** Why an IP address may not be fetched; null when it is a public address. */
export function blockedAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 0) return `${address} is not an IP address`;
  if (family === 6) {
    // IPv4 embedded in IPv6 (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::a.b.c.d): judge the IPv4 address.
    const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (embedded) return blockedAddress(embedded[1]!);
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return blockedAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
  }
  return BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4") ? `${address} is a private, loopback, link-local, or reserved address` : null;
}

/** The URL's host without IPv6 brackets. */
export function urlHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Parse and check a URL before any request: http(s) only, no credentials in it, and no host
 * that is blocked by name or is a blocked IP literal. Returns the parsed URL or throws.
 */
export function checkWebUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfRefusal(`not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfRefusal(`only http and https URLs can be fetched (got ${u.protocol})`);
  if (u.username || u.password) throw new SsrfRefusal("URLs with credentials are refused");
  const host = urlHost(u);
  if (!host) throw new SsrfRefusal("the URL has no host");
  if (BLOCKED_NAMES.some((re) => re.test(host))) throw new SsrfRefusal(`refused: ${host} is a local or metadata host name`);
  if (isIP(host)) {
    const why = blockedAddress(host);
    if (why) throw new SsrfRefusal(`refused: ${why}`);
  }
  return u;
}

/** Resolve a host name to all its addresses (injectable for tests). */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))));

/** Resolve `host` and refuse it when any address is blocked (an IP literal is checked as is). */
export async function checkHostResolves(host: string, resolve: Resolver): Promise<string[]> {
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (!addrs.length) throw new Error(`${host} did not resolve`);
  for (const a of addrs) {
    const why = blockedAddress(a);
    if (why) throw new SsrfRefusal(`refused: ${host} resolves to ${why}`);
  }
  return addrs;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `http.request` that resolves like the system and refuses blocked addresses at
 * connection time, so the address connected to is always one that was checked.
 */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err, "", 4);
    const list = addrs as LookupAddress[];
    const bad = list.map((a) => blockedAddress(a.address)).find((w) => w !== null);
    if (bad || !list.length) {
      const e = new Error(`refused: ${hostname} resolves to ${bad ?? "no address"}`) as NodeJS.ErrnoException;
      e.code = "ESSRF";
      return callback(e, "", 4);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}
