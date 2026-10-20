import { ProviderError } from "./errors.js";

/**
 * Secrets never leave a provider call inside an error message. Providers echo keys in error
 * bodies, and a network failure's text can carry the request URL (a Google `?key=`), so every
 * `ProviderError` the transport and the client throw is masked here, before key state stores it
 * as `last_error` or a surface prints it. A masked secret keeps only its last four characters
 * (`...WXYZ`), the same identification every key view shows.
 */

/** Values shorter than this are not treated as secrets: masking them would garble ordinary text. */
const MIN_SECRET_LENGTH = 4;
/** Below this length even the last four characters say too much about the secret. */
const SHOW_LAST4_FROM = 8;

/** Header names that carry credentials: auth headers and any configured key or token header. */
const SECRET_HEADER = /auth|api[-_]?key|token|secret|signature|password/i;
/** Query parameters that carry credentials (`?key=` on Google, `api_key`, `access_token`, ...). */
const SECRET_PARAM = /^(key|api[-_]?key|apikey|access[-_]?token|token|auth|secret|password|sig|signature)$/i;

const placeholder = (secret: string) => (secret.length >= SHOW_LAST4_FROM ? `...${secret.slice(-4)}` : "[redacted]");

/** Replace every occurrence of each secret (and its URL-encoded form) in `text`. */
export function maskSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  // Longest first, so a secret that contains another is masked whole.
  const list = [...new Set([...secrets].filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) {
    const mask = placeholder(s);
    out = out.split(s).join(mask);
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join(mask);
  }
  return out;
}

/**
 * The secrets in one request: credential header values (the value after an auth scheme such as
 * `Bearer `, and the whole value) and credential query parameters of the URL.
 */
export function requestSecrets(headers: Readonly<Record<string, string>>, url: string): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER.test(name) || !value) continue;
    out.push(value);
    const scheme = /^[A-Za-z][\w-]*\s+(\S.*)$/.exec(value);
    if (scheme) out.push(scheme[1]!);
  }
  try {
    for (const [name, value] of new URL(url).searchParams) if (SECRET_PARAM.test(name) && value) out.push(value);
  } catch {
    // Not a parseable URL: no query secrets to find.
  }
  return out;
}

/** The same error with the secrets masked from its message; the error itself when none occurs. */
export function maskProviderError(err: ProviderError, secrets: Iterable<string | null | undefined>): ProviderError {
  const message = maskSecrets(err.message, secrets);
  if (message === err.message) return err;
  return new ProviderError(err.reason, message, {
    provider: err.provider,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    possiblyConsumed: err.possiblyConsumed,
    providerCode: err.providerCode,
    rateLimits: err.rateLimits,
  });
}
