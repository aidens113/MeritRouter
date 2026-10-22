import { GatewayError, type GatewayErrorKind } from "../core/errors.js";
import { cooldownMs, type RateLimitSnapshot } from "./rate-limits.js";

/**
 * Why a provider request failed, in the terms key rotation and routing act on:
 * - `rate_limited`: this key is cooling down (`retryAfterMs`); another key may serve.
 * - `auth_invalid`: the key is wrong, revoked, or lacks access; disable it.
 * - `out_of_credits`: 402, or a spend cap; not retryable on this key.
 * - `not_in_plan`: this key's plan does not include the model (Ollama Cloud's free plan answers
 *   402 for models outside it); the key still serves other models, so the model is skipped for
 *   this key and routing moves to the next model.
 * - `policy`: the provider refused the content (moderation, safety).
 * - `server`, `timeout`, `transport`: the provider failed; retry elsewhere.
 * - `bad_request`, `unknown_model`: the request or model id is wrong; do not retry as is.
 * - `aborted`: the caller cancelled.
 */
export type ProviderErrorKind = "rate_limited" | "auth_invalid" | "out_of_credits" | "not_in_plan" | "policy" | "server" | "timeout" | "transport" | "bad_request" | "unknown_model" | "aborted";

const GATEWAY_KIND: Record<ProviderErrorKind, GatewayErrorKind> = {
  rate_limited: "rate_limited",
  auth_invalid: "auth",
  out_of_credits: "pool_exhausted",
  not_in_plan: "pool_exhausted",
  policy: "policy_violation",
  server: "server",
  timeout: "timeout",
  transport: "transport",
  bad_request: "bad_request",
  unknown_model: "unknown_model",
  aborted: "aborted",
};

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  rate_limited: true,
  auth_invalid: false,
  out_of_credits: false,
  not_in_plan: false,
  policy: false,
  server: true,
  timeout: true,
  transport: true,
  bad_request: false,
  unknown_model: false,
  aborted: false,
};

export interface ProviderErrorDetails {
  provider: string;
  status?: number;
  retryAfterMs?: number;
  possiblyConsumed?: boolean;
  /** The provider's own error code or type, when it sent one. */
  providerCode?: string | null;
  rateLimits?: RateLimitSnapshot | null;
}

/**
 * A classified provider failure. It is a `GatewayError` (kind mapped from `reason`) so existing
 * gate handling keeps working; `reason`, `retryable`, and `rateLimits` serve key rotation.
 */
export class ProviderError extends GatewayError {
  readonly provider: string;
  /** Worth retrying on another key or later (never for auth, credits, policy, bad requests). */
  readonly retryable: boolean;
  readonly providerCode: string | null;
  readonly rateLimits: RateLimitSnapshot | null;

  constructor(
    readonly reason: ProviderErrorKind,
    message: string,
    d: ProviderErrorDetails,
  ) {
    super(GATEWAY_KIND[reason], message, d.status, d.retryAfterMs, d.possiblyConsumed ?? !(d.status !== undefined && d.status >= 400 && d.status < 500));
    this.provider = d.provider;
    this.retryable = RETRYABLE[reason];
    this.providerCode = d.providerCode ?? null;
    this.rateLimits = d.rateLimits ?? null;
  }
}

interface ErrorBody {
  message: string;
  code: string | null;
  /** Numeric code that mirrors an HTTP status (OpenRouter, Google). */
  status: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/**
 * Pull the error out of a provider body. Shapes: OpenAI/Groq/Mistral `{error:{message,type,code}}`,
 * OpenRouter `{error:{code,message,metadata}}`, Anthropic `{type:"error",error:{type,message}}`,
 * Google `{error:{code,message,status}}` (sometimes wrapped in an array), Cloudflare
 * `{success:false,errors:[{code,message}]}`, or `{error:"text"}`. Null when there is none.
 */
export function extractErrorBody(json: unknown): ErrorBody | null {
  const root = Array.isArray(json) ? json[0] : json;
  if (!root || typeof root !== "object") return null;
  const r = root as Record<string, unknown>;
  if (typeof r.error === "string" && r.error) return { message: r.error, code: null, status: null };
  if (r.error && typeof r.error === "object") {
    const e = r.error as Record<string, unknown>;
    const numeric = typeof e.code === "number" ? e.code : null;
    const meta = e.metadata && typeof e.metadata === "object" ? ` ${JSON.stringify(e.metadata).slice(0, 300)}` : "";
    return { message: `${str(e.message) ?? "provider error"}${meta}`, code: str(e.type) ?? str(e.status) ?? str(e.code), status: numeric !== null && numeric >= 100 && numeric < 600 ? numeric : null };
  }
  if (r.success === false && Array.isArray(r.errors) && r.errors.length) {
    const e = (r.errors[0] ?? {}) as Record<string, unknown>;
    return { message: str(e.message) ?? "provider error", code: str(e.code), status: null };
  }
  return null;
}

const POLICY = /content[ _-]?policy|content[ _-]?filter|moderation|flagged|safety|responsible[ _-]?ai/i;
/** A refusal of one model by the key's plan, not of the key (checked before treating a 402 as credits). */
const NOT_IN_PLAN = /not included in your (?:free )?(?:usage|plan)|not (?:available|included) (?:on|in|with) your (?:current )?plan|requires? a (?:paid|pro|higher) (?:plan|tier|subscription)|upgrade (?:your plan )?to (?:use|access) this model/i;
const CREDITS = /enforced_spend_limit|spend[ _-]?limit|insufficient_quota|insufficient[ _-]?credits|out of credits|credit balance/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Classify a failed provider response. `status` is the HTTP status, or the status-like code an
 * HTTP 200 error body carried. The message keeps a bounded slice of the body (never headers).
 */
export function classifyProviderError(provider: string, status: number, bodyText: string, rateLimits: RateLimitSnapshot | null, opts: { httpStatus?: number } = {}): ProviderError {
  const body = extractErrorBody(parseJson(bodyText));
  const detail = body ? `${body.code ? `${body.code}: ` : ""}${body.message}` : bodyText;
  const msg = `${provider} HTTP ${opts.httpStatus ?? status}${opts.httpStatus !== undefined && opts.httpStatus !== status ? ` (error ${status})` : ""}: ${detail.slice(0, 400)}`;
  const haystack = `${body?.code ?? ""} ${body?.message ?? bodyText.slice(0, 2000)}`;
  const base = { provider, status: opts.httpStatus ?? status, providerCode: body?.code ?? null, rateLimits };
  // A 200 that carries an error may have run (and billed) before failing.
  const consumed = opts.httpStatus !== undefined && opts.httpStatus < 400 ? { possiblyConsumed: status >= 500 } : {};
  if ((status === 402 || status === 403) && NOT_IN_PLAN.test(haystack)) return new ProviderError("not_in_plan", `${msg} (model not in this key's plan)`, { ...base, ...consumed });
  if (status === 402) return new ProviderError("out_of_credits", `${msg} (out of credits)`, { ...base, ...consumed });
  if (status === 451 || ((status === 400 || status === 403) && POLICY.test(haystack))) return new ProviderError("policy", msg, { ...base, ...consumed });
  if (status === 401 || status === 403) return new ProviderError("auth_invalid", msg, { ...base, ...consumed });
  if (status === 429) {
    if (CREDITS.test(haystack)) return new ProviderError("out_of_credits", `${msg} (spend limit)`, { ...base, ...consumed });
    const wait = rateLimits ? cooldownMs(rateLimits) : null;
    return new ProviderError("rate_limited", msg, { ...base, ...consumed, ...(wait !== null ? { retryAfterMs: wait } : {}) });
  }
  if (status === 404) return new ProviderError("unknown_model", msg, { ...base, ...consumed });
  if (status === 408) return new ProviderError("timeout", msg, { ...base, possiblyConsumed: true });
  if (status >= 400 && status < 500) return new ProviderError("bad_request", msg, { ...base, ...consumed });
  // 5xx and 529 (overloaded): the provider may or may not have billed; treat as possibly consumed.
  const wait = rateLimits?.retryAfterMs ?? null;
  return new ProviderError("server", msg, { ...base, possiblyConsumed: true, ...(wait !== null ? { retryAfterMs: wait } : {}) });
}

/**
 * An HTTP 200 body that is really an error (OpenRouter documents this; others do it too):
 * an `error` member and no result. Returns the classified error, or null for a normal body.
 */
export function errorInOkBody(provider: string, json: unknown, httpStatus: number, rateLimits: RateLimitSnapshot | null, resultKey: string): ProviderError | null {
  if (!json || typeof json !== "object") return null;
  if (!Array.isArray(json) && (json as Record<string, unknown>)[resultKey] !== undefined) return null;
  const body = extractErrorBody(json);
  if (!body) return null;
  const status = body.status ?? (POLICY.test(`${body.code ?? ""} ${body.message}`) ? 400 : 502);
  return classifyProviderError(provider, status, JSON.stringify(json), rateLimits, { httpStatus });
}

/**
 * A failure that says the key itself cannot serve until the user acts: the provider rejected it
 * (401/403, `auth_invalid`) or it is out of credits (402 or a spend cap, `out_of_credits`).
 * Model listings and key tests record these on the key exactly as a failed request would.
 */
export function isKeyFailure(err: unknown): err is ProviderError {
  return err instanceof ProviderError && (err.reason === "auth_invalid" || err.reason === "out_of_credits");
}
